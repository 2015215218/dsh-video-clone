/**
 * 文件 IO 原语：随机读、按 splice 流式改写、哈希。
 *
 * 设计约束：视频文件可能是几个 GB，所以这里一律**不整文件读进内存**。
 *   · 规划阶段只做小范围随机读（box 头、moov、文件头尾），并带缓存；
 *   · 写出阶段用「源区间流式拷贝 + 插入替换数据」的 splice 模型；
 *   · 校验阶段按区间做流式哈希。
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** 打开一个支持随机读的 reader；小读（<8MB）自动缓存，方便 N 份共用同一规划。 */
export async function openReader(path) {
  const info = await stat(path);
  const fd = await open(path, 'r');
  const cache = new Map();
  return {
    path,
    size: info.size,
    async read(offset, length) {
      const len = Math.max(0, Math.min(length, info.size - offset));
      if (len <= 0) return Buffer.alloc(0);
      const key = `${offset}:${len}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fd.read(buf, 0, len, offset);
      const out = buf.subarray(0, bytesRead);
      if (len <= 8 * 1024 * 1024) cache.set(key, out);
      return out;
    },
    async close() { await fd.close(); },
  };
}

/* ── 区间映射 ───────────────────────────────────────────────────────── */

/**
 * splice 模型：`{ start, end, data }` 表示用 `data` 替换源文件 `[start, end)`。
 * `start === end` 即纯插入（在文件尾即"追加"）。splice 之间不允许重叠。
 *
 * 返回：
 *   · `untouched` —— 源文件未改动区间及其在副本中的落点 `[srcStart, srcEnd, dstStart]`
 *   · `placed`    —— 每个 splice 的写入数据及其在副本中的落点
 *   · `sizeDelta` —— 副本相对源文件的体积差
 */
export function computeMapping(sourceSize, splices) {
  const sorted = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  const untouched = [];
  const placed = [];
  let srcCursor = 0;
  let dstCursor = 0;
  for (const sp of sorted) {
    if (sp.start < srcCursor) throw new Error(`overlapping splice at ${sp.start} (cursor ${srcCursor})`);
    if (sp.end < sp.start) throw new Error(`invalid splice range ${sp.start}..${sp.end}`);
    if (sp.start > srcCursor) {
      untouched.push([srcCursor, sp.start, dstCursor]);
      dstCursor += sp.start - srcCursor;
    }
    const length = sp.data ? sp.data.length : (sp.bytes ?? (sp.end - sp.start));
    placed.push({ dstStart: dstCursor, data: sp.data ?? null, bytes: length, srcStart: sp.start, srcEnd: sp.end, note: sp.note ?? null });
    dstCursor += length;
    srcCursor = sp.end;
  }
  if (srcCursor < sourceSize) {
    untouched.push([srcCursor, sourceSize, dstCursor]);
    dstCursor += sourceSize - srcCursor;
  }
  return { untouched, placed, sizeDelta: dstCursor - sourceSize, outputSize: dstCursor };
}

/* ── 写出 ───────────────────────────────────────────────────────────── */

function pipeRange(srcPath, start, end, out) {
  return new Promise((resolve, reject) => {
    if (end <= start) return resolve();
    const rs = createReadStream(srcPath, { start, end: end - 1 });
    rs.on('error', reject);
    rs.on('end', resolve);
    rs.pipe(out, { end: false });
  });
}

function writeChunk(stream, buf) {
  return new Promise((resolve, reject) => {
    stream.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

/** 按 splice 模型流式生成副本。 */
export async function writeSplicedCopy(srcPath, outPath, sourceSize, splices) {
  const { placed } = computeMapping(sourceSize, splices);
  const out = createWriteStream(outPath);
  const srcCursor = 0;
  try {
    let cursor = srcCursor;
    for (const item of placed) {
      const srcStart = item.srcStart;
      if (srcStart > cursor) await pipeRange(srcPath, cursor, srcStart, out);
      if (item.data === null) throw new Error('writeSplicedCopy 需要一个带 data 的 splice（预览规划不能直接写出）');
      await writeChunk(out, item.data);
      cursor = item.srcEnd;
    }
    if (cursor < sourceSize) await pipeRange(srcPath, cursor, sourceSize, out);
  } catch (error) {
    out.destroy();
    throw error;
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return outPath;
}

/* ── 哈希 ───────────────────────────────────────────────────────────── */

/** 一个文件一条流同时算出 sha256 + md5 + 大小。 */
export async function hashFile(path, algorithms = ['sha256', 'md5']) {
  const hashes = Object.fromEntries(algorithms.map((a) => [a, createHash(a)]));
  let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    size += chunk.length;
    for (const h of Object.values(hashes)) h.update(chunk);
  }
  return {
    size,
    ...Object.fromEntries(Object.entries(hashes).map(([k, h]) => [k, h.digest('hex')])),
  };
}

/** 对若干区间依次流式哈希，返回单个摘要（用于"这些字节没被动过"的证明）。 */
export async function hashRanges(path, ranges, algorithm = 'sha256') {
  const h = createHash(algorithm);
  for (const [start, end] of ranges) {
    if (end <= start) continue;
    for await (const chunk of createReadStream(path, { start, end: end - 1, highWaterMark: 4 * 1024 * 1024 })) {
      h.update(chunk);
    }
  }
  return h.digest('hex');
}

/** 读文件的一段（小范围）。 */
export async function readRange(path, start, length) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
