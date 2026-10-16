/**
 * 编排放核心：把一支视频复制成 N 份，每份塞一个唯一 GUID。
 *
 * 三条硬承诺（每一步都会自证）：
 *   1. 媒体不变 —— 编码流哈希 streamhash 与源文件完全一致（可选：逐帧 framemd5）；
 *   2. 原始字节不变 —— 除规划出的 splice 区间外，副本与源文件逐字节相同（流式区间哈希比对）；
 *   3. 文件哈希互异 —— N 份的 sha256 / md5 两两不同。
 *
 * 另外产出一份 ledger（guid → 文件 → 标签），用于事后溯源：拿到任何一份就知道是谁发的。
 */

import { basename, dirname, extname, join, resolve } from 'node:path';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';

import { openReader, computeMapping, writeSplicedCopy, hashFile, hashRanges, readRange } from './io.js';
import { planCopy, detect } from './plan.js';
import { encodeMarker, findMarkers, guidFromLabel, makeGuid, markerPayload } from './marker.js';
import { ffmpegAvailable, ffmpegFrameHashes, ffmpegStreamHash } from './verify.js';

export const TOOL_VERSION = '1.0.0';

const DEFAULTS = {
  count: 5,
  mode: 'both',
  padBytes: 192,
  namePattern: '{name}_{i:03}{ext}',
  verify: 'media',
  ffmpegPath: 'ffmpeg',
  overwrite: true,
  maxCount: 500,
};

async function exists(path) {
  try { await access(path, FS.F_OK); return true; } catch { return false; }
}

/** 文件名模板：{name} {i} {i:03} {guid} {label} {ext} */
export function formatName(pattern, ctx) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error(`文件名模板必须是非空字符串，收到：${JSON.stringify(pattern)}`);
  }
  const out = pattern.replace(/\{(\w+)(?::(\d+))?\}/g, (all, key, pad) => {
    if (key === 'i') return pad ? String(ctx.i).padStart(Number(pad), '0') : String(ctx.i);
    if (key === 'name') return ctx.name;
    if (key === 'guid') return ctx.guid;
    if (key === 'label') return ctx.label ?? '';
    if (key === 'ext') return ctx.ext;
    if (key === 'seconds') return ctx.seconds ?? '';
    return all;
  });
  // 兜底：模板本身合法但字段缺失时（如 name/guid 为 undefined），渲染结果会混进字面量
  // "undefined"，N 份同名互相覆盖。宁可显式报错，也不要产出这种静默坏文件。
  if (out.includes('undefined')) {
    throw new Error(`文件名模板渲染出字面量 "undefined"：pattern=${JSON.stringify(pattern)} ctx=${JSON.stringify(ctx)}`);
  }
  return out;
}

/**
 * 由「基础填充量 + marker 实际长度」算出 padBytes。
 *
 * 关键：必须量化到 >= marker 的固定 64 字节对齐值，不能用 Math.max(base, marker.length)。
 * 后者在 marker 超过 base（真实附注 JSON 会让 marker 涨到 ~213B）时会把 padBytes
 * 钳成 marker.length，两处填充归零，注释与 free 载荷都等于**变长**的 marker，
 * 于是同一支源的副本体积随标签字节数浮动（实测差 6B）。
 * 抽成函数是为了让 cloneVideo 与 previewPlan 共用同一规则，避免干跑与实跑不一致。
 */
export function resolvePadBytes(base, markerLength) {
  const b = Math.max(1, Number(base) || DEFAULTS.padBytes);
  return Math.max(b, Math.ceil(markerLength / 64) * 64);
}

/**
 * 主入口。
 * @param {object} options
 * @param {string} options.input        源视频
 * @param {string} [options.outputDir]  输出目录（默认 <源目录>/<源名>_clones）
 * @param {number} [options.count]      复制份数
 * @param {'pad'|'meta'|'both'} [options.mode] 标记写入策略
 * @param {string[]} [options.guids]    显式指定每份的 GUID
 * @param {string[]} [options.labels]   每份的标签（账号名/设备名），进 ledger
 * @param {boolean} [options.deriveFromLabel] 用标签确定性推导 GUID
 * @param {string} [options.namePattern]
 * @param {'off'|'hash'|'media'|'frames'} [options.verify]
 */
export async function cloneVideo(options = {}) {
  // 先剔除值为 undefined 的键，再套默认值。
  // 必须这么做的原因：调用方常写成 `{ namePattern: values.name }`，CLI 没给 --name 时
  // 该键就是显式 undefined，而 spread 里显式 undefined 会**覆盖**默认值（不是「不覆盖」）。
  // 结果 namePattern 变成 undefined，文件名全被 formatName 渲染成字面量 "undefined"，
  // N 份写向同一个路径互相覆盖，最终只剩最后一份——而哈希互异自证会报 FAIL。
  const provided = {};
  for (const [k, v] of Object.entries(options)) if (v !== undefined) provided[k] = v;
  const opts = { ...DEFAULTS, ...provided };
  if (!opts.input) throw new Error('缺少 input（源视频路径）');
  const input = resolve(opts.input);
  if (!(await exists(input))) throw new Error(`源文件不存在：${input}`);

  const name = basename(input, extname(input));
  const ext = extname(input) || '';
  const outputDir = resolve(opts.outputDir ?? join(dirname(input), `${name}_clones`));
  const count = Math.max(1, Math.min(Number(opts.count) || DEFAULTS.count, Number(opts.maxCount) || DEFAULTS.maxCount));
  const mode = ['pad', 'meta', 'both'].includes(opts.mode) ? opts.mode : DEFAULTS.mode;
  const verifyLevel = ['off', 'hash', 'media', 'frames'].includes(opts.verify) ? opts.verify : DEFAULTS.verify;
  if (opts.guids && opts.guids.length < count) throw new Error(`guids 数量(${opts.guids.length})少于份数(${count})`);

  await mkdir(outputDir, { recursive: true });
  const reader = await openReader(input);
  const notes = [];
  const copies = [];
  const stamp = new Date().toISOString();
  let sourceSize = reader.size;

  const ffmpegOk = verifyLevel === 'media' || verifyLevel === 'frames'
    ? await ffmpegAvailable(opts.ffmpegPath)
    : false;
  if ((verifyLevel === 'media' || verifyLevel === 'frames') && !ffmpegOk) {
    notes.push(`找不到可用的 ffmpeg（${opts.ffmpegPath}），媒体层校验自动降级为哈希校验`);
  }

  // GUI 面板用的进度回调：纯可选，默认关闭，CLI 与工具路径完全不受影响。
  // 它是唯一的「中断点」——面板取消任务时从回调里抛出，cloneVideo 随即 reject。
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  let container;
  try {
    container = await detect(reader);
    for (let i = 0; i < count; i += 1) {
      const label = opts.labels?.[i] ?? null;
      const guid = opts.guids?.[i]
        ?? (label && opts.deriveFromLabel ? guidFromLabel(String(label), opts.labelSalt ?? 'dsh-video-clone') : makeGuid());
      const extra = {
        tool: 'dsh-video-clone',
        v: 1,
        guid,
        i,
        n: count,
        ...(label ? { label: String(label) } : {}),
        ts: stamp,
        src: basename(input),
      };
      const marker = markerPayload(guid, extra, 0);
      const padBytes = resolvePadBytes(opts.padBytes, marker.length);
      const plan = await planCopy(reader, {
        marker,
        mode,
        padBytes,
        strictSize: Boolean(opts.strictSize),
        extra,
      });
      const outPath = join(outputDir, formatName(opts.namePattern, { i, name, guid, label, ext }));
      if (resolve(outPath) === input) throw new Error('输出路径与源文件同名，请换 namePattern 或 outputDir');
      if (!opts.overwrite && (await exists(outPath))) throw new Error(`目标文件已存在：${outPath}`);
      await writeSplicedCopy(input, outPath, reader.size, plan.splices);
      progress?.({ phase: 'copy', index: i + 1, total: count, file: basename(outPath) });
      copies.push({
        index: i,
        path: outPath,
        guid,
        label,
        marker: encodeMarker(guid),
        container: plan.container,
        strategy: plan.strategy,
        visible: plan.visible,
        degraded: plan.degraded,
        sizeDelta: plan.sizeDelta,
        planNotes: plan.notes,
        plan,
      });
      if (opts.onProgress) opts.onProgress({ index: i, count, path: outPath });
    }
    sourceSize = reader.size;
  } finally {
    await reader.close();
  }

  const containerName = container;

  /* ── 1) 字节布局自证：未改动区间逐一比对 + 写入内容回读 ────────────── */
  const layout = [];
  for (const copy of copies) {
    const { untouched, placed } = computeMapping(sourceSize, copy.plan.splices);
    const srcRanges = untouched.map(([s, e]) => [s, e]);
    const dstRanges = untouched.map(([s, e, d]) => [d, d + (e - s)]);
    const srcHash = srcRanges.length ? await hashRanges(input, srcRanges) : null;
    const dstHash = dstRanges.length ? await hashRanges(copy.path, dstRanges) : null;
    let readbackOk = true;
    for (const item of placed) {
      const chunk = await readRange(copy.path, item.dstStart, item.data.length);
      if (!chunk.equals(item.data)) { readbackOk = false; break; }
    }
    const untouchedBytes = srcRanges.reduce((acc, [s, e]) => acc + (e - s), 0);
    const patchedBytes = placed.reduce((acc, item) => acc + item.data.length, 0);
    layout.push({
      index: copy.index,
      path: copy.path,
      untouchedRanges: untouched.length,
      untouchedBytes,
      patchedBytes,
      mediaUntouched: srcHash === dstHash,
      markerReadback: readbackOk,
      ok: srcHash === dstHash && readbackOk,
    });
  }

  /* ── 2) 文件哈希互异 ─────────────────────────────────────────────── */
  const sourceHash = await hashFile(input);
  for (const copy of copies) copy.hash = await hashFile(copy.path);
  const seen = new Map();
  const collisions = [];
  for (const copy of copies) {
    for (const algo of ['sha256', 'md5']) {
      const key = `${algo}:${copy.hash[algo]}`;
      if (seen.has(key)) collisions.push({ algo, a: seen.get(key), b: copy.path });
      else seen.set(key, copy.path);
    }
  }
  const sourceOverlap = copies.filter((c) => c.hash.sha256 === sourceHash.sha256).map((c) => c.path);

  /* ── 3) 媒体层自证：编码流 / 解码帧 ──────────────────────────────── */
  let media = { level: 'off', ok: null };
  if (ffmpegOk && verifyLevel !== 'off' && verifyLevel !== 'hash') {
    try {
      const sourceStream = await ffmpegStreamHash(input, opts.ffmpegPath);
      const streamMismatch = [];
      let streamDone = 0;
      for (const copy of copies) {
        copy.streamHash = await ffmpegStreamHash(copy.path, opts.ffmpegPath);
        copy.streamIdentical = copy.streamHash === sourceStream;
        if (!copy.streamIdentical) streamMismatch.push(copy.path);
        streamDone += 1;
        progress?.({ phase: 'stream', index: streamDone, total: copies.length, file: basename(copy.path) });
      }
      media = { level: 'media', ok: streamMismatch.length === 0, mismatches: streamMismatch };
      if (verifyLevel === 'frames') {
        const sourceFrames = await ffmpegFrameHashes(input, opts.ffmpegPath);
        const frameMismatch = [];
        let framesDone = 0;
        for (const copy of copies) {
          const frames = await ffmpegFrameHashes(copy.path, opts.ffmpegPath);
          copy.framesIdentical = frames === sourceFrames;
          if (!copy.framesIdentical) frameMismatch.push(copy.path);
          framesDone += 1;
          progress?.({ phase: 'frames', index: framesDone, total: copies.length, file: basename(copy.path) });
        }
        media = { level: 'frames', ok: streamMismatch.length === 0 && frameMismatch.length === 0, mismatches: [...new Set([...streamMismatch, ...frameMismatch])] };
      }
    } catch (error) {
      // 校验器本身失败 ≠ 校验通过。副本已经写出去了，账本也还有用，
      // 所以不把整次克隆炸掉；但 media.ok 必须落成 false，绝不留一个
      // 「没验过却显示 OK」的状态。
      media = {
        level: verifyLevel === 'frames' ? 'frames' : 'media',
        ok: false,
        error: String(error?.message ?? error),
        mismatches: [],
      };
      notes.push(`媒体层校验未能完成：${media.error}`);
    }
  }

  /* ── 4) ledger ──────────────────────────────────────────────────── */
  const ledgerDir = outputDir;
  const ledger = {
    tool: 'dsh-video-clone',
    version: TOOL_VERSION,
    createdAt: stamp,
    source: {
      path: input,
      size: sourceHash.size,
      sha256: sourceHash.sha256,
      md5: sourceHash.md5,
      container: containerName,
    },
    options: { count, mode, verify: verifyLevel, padBytes: opts.padBytes, namePattern: opts.namePattern },
    copies: copies.map((c) => ({
      index: c.index,
      file: basename(c.path),
      path: c.path,
      guid: c.guid,
      marker: c.marker,
      label: c.label,
      container: c.container,
      strategy: c.strategy,
      visibleInMetadata: c.visible,
      degraded: c.degraded,
      size: c.hash.size,
      sizeDelta: c.sizeDelta,
      sha256: c.hash.sha256,
      md5: c.hash.md5,
      mediaUntouched: layout.find((l) => l.index === c.index)?.mediaUntouched ?? null,
      streamIdentical: c.streamIdentical ?? null,
      framesIdentical: c.framesIdentical ?? null,
      notes: c.planNotes,
      // 暴露实际使用的 splice 计划（含 padBytes）。调用方要独立复核「未触碰区间逐字节
      // 相同」时，必须用**真实**计划，不能用 previewPlan 重新推导——preview 的 marker
      // 更短（附注里没有 label/src），64 字节量化后的 padBytes 与真实值不同，
      // 据此算出的偏移全错，会把正确的输出误判为不一致。
      splices: c.plan.splices.map((s) => ({ start: s.start, end: s.end, bytes: s.data.length, note: s.note })),
      padBytes: c.plan.padBytes ?? null,
    })),
    verification: {
      ffmpegAvailable: ffmpegOk,
      layoutOk: layout.every((l) => l.ok),
      hashesAllDistinct: collisions.length === 0 && sourceOverlap.length === 0,
      media,
      notes,
    },
  };
  await writeFile(join(ledgerDir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await writeFile(join(ledgerDir, 'ledger.jsonl'), `${ledger.copies.map((c) => JSON.stringify(c)).join('\n')}\n`, 'utf8');
  await writeFile(join(ledgerDir, 'ledger.csv'), toCsv(ledger.copies), 'utf8');

  const ok = layout.every((l) => l.ok)
    && collisions.length === 0
    && sourceOverlap.length === 0
    && (media.ok === null || media.ok === true);

  return {
    ok,
    source: ledger.source,
    outputDir,
    ledgerPath: join(ledgerDir, 'ledger.json'),
    container: containerName,
    mode,
    verifyLevel,
    copies: ledger.copies.map((c, i) => ({ ...c, strategy: copies[i].strategy, degraded: copies[i].degraded, notes: copies[i].planNotes })),
    verification: {
      ...ledger.verification,
      collisions,
      sourceOverlap,
      layout,
    },
  };
}

function toCsv(rows) {
  const columns = ['index', 'file', 'guid', 'label', 'container', 'strategy', 'size', 'sha256', 'md5', 'streamIdentical', 'framesIdentical'];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => esc(row[c])).join(','));
  return `${lines.join('\n')}\n`;
}

/* ── 溯源扫描 ───────────────────────────────────────────────────────── */

/**
 * 在文件里找标记。默认只扫头尾（标记要么在 moov/udta 里，要么在文件尾），
 * `full: true` 时整文件流式扫描。
 */
export async function scanMarkers(paths, { full = false, headBytes = 4 << 20, tailBytes = 4 << 20 } = {}) {
  const results = [];
  for (const p of paths) {
    const path = resolve(p);
    const reader = await openReader(path);
    try {
      const chunks = [];
      if (full || reader.size <= headBytes + tailBytes) {
        chunks.push({ offset: 0, buf: await reader.read(0, reader.size) });
      } else {
        chunks.push({ offset: 0, buf: await reader.read(0, headBytes) });
        chunks.push({ offset: reader.size - tailBytes, buf: await reader.read(reader.size - tailBytes, tailBytes) });
      }
      const found = [];
      for (const { offset, buf } of chunks) {
        for (const hit of findMarkers(buf, offset)) {
          if (!found.some((f) => f.offset === hit.offset)) found.push(hit);
        }
      }
      results.push({ path, size: reader.size, markers: found });
    } finally {
      await reader.close();
    }
  }
  return results;
}

/** 干跑：只输出规划，不写文件（用于确认策略与体积差）。 */
export async function previewPlan(input, { guid = makeGuid(), mode = 'both', padBytes = 192 } = {}) {
  const path = resolve(input);
  const reader = await openReader(path);
  try {
    const container = await detect(reader);
    const marker = markerPayload(guid, { tool: 'dsh-video-clone', v: 1, guid, preview: true }, 0);
    // 必须与 cloneVideo 用同一个 padBytes 规则，否则干跑出来的区间/体积差与实跑不符，
    // 依赖干跑结果做的布局自证会误判（曾导致 "未触碰区间逐字节相同" 失败）。
    const plan = await planCopy(reader, { marker, mode, padBytes: resolvePadBytes(padBytes, marker.length) });
    return {
      container,
      size: reader.size,
      strategy: plan.strategy,
      visible: plan.visible,
      degraded: plan.degraded,
      sizeDelta: plan.sizeDelta,
      notes: plan.notes,
      splices: plan.splices.map((s) => ({ start: s.start, end: s.end, bytes: s.data.length, note: s.note })),
    };
  } finally {
    await reader.close();
  }
}
