/**
 * RIFF（AVI / WAVE）规划器。
 *
 * AVI 里放 padding 的标准做法就是 `JUNK` chunk：解析器按 4CC 跳过，不影响任何帧。
 * 追加 chunk 之后要把文件头第 4 字节处的 RIFF size（little-endian，等于文件长度-8）
 * 一起加上去 —— 这是原地 4 字节改写。
 */

import { u32le } from './bytes.js';

const FOURCC_JUNK = Buffer.from('JUNK', 'latin1');

export function looksLikeRiff(head) {
  if (head.length < 12) return false;
  if (head.toString('latin1', 0, 4) !== 'RIFF') return false;
  const form = head.toString('latin1', 8, 12);
  return form === 'AVI ' || form === 'WAVE';
}

export async function planRiff(reader, opts) {
  const { marker, padBytes = 128, strictSize = false } = opts;
  const size = reader.size;
  const head = await reader.read(0, 12);
  const riffSize = head.readUInt32LE(4);
  const notes = [];

  if (strictSize) throw new Error('strictSize: RIFF 只能追加 chunk，会改变体积');

  const payload = Buffer.concat([marker, Buffer.alloc(Math.max(0, padBytes - marker.length), 0)]);
  const pad = payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  const chunk = Buffer.concat([FOURCC_JUNK, u32le(payload.length), payload, pad]);

  if (8 + riffSize !== size) {
    notes.push(`RIFF size 字段(${8 + riffSize})与文件长度(${size})不一致，仍按字段值递增`);
  }

  const splices = [
    { start: 4, end: 8, data: u32le(riffSize + chunk.length), note: 'riff-size' },
    { start: size, end: size, data: chunk, note: 'junk-append' },
  ];

  return {
    container: 'riff',
    strategy: 'junk-append',
    visible: false,
    splices,
    notes,
    degraded: false,
    sizeDelta: chunk.length,
    mediaImpact: 'none',
  };
}
