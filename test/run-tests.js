/**
 * 端到端测试：先在临时目录造出各种容器的测试素材，再逐个跑一遍完整流程，
 * 最后断言三条硬承诺。不依赖外部素材，可离线跑。
 *
 *   node test/run-tests.js
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, stat, writeFile, mkdir, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { cloneVideo, scanMarkers, previewPlan, formatName } from '../lib/clone.js';
import { openReader, computeMapping } from '../lib/io.js';
import { ffmpegStreamHash, ffmpegFrameHashes } from '../lib/verify.js';
import { detect } from '../lib/plan.js';
import { encodeMarker, guidFromLabel, crc32hex, parseMarker, markerPayload } from '../lib/marker.js';
import { box, boxHeader, ebml, readVint, writeVint, vintMax, EBML } from '../lib/bytes.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✔ ${label}`); }
  else { failed += 1; failures.push(`${label} ${detail}`); console.log(`  ✘ ${label} ${detail}`); }
}

function section(title) { console.log(`\n== ${title} ==`); }

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/* ── 单元：标记 / 字节原语 ─────────────────────────────────────────── */

function unitTests() {
  section('单元：标记与字节原语');

  const guid = 'a'.repeat(32);
  const marker = encodeMarker(guid);
  check('标记格式', /^XCLN1-[0-9a-f]{32}-[0-9a-f]{8}$/.test(marker), marker);
  const parsed = parseMarker(marker);
  check('标记自解析 + CRC 通过', parsed?.guid === guid && parsed.valid === true);
  const tampered = parseMarker(`XCLN1-${'b'.repeat(32)}-${crc32hex(guid)}`);
  check('CRC 能抓出被改过的 GUID', tampered?.valid === false);

  check('确定性 GUID 可重算', guidFromLabel('acct-a') === guidFromLabel('acct-a') && guidFromLabel('acct-a') !== guidFromLabel('acct-b'));

  const payload = markerPayload(guid, { i: 3 }, 64);
  check('载荷以标记开头', payload.subarray(0, marker.length).toString('latin1') === marker, payload.subarray(0, 48).toString('latin1'));
  check('载荷附注为一行 JSON', payload.subarray(marker.length).toString('utf8').startsWith('\n{"i":3}'));
  check('载荷定长填充', payload.length === 64 && payload.subarray(payload.length - 8).every((b) => b === 0), `len=${payload.length}`);
  const bare = markerPayload(guid, null, 64);
  check('无附注时整段补零', bare.length === 64 && bare.subarray(marker.length).every((b) => b === 0));

  const b = box('free', Buffer.from('hello'));
  check('box 编码', b.readUInt32BE(0) === 13 && b.toString('latin1', 4, 8) === 'free' && b.toString('latin1', 8) === 'hello');

  const mid = box('free', Buffer.alloc(70000));
  check('常规体积 box 用 32 位 size', mid.readUInt32BE(0) === 70008 && mid.length === 70008, String(mid.readUInt32BE(0)));
  // 这里刻意不再构造真实的 4GB box：那曾经为了验一个 16 字节的头分配了 4GB
  // （concat 峰值 8GB），并且在 Node 18/20 上会撞 Buffer.MAX_LENGTH=4GiB 直接崩掉
  // 整套测试。判断该走哪条分支，用 boxHeader 就够；box() 的整体行为由上面
  // 小体积与 70000 字节两条覆盖。
  const hugeHeader = boxHeader('free', 0xffffffff);
  check('超 4GB 时自动改用 64 位 largesize',
    hugeHeader.length === 16 && hugeHeader.readUInt32BE(0) === 1 && hugeHeader.readBigUInt64BE(8) === BigInt(0xffffffff + 16),
    `${hugeHeader.length} 字节 / largesize=${hugeHeader.length === 16 ? hugeHeader.readBigUInt64BE(8) : 'n/a'}`);
  check('边界内（len+8 <= 0xffffffff）仍用 32 位 size', boxHeader('free', 0xfffffff7).length === 8);
  check('越界一字节就切 64 位 largesize', boxHeader('free', 0xfffffff8).length === 16);
  check('boxHeader 与 box 拼出的头完全一致',
    box('free', Buffer.alloc(32)).subarray(0, 8).equals(boxHeader('free', 32)));

  for (const width of [1, 2, 3, 4]) {
    const value = Math.min(1000, vintMax(width));
    const encoded = writeVint(value, width);
    const decoded = readVint(encoded, 0);
    check(`EBML VINT 往返(width=${width})`, decoded.width === width && decoded.value === value && !decoded.unknown, `${JSON.stringify(decoded)}`);
  }
  const unknownLen = Buffer.from([0xff]);
  check('EBML 未知长度可识别', readVint(unknownLen, 0).unknown === true);

  const el = ebml(EBML.void, Buffer.alloc(5));
  check('EBML element 编码', el[0] === 0xec && readVint(el, 1).value === 5);

  check('文件名模板', formatName('{name}_{i:03}_{label}{ext}', { name: 'v', i: 7, label: 'a', ext: '.mp4' }) === 'v_007_a.mp4');
  check('文件名模板：{guid} 占位符', formatName('{name}-{guid}{ext}', { name: 'v', i: 0, guid: 'abc123', ext: '.mp4' }) === 'v-abc123.mp4');

  // 回归：pattern 非法时必须显式抛错，绝不能渲染出字面量 "undefined"。
  // 曾经的线上故障链：CLI 省略 --name → options.namePattern=undefined →
  // spread 覆盖默认值 → 文件名全叫 "undefined" → N 份互相覆盖只剩最后一份。
  const mustThrow = (label, fn) => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(label, threw);
  };
  mustThrow('文件名模板为 undefined 时抛错（不再渲染成 "undefined"）', () => formatName(undefined, { name: 'v', i: 0, ext: '.mp4' }));
  mustThrow('文件名模板为空串时抛错', () => formatName('', { name: 'v', i: 0, ext: '.mp4' }));
  mustThrow('模板字段缺失导致渲染出 "undefined" 时抛错', () => formatName('{name}{ext}', { i: 0, ext: '.mp4' }));

  // 回归：显式 undefined 不得覆盖 DEFAULTS（这是上面故障的真正机制）
  const stripUndef = (o) => { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v; return r; };
  const DEFAULTS_SAMPLE = { namePattern: '{name}_{i:03}{ext}', mode: 'both' };
  const merged = { ...DEFAULTS_SAMPLE, ...stripUndef({ namePattern: undefined, mode: 'meta' }) };
  check('显式 undefined 不覆盖默认值', merged.namePattern === DEFAULTS_SAMPLE.namePattern, String(merged.namePattern));
  check('显式值仍然生效', merged.mode === 'meta', merged.mode);

  const mapping = computeMapping(100, [
    { start: 10, end: 20, data: Buffer.alloc(5), note: 'shrink' },
    { start: 60, end: 60, data: Buffer.alloc(8), note: 'insert' },
  ]);
  // 期望值手算：splice1 在 [10,20) 写入 5B，splice2 在 60 处插入 8B
  // 未触碰区间：源 [0,10)→副本[0,10)、源 [20,60)→副本[15,55)、源 [60,100)→副本[63,103)
  check('区间映射：未触碰区间正确', JSON.stringify(mapping.untouched) === JSON.stringify([[0, 10, 0], [20, 60, 15], [60, 100, 63]]), JSON.stringify(mapping.untouched));
  check('区间映射：写入落点正确', mapping.placed.map((p) => p.dstStart).join(',') === '10,55', JSON.stringify(mapping.placed.map((p) => p.dstStart)));
  check('区间映射：副本体积正确', mapping.outputSize === 103, String(mapping.outputSize));
  check('区间映射：体积差正确', mapping.sizeDelta === -5 + 8, String(mapping.sizeDelta));
}

/* ── 单元：容器探测 ─────────────────────────────────────────────────── */

async function detectionTests(dir, fixtures) {
  section('单元：容器探测');
  for (const [file, expected] of Object.entries(fixtures)) {
    const reader = await openReader(join(dir, file));
    try {
      const container = await detect(reader);
      check(`探测 ${file} → ${expected}`, container === expected, `实际 ${container}`);
    } finally { await reader.close(); }
  }
}

/* ── 主流程：每种容器 ───────────────────────────────────────────────── */

async function cloneTests(dir, fixtures) {
  section('主流程：clone + 三重自证');
  for (const [file, container] of Object.entries(fixtures)) {
    const src = join(dir, file);
    const outDir = join(dir, `out_${container}_${file.replace(/\W/g, '_')}`);
    let result;
    try {
      result = await cloneVideo({
        input: src, count: 4, outputDir: outDir, verify: 'frames',
        labels: ['a', 'b', 'c', 'd'],
      });
    } catch (error) {
      check(`${file} 整体流程`, false, error.message);
      continue;
    }
    console.log(`  · ${file} 策略=${result.copies[0].strategy}`);
    check(`${file} 整体判定 ok`, result.ok === true);
    check(`${file} 哈希两两互异`, result.verification.hashesAllDistinct === true);
    check(`${file} 副本哈希 ≠ 源哈希`, result.verification.sourceOverlap.length === 0);
    check(`${file} 字节布局自证`, result.verification.layoutOk === true);
    check(`${file} 媒体流不变`, result.copies.every((c) => c.streamIdentical === true));
    check(`${file} 解码帧不变`, result.copies.every((c) => c.framesIdentical === true));

    // 源文件本身不能被改动
    const before = await stat(src);
    const after = await stat(src);
    check(`${file} 源文件未被改写`, before.size === after.size);

    // 副本里必须能扫到自己的 GUID
    const scan = await scanMarkers([result.copies[0].path]);
    check(`${file} 标记可被 scan 找回`, scan[0].markers.some((m) => m.guid === result.copies[0].guid && m.valid));

    // 逐字节复核：未触碰区间与源完全相同。
    // 必须用该副本**真实**的 splices，不能用 previewPlan 重新推导：
    // preview 的 marker 更短（附注不含 label/src），64B 量化后的 padBytes 与真实值不同，
    // 据此算出的未触碰区间偏移全错，会把正确输出误判成不一致。
    const reader = await openReader(src);
    try {
      const realSplices = result.copies[0].splices;
      check(`${file} 结果里带真实 splice 计划`, Array.isArray(realSplices) && realSplices.length > 0);
      const { untouched } = computeMapping(reader.size, realSplices);
      const dstBuf = await readFile(result.copies[0].path);
      let same = true;
      let badRange = null;
      for (const [s, e, d] of untouched) {
        const srcBuf = await reader.read(s, e - s);
        if (!srcBuf.equals(dstBuf.subarray(d, d + (e - s)))) { same = false; badRange = [s, e, d]; break; }
      }
      check(`${file} 未触碰区间逐字节相同`, same, badRange ? `首个不符区间 [${badRange.join(',')}]` : '');
    } finally { await reader.close(); }

    // 账本可读
    const ledger = JSON.parse(await readFile(result.ledgerPath, 'utf8'));
    check(`${file} 账本 GUID 与副本一一对应`, ledger.copies.every((c) => c.guid.length === 32) && ledger.copies.length === 4);
  }
}

/* ── 调用方传显式 undefined（CLI 省略选项时的真实形态）────────────────── */

async function undefinedOptionTests(dir) {
  section('调用方传显式 undefined');
  const src = join(dir, 'src_normal.mp4');
  const out = join(dir, 'out_undef');

  // 这条路径曾整条坏掉：CLI 的 `namePattern: values.name` 在省略 --name 时是
  // undefined，覆盖掉 DEFAULTS → 文件名全渲染成 "undefined" → N 份写同一路径
  // 互相覆盖，最终只剩一份，而「哈希互异」自证报 FAIL。
  // 关键：这里必须显式传 undefined，而不是省略该键（省略走不到 bug）。
  const r = await cloneVideo({
    input: src, count: 3, outputDir: out, verify: 'off',
    namePattern: undefined, mode: undefined, labels: undefined, guids: undefined,
  });

  check('传 undefined 时份数正确', r.copies.length === 3, String(r.copies.length));
  const names = r.copies.map((c) => basename(c.path));
  check('文件名无字面量 "undefined"', !names.some((n) => n.includes('undefined')), names.join(','));
  check('三份文件名互不相同', new Set(names).size === 3, names.join(','));
  check('三份 GUID 互不相同', new Set(r.copies.map((c) => c.guid)).size === 3);
  const onDisk = (await readdir(out)).filter((f) => f.endsWith('.mp4'));
  check('磁盘上确实落了 3 个文件（没有互相覆盖）', onDisk.length === 3, onDisk.join(','));
  check('哈希互异自证通过', r.verification.hashesAllDistinct === true, JSON.stringify(r.verification.collisions));
}

/* ── 输出体积定长 ──────────────────────────────────────────────────── */

async function uniformSizeTests(dir) {
  section('输出体积定长');
  const src = join(dir, 'src_normal.mp4');
  const out = join(dir, 'out_uniform');

  // 回归：不同标签的 UTF-8 字节数不同（"抖音号A"=10B、"快手F"=7B）。曾经 padBytes 用
  // Math.max(192, marker.length) 钳制，而真实附注 JSON 让 marker 涨到 ~213B，
  // 于是 padBytes 被钳成 marker.length、两处填充归零，注释与 free 载荷都等于变长 marker，
  // 同一支源的副本体积随标签浮动（实测 9319471 vs 9319465，差 6B）。
  // 正确做法是把 padBytes 量化到 >= marker 的固定 64 字节对齐值。
  const labels = ['抖音号A', '抖音号B', '快手F', '备用H'];
  const r = await cloneVideo({ input: src, count: 4, outputDir: out, verify: 'off', labels, mode: 'both' });
  const sizes = r.copies.map((c) => c.size);
  check('四份输出体积完全一致（不随标签字节数浮动）', new Set(sizes).size === 1, sizes.join(','));
  check('哈希仍互异', r.verification.hashesAllDistinct === true);
  check('体积确实比源大（写入生效，非空转）', sizes[0] > (await stat(src)).size, `${sizes[0]} vs ${(await stat(src)).size}`);

  // 跨调用不做「体积相同」的断言：无标签时 marker 更短（少一个 label 字段），
  // 量化后自然落到更小的 64 字节量子。真正要保证的是「同一次调用内 N 份体积一致」。
  const r1 = await cloneVideo({ input: src, count: 1, outputDir: join(dir, 'out_uniform_1'), verify: 'off', mode: 'both' });
  check('单份调用自身体积自洽（>源且非零填充）', r1.copies[0].size > (await stat(src)).size, `${r1.copies[0].size} vs ${(await stat(src)).size}`);
  const r2 = await cloneVideo({ input: src, count: 2, outputDir: join(dir, 'out_uniform_2'), verify: 'off', labels: ['快手F', '备用H'], mode: 'both' });
  check('同为 7 字节标签的两份体积一致', new Set(r2.copies.map((c) => c.size)).size === 1, r2.copies.map((c) => c.size).join(','));
}

/* ── strictSize 模式 ────────────────────────────────────────────────── */

async function strictSizeTests(dir) {
  section('体积零变化（strictSize）');
  const src = join(dir, 'src_normal.mp4');
  try {
    await cloneVideo({ input: src, count: 2, outputDir: join(dir, 'out_strict_fail'), strictSize: true, verify: 'off', mode: 'pad' });
    check('无可复用填充位时应当拒绝', false, '竟然成功了');
  } catch (error) {
    check('无可复用填充位时拒绝并说明原因', /strictSize/.test(error.message), error.message);
  }

  const reserved = join(dir, 'src_reserved.mp4');
  if (await hasFfmpeg()) {
    ffmpeg(['-i', src, '-c', 'copy', '-moov_size', '8192', reserved]);
    const r = await cloneVideo({ input: reserved, count: 3, outputDir: join(dir, 'out_strict_pad'), strictSize: true, verify: 'frames', mode: 'pad' });
    const srcSize = (await stat(reserved)).size;
    check('有预留 free box 时体积不变', r.copies.every((c) => c.size === srcSize), `源 ${srcSize} 副本 ${r.copies.map((c) => c.size)}`);
    check('体积不变模式下哈希仍互异', r.verification.hashesAllDistinct === true);
    check('体积不变模式下媒体层不变', r.verification.media.ok === true);
    check('体积不变模式走 free-inplace', r.copies[0].strategy === 'free-inplace', r.copies[0].strategy);

    const bigComment = join(dir, 'src_bigcomment.mp4');
    ffmpeg(['-i', src, '-c', 'copy', '-metadata', `comment=${'P'.repeat(300)}`, bigComment]);
    const r2 = await cloneVideo({ input: bigComment, count: 3, outputDir: join(dir, 'out_strict_meta'), strictSize: true, verify: 'frames', mode: 'meta' });
    const size2 = (await stat(bigComment)).size;
    check('注释字段够大时体积不变', r2.copies.every((c) => c.size === size2), `源 ${size2} 副本 ${r2.copies.map((c) => c.size)}`);
    check('注释原地覆盖模式', r2.copies[0].strategy === 'comment-inplace', r2.copies[0].strategy);
    check('原地覆盖后注释仍可读', r2.copies[0].visibleInMetadata === true);
  }
}

/* ── 边界：异常输入 ─────────────────────────────────────────────────── */

async function edgeTests(dir) {
  section('边界情况');
  const unknown = join(dir, 'unknown.bin');
  await writeFile(unknown, Buffer.concat([Buffer.from('NOTACONTAINER'), Buffer.alloc(4096, 0x5a)]));
  const r = await cloneVideo({ input: unknown, count: 2, outputDir: join(dir, 'out_unknown'), verify: 'off' });
  check('未知容器降级为尾部追加', r.copies[0].strategy === 'tail-append-generic' && r.copies[0].degraded === true, r.copies[0].strategy);
  check('未知容器仍保证哈希互异', r.verification.hashesAllDistinct === true);

  const reader = await openReader(join(dir, 'src_normal.mp4'));
  try {
    const n = (await readFile(join(dir, 'src_normal.mp4'))).length;
    check('文件体积与 reader 一致', reader.size === n);
  } finally { await reader.close(); }

  // 输出路径撞源文件时必须报错
  try {
    await cloneVideo({ input: join(dir, 'src_normal.mp4'), count: 1, outputDir: dir, namePattern: 'src_normal.mp4', verify: 'off' });
    check('输出与源同名时报错', false);
  } catch (error) {
    check('输出与源同名时报错', /同名/.test(error.message), error.message);
  }

  // guids 数量不足必须报错
  try {
    await cloneVideo({ input: join(dir, 'src_normal.mp4'), count: 3, guids: ['a'.repeat(32)], outputDir: join(dir, 'out_guids'), verify: 'off' });
    check('guids 不足时报错', false);
  } catch (error) {
    check('guids 不足时报错', /guids/.test(error.message), error.message);
  }

  // 显式 guids 必须原样落到文件里
  const guidList = ['1'.repeat(32), '2'.repeat(32)];
  const rg = await cloneVideo({ input: join(dir, 'src_normal.mp4'), count: 2, guids: guidList, outputDir: join(dir, 'out_explicit'), verify: 'off' });
  const scan = await scanMarkers(rg.copies.map((c) => c.path));
  check('显式 GUID 原样写入并可扫回', scan[0].markers.some((m) => m.guid === guidList[0]) && scan[1].markers.some((m) => m.guid === guidList[1]));
}

/* ── 校验器失效时不许「默认通过」 ─────────────────────────────────────
 *
 * 这是本工具最核心的那条承诺（媒体层一个字节没变）的守卫。
 * 曾经的真故障：ffmpegStreamHash / ffmpegFrameHashes 在零输出时返回空串，
 * 而调用方拿两个空串比相等 —— 于是一个退出码 0 但什么都不输出的「假 ffmpeg」
 * 能让 streamIdentical 全 true、media.ok 为 true、整体 ok 为 true。
 * 也就是：验证器根本没工作，报告却写着「媒体层 OK」。实测复现过。
 * 拿不到证据就必须响亮失败，绝不能默认通过。
 */

async function verifierGuardTests(dir) {
  section('校验器失效不许默认通过');

  const fake = join(dir, 'fake-ffmpeg.sh');
  await writeFile(fake, [
    '#!/bin/sh',
    // 只对 -version 说话，让 ffmpegAvailable() 认为它可用；算哈希时零输出、退出码 0
    'for a in "$@"; do if [ "$a" = "-version" ]; then echo "ffmpeg version 0-fake"; exit 0; fi; done',
    'exit 0',
  ].join('\n'), 'utf8');
  await chmod(fake, 0o755);

  const src = join(dir, 'src_normal.mp4');

  // 1) 两个哈希函数都必须对空输出抛错
  try {
    await ffmpegStreamHash(src, fake);
    check('空输出的 streamHash 必须抛错', false, '竟然成功返回了');
  } catch (error) {
    check('空输出的 streamHash 必须抛错', /没有输出任何编码流哈希/.test(error.message), error.message);
  }
  try {
    await ffmpegFrameHashes(src, fake);
    check('空输出的 frameHashes 必须抛错', false, '竟然成功返回了');
  } catch (error) {
    check('空输出的 frameHashes 必须抛错', /没有输出任何解码帧哈希/.test(error.message), error.message);
  }

  // 2) 整条克隆链路：验证器坏了，结果就不许说 OK
  const bad = await cloneVideo({
    input: src, outputDir: join(dir, 'out_fake_ffmpeg'), count: 2,
    mode: 'pad', verify: 'media', ffmpegPath: fake,
  });
  check('假 ffmpeg 下整体 ok 必须为 false', bad.ok === false, String(bad.ok));
  check('假 ffmpeg 下 media.ok 必须为 false', bad.verification.media.ok === false, JSON.stringify(bad.verification.media));
  check('假 ffmpeg 下 media 带上失败原因', typeof bad.verification.media.error === 'string' && bad.verification.media.error.length > 10,
    String(bad.verification.media.error));
  check('假 ffmpeg 下不谎报 streamIdentical', bad.copies.every((c) => c.streamIdentical === undefined || c.streamIdentical === null),
    JSON.stringify(bad.copies.map((c) => c.streamIdentical)));
  check('失败原因进了 notes', bad.verification.notes.some((n) => /媒体层校验未能完成/.test(n)),
    JSON.stringify(bad.verification.notes));

  // 3) 真 ffmpeg 不能被这条守卫误伤 —— 产出必须非空
  if (await hasFfmpeg()) {
    const realStream = await ffmpegStreamHash(src);
    const realFrames = await ffmpegFrameHashes(src);
    check('真 ffmpeg 的 streamHash 非空', realStream.length > 0, `长度 ${realStream.length}`);
    check('真 ffmpeg 的 streamHash 是 SHA256 行', /SHA256=[0-9a-f]{64}/.test(realStream), realStream.slice(0, 60));
    check('真 ffmpeg 的 framemd5 非空', realFrames.length > 0, `长度 ${realFrames.length}`);

    const good = await cloneVideo({
      input: src, outputDir: join(dir, 'out_real_ffmpeg'), count: 2,
      mode: 'both', verify: 'media',
    });
    check('真 ffmpeg 下整体 ok 为 true', good.ok === true, JSON.stringify(good.verification.media));
    check('真 ffmpeg 下每份 streamIdentical 为 true', good.copies.every((c) => c.streamIdentical === true));
  } else {
    console.log('  ⚠️  没有 ffmpeg，跳过真路径对照');
  }
}

/* ── 大批量：N=50 哈希互异 ──────────────────────────────────────────── */

async function bulkTest(dir) {
  section('批量：N=50');
  const r = await cloneVideo({ input: join(dir, 'src_normal.mp4'), count: 50, outputDir: join(dir, 'out_bulk'), verify: 'media', namePattern: '{name}_{i:03}{ext}' });
  const hashes = new Set(r.copies.map((c) => c.sha256));
  check('50 份 sha256 全不同', hashes.size === 50, `唯一 ${hashes.size}`);
  check('50 份判定全部通过', r.ok === true);
  check('50 份媒体流全部不变', r.copies.every((c) => c.streamIdentical === true));
}

/* ── 素材准备 ───────────────────────────────────────────────────────── */

async function makeFixtures(dir) {
  const base = join(dir, 'src_normal.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', base]);

  const fixtures = { 'src_normal.mp4': 'mp4' };
  const add = (name, args, container) => { ffmpeg(['-i', base, ...args, join(dir, name)]); fixtures[name] = container; };

  add('src_faststart.mp4', ['-c', 'copy', '-movflags', '+faststart'], 'mp4');
  add('src.mov', ['-c', 'copy'], 'mp4');
  add('src.mkv', ['-c', 'copy'], 'mkv');
  add('src.avi', ['-c:v', 'mpeg4', '-c:a', 'libmp3lame'], 'riff');
  add('src.ts', ['-c:v', 'libx264', '-c:a', 'aac', '-f', 'mpegts'], 'ts');
  add('src.m2ts', ['-c:v', 'libx264', '-c:a', 'aac', '-f', 'mpegts', '-mpegts_m2ts_mode', '1'], 'ts');
  add('src.flv', ['-c:v', 'libx264', '-c:a', 'aac', '-f', 'flv'], 'flv');
  add('src_hv.mp4', ['-c', 'copy', '-metadata', 'comment=HELLO'], 'mp4');
  return fixtures;
}

/* ── main ───────────────────────────────────────────────────────────── */

async function main() {
  if (!(await hasFfmpeg())) {
    console.error('需要 ffmpeg 才能跑测试');
    process.exit(2);
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-video-clone-test-'));
  console.log(`临时目录：${dir}`);
  try {
    unitTests();
    const fixtures = await makeFixtures(dir);
    await detectionTests(dir, fixtures);
    await cloneTests(dir, fixtures);
    await strictSizeTests(dir);
    await undefinedOptionTests(dir);
    await uniformSizeTests(dir);
    await edgeTests(dir);
  await verifierGuardTests(dir);
    await bulkTest(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  if (failures.length) { console.log('失败项：'); for (const f of failures) console.log(`  - ${f}`); }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
