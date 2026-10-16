/**
 * MP4 / MOV / M4V / 3GP（ISO BMFF）规划器。
 *
 * 铁律：**只改容器，一个字节都不碰媒体**。只允许动这几类位置：
 *   1) `free` / `skip` box 的填充区（所有解析器都会跳过，写什么都不影响播放）；
 *   2) `moov/udta/meta/ilst` 里的注释字段（`©cmt`，ffprobe 显示为 comment）；
 *   3) 文件尾追加一个合法的 `free` box（原始字节 100% 是副本前缀）。
 *
 * 注释字段有两种合法写法，按文件现有结构择一，**不能混**：
 *   · ilst 风格（ffmpeg 自己写的）：`udta/meta/ilst/©cmt`，`©cmt` 内套 `data` 盒；
 *   · 传统 QuickTime 风格：`udta/©cmt`，`©cmt` 内直接放 UTF-8 原文。
 *   把 `data` 盒塞进顶层 `©cmt` 会被 ffprobe 当传统风格解析，读出空值。
 *
 * 需要"长胖" moov 时（把注释挤进去），必须同步修正 stco/co64 的绝对偏移；
 * 分片 MP4（moof/sidx）不参与重排，直接降级为只追加。
 */

import { box, u32be, u64be, b4 } from './bytes.js';

const CONTAINER_TYPES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'mvex', 'moof', 'traf', 'dinf', 'ilst', 'meta']);
const FULLBOX_CONTAINERS = new Set(['meta']);
const FREE_TYPES = new Set(['free', 'skip']);
export const CMT = '\u00a9cmt';
const FRAGMENT_TYPES = new Set(['moof', 'sidx', 'styp']);
const TOP_TYPES = new Set(['ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'sidx']);

/* ── 解析 ───────────────────────────────────────────────────────────── */

export function looksLikeIsoBmff(head) {
  if (head.length < 12) return false;
  return TOP_TYPES.has(head.toString('latin1', 4, 8));
}

function readBoxesSync(buf, start, end) {
  const boxes = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let headerSize = 8;
    let implicitSize = false;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - p;
      implicitSize = true;
    }
    if (size < headerSize || p + size > end) {
      boxes.push({ start: p, end, size: end - p, type, headerSize, bodyStart: p + headerSize, bodyEnd: end, truncated: true, implicitSize });
      break;
    }
    boxes.push({ start: p, end: p + size, size, type, headerSize, bodyStart: p + headerSize, bodyEnd: p + size, implicitSize });
    p += size;
  }
  return boxes;
}

export function parseBoxes(buf, start = 0, end = buf.length, depth = 0, maxDepth = 6) {
  const out = [];
  for (const b of readBoxesSync(buf, start, end)) {
    const node = { ...b, depth, children: [] };
    if (depth < maxDepth && CONTAINER_TYPES.has(b.type)) {
      node.children = parseBoxes(buf, b.bodyStart + (FULLBOX_CONTAINERS.has(b.type) ? 4 : 0), b.bodyEnd, depth + 1, maxDepth);
    }
    out.push(node);
  }
  return out;
}

async function readBoxesAt(reader, start, end) {
  if (end <= start) return [];
  const buf = await reader.read(start, end - start);
  return readBoxesSync(buf, 0, buf.length).map((b) => ({
    ...b,
    start: b.start + start,
    end: b.end + start,
    bodyStart: b.bodyStart + start,
    bodyEnd: b.bodyEnd + start,
  }));
}

/* ── udta / meta / ilst 定位 ────────────────────────────────────────── */

async function findUdtaStructure(reader, moov) {
  const empty = { moovChildren: [], udta: null, udtaChildren: [], meta: null, metaChildren: [], metaFullbox: Buffer.alloc(4), ilst: null, ilstChildren: [] };
  if (!moov) return empty;
  const moovChildren = await readBoxesAt(reader, moov.bodyStart, moov.bodyEnd);
  const udta = moovChildren.find((b) => b.type === 'udta') ?? null;
  if (!udta) return { ...empty, moovChildren };
  const udtaChildren = await readBoxesAt(reader, udta.bodyStart, udta.bodyEnd);
  const meta = udtaChildren.find((b) => b.type === 'meta') ?? null;
  if (!meta) return { ...empty, moovChildren, udta, udtaChildren };
  const metaFullbox = await reader.read(meta.bodyStart, 4);
  const metaChildren = await readBoxesAt(reader, meta.bodyStart + 4, meta.bodyEnd);
  const ilst = metaChildren.find((b) => b.type === 'ilst') ?? null;
  const ilstChildren = ilst ? await readBoxesAt(reader, ilst.bodyStart, ilst.bodyEnd) : [];
  return { moovChildren, udta, udtaChildren, meta, metaChildren, metaFullbox, ilst, ilstChildren };
}

/** 找现有注释字段：返回文本区间与可写容量（原地覆盖用）。 */
async function findComment(reader, struct) {
  const entry = struct.ilstChildren.find((b) => b.type === CMT);
  if (entry) {
    const data = (await readBoxesAt(reader, entry.bodyStart, entry.bodyEnd)).find((b) => b.type === 'data');
    if (data) {
      const stringStart = data.bodyStart + 8;
      return { kind: 'ilst', entry, stringStart, stringEnd: data.bodyEnd, capacity: data.bodyEnd - stringStart };
    }
  }
  const legacy = struct.udtaChildren.find((b) => b.type === CMT);
  if (legacy) {
    return { kind: 'legacy', entry: legacy, stringStart: legacy.bodyStart, stringEnd: legacy.bodyEnd, capacity: legacy.bodyEnd - legacy.bodyStart };
  }
  return null;
}

function ilstCommentAtom(text) {
  const data = box('data', Buffer.concat([u32be(1), u32be(0), Buffer.from(text, 'utf8')]));
  return box(CMT, data);
}

function legacyCommentAtom(text) {
  return box(CMT, Buffer.from(text, 'utf8'));
}

/* ── stco / co64 偏移修正 ───────────────────────────────────────────── */

function patchChunkOffsets(buf, start, end, shiftFrom, delta) {
  let patched = 0;
  for (const b of readBoxesSync(buf, start, end)) {
    if (b.type === 'stco' || b.type === 'co64') {
      const count = buf.readUInt32BE(b.bodyStart + 4);
      const width = b.type === 'stco' ? 4 : 8;
      for (let i = 0; i < count; i += 1) {
        const off = b.bodyStart + 8 + i * width;
        if (off + width > b.bodyEnd) break;
        const value = width === 4 ? buf.readUInt32BE(off) : Number(buf.readBigUInt64BE(off));
        if (value >= shiftFrom) {
          if (width === 4) buf.writeUInt32BE(value + delta, off);
          else buf.writeBigUInt64BE(BigInt(value + delta), off);
          patched += 1;
        }
      }
    } else if (CONTAINER_TYPES.has(b.type)) {
      patched += patchChunkOffsets(buf, b.bodyStart + (FULLBOX_CONTAINERS.has(b.type) ? 4 : 0), b.bodyEnd, shiftFrom, delta);
    }
  }
  return patched;
}

/* ── children 缓冲拼装 ──────────────────────────────────────────────── */

/**
 * 在相对坐标缓冲里重建 children 序列：逐个子盒拷贝，`drop` 里的整段跳过
 * （连它的字节一起跳，不能只跳过索引），`append` 拼到末尾。
 * 关键点：最后一个被丢弃的子盒若正好在缓冲区尾部，尾部拷贝必须一起停掉，
 * 否则会把被丢弃的字节原样复制回去 —— 这正是"同一个 udta 出现两次"的成因。
 */
function joinChildren(buf, children, drop = [], append = [], sliceAt = null) {
  const dropKeys = new Set(drop.map((b) => `${b.start}:${b.end}`));
  const sorted = [...children].sort((x, y) => x.start - y.start);
  const parts = [];
  let cursor = 0;
  for (const b of sorted) {
    if (b.start > cursor) parts.push(buf.subarray(cursor, b.start));
    if (!dropKeys.has(`${b.start}:${b.end}`)) parts.push(buf.subarray(b.start, b.end));
    cursor = b.end;
  }
  const tailEnd = sliceAt === null ? buf.length : Math.min(buf.length, sliceAt);
  if (cursor < tailEnd) parts.push(buf.subarray(cursor, tailEnd));
  parts.push(...append);
  return Buffer.concat(parts);
}

/* ── moov 重建 ──────────────────────────────────────────────────────── */

/**
 * 重建 moov，把注释字段放进**正确的父节点**：
 *   ilst 存在 → 替换 ilst 里的 `©cmt`（data 盒风格）
 *   meta 存在 → 补建 ilst
 *   udta 存在 → 传统风格 `©cmt`
 *   都没有     → 新建 udta + 传统风格 `©cmt`
 */
async function buildGrownMoov(reader, moov, struct, markerText) {
  const childrenBuf = await reader.read(moov.bodyStart, moov.size - moov.headerSize);
  const rel = (abs) => abs - moov.bodyStart;
  const relBox = (b) => ({ ...b, start: rel(b.start), end: rel(b.end), bodyStart: rel(b.bodyStart), bodyEnd: rel(b.bodyEnd) });

  const moovChildren = struct.moovChildren.map(relBox);
  const udtaChild = moovChildren.find((b) => b.type === 'udta') ?? null;

  let newChildren;
  if (!struct.udta) {
    newChildren = Buffer.concat([childrenBuf, box('udta', legacyCommentAtom(markerText))]);
  } else {
    const uOff = rel(struct.udta.bodyStart);
    const udtaBuf = childrenBuf.subarray(uOff, rel(struct.udta.bodyEnd));
    // udta 的 children 缓冲从 udta.bodyStart 开始，故本地坐标基准是 uOff
    const local = (b, base) => ({
      ...relBox(b), start: rel(b.start) - base, end: rel(b.end) - base,
      bodyStart: rel(b.bodyStart) - base, bodyEnd: rel(b.bodyEnd) - base,
    });
    const udtaChildren = struct.udtaChildren.map((b) => local(b, uOff));
    const metaChild = udtaChildren.find((b) => b.type === 'meta') ?? null;

    let newUdta;
    if (metaChild && struct.ilst) {
      // meta 是 fullbox：children 缓冲从 meta.bodyStart + 4 开始
      const mOff = rel(struct.meta.bodyStart) + 4;
      const metaBuf = childrenBuf.subarray(mOff, rel(struct.meta.bodyEnd));
      const metaChildren = struct.metaChildren.map((b) => local(b, mOff));
      const iOff = rel(struct.ilst.bodyStart);
      const ilstBuf = childrenBuf.subarray(iOff, rel(struct.ilst.bodyEnd));
      const ilstChildren = struct.ilstChildren.map((b) => local(b, iOff));
      const newIlst = box('ilst', joinChildren(ilstBuf, ilstChildren, ilstChildren.filter((b) => b.type === CMT), [ilstCommentAtom(markerText)]));
      const newMeta = box('meta', Buffer.concat([
        struct.metaFullbox,
        joinChildren(metaBuf, metaChildren, metaChildren.filter((b) => b.type === 'ilst'), [newIlst]),
      ]));
      newUdta = box('udta', joinChildren(udtaBuf, udtaChildren, [metaChild], [newMeta]));
    } else if (metaChild) {
      const mOff = rel(struct.meta.bodyStart) + 4;
      const metaBuf = childrenBuf.subarray(mOff, rel(struct.meta.bodyEnd));
      const metaChildren = struct.metaChildren.map((b) => local(b, mOff));
      const newMeta = box('meta', Buffer.concat([
        struct.metaFullbox,
        joinChildren(metaBuf, metaChildren, [], [box('ilst', ilstCommentAtom(markerText))]),
      ]));
      newUdta = box('udta', joinChildren(udtaBuf, udtaChildren, [metaChild], [newMeta]));
    } else {
      newUdta = box('udta', joinChildren(udtaBuf, udtaChildren, udtaChildren.filter((b) => b.type === CMT), [legacyCommentAtom(markerText)]));
    }
    newChildren = joinChildren(childrenBuf, moovChildren, udtaChild ? [udtaChild] : [], [newUdta], rel(struct.udta.start));
  }

  const header = moov.headerSize === 16
    ? Buffer.concat([u32be(1), b4('moov'), u64be(newChildren.length + 16)])
    : Buffer.concat([u32be(newChildren.length + 8), b4('moov')]);
  const newMoov = Buffer.concat([header, newChildren]);
  const delta = newMoov.length - moov.size;
  let patchedOffsets = 0;
  if (delta !== 0) patchedOffsets = patchChunkOffsets(newMoov, moov.headerSize, newMoov.length, moov.end, delta);
  return { buffer: newMoov, patchedOffsets, delta };
}

/* ── 规划 ───────────────────────────────────────────────────────────── */

export async function planMp4(reader, opts) {
  const { marker, mode = 'both', padBytes = 128, strictSize = false } = opts;
  // 注释文本补齐到 padBytes 定长。必须定长，否则注释长度会随标签的 UTF-8 字节数浮动
  // （"抖音号A"=10B、"快手F"=7B），同一支源视频的不同副本会产出**不同体积**的文件——
  // 分发时这点很扎眼。free 尾巴本来就按 padBytes 补零，这里与它保持一致。
  // 注意：原地覆盖分支按 capacity 补齐（capacity 是源文件固有属性，天然定长），
  // 所以这里补长不会影响 comment-inplace 的可用性判断。
  const rawMarkerText = marker.toString('utf8').split('\n')[0];
  const markerText = rawMarkerText + ' '.repeat(Math.max(0, padBytes - Buffer.byteLength(rawMarkerText)));
  const size = reader.size;
  const top = await readBoxesAt(reader, 0, size);
  const moov = top.find((b) => b.type === 'moov') ?? null;
  const fragmented = top.some((b) => FRAGMENT_TYPES.has(b.type));
  const splices = [];
  const strategies = [];
  const notes = [];
  let visible = false;

  if (mode === 'meta' || mode === 'both') {
    const struct = await findUdtaStructure(reader, moov);
    if (!moov) {
      notes.push('没有 moov，跳过注释字段');
    } else if (fragmented && !struct.udta) {
      notes.push('分片 MP4（moof/sidx 存在），不重排 moov，注释字段跳过');
    } else {
      const comment = await findComment(reader, struct);
      if (comment && comment.capacity >= marker.length) {
        const padded = Buffer.concat([marker, Buffer.alloc(comment.capacity - marker.length, 0x20)]);
        splices.push({ start: comment.stringStart, end: comment.stringEnd, data: padded, note: `comment(${comment.kind})-inplace` });
        strategies.push('comment-inplace');
        visible = true;
      } else {
        const built = await buildGrownMoov(reader, moov, struct, markerText);
        splices.push({ start: moov.start, end: moov.end, data: built.buffer, note: 'moov+comment' });
        strategies.push(comment ? 'comment-grow' : 'comment-add');
        visible = true;
        if (built.patchedOffsets > 0) notes.push(`修正了 ${built.patchedOffsets} 个 stco/co64 条目`);
      }
    }
  }

  if (mode === 'pad' || mode === 'both') {
    const moovRewritten = splices.some((s) => s.note === 'moov+comment');
    const room = moovRewritten ? null : await findFreeBoxWithRoom(reader, top, moov, marker.length);
    if (room) {
      splices.push({ start: room.payloadStart, end: room.payloadStart + marker.length, data: marker, note: 'free-inplace' });
      strategies.push('free-inplace');
    } else if (strictSize) {
      throw new Error('strictSize: 这个文件里没有可写的 free box，无法在不改变体积的前提下塞标记');
    } else {
      const payload = Buffer.concat([marker, Buffer.alloc(Math.max(0, padBytes - marker.length), 0)]);
      const implicitMdat = top.find((b) => b.type === 'mdat' && b.implicitSize);
      if (implicitMdat) {
        splices.push({ start: implicitMdat.start, end: implicitMdat.start + 4, data: u32be(implicitMdat.size), note: 'mdat-size-fix' });
        notes.push('mdat 原为"到文件尾"，已补显式长度');
      }
      splices.push({ start: size, end: size, data: box('free', payload), note: 'free-append' });
      strategies.push('free-append');
    }
  }

  const sizeDelta = splices.reduce((acc, s) => acc + (s.data.length - (s.end - s.start)), 0);
  if (strictSize && sizeDelta !== 0) {
    throw new Error('strictSize: 该文件无法在保持原体积的前提下塞入标记（需要 free box 或可原地覆盖的注释字段）');
  }

  return {
    container: 'mp4',
    strategy: strategies.join('+') || 'none',
    visible,
    splices,
    notes,
    degraded: strategies.length === 0,
    sizeDelta,
    mediaImpact: 'none',
  };
}

async function findFreeBoxWithRoom(reader, top, moov, need) {
  const candidates = [...top.filter((b) => FREE_TYPES.has(b.type))];
  if (moov) {
    const moovChildren = await readBoxesAt(reader, moov.bodyStart, moov.bodyEnd);
    candidates.push(...moovChildren.filter((b) => FREE_TYPES.has(b.type)));
    const udta = moovChildren.find((b) => b.type === 'udta');
    if (udta) candidates.push(...(await readBoxesAt(reader, udta.bodyStart, udta.bodyEnd)).filter((b) => FREE_TYPES.has(b.type)));
  }
  for (const b of candidates) if (b.bodyEnd - b.bodyStart >= need) return { ...b, payloadStart: b.bodyStart };
  return null;
}

export async function describeBoxes(reader, maxDepth = 5) {
  const lines = [];
  const walk = async (start, end, depth) => {
    if (depth > maxDepth) return;
    for (const b of await readBoxesAt(reader, start, end)) {
      lines.push({ depth, type: b.type, start: b.start, size: b.size });
      if (CONTAINER_TYPES.has(b.type)) await walk(b.bodyStart + (FULLBOX_CONTAINERS.has(b.type) ? 4 : 0), b.bodyEnd, depth + 1);
    }
  };
  await walk(0, reader.size, 0);
  return lines;
}
