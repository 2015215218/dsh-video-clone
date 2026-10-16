/**
 * 容器探测与规划调度。
 */

import { looksLikeIsoBmff, planMp4 } from './mp4.js';
import { looksLikeMkv, planMkv } from './mkv.js';
import { looksLikeRiff, planRiff } from './riff.js';
import { looksLikeTs, planTs } from './mpegts.js';
import { looksLikeFlv, planFlv } from './flv.js';
import { planGeneric } from './generic.js';

/** 扩展名只用来给报告填个字段，真正判断一律看魔数。 */
export function containerHintByExtension(path) {
  const ext = String(path).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (['mp4', 'm4v', 'mov', 'm4a', '3gp', '3g2', 'heic'].includes(ext)) return 'mp4';
  if (['mkv', 'webm', 'mka'].includes(ext)) return 'mkv';
  if (['avi', 'wav'].includes(ext)) return 'riff';
  if (['ts', 'm2ts', 'mts', 'tp'].includes(ext)) return 'ts';
  if (['flv', 'f4v'].includes(ext)) return 'flv';
  return 'unknown';
}

async function detect(reader) {
  const head = await reader.read(0, 204 * 3 + 8);
  if (looksLikeIsoBmff(head)) return 'mp4';
  if (looksLikeMkv(head)) return 'mkv';
  if (looksLikeRiff(head)) return 'riff';
  if (looksLikeTs(head)) return 'ts';
  if (looksLikeFlv(head)) return 'flv';
  return 'unknown';
}

/**
 * 为一个视频生成"写入标记"的规划。
 * @param {object} reader openReader() 的返回值
 * @param {object} opts { marker:Buffer, mode, padBytes, strictSize, extra }
 */
export async function planCopy(reader, opts) {
  const container = await detect(reader);
  const base = { ...opts, container, extra: opts.extra ?? null };
  switch (container) {
    case 'mp4': return planMp4(reader, base);
    case 'mkv': return { ...(await planMkv(reader, base)) };
    case 'riff': return planRiff(reader, base);
    case 'ts': return planTs(reader, base);
    case 'flv': return planFlv(reader, base);
    default: return planGeneric(reader, base);
  }
}

export { detect };
