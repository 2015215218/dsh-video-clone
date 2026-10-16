/**
 * 兜底规划器：认不出容器时，只在文件尾追加"标记 + 注释"，原始字节保持前缀不变。
 *
 * 这不是首选（部分严格解析器会抱怨尾部垃圾），但它的性质依然可靠：
 *   · 原文件所有字节逐一保留；
 *   · 媒体流一个字节没动；
 *   · 文件哈希已经不同。
 * 用 --mode pad 之外的模式时会给出降级说明，方便事后知道发生过什么。
 */

export async function planGeneric(reader, opts) {
  const { marker, padBytes = 128, container = 'unknown', strictSize = false } = opts;
  const size = reader.size;
  if (strictSize) throw new Error('strictSize: 未识别的容器无法在保持体积的前提下塞标记');

  const appended = Buffer.concat([marker, Buffer.alloc(Math.max(0, padBytes - marker.length), 0)]);
  return {
    container,
    strategy: 'tail-append-generic',
    visible: false,
    splices: [{ start: size, end: size, data: appended, note: 'tail-append' }],
    notes: ['未识别的容器格式：仅做尾部追加（原始字节仍为副本前缀）'],
    degraded: true,
    sizeDelta: appended.length,
    mediaImpact: 'none',
  };
}
