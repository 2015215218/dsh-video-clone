/**
 * 字节与容器编码小工具 —— 零依赖。
 *
 * 这里只放两种东西：
 *   1) 定长整数/字符串的 Buffer 编码；
 *   2) ISO BMFF（MP4/MOV）box 与 EBML（MKV/WebM）element 的构造与解析原语。
 */

/* ── 定长整数 ───────────────────────────────────────────────────────── */

export const b4 = (type) => {
  if (Buffer.isBuffer(type)) return type;
  const buf = Buffer.from(type, 'latin1');
  if (buf.length !== 4) throw new Error(`4CC must be 4 bytes, got ${buf.length}: ${JSON.stringify(type)}`);
  return buf;
};

export function u16be(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n >>> 0); return b; }
export function u24be(n) { const b = Buffer.alloc(3); b.writeUIntBE(n >>> 0, 0, 3); return b; }
export function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
export function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
export function u64be(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }

export const hex = (n, width = 0) => n.toString(16).padStart(width, '0');

/* ── ISO BMFF ───────────────────────────────────────────────────────── */

/**
 * 组装一个 ISO BMFF box：`[size:4]['type':4][payload]`。
 * payload 超过 4GB 时自动改用 64 位 largesize（size==1）。
 */
export function box(type, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.concat(payload);
  return Buffer.concat([boxHeader(type, body.length), body]);
}

/**
 * 只造 box 头、不碰载荷。
 *
 * 拆出来是为了让「超 4GB 要不要改用 largesize」这个判断能被**廉价地**验证：
 * 以前测试直接 `box('free', Buffer.alloc(0xffffffff))`，为了验一个 16 字节的头
 * 真的去分配 4GB（concat 时峰值 8GB），在 Node 18/20 上还会因为
 * Buffer.MAX_LENGTH=4GiB 直接崩掉整套测试。判断和物化本来就不必绑在一起。
 *
 * @returns {Buffer} 8 字节（32 位 size），或 16 字节（size==1 + 64 位 largesize）
 */
export function boxHeader(type, bodyLength) {
  if (bodyLength + 8 <= 0xffffffff) return Buffer.concat([u32be(bodyLength + 8), b4(type)]);
  return Buffer.concat([u32be(1), b4(type), u64be(bodyLength + 16)]);
}

/** 覆盖已存在 box 的 size 字段（尊重 32/64 位 header 宽度）。 */
export function writeBoxSize(buf, boxStart, headerSize, size) {
  if (headerSize === 16) buf.writeBigUInt64BE(BigInt(size), boxStart + 8);
  else buf.writeUInt32BE(size >>> 0, boxStart);
}

/* ── EBML（MKV / WebM） ─────────────────────────────────────────────── */

/**
 * 读一个 EBML VINT（元素 ID 用不到，这里读的是 size 字段）。
 * @returns {{width:number, value:number, unknown:boolean}|null} unknown=true 表示"未知长度"（全 1）。
 */
export function readVint(buf, off) {
  const first = buf[off];
  if (first === undefined) return null;
  let width = 1;
  let marker = 0x80;
  while (width <= 8 && (first & marker) === 0) { marker >>= 1; width += 1; }
  if (width > 8 || off + width > buf.length) return null;
  let value = BigInt(first & (marker - 1));
  let unknown = (first & (marker - 1)) === marker - 1;
  for (let i = 1; i < width; i += 1) {
    const byte = buf[off + i];
    value = (value << 8n) | BigInt(byte);
    if (byte !== 0xff) unknown = false;
  }
  return { width, value: Number(value), unknown };
}

/** 用固定宽度写一个 EBML VINT（宽度不变即可原地改写 size 字段）。 */
export function writeVint(value, width) {
  const buf = Buffer.alloc(width);
  let rest = BigInt(value);
  for (let i = width - 1; i >= 1; i -= 1) { buf[i] = Number(rest & 0xffn); rest >>= 8n; }
  buf[0] = Number(rest) | (1 << (8 - width));
  return buf;
}

/** 该宽度能表达的最大 size 值（全 1 表示"未知长度"，故要减一）。 */
export function vintMax(width) {
  return 2 ** (7 * width) - 2;
}

/** 组装 EBML element：`[ID bytes][size VINT][payload]`。 */
export function ebml(idBytes, payload = Buffer.alloc(0), sizeWidth = 0) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.concat(payload);
  let width = sizeWidth;
  if (!width) {
    width = 1;
    while (width < 8 && body.length > vintMax(width)) width += 1;
  }
  if (body.length > vintMax(width)) throw new Error(`EBML payload too large for ${width}-byte size field: ${body.length}`);
  return Buffer.concat([idBytes, writeVint(body.length, width), body]);
}

export const ebmlId = (...bytes) => Buffer.from(bytes);

export const EBML = {
  header: ebmlId(0x1a, 0x45, 0xdf, 0xa3),
  segment: ebmlId(0x18, 0x53, 0x80, 0x67),
  void: ebmlId(0xec),
  tags: ebmlId(0x12, 0x54, 0xc3, 0x67),
  tag: ebmlId(0x73, 0x73),
  targets: ebmlId(0x63, 0xc0),
  simpleTag: ebmlId(0x67, 0xc8),
  tagName: ebmlId(0x45, 0xa3),
  tagString: ebmlId(0x44, 0x87),
};
