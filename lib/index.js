/**
 * dsh-video-clone 库入口。
 */

export {
  cloneVideo,
  scanMarkers,
  previewPlan,
  formatName,
  resolvePadBytes,
  TOOL_VERSION,
} from './clone.js';

export { openReader, computeMapping, writeSplicedCopy, hashFile, hashRanges, readRange } from './io.js';
export { planCopy, detect, containerHintByExtension } from './plan.js';
export { planMp4, describeBoxes, parseBoxes, looksLikeIsoBmff } from './mp4.js';
export { planMkv, looksLikeMkv } from './mkv.js';
export { planRiff, looksLikeRiff } from './riff.js';
export { planTs, looksLikeTs, detectTsPacketSize } from './mpegts.js';
export { planFlv, looksLikeFlv } from './flv.js';
export { planGeneric } from './generic.js';
export {
  MARKER_PREFIX, crc32hex, makeGuid, guidFromLabel,
  encodeMarker, parseMarker, markerPayload, findMarkers,
} from './marker.js';
export { ffmpegAvailable, ffmpegStreamHash, ffmpegFrameHashes } from './verify.js';
export { box, boxHeader, ebml, readVint, writeVint } from './bytes.js';
