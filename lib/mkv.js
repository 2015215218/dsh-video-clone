/**
 * MKV / WebM（EBML）规划器。
 *
 * 只往 Segment 里追加两类元素：
 *   · `Void`(0xEC) —— 规范定义的"填充"，内容任意、解析器必跳过，用来放隐形标记；
 *   · `Tags` —— 元数据，里面塞 COMMENT=<标记>，mkvinfo / MediaInfo 能看到。
 * 追加会让 Segment 变长，所以还要把 Segment 的 size 字段按原宽度原地改写
 * （宽度不够或 Segment 不是最后一个元素时降级为纯尾部追加）。
 */

import { EBML, ebml, readVint, writeVint, vintMax } from './bytes.js';

export function looksLikeMkv(head) {
  return head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
}

export async function planMkv(reader, opts) {
  const { marker, mode = 'both', padBytes = 128, strictSize = false } = opts;
  const size = reader.size;
  const head = await reader.read(0, 64);
  const header = readVint(head, 4);
  if (!header) throw new Error('MKV: EBML 头解析失败');
  const segStart = 4 + header.width + header.value;
  const segHead = await reader.read(segStart, 24);
  if (segHead.length < 8 || segHead.readUInt32BE(0) !== 0x18538067) {
    throw new Error(`MKV: 在偏移 ${segStart} 处找不到 Segment 元素`);
  }
  const sizeFieldOffset = segStart + 4;
  const segSize = readVint(segHead, 4);
  if (!segSize) throw new Error('MKV: Segment size 解析失败');

  const notes = [];
  const splices = [];
  const strategies = [];
  let visible = false;

  const invisible = Buffer.concat([marker, Buffer.alloc(Math.max(0, padBytes - marker.length), 0)]);
  const elements = [];
  if (mode === 'pad' || mode === 'both') {
    elements.push(ebml(EBML.void, invisible));
    strategies.push('void');
  }
  if (mode === 'meta' || mode === 'both') {
    const simpleTag = ebml(EBML.simpleTag, Buffer.concat([
      ebml(EBML.tagName, Buffer.from('COMMENT', 'utf8')),
      ebml(EBML.tagString, marker),
    ]));
    const tag = ebml(EBML.tag, Buffer.concat([ebml(EBML.targets, Buffer.alloc(0)), simpleTag]));
    elements.push(ebml(EBML.tags, tag));
    strategies.push('tags');
    visible = true;
  }

  if (elements.length === 0) {
    return { container: 'mkv', strategy: 'none', visible: false, splices: [], notes: ['未选择任何写入策略'], degraded: true, sizeDelta: 0, mediaImpact: 'none' };
  }

  const appended = Buffer.concat(elements);
  if (strictSize) {
    throw new Error('strictSize: MKV 只能追加元素，必然改变体积（EBML 没有可复用的固定填充位）');
  }

  if (segSize.unknown) {
    // 未知长度 = 到文件尾，直接追加即可，无需改 size 字段
    splices.push({ start: size, end: size, data: appended, note: 'segment-append' });
  } else {
    const segEnd = sizeFieldOffset + segSize.width + segSize.value;
    const newSegSize = segSize.value + appended.length;
    if (segEnd !== size) {
      notes.push(`Segment 结束于 ${segEnd}，文件尾还有 ${size - segEnd} 字节额外数据，降级为纯尾部追加`);
      splices.push({ start: size, end: size, data: appended, note: 'tail-append' });
      strategies.push('degraded-tail');
    } else if (newSegSize > vintMax(segSize.width)) {
      notes.push(`Segment size 字段宽度 ${segSize.width} 字节不够用，降级为纯尾部追加`);
      splices.push({ start: size, end: size, data: appended, note: 'tail-append' });
      strategies.push('degraded-tail');
    } else {
      splices.push({
        start: sizeFieldOffset,
        end: sizeFieldOffset + segSize.width,
        data: writeVint(newSegSize, segSize.width),
        note: 'segment-size',
      });
      splices.push({ start: size, end: size, data: appended, note: 'segment-append' });
    }
  }

  const delta = splices.reduce((acc, s) => acc + (s.data.length - (s.end - s.start)), 0);
  return {
    container: 'mkv',
    strategy: strategies.join('+'),
    visible,
    splices,
    notes,
    degraded: strategies.includes('degraded-tail'),
    sizeDelta: delta,
    mediaImpact: 'none',
  };
}
