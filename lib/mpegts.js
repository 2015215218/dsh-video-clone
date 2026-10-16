/**
 * MPEG-TS / M2TS 规划器。
 *
 * 做法：在文件尾追加若干 **null packet**（PID 0x1FFF）。ISO/IEC 13818-1 明确规定
 * null packet 的 payload "可以为任意值"，解复用器必须丢弃它们 —— 所以标记写在这里
 * 既有合法身份，又不会被当成任何 PID 的数据。
 *
 * 包长自动探测：188（TS）/ 192（M2TS，前面 4 字节 TP_extra_header）/ 204（带 RS 校验）。
 */

import { u32be } from './bytes.js';

/**
 * 探测包结构。返回 `{ packetSize, syncOffset }`：
 *   · 188 / syncOffset 0 —— 标准 TS
 *   · 192 / syncOffset 4 —— M2TS（4 字节 TP_extra_header 在 sync 之前）
 *   · 204 / syncOffset 0 —— 带 Reed-Solomon 校验的 TS
 * ffmpeg 写出的 M2TS 就是 192/4，只按 syncOffset 0 找会漏判成 unknown。
 */
export function detectTsPacket(head) {
  for (const [packetSize, syncOffset] of [[188, 0], [192, 4], [204, 0]]) {
    if (head.length < packetSize * 3 + syncOffset + 1) continue;
    const at = (i) => head[syncOffset + packetSize * i];
    if (at(0) === 0x47 && at(1) === 0x47 && at(2) === 0x47) return { packetSize, syncOffset };
  }
  return null;
}

export function detectTsPacketSize(head) {
  return detectTsPacket(head)?.packetSize ?? 0;
}

export function looksLikeTs(head) {
  return detectTsPacket(head) !== null;
}

export async function planTs(reader, opts) {
  const { marker, strictSize = false } = opts;
  const size = reader.size;
  const head = await reader.read(0, 204 * 3 + 8);
  const detected = detectTsPacket(head);
  if (!detected) throw new Error('TS: 无法确定包结构');
  const { packetSize, syncOffset } = detected;
  if (strictSize) throw new Error('strictSize: TS 只能追加 null packet，会改变体积');

  const trailer = packetSize === 204 ? 16 : 0;
  const payloadCapacity = packetSize - syncOffset - 4 - trailer;

  const pieces = [];
  for (let offset = 0; offset < marker.length; offset += payloadCapacity) {
    const chunk = marker.subarray(offset, offset + payloadCapacity);
    const padded = Buffer.concat([chunk, Buffer.alloc(payloadCapacity - chunk.length, 0xff)]);
    const header = Buffer.concat([
      Buffer.alloc(syncOffset, 0),             // M2TS 的 TP_extra_header：抄送位 0 + 到达时间戳 0
      Buffer.from([0x47, 0x1f, 0xff, 0x10]),   // sync + PID 0x1FFF + 无调整字段 + CC=0
    ]);
    pieces.push(Buffer.concat([header, padded, Buffer.alloc(trailer, 0xff)]));
  }
  const appended = Buffer.concat(pieces);

  return {
    container: 'ts',
    strategy: `null-packet(len=${packetSize}${syncOffset ? `,sync@${syncOffset}` : ''})`,
    visible: false,
    splices: [{ start: size, end: size, data: appended, note: 'null-packets' }],
    notes: [`包长 ${packetSize}（sync 偏移 ${syncOffset}），追加 ${pieces.length} 个 null packet（PID 0x1FFF）`],
    degraded: false,
    sizeDelta: appended.length,
    mediaImpact: 'none',
  };
}
