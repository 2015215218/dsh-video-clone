#!/usr/bin/env node
/**
 * dsh-video-clone —— web 半区与客户端半边的测试。
 *
 * 这个套件刻意跑**真实**的东西，不用假对象糊过去：
 *   · 真 node:http 服务器 + 真 fetch（真 socket、真 JSON 往返）
 *   · 真 ffmpeg 生成素材、真克隆、真扫描
 *   · 真 @deepseek-ai/cordis Context 装载插件，验证 fiber 真的 ACTIVE
 *
 * 最后一条是必须的：上一轮的教训是「用普通对象伪造 ctx」永远测不出
 * Cordis 的 inject 契约，78 项测试全绿而宿主始终失败。所以这里要么用真
 * Cordis，要么用会抛错的 Proxy —— 绝不用宽容的假对象。
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
  mountWebRoutes, ROUTE_PREFIX, normalizeInput, listDirectory, isTrustedWebRequest,
  listJobs, clearJobs, buildPickFileCommand, interpretPickResult, applescriptString, listPicks, clearPicks,
} from '../lib/web.js';

/**
 * 定位 DSH 安装里的 @deepseek-ai/cordis。
 *
 * 以前这里写死的是一条本机绝对路径 —— 别人 clone 下来必然找不到，CI 上更找不到。
 * 现在按「环境变量 → node 版本管理器 → 常见全局前缀」顺序找；找不到就返回 null，
 * 依赖 DSH 的那几组检查会**显式跳过并说明**，而不是假装通过。
 */
async function findDshCordis() {
  const home = homedir();
  const tail = join('@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis');
  const candidates = [];

  // 环境变量优先。它只是**首选**不是**强制**：下面照旧校验存在性，
  // 指错路径会继续往下找，实在找不到才退化成「跳过」。
  if (process.env.DSH_CORDIS_PATH) candidates.push(process.env.DSH_CORDIS_PATH);

  // fnm：~/.local/share/fnm/node-versions/v24.12.0/installation/lib/node_modules/…
  const fnmRoot = join(home, '.local', 'share', 'fnm', 'node-versions');
  try {
    for (const v of (await readdir(fnmRoot)).sort(byVersionDesc)) {
      candidates.push(join(fnmRoot, v, 'installation', 'lib', 'node_modules', tail));
    }
  } catch { /* 没装 fnm */ }

  // nvm：~/.nvm/versions/node/v24.12.0/lib/node_modules/…
  const nvmRoot = join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of (await readdir(nvmRoot)).sort(byVersionDesc)) {
      candidates.push(join(nvmRoot, v, 'lib', 'node_modules', tail));
    }
  } catch { /* 没装 nvm */ }

  // 常见全局前缀
  for (const prefix of ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules', '/usr/lib/node_modules']) {
    candidates.push(join(prefix, tail));
  }

  for (const c of candidates) if (existsSync(join(c, 'lib', 'index.js'))) return c;
  return null;
}

/** v 号降序；认不出编号的排在最后，保证高版本优先被选中。 */
function byVersionDesc(a, b) {
  const parse = (s) => (s.match(/^v?(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  const [A, B] = [parse(a), parse(b)];
  if (A.length !== 3) return 1;
  if (B.length !== 3) return -1;
  for (let i = 0; i < 3; i += 1) if (A[i] !== B[i]) return B[i] - A[i];
  return 0;
}

const DSH_CORDIS = await findDshCordis();

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ✔ ${name}`); return true; }
  failed += 1;
  failures.push(name);
  console.log(`  ✖ ${name}${detail === undefined ? '' : ` —— ${detail}`}`);
  return false;
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

/* ───────────────────────── ffmpeg 素材 ───────────────────────── */

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', () => resolvePromise({ code: -1, out, err }));
    child.on('close', (code) => resolvePromise({ code, out, err }));
  });
}

async function hasFfmpeg() {
  const r = await run('ffmpeg', ['-version']);
  return r.code === 0;
}

async function makeSample(dir, name, args) {
  const path = join(dir, name);
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path]);
  if (r.code !== 0) throw new Error(`生成素材失败：${r.err}`);
  return path;
}

/* ───────────────────────── 简易 HTTP 载体 ───────────────────────── */

/**
 * 把 mountWebRoutes 注册的**真实**路由处理器挂到一个真 node:http 服务器上，
 * 其他路径一律 404 —— 与宿主 webServer 的行为一致。
 */
async function startHarness() {
  let route = null;
  const ctx = {
    webServer: {
      register(definition) {
        route = definition;
        return () => { route = null; };
      },
    },
  };
  const dispose = mountWebRoutes(ctx, { logger: { warn: () => {} } });

  const server = createServer((req, res) => {
    if (route && req.url.startsWith(route.path)) {
      Promise.resolve(route.handler(req, res)).catch(() => {
        res.writeHead(500).end('boom');
      });
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  return {
    route,
    base,
    ctx,
    async call(action, params, init = {}) {
      const response = await fetch(`${base}${ROUTE_PREFIX}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        body: JSON.stringify({ action, ...(params ?? {}) }),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 保留原文 */ }
      return { status: response.status, json, text };
    },
    async close() {
      dispose();
      await new Promise((r) => server.close(r));
    },
  };
}

/* ───────────────────────── 主流程 ───────────────────────── */

const work = await mkdtemp(join(tmpdir(), 'vc-web-test-'));
const ffmpeg = await hasFfmpeg();
const cleanup = [];
/** 跨小节传递的实测观测值（比如宿主真的把文件写到哪了）。 */
const observed = {};
/** client.js 在本进程里只会被求值一次（ESM 缓存），两个小节共用这份。 */
let clientModule = null;

try {
  const harness = await startHarness();
  cleanup.push(() => harness.close());

  /* ── 路由契约 ── */
  section('路由与信任 fence');
  ok('注册的是前缀路由 ' + ROUTE_PREFIX, harness.route?.kind === 'prefix' && harness.route.path === ROUTE_PREFIX,
    JSON.stringify({ kind: harness.route?.kind, path: harness.route?.path }));

  const getResp = await fetch(`${harness.base}${ROUTE_PREFIX}`);
  ok('GET 被拒（405）', getResp.status === 405, `实际 ${getResp.status}`);

  const crossSite = await fetch(`${harness.base}${ROUTE_PREFIX}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ action: 'state' }),
  });
  ok('跨站请求被拒（403）', crossSite.status === 403, `实际 ${crossSite.status}`);

  const badOrigin = await fetch(`${harness.base}${ROUTE_PREFIX}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ action: 'state' }),
  });
  ok('异源 Origin 被拒（403）', badOrigin.status === 403, `实际 ${badOrigin.status}`);

  const goodOrigin = await fetch(`${harness.base}${ROUTE_PREFIX}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: harness.base },
    body: JSON.stringify({ action: 'state' }),
  });
  ok('同源 Origin 放行（200）', goodOrigin.status === 200, `实际 ${goodOrigin.status}`);

  ok('fence 直接调用：跨站为假', isTrustedWebRequest({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }) === false);

  const unknown = await harness.call('nope');
  ok('未知 action 被拒且 ok:false', unknown.status === 400 && unknown.json?.ok === false, JSON.stringify(unknown.json));

  const badBody = await fetch(`${harness.base}${ROUTE_PREFIX}`, { method: 'POST', body: '{not json' });
  ok('非法 JSON 被拒（400）', badBody.status === 400, `实际 ${badBody.status}`);

  /* ── state ── */
  section('action · state');
  const state = await harness.call('state');
  ok('state 成功', state.json?.ok === true, JSON.stringify(state.json));
  ok('state 带版本号', typeof state.json?.data?.version === 'string');
  ok('state 带 ffmpeg 探测结果', typeof state.json?.data?.ffmpeg?.available === 'boolean',
    String(state.json?.data?.ffmpeg?.available));
  ok('ffmpeg 探测与宿主一致', state.json?.data?.ffmpeg?.available === ffmpeg,
    `路由说 ${state.json?.data?.ffmpeg?.available}，实际 ${ffmpeg}`);

  /* ── browse ── */
  section('action · browse');
  const subDir = join(work, '素材库');
  await mkdir(subDir, { recursive: true });
  await writeFile(join(work, 'note.txt'), 'x');
  await writeFile(join(work, '黑客帝国.mp4'), 'not really a video');
  if (ffmpeg) await makeSample(work, 'sample.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '1', '-pix_fmt', 'yuv420p']);

  const browse = await harness.call('browse', { path: work });
  ok('browse 成功', browse.json?.ok === true, JSON.stringify(browse.json));
  ok('browse 列出子目录', (browse.json?.data?.dirs ?? []).some((d) => d.name === '素材库'));
  ok('browse 只列视频、不列 txt', !(browse.json?.data?.files ?? []).some((f) => f.name === 'note.txt'));
  ok('browse 认 .mp4', (browse.json?.data?.files ?? []).some((f) => f.name === '黑客帝国.mp4'));
  ok('browse 返回上级路径', typeof browse.json?.data?.parent === 'string' && browse.json.data.parent.length > 0);

  const browseBad = await harness.call('browse', { path: join(work, 'no-such-dir') });
  ok('browse 不存在的目录 → ok:false 且带错误', browseBad.json?.ok === false && /ENOENT|不存在|no such/i.test(browseBad.json.error));

  const browseFile = await harness.call('browse', { path: join(work, 'note.txt') });
  ok('browse 指向文件 → 明确报「不是目录」', browseFile.json?.ok === false && /不是目录/.test(browseFile.json.error), browseFile.json?.error);

  /* ── normalizeInput ── */
  section('输入收敛');
  const norm = normalizeInput({ source: '  /a/b.mp4  ', count: '7', mode: 'pad', labels: 'A\nB，C;D', junk: 1 });
  ok('trim 源路径', norm.input === '/a/b.mp4', norm.input);
  ok('count 转数字', norm.count === 7, String(norm.count));
  ok('labels 按中英文分隔符切成数组', JSON.stringify(norm.labels) === '["A","B","C","D"]', JSON.stringify(norm.labels));
  ok('未认得的键被丢弃', !('junk' in norm));
  const norm2 = normalizeInput({ source: '/x.mp4', namePattern: '', outputDir: '', labels: '' });
  ok('空字符串不进 options（否则会覆盖默认值）',
    !('namePattern' in norm2) && !('outputDir' in norm2) && !('labels' in norm2), JSON.stringify(norm2));

  if (!ffmpeg) {
    console.log('\n⚠️  没有可用的 ffmpeg，跳过克隆/扫描/进度相关断言');
  } else {
    /* ── plan ── */
    section('action · plan');
    const sample = join(work, 'sample.mp4');
    const planResp = await harness.call('plan', { input: { source: sample, mode: 'both' } });
    ok('plan 成功', planResp.json?.ok === true, JSON.stringify(planResp.json));
    ok('plan 报容器为 mp4', planResp.json?.data?.container === 'mp4', JSON.stringify(planResp.json?.data?.container));
    ok('plan 有体积差', typeof planResp.json?.data?.sizeDelta === 'number');
    ok('plan 不写文件（目录里没多出副本）', existsSync(join(work, 'sample_clones')) === false);

    /* ── clone + job 轮询 ── */
    section('action · clone / job');
    const cloneResp = await harness.call('clone', {
      input: {
        source: sample,
        count: 3,
        mode: 'both',
        verify: 'frames',
        labels: '抖音号A,视频号B,小红书C',
        deriveFromLabel: true,
      },
    });
    ok('clone 立即返回 jobId', cloneResp.json?.ok === true && typeof cloneResp.json?.data?.jobId === 'string', JSON.stringify(cloneResp.json));
    const jobId = cloneResp.json.data.jobId;
    ok('初始 job 状态为 running', cloneResp.json.data.job.state === 'running');

    let job = cloneResp.json.data.job;
    const deadline = Date.now() + 120000;
    while (job.state === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      const poll = await harness.call('job', { jobId });
      job = poll.json.data;
    }
    ok('job 最终 done', job.state === 'done', `${job.state} / ${job.error}`);
    ok('job 有 finishedAt 与耗时', typeof job.finishedAt === 'number' && job.elapsedMs >= 0);

    const result = job.result;
    ok('结果 ok=true', result?.ok === true, JSON.stringify(result?.verification?.layoutOk));
    ok('产出 3 份', result?.copies?.length === 3, String(result?.copies?.length));
    ok('三项自证：布局', result?.verification?.layoutOk === true);
    ok('三项自证：哈希两两互异', result?.verification?.hashesAllDistinct === true);
    ok('三项自证：媒体层 frames', result?.verification?.media?.ok === true && result?.verification?.media?.level === 'frames',
      JSON.stringify(result?.verification?.media));
    ok('三份 sha256 两两不同', new Set(result.copies.map((c) => c.sha256)).size === 3);
    ok('三份 guid 两两不同', new Set(result.copies.map((c) => c.guid)).size === 3);
    ok('标签落进结果', result.copies.map((c) => c.label).join(',') === '抖音号A,视频号B,小红书C',
      result.copies.map((c) => c.label).join(','));
    ok('deriveFromLabel 生效（同标签 → 同 GUID）', true);

    /* 同一标签重跑一次，GUID 必须一致 */
    const again = await harness.call('clone', {
      input: { source: sample, count: 1, mode: 'both', verify: 'off', labels: '抖音号A', deriveFromLabel: true, outputDir: join(work, 'repeat') },
    });
    let againJob = again.json.data.job;
    while (againJob.state === 'running' && Date.now() < Date.now() + 60000) {
      await new Promise((r) => setTimeout(r, 200));
      againJob = (await harness.call('job', { jobId: again.json.data.jobId })).json.data;
      if (againJob.state !== 'running') break;
    }
    ok('标签确定性推导：同标签得到同 GUID',
      againJob.result?.copies?.[0]?.guid === result.copies[0].guid,
      `${againJob.result?.copies?.[0]?.guid} vs ${result.copies[0].guid}`);

    /* ── 不传 outputDir：宿主落在哪，面板就该预告哪 ──
     * 用一个**单独的素材**：隐式目录是 <源名>_clones，若沿用上面的 sample.mp4，
     * 这一跑会覆盖掉 sample_clones/sample_000.mp4，把后面 scan 小节的比对弄脏
     * （实测踩过：scan 扫回的 GUID 与账本对不上）。 */
    {
      const sample2 = await makeSample(work, 'sample2.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '1', '-pix_fmt', 'yuv420p']);
      const implicit = await harness.call('clone', {
        input: { source: sample2, count: 1, mode: 'pad', verify: 'off' },
      });
      let implicitJob = implicit.json.data.job;
      while (implicitJob.state === 'running') {
        await new Promise((r) => setTimeout(r, 200));
        implicitJob = (await harness.call('job', { jobId: implicit.json.data.jobId })).json.data;
      }
      observed.hostOutputDir = implicitJob.result?.outputDir ?? null;
      observed.sourceForDefault = sample2;
      ok('不传 outputDir 时宿主落在源旁 <名字>_clones',
        observed.hostOutputDir === join(work, 'sample2_clones'), String(observed.hostOutputDir));
    }

    /* ── scan ── */
    section('action · scan');
    const produced = result.copies.map((c) => `${result.outputDir}/${c.file}`);
    const scan = await harness.call('scan', { files: produced });
    ok('scan 成功', scan.json?.ok === true, JSON.stringify(scan.json));
    ok('每份至少命中一个标记', scan.json.data.files.every((f) => f.markers.length > 0),
      JSON.stringify(scan.json.data.files.map((f) => f.markers.length)));
    ok('扫回的 GUID 与账本一致',
      scan.json.data.files.map((f) => f.markers[0].guid).join(',') === result.copies.map((c) => c.guid).join(','));
    ok('所有命中项 CRC 自校验通过', scan.json.data.files.every((f) => f.markers.every((m) => m.valid === true)));

    const scanEmpty = await harness.call('scan', { files: [] });
    ok('scan 空列表被拒', scanEmpty.json?.ok === false, JSON.stringify(scanEmpty.json));

    /* ── job 表 ── */
    section('action · jobs / job 缺失');
    const jobs = await harness.call('jobs');
    ok('jobs 列出已跑任务', (jobs.json?.data?.jobs ?? []).length >= 2, String(jobs.json?.data?.jobs?.length));
    const missing = await harness.call('job', { jobId: 'vc-nope' });
    ok('未知 jobId → missing:true', missing.json?.data?.missing === true);

    /* ── reveal 参数校验（不真的开访达）── */
    section('action · reveal 守卫');
    const revealBad = await harness.call('reveal', { path: join(work, 'no-such-file') });
    ok('reveal 不存在的路径 → ok:false', revealBad.json?.ok === false, JSON.stringify(revealBad.json));
  }

  /* ── 原生文件选择框 ── */
  section('原生文件选择框');
  {
    // 下面全是纯函数 + osacompile 编译校验，**不会往屏幕上弹任何窗口**。

    const mac = buildPickFileCommand('darwin', { prompt: '选择源视频', startPath: '/tmp', extensions: ['mp4', 'mov'] });
    ok('macOS 走 osascript -e', mac.command === 'osascript' && mac.args[0] === '-e', JSON.stringify(mac));
    ok('macOS 用 POSIX path of (choose file …)', /POSIX path of \(choose file/.test(mac.args[1]), mac.args[1]);
    ok('macOS 带上起始目录', mac.args[1].includes('default location POSIX file "/tmp"'), mac.args[1]);
    ok('macOS 展开扩展名过滤', mac.args[1].includes('of type {"mp4", "mov"}'), mac.args[1]);

    const bare = buildPickFileCommand('darwin', {});
    ok('没有起始目录就不写 default location（写了会让对话框直接报错而不是打开）',
      !bare.args[1].includes('default location'), bare.args[1]);
    ok('没有扩展名就不写 of type', !bare.args[1].includes('of type'), bare.args[1]);

    const win = buildPickFileCommand('win32', { prompt: '选', extensions: ['mp4'] });
    ok('Windows 走 powershell 且带 -STA（不然 WinForms 对话框起不来）',
      win.command === 'powershell' && win.args.includes('-STA'), JSON.stringify(win.args));
    ok('Windows 用 OpenFileDialog', win.args.join(' ').includes('OpenFileDialog'));

    const lin = buildPickFileCommand('linux', { prompt: '选', extensions: ['mp4'] });
    ok('Linux 走 zenity', lin.command === 'zenity' && lin.args.includes('--file-selection'), JSON.stringify(lin.args));

    // 引号转义：路径里带双引号/反斜杠不能把脚本撕成两半
    const tricky = buildPickFileCommand('darwin', { prompt: 'a"b', startPath: '/tmp/we"ird\\x' });
    ok('AppleScript 转义了双引号', tricky.args[1].includes('\\"'), tricky.args[1]);
    ok('AppleScript 转义了反斜杠', tricky.args[1].includes('\\\\'), tricky.args[1]);
    ok('applescriptString 原样处理普通字符串', applescriptString('/a/b.mp4') === '"/a/b.mp4"');
    ok('PowerShell 单引号转义成两个', buildPickFileCommand('win32', { prompt: "it's" }).args.join(' ').includes("it''s"));

    // 退出码三态解读
    ok('选中 → path', interpretPickResult({ code: 0, stdout: '/a/b.mp4\n', stderr: '' }).path === '/a/b.mp4');
    ok('macOS 取消（-128）→ cancelled，不是 error',
      interpretPickResult({ code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' }).cancelled === true);
    ok('zenity 取消（退出码 1 无输出）→ cancelled',
      interpretPickResult({ code: 1, stdout: '', stderr: '' }).cancelled === true);
    ok('退出码 0 但没有输出 → 不算选中',
      interpretPickResult({ code: 0, stdout: '  ', stderr: '' }).path === undefined);
    ok('真失败 → error 且带原因',
      typeof interpretPickResult({ code: 3, stdout: '', stderr: 'boom' }).error === 'string');

    // 走真实 HTTP 路由的 dryRun：回报将要执行的命令，但不起进程
    const dry = await harness.call('pickFile', { dryRun: true, startPath: work, extensions: ['mp4'] });
    ok('pickFile dryRun 成功（没弹窗）', dry.json?.ok === true && dry.json.data.dryRun === true, JSON.stringify(dry.json));
    ok('dryRun 报出当前平台的真实命令', typeof dry.json?.data?.command === 'string' && dry.json.data.command.length > 0,
      String(dry.json?.data?.command));
    ok('dryRun 没起任何选择器进程', (await run('pgrep', ['-l', 'osascript'])).code !== 0, '有 osascript 残留');
    ok('dryRun 没往选择框表里塞东西', listPicks().length === 0, String(listPicks().length));

    const pickMissing = await harness.call('pickPoll', { pickId: 'pick-nope' });
    ok('未知 pickId → missing:true', pickMissing.json?.data?.missing === true, JSON.stringify(pickMissing.json));

    // 依赖自检：确认我这条代码路径依赖的 osascript 真的存在且可用 -e 调用。
    // 用「算个数」而不是 choose file —— 不弹任何窗口，纯测可调用性 + stdout 捕获。
    if (process.platform === 'darwin') {
      const probe = await run('osascript', ['-e', 'return 40 + 2']);
      ok('osascript 存在且 -e 调用可用（stdout 能拿到）', probe.code === 0 && probe.out.trim() === '42',
        `code=${probe.code} out=${JSON.stringify(probe.out)}`);
    }

    // 真语法校验：osacompile **只编译不执行**，所以脚本合法与否可离线确证，且不弹窗
    if (process.platform === 'darwin') {
      const script = buildPickFileCommand('darwin', { prompt: '选择源视频', startPath: work, extensions: ['mp4', 'mov', 'mkv'] }).args[1];
      const dir = await mkdtemp(join(tmpdir(), 'vc-osacompile-'));
      const compiled = await run('osacompile', ['-o', join(dir, 'check.scpt'), '-e', script]);
      ok('生成的 AppleScript 通过 osacompile 编译（语法真合法）', compiled.code === 0, compiled.err.trim());
      ok('编译期间没有 osascript 进程（确证只编译、没执行）', (await run('pgrep', ['-l', 'osascript'])).code !== 0);
      await rm(dir, { recursive: true, force: true });
    } else {
      console.log('  ⚠️  非 macOS，跳过 osacompile 语法校验');
    }
  }

  /* ── 真实 Cordis 装载 ── */
  section('真实 Cordis 装载（宿主半边）');
  if (DSH_CORDIS === null || !existsSync(DSH_CORDIS)) {
    console.log('  ⚠️  找不到 @deepseek-ai/cordis，跳过');
  } else {
    const { Context } = await import(pathToFileURL(join(DSH_CORDIS, 'lib', 'index.js')).href);
    const plugin = await import('../index.js');

    const seen = { tools: [], routes: [], effects: [] };

    const root = new Context();
    // 关键：把 tools / webServer 放在**兄弟插件**里提供。
    // 只有这样 Cordis 才会对「未声明的服务读取」抛错 —— 由 root 直接 provide
    // 的话守卫不触发，正是上一轮假绿的原因。
    root.plugin({
      name: 'sibling-providers',
      apply(sctx) {
        sctx.provide('tools', {
          register(definition) { seen.tools.push(definition?.name); return () => {}; },
        });
        sctx.provide('webServer', {
          register(route) { seen.routes.push({ kind: route.kind, path: route.path }); return () => {}; },
        });
      },
    });

    root.plugin(plugin);
    await new Promise((r) => setTimeout(r, 300));

    const fibers = [];
    for (const plugin of root.registry.values()) {
      // plugin.fibers 是 {sn, map, weak} 的响应式存储，真正的 Fiber 实例在 .map 里。
      for (const fiber of plugin.fibers?.map?.values?.() ?? []) {
        fibers.push({ name: plugin.name, state: fiber.state });
      }
    }
    const mine = fibers.find((s) => s.name === 'video-clone' || s.name === 'dsh-video-clone');

    // 2 = ACTIVE（0 PENDING / 1 LOADING / 2 ACTIVE / 3 FAILED / 4 DISPOSED / 5 UNLOADING）
    ok('插件 fiber 真的 ACTIVE（state=2）', mine?.state === 2, JSON.stringify(fibers));
    ok('根 fiber 也是 ACTIVE', root.fiber?.state === 2, String(root.fiber?.state));
    ok('注册了两个工具', seen.tools.length === 2 && seen.tools.includes('video_clone') && seen.tools.includes('video_clone_scan'),
      JSON.stringify(seen.tools));
    ok('webServer 路由被挂上（说明 ctx.inject 可选依赖生效）',
      seen.routes.some((r) => r.path === ROUTE_PREFIX), JSON.stringify(seen.routes));

    await root.stop?.().catch?.(() => {});
  }

  /* ── 客户端半边 ── */
  section('客户端半边（client.js 形状）');
  {
    let captured = null;
    globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
    await import('../client.js');
    ok('调用了 __ModuleLoader__.load', captured !== null);
    ok('模块 id 与包名一致', captured?.id === 'dsh-video-clone', String(captured?.id));

    const React = {
      createElement: (type, props, ...kids) => ({ type, props, kids }),
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }),
    };
    const client = captured.factory((name) => {
      if (name === 'react') return React;
      throw new Error(`client.js 只应 require("react")，却要了 ${name}`);
    });

    ok('导出 apply', typeof client.apply === 'function');
    ok('导出 inject 且含 slots', Array.isArray(client.inject) && client.inject.includes('slots'), JSON.stringify(client.inject));
    ok('inject 面子最小（只要 slots，不碰用不到的 layout）', client.inject.length === 1 && client.inject[0] === 'slots', JSON.stringify(client.inject));
    ok('PANEL_ID 与宿主路由前缀相邻', client.PANEL_ID === 'video-clone' && client.ROUTE_PREFIX === ROUTE_PREFIX);

    // 用会抛错的 Proxy 模拟 Cordis：**按下模块自己声明的 inject 列表**放行。
    // 这一点很关键 —— 如果 Proxy 无条件放行 slots，"漏声明 inject" 就测不出来，
    // 而漏声明正是上一轮让插件在宿主里静默失败的那个 bug（客户端半边同理）。
    // effect 是 Cordis 核心方法，不是服务，不需要声明。
    const declared = new Set(client.inject);
    const order = [];
    const strictCtx = new Proxy({}, {
      get(_t, prop) {
        const key = String(prop);
        if (key !== 'effect' && !declared.has(key)) {
          throw new Error(`cannot get property "${key}" without inject`);
        }
        if (prop === 'slots') {
          return {
            inject: (slotKey, cb) => { order.push(`inject:${slotKey}`); cb(); },
            register: (opts) => { order.push(`register:${opts.name}#${opts.key ?? opts.id}`); return () => {}; },
          };
        }
        if (prop === 'effect') return (fn) => fn();
        throw new Error(`cannot get property "${key}" without inject`);
      },
    });
    let threw = null;
    try { client.apply(strictCtx); } catch (e) { threw = e; }
    ok('在严格 ctx 下 apply 不抛错', threw === null, String(threw?.message));
    ok('先注册 main，再注册侧边栏行（顺序是契约）',
      order.indexOf('register:main#video-clone') < order.indexOf('register:sidebar.panellist#video-clone'),
      order.join(' → '));
    ok('侧边栏行的 id 与 main 的 key 相同（否则宿主拒绝选中）',
      order.includes('register:main#video-clone') && order.includes('register:sidebar.panellist#video-clone'));
    clientModule = client;   // 交给下面的「面板体验」小节复用（ESM 缓存，不能重复 import）
  }

  /* ── 面板体验（纯函数 + 防回归） ── */
  section('面板体验');
  {
    const client = clientModule;
    ok('复用到了客户端模块（ESM 只求值一次）', client !== null);
    const t = client?.__test ?? {};
    ok('__test 纯函数出口存在', typeof t.defaultOutputDir === 'function', Object.keys(t).join(', '));

    ok('defaultOutputDir: 常规', t.defaultOutputDir('/a/b/c.mp4') === '/a/b/c_clones', t.defaultOutputDir('/a/b/c.mp4'));
    ok('defaultOutputDir: 只剥最后一个扩展名（与 Node basename/extname 一致）',
      t.defaultOutputDir('/a/b/my.video.mp4') === '/a/b/my.video_clones', t.defaultOutputDir('/a/b/my.video.mp4'));
    ok('defaultOutputDir: 没有扩展名', t.defaultOutputDir('/a/b/video') === '/a/b/video_clones', t.defaultOutputDir('/a/b/video'));
    ok('defaultOutputDir: 点开头的隐藏名不算扩展名',
      t.defaultOutputDir('/a/b/.hidden') === '/a/b/.hidden_clones', t.defaultOutputDir('/a/b/.hidden'));
    ok('defaultOutputDir: 空/纯空白给空串', t.defaultOutputDir('') === '' && t.defaultOutputDir('   ') === '');
    ok('defaultOutputDir: 没有目录部分给空串', t.defaultOutputDir('c.mp4') === '', t.defaultOutputDir('c.mp4'));

    // 与宿主的**实测**输出目录对齐 —— 面板上的「将输出到 …」不能是编的
    if (observed.hostOutputDir) {
      ok('面板预告的默认输出目录 == 宿主真的写到的地方',
        t.defaultOutputDir(observed.sourceForDefault) === observed.hostOutputDir,
        `面板 ${t.defaultOutputDir(observed.sourceForDefault)} vs 宿主 ${observed.hostOutputDir}`);
    } else {
      console.log('  ⚠️  没跑出宿主的隐式输出目录，跳过一致性对照');
    }

    // 防回归：表单与上次结果必须走 useStored，不能是裸 useState（否则切走即丢失）
    const src = await readFile(new URL('../client.js', import.meta.url), 'utf8');
    for (const key of ['source', 'count', 'mode', 'verify', 'labels', 'namePattern', 'outputDir', 'deriveFromLabel', 'scanInput', 'lastResult']) {
      ok(`持久化字段 ${key} 走 useStored`, src.includes(`useStored('${key}'`), `没找到 useStored('${key}'`);
    }
    // 必须精确看 `= useState(`：第一版写成 `const \[result, set` 被
    // `const [result, setResult] = useStored(...)` 误报了 —— 断言本身也是代码。
    const withUseState = [...src.matchAll(/const\s+\[(\w+),\s*set\w+\]\s*=\s*useState\(/g)].map((m) => m[1]);
    const leaked = withUseState.filter((name) => [
      'source', 'count', 'mode', 'verify', 'labels', 'namePattern', 'outputDir',
      'deriveFromLabel', 'scanInput', 'result', 'scanResult',
    ].includes(name));
    ok('表单/结果字段没有再用裸 useState（那样切走就丢）', leaked.length === 0, leaked.join(', '));

    // 编号连续性：没有「3 · 结果」时不该出现「4 · 反查」这种跳号
    ok('反查卡片不再占用流程编号（避免 2 → 4 跳号）',
      src.includes("'反查 · 谁发的'") && !src.includes("'4 · 反查"), '仍有 4 · 反查');
    ok('结果卡片仍编号 3', src.includes("'3 · 结果'"));
  }

  /* ── 主题 token 审计 ── */
  section('主题 token 审计（守住「白底白字」那类 bug）');
  {
    // 起因：主按钮曾写成 `background: var(--dsw-alias-brand-primary); color: #fff`。
    // --dsw-alias-brand-primary 是个**会翻转**的 token（浅色主题 #0f1115 近黑、
    // 深色主题 #f9fafb 近白），配写死的 #fff 之后，深色主题里就是白底白字，
    // 两个主按钮的文案整个消失。这类 bug 逻辑测试全绿也照样存在，必须专门守。

    const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
    const css = clientSource.match(/const CSS = `([\s\S]*?)`;/)?.[1] ?? '';
    ok('能从 client.js 里取到面板样式表', css.length > 500, `长度 ${css.length}`);

    // 先去掉 CSS 注释再扫：注释里为了讲清道理会写颜色值（比如说明
    // brand-primary 在浅色主题是 #0f1115），那不是声明，不该被判违规。
    const decls = css.replace(/\/\*[\s\S]*?\*\//g, '');

    // 1) 样式表里不许有任何写死的颜色字面量
    const hardcoded = [
      ...decls.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
      ...decls.matchAll(/\brgba?\([^)]*\)/g),
      ...decls.matchAll(/:\s*(?:white|black|red|blue|green|gray|grey|silver|navy)\b/g),
    ].map((m) => m[0].trim());
    ok('样式表里没有写死的颜色字面量（必须全走主题 token）', hardcoded.length === 0, hardcoded.join(', '));

    // 下面两组只读 client.js，不依赖宿主，任何环境都跑
    const primary = css.match(/\.vc-btn\.primary\s*\{[^}]*\}/)?.[0] ?? '';
    ok('主按钮背景用 button-contrast-fill', primary.includes('--dsw-alias-button-contrast-fill'), primary);
    ok('主按钮前景用 label-primary-inverted（跟着主题翻转，不会白底白字）',
      primary.includes('--dsw-alias-label-primary-inverted'), primary);

    // 下面两组要读 DSH 主题定义，用来防「token 拼错 / 臆造」和「对比色对名不副实」。
    // 没装 DSH 时显式跳过 —— 假通过比不测更危险，所以这里必须说出来。
    const dshRoot = DSH_CORDIS === null ? null : join(DSH_CORDIS, '..');
    if (dshRoot === null) {
      console.log('  ⚠️  未检测到 DSH 安装，跳过「token 真实性」与「对比色对」两组检查');
      console.log('      （要找的是安装目录里的 @deepseek-ai/dsh/node_modules/@deepseek-ai/cordis）');
      console.log('      可设 DSH_CORDIS_PATH=… 直接指定；上面那组硬编码颜色检查照跑不误。');
    } else {
      // 2) 引用的每个 --dsw token 都必须是主题真的定义过的（防拼错、防臆造）
      const defined = new Set();
      const scanFile = async (path) => {
        try {
          const text = await readFile(path, 'utf8');
          for (const m of text.matchAll(/--dsw-[a-z0-9-]+(?=\s*:)/g)) defined.add(m[0]);
        } catch { /* 文件不在就算了，下面会体现为 token 找不到 */ }
      };
      // DSH_CORDIS 指向 …/dsh/node_modules/@deepseek-ai/cordis，上一级就是 @deepseek-ai/
      await scanFile(join(dshRoot, 'dsh-client-ui-theme', 'lib', 'client.js'));
      const assetsDir = join(dshRoot, 'dsh-web-frontend', 'dist', 'assets');
      try {
        for (const f of await readdir(assetsDir)) {
          if (f.endsWith('.css')) await scanFile(join(assetsDir, f));
        }
      } catch { /* 没有 frontend 产物 */ }

      ok('扫到了主题 token 定义（否则下一条等于没检）', defined.size > 20, `找到 ${defined.size} 个`);
      const used = [...new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))];
      const unknown = used.filter((t) => !defined.has(t));
      ok(`引用的 ${used.length} 个主题 token 全部真实存在`, unknown.length === 0, unknown.join(', '));

      // 4) 反过来确认这对 token 在两个方向上确实彼此对比（把上面那条的道理钉住）
      let themeText = '';
      try { themeText = await readFile(join(dshRoot, 'dsh-client-ui-theme', 'lib', 'client.js'), 'utf8'); } catch { /* 上面已报 */ }
      const fillShades = [...new Set([...themeText.matchAll(/--dsw-alias-button-contrast-fill:var\((--dsw-static-[a-z0-9-]+)\)/g)].map((m) => m[1]))];
      const labelShades = [...new Set([...themeText.matchAll(/--dsw-alias-label-primary-inverted:var\((--dsw-static-[a-z0-9-]+)\)/g)].map((m) => m[1]))];
      ok('button-contrast-fill 在两套主题下各有一个取值', fillShades.length >= 2, fillShades.join(', '));
      ok('label-primary-inverted 在两套主题下各有一个取值', labelShades.length >= 2, labelShades.join(', '));
      ok('两套主题里填充与前景都不是同一个色阶（否则必然同色）',
        fillShades.every((f, i) => f !== labelShades[i]) || fillShades.join() !== labelShades.join(),
        `fill=[${fillShades}] label=[${labelShades}]`);
    }
  }

  /* ── 包清单 ── */
  section('包清单');
  {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    ok('exports["./client"] 指向 client.js', pkg.exports['./client'] === './client.js', String(pkg.exports['./client']));
    ok('exports["."] 仍是宿主入口', pkg.exports['.'] === './index.js', String(pkg.exports['.']));
    ok('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client));
    ok('files 里包含 client.js', (pkg.files ?? []).includes('client.js'), JSON.stringify(pkg.files));
    ok('client.js 真的存在', existsSync(new URL('../client.js', import.meta.url)));

    // 这条以前写的是常量 true —— 等于没检。发布到 Git 之后它是真有意义的：
    // 一个被 .gitignore 吃掉的入口文件，本地一切正常，别人 clone 下来直接缺半边。
    const mustShip = [
      'index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'README.md', 'SKILL.md',
      'LICENSE', 'bin/video-clone.js', 'lib/web.js', 'lib/clone.js', 'lib/verify.js',
      'test/run-tests.js', 'test/plugin-tests.js', 'test/web-tests.js',
    ];
    let ignored = null; // null = 无从判断（不算通过，也不算失败）
    try {
      ignored = execFileSync('git', ['-C', fileURLToPath(new URL('..', import.meta.url)), 'check-ignore', '--no-index', ...mustShip], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (err) {
      if (err.status === 1) ignored = '';           // 1 = 一个都没被忽略，正是我们要的
      else ignored = null;                          // 不在仓库里 / 没装 git → 跳过
    }
    if (ignored === null) {
      console.log('  ⚠️  跳过 .gitignore 覆盖检查（不在 git 工作树里，或没装 git）');
    } else {
      ok(`待发布的 ${mustShip.length} 个文件都没被 .gitignore 吃掉`, ignored === '', ignored);
    }
  }
} finally {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* 忽略收尾失败 */ } }
  clearJobs();
  await rm(work, { recursive: true, force: true });
}

console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}