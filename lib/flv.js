/**
 * FLV 规划器。
 *
 * 在文件尾追加一个 **script data tag**：类型 18、时间戳 0、流号 0，body 是一段 AMF0。
 * 名字用 `onXCLN`（而不是 onMetaData），这样播放器把它当成不认识的脚本标签忽略掉，
 * 既不会覆盖真正的 onMetaData，也不会影响任何音视频 tag。
 */

import { u24be, u32be } from './bytes.js';

export function looksLikeFlv(head) {
  return head.length >= 9 && head.toString('latin1', 0, 3) === 'FLV';
}

function amfString(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([0x02]), Buffer.from([(bytes.length >> 8) & 0xff, bytes.length & 0xff]), bytes]);
}

export async function planFlv(reader, opts) {
  const { marker, strictSize = false } = opts;
  const size = reader.size;
  if (strictSize) throw new Error('strictSize: FLV 只能追加 tag，会改变体积');

  const body = Buffer.concat([amfString('onXCLN'), amfString(marker.toString('utf8').split('\n')[0])]);
  const header = Buffer.concat([
    Buffer.from([18]),        // tag type: script data
    u24be(body.length),       // data size
    u24be(0),                 // timestamp
    Buffer.from([0]),         // timestamp extended
    u24be(0),                 // stream id
  ]);
  const tag = Buffer.concat([header, body]);
  const prevTagSize = u32be(tag.length);
  const appended = Buffer.concat([tag, prevTagSize]);

  return {
    container: 'flv',
    strategy: 'script-tag-append',
    visible: false,
    splices: [{ start: size, end: size, data: appended, note: 'script-tag' }],
    notes: ['追加 onXCLN script tag（播放器会忽略未知脚本标签）'],
    degraded: false,
    sizeDelta: appended.length,
    mediaImpact: 'none',
  };
}
