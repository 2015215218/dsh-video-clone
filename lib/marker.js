/**
 * 标记（marker）编解码。
 *
 * 标记是一条自校验的 ASCII 串，永远排在载荷最前面，方便任何工具（grep / hexdump /
 * 本工具的 scan 子命令）直接搜到：
 *
 *     XCLN1-<32位十六进制GUID>-<8位CRC32>
 *
 * 后面允许跟一行 JSON 附注（标签、序号、时间、源文件名），scan 会一并解出来。
 */

import { createHash, randomUUID, randomBytes } from 'node:crypto';

export const MARKER_PREFIX = 'XCLN1';
const MARKER_RE = /XCLN1-([0-9a-f]{32})(?:-([0-9a-f]{8}))?/gi;

/* ── CRC32（多项式 0xEDB88320，与 zip/gzip 一致） ───────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32hex(text) {
  const bytes = Buffer.from(text, 'latin1');
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0');
}

/* ── GUID ───────────────────────────────────────────────────────────── */

/** 随机 GUID（UUIDv4 去连字符，32 位十六进制）。 */
export function makeGuid() {
  return randomUUID().replace(/-/g, '');
}

/**
 * 由标签确定性推导 GUID：同一个 label + 同一个 salt 永远得到同一个 GUID。
 * 好处是哪怕 ledger 丢了，也能从 label 重算出来比对。
 */
export function guidFromLabel(label, salt = 'dsh-video-clone') {
  return createHash('sha256').update(`${salt}\u0000${label}`).digest('hex').slice(0, 32);
}

/* ── 标记串 ─────────────────────────────────────────────────────────── */

export function encodeMarker(guid) {
  const g = String(guid).toLowerCase();
  return `${MARKER_PREFIX}-${g}-${crc32hex(g)}`;
}

/** 解析标记串；crc 缺省或校验失败时 valid=false（仍返回内容，便于人工判断）。 */
export function parseMarker(text) {
  MARKER_RE.lastIndex = 0;
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  const guid = m[1].toLowerCase();
  const crc = m[2] ? m[2].toLowerCase() : null;
  return { marker: m[0], guid, crc, valid: crc === null || crc === crc32hex(guid) };
}

/**
 * 生成写进容器的载荷：标记串 + 可选 JSON 附注 + 定长填充。
 * @param {string} guid
 * @param {object} [extra] 附注字段
 * @param {number} [totalBytes] 目标长度（不足则用 0x00 补齐）
 */
export function markerPayload(guid, extra = null, totalBytes = 0) {
  const parts = [Buffer.from(encodeMarker(guid), 'ascii')];
  if (extra && Object.keys(extra).length > 0) {
    parts.push(Buffer.from(`\n${JSON.stringify(extra)}`, 'utf8'));
  }
  let buf = Buffer.concat(parts);
  if (totalBytes && buf.length < totalBytes) {
    buf = Buffer.concat([buf, Buffer.alloc(totalBytes - buf.length, 0)]);
  }
  return buf;
}

/** 在一段内存里搜出所有标记。 */
export function findMarkers(buf, baseOffset = 0) {
  const haystack = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
  const found = [];
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(haystack)) !== null) {
    const guid = m[1].toLowerCase();
    const crc = m[2] ? m[2].toLowerCase() : null;
    found.push({
      offset: baseOffset + m.index,
      marker: m[0],
      guid,
      crc,
      valid: crc === null || crc === crc32hex(guid),
    });
  }
  return found;
}

/** 取一段随机填充字节（用于把容器里的填充区写得更自然）。 */
export function randomFiller(length) {
  return randomBytes(length);
}
