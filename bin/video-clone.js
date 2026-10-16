#!/usr/bin/env node
/**
 * video-clone CLI。
 *
 *   video-clone clone  <源视频> [--count N] [--out DIR] [--mode pad|meta|both]
 *                              [--label a,b,c] [--name PATTERN] [--verify off|hash|media|frames]
 *                              [--strict-size] [--guid g1,g2,...] [--json]
 *   video-clone scan   <文件...> [--full] [--json]
 *   video-clone plan   <源视频> [--mode ...] [--json]
 *   video-clone info   <源视频>
 */

import { parseArgs } from 'node:util';
import { resolve, basename } from 'node:path';

import { cloneVideo, scanMarkers, previewPlan, TOOL_VERSION } from '../lib/clone.js';
import { openReader } from '../lib/io.js';
import { describeBoxes } from '../lib/mp4.js';
import { detect, containerHintByExtension } from '../lib/plan.js';

const USAGE = `video-clone ${TOOL_VERSION} — 视频唯一化分发（容器层标记，媒体零改动）

用法:
  video-clone clone <源视频> [选项]
  video-clone scan  <文件...> [--full]
  video-clone plan  <源视频> [--mode pad|meta|both]
  video-clone info  <源视频>

clone 选项:
  --count, -n <N>        复制份数（默认 5）
  --out, -o <DIR>        输出目录（默认 <源目录>/<源名>_clones）
  --mode, -m <MODE>      pad=只写隐形标记 / meta=只写可见元数据 / both=两者都写（默认）
  --label, -l <a,b,c>    每份的标签（账号名、设备名、渠道），写进标记与账本
  --derive-from-label    用标签确定性推导 GUID（同标签永远同 GUID，便于事后重算比对）
  --name <PATTERN>       文件名模板，占位符 {name} {i} {i:03} {guid} {label} {ext}（默认 "{name}_{i:03}{ext}"）
  --guid <g1,g2,...>     显式指定每份的 GUID
  --pad-bytes <N>        尾部/填充标记的长度（默认 192）
  --verify <LEVEL>       off | hash | media（编码流哈希）| frames（逐帧解码哈希，默认）
  --strict-size          要求副本体积与源文件完全一致（没有可复用填充位时报错退出）
  --no-overwrite         目标已存在则报错而不是覆盖
  --ffmpeg <PATH>        ffmpeg 路径（默认 ffmpeg）
  --json                 输出 JSON
  --quiet, -q            只输出摘要行

scan 选项:
  --full                 整文件扫描（默认只扫头尾 4MB）
  --json                 输出 JSON
`;

function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      count: { type: 'string', short: 'n' },
      out: { type: 'string', short: 'o' },
      mode: { type: 'string', short: 'm' },
      label: { type: 'string', short: 'l' },
      name: { type: 'string' },
      guid: { type: 'string' },
      'pad-bytes': { type: 'string' },
      verify: { type: 'string' },
      'strict-size': { type: 'boolean' },
      'derive-from-label': { type: 'boolean' },
      'no-overwrite': { type: 'boolean' },
      ffmpeg: { type: 'string' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      full: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

const splitList = (value) => (value ? String(value).split(',').map((s) => s.trim()).filter(Boolean) : undefined);

async function cmdClone(positionals, values) {
  const input = positionals[0];
  if (!input) throw new Error('请给出源视频路径');
  const result = await cloneVideo({
    input,
    outputDir: values.out,
    count: values.count ? Number(values.count) : undefined,
    mode: values.mode,
    labels: splitList(values.label),
    deriveFromLabel: values['derive-from-label'],
    guids: splitList(values.guid),
    namePattern: values.name,
    padBytes: values['pad-bytes'] ? Number(values['pad-bytes']) : undefined,
    verify: values.verify,
    strictSize: values['strict-size'],
    overwrite: !values['no-overwrite'],
    ffmpegPath: values.ffmpeg,
    onProgress: values.json || values.quiet ? undefined : ({ index, count, path }) => process.stderr.write(`  [${index + 1}/${count}] ${basename(path)}\n`),
  });
  if (values.json) { console.log(JSON.stringify(result, null, 2)); return result.ok ? 0 : 1; }
  console.log(`源文件   ${result.source.path}`);
  console.log(`         ${result.source.size} 字节  sha256=${result.source.sha256}`);
  console.log(`容器     ${result.container}  策略=${result.copies[0]?.strategy}  校验=${result.verifyLevel}`);
  console.log(`输出     ${result.outputDir}`);
  for (const c of result.copies) {
    console.log(`  #${c.index}  ${c.file}`);
    console.log(`       guid=${c.guid}${c.label ? `  label=${c.label}` : ''}`);
    console.log(`       sha256=${c.sha256}  流不变=${c.streamIdentical ?? 'n/a'}  帧不变=${c.framesIdentical ?? 'n/a'}`);
  }
  const v = result.verification;
  console.log(`校验     布局=${v.layoutOk ? 'OK' : 'FAIL'}  哈希互异=${v.hashesAllDistinct ? 'OK' : 'FAIL'}  媒体层=${v.media.ok === null ? 'skipped' : v.media.ok ? 'OK' : 'FAIL'}(${v.media.level})`);
  if (v.collisions.length || v.sourceOverlap.length) console.log(`冲突     ${JSON.stringify({ collisions: v.collisions, sourceOverlap: v.sourceOverlap })}`);
  console.log(`账本     ${result.ledgerPath}`);
  return result.ok ? 0 : 1;
}

async function cmdScan(positionals, values) {
  if (!positionals.length) throw new Error('请给出至少一个文件');
  const results = await scanMarkers(positionals, { full: values.full });
  if (values.json) { console.log(JSON.stringify(results, null, 2)); return 0; }
  let total = 0;
  for (const r of results) {
    if (!r.markers.length) { console.log(`${r.path}\n  (未找到标记)`); continue; }
    console.log(`${r.path}  ${r.size} 字节`);
    for (const m of r.markers) {
      total += 1;
      console.log(`  @${m.offset}  guid=${m.guid}  crc=${m.valid ? 'OK' : 'MISMATCH'}  ${m.marker}`);
    }
  }
  console.log(`共 ${total} 个标记`);
  return 0;
}

async function cmdPlan(positionals, values) {
  const input = positionals[0];
  if (!input) throw new Error('请给出源视频路径');
  const plan = await previewPlan(input, { mode: values.mode });
  if (values.json) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  console.log(`容器     ${plan.container}  体积=${plan.size}`);
  console.log(`策略     ${plan.strategy}  可见标记=${plan.visible}  体积变化=${plan.sizeDelta}  降级=${plan.degraded}`);
  for (const s of plan.splices) console.log(`  splice  ${s.start}..${s.end}  ${s.bytes}B  ${s.note}`);
  for (const n of plan.notes) console.log(`  note    ${n}`);
  return 0;
}

async function cmdInfo(positionals) {
  const input = positionals[0];
  if (!input) throw new Error('请给出源视频路径');
  const reader = await openReader(resolve(input));
  try {
    const container = await detect(reader);
    console.log(`文件     ${resolve(input)}`);
    console.log(`体积     ${reader.size}`);
    console.log(`容器     ${container}${container === 'unknown' ? `（扩展名推测：${containerHintByExtension(input)}）` : ''}`);
    if (container === 'mp4') {
      for (const b of await describeBoxes(reader)) {
        console.log(`  ${'  '.repeat(b.depth)}${b.type.padEnd(8)} off=${b.start} size=${b.size}`);
      }
    }
  } finally {
    await reader.close();
  }
  return 0;
}

async function main() {
  const { values, positionals } = parse(process.argv.slice(2));
  if (values.help || positionals.length === 0) { console.log(USAGE); return positionals.length === 0 && !values.help ? 2 : 0; }
  const [command, ...rest] = positionals;
  switch (command) {
    case 'clone': return cmdClone(rest, values);
    case 'scan': return cmdScan(rest, values);
    case 'plan': return cmdPlan(rest, values);
    case 'info': return cmdInfo(rest, values);
    default: console.error(`未知命令：${command}\n`); console.log(USAGE); return 2;
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`错误：${error.message}`);
  process.exit(1);
});
