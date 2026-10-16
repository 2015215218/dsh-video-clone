/**
 * 媒体层校验：调用 ffmpeg 算「编码流哈希」与「解码帧哈希」。
 *
 * 这两个是给"画面一个字节都没变"作证的关键证据：
 *   · streamhash  —— 直接对解复用出来的音视频基本流做哈希（不解码），
 *                    它变了就说明码流被动过；
 *   · framemd5    —— 逐帧解码后对像素做哈希，是最终观众看到的东西。
 *
 * 注意：这两个命令都不需要我们写临时文件，直接吃 stdin/stdout。
 */

import { spawn } from 'node:child_process';

function run(command, args, { timeoutMs = 900_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} 超时（${timeoutMs} ms）`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} 退出码 ${code}：${stderr.split('\n').filter(Boolean).slice(-4).join(' | ')}`));
    });
  });
}

export async function ffmpegAvailable(command = 'ffmpeg') {
  try {
    await run(command, ['-hide_banner', '-version'], { timeoutMs: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** 每个流一个 SHA256：`0,v,SHA256=...` / `1,a,SHA256=...`（顺序归一化后返回）。 */
export async function ffmpegStreamHash(file, command = 'ffmpeg') {
  const { stdout } = await run(command, [
    '-v', 'error', '-i', file, '-map', '0', '-c', 'copy', '-f', 'streamhash', '-',
  ]);
  const normalized = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort()
    .join('\n');
  // 空输出绝不能当成一个「哈希值」拿去比较：两个空串相等，会让
  // 「媒体层一个字节没变」在验证器压根没工作时**静默通过**。
  // 实测过——一个退出码 0 但零输出的假 ffmpeg 能让 streamIdentical 全 true、
  // media.ok 为 true、整体 ok 也为 true，而每份的 streamHash 长度都是 0。
  // 拿不到证据就是拿不到证据，必须响亮地失败，不能默认通过。
  if (normalized === '') {
    throw new Error(`${command} 没有输出任何编码流哈希（媒体层无法作证，不能当作通过）`);
  }
  return normalized;
}

/** 逐帧像素 md5（去掉 ffmpeg 自己写的前几行注释）。 */
export async function ffmpegFrameHashes(file, command = 'ffmpeg') {
  const { stdout } = await run(command, [
    '-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-',
  ]);
  const lines = stdout.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
  // 同上：零帧哈希同样是「没有证据」，不是「帧完全一致」。
  if (lines.length === 0) {
    throw new Error(`${command} 没有输出任何解码帧哈希（媒体层无法作证，不能当作通过）`);
  }
  return lines.join('\n');
}

/** 媒体层摘要：流哈希 + 容器探测信息（ffprobe 可选）。 */
export async function mediaSummary(file, command = 'ffmpeg') {
  return {
    streamHash: await ffmpegStreamHash(file, command),
  };
}
