/**
 * dsh-video-clone —— web 半区：给 GUI 面板提供同源 HTTP 路由。
 *
 * 挂到 ctx.webServer 的前缀路由：
 *   POST /video-clone/api   JSON 调度（action 白名单，杜绝任意反射调用）
 *
 * 设计要点：
 *   · 宿主半边已经拥有全部克隆能力，这里**只做搬运**，不重新实现任何逻辑，
 *     所以 CLI / 工具 / 面板三条路径跑的是同一段代码，结果必然一致。
 *   · 克隆可能跑几分钟（大文件 + 逐帧校验），因此 clone 立即返回 jobId，
 *     面板轮询 job 取进度，避免一个长请求挂在 HTTP 上。
 *   · 所有路由都过浏览器信任 fence（回环/可信域 + 非跨站 + Origin 同源），
 *     与 dsh-mcp-connector 同一策略。
 *   · 本模块在非 web 部署（无 webServer 服务）时不会被挂载，调用方负责跳过，
 *     插件仍可用于纯对话工具场景。
 */

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';

import { cloneVideo, scanMarkers, previewPlan, TOOL_VERSION } from './clone.js';
import { ffmpegAvailable } from './verify.js';

export const ROUTE_PREFIX = '/video-clone/api';

/** 浏览目录时认作「视频」的扩展名。 */
const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mov', '.qt', '.mkv', '.webm', '.avi',
  '.ts', '.m2ts', '.mts', '.flv', '.wmv', '.mpg', '.mpeg',
  '.3gp', '.3g2', '.ogv', '.rmvb', '.rm', '.vob', '.mxf',
]);

const BODY_LIMIT = 1 << 20; // 1 MiB
const JOB_KEEP_MS = 30 * 60 * 1000; // 完成后的 job 保留半小时供面板回读

/* ───────────────────────── 浏览器信任 fence ───────────────────────── */

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseAuthority(host) {
  if (typeof host !== 'string' || host.length === 0) return undefined;
  try {
    const u = new URL(`http://${host}`);
    if (!u.hostname) return undefined;
    return { hostname: u.hostname, host: u.host };
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  return (
    hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '0:0:0:0:0:0:0:1'
    || hostname.endsWith('.localhost')
  );
}

function isTrustedAuthority(url, trustedHosts) {
  for (const raw of trustedHosts ?? []) {
    const authority = typeof raw === 'string' ? parseAuthority(raw) : undefined;
    if (authority && authority.host === url.host) return true;
  }
  return false;
}

/**
 * 浏览器信任 fence：Host 必须是本机回环或部署声明的可信域，
 * 且请求非跨站、Origin 与 Host 同源。
 */
export function isTrustedWebRequest(request, trustedHosts = []) {
  const host = header(request.headers, 'host');
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(request.headers, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/* ───────────────────────── HTTP 小工具 ───────────────────────── */

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > BODY_LIMIT) throw new Error('请求体不能超过 1 MiB');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/* ───────────────────────── 任务表 ───────────────────────── */

let jobSeq = 0;
const jobs = new Map();

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && now - job.finishedAt > JOB_KEEP_MS) jobs.delete(id);
  }
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    phase: job.phase,
    index: job.index,
    total: job.total,
    file: job.file,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    error: job.error,
    result: job.result,
  };
}

/** 从进度回调里抛出以中断任务；cloneVideo 会把它当普通异常向上抛。 */
class JobCancelled extends Error {
  constructor() {
    super('任务已取消');
    this.name = 'JobCancelled';
  }
}

/* ───────────────────────── 原生文件选择框 ───────────────────────── */

/**
 * DSH 自带的只有**目录**选择器（`directoryPicker` / `uiWorkspace.pickDirectory`），
 * 没有原生文件选择器，所以这里直接调宿主所在系统的对话框程序。
 *
 * 同样是两段式：`pickFile` 立刻返回 pickId，对话框在后台开着，面板轮询 `pickPoll`。
 * 这样用户可以在对话框前停几分钟，也不会把 HTTP 请求挂死（长请求可能被上层超时掐掉）。
 */
const PICK_TIMEOUT_MS = 5 * 60 * 1000;
const PICK_KEEP_MS = 10 * 60 * 1000;

let pickSeq = 0;
const picks = new Map();

/** AppleScript 字符串字面量转义（反斜杠与双引号）。 */
export function applescriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** PowerShell 单引号字面量转义（单引号要写成两个）。 */
function powershellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 生成「弹出原生文件选择框」的命令。**纯函数**，所以可以离线验证：
 * macOS 分支用 `osacompile` 只编译不执行，就能确证脚本语法合法、且不弹出任何窗口。
 *
 * @param {string} platform process.platform
 * @param {{prompt?: string, startPath?: string, extensions?: string[]}} [options]
 * @returns {{command: string, args: string[]}}
 */
export function buildPickFileCommand(platform, options = {}) {
  const prompt = options.prompt || '选择源视频';
  const extensions = Array.isArray(options.extensions) && options.extensions.length > 0
    ? options.extensions.map((e) => String(e).replace(/^\./, ''))
    : [];
  const startPath = typeof options.startPath === 'string' ? options.startPath : '';

  if (platform === 'darwin') {
    // of type 按扩展名过滤；startPath 不存在时绝不能写进 default location，
    // 否则 choose file 会直接抛错，而不是打开对话框。
    const ofType = extensions.length > 0
      ? ` of type {${extensions.map(applescriptString).join(', ')}}`
      : '';
    const defaultLocation = startPath ? ` default location POSIX file ${applescriptString(startPath)}` : '';
    const script = `POSIX path of (choose file with prompt ${applescriptString(prompt)}${defaultLocation}${ofType})`;
    return { command: 'osascript', args: ['-e', script] };
  }

  if (platform === 'win32') {
    const filter = extensions.length > 0
      ? `视频文件|${extensions.map((e) => `*.${e}`).join(';')}|所有文件|*.*`
      : '所有文件|*.*';
    const lines = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      `$d.Title = ${powershellString(prompt)}`,
      `$d.Filter = ${powershellString(filter)}`,
      startPath ? `$d.InitialDirectory = ${powershellString(startPath)}` : '',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
    ].filter(Boolean).join('; ');
    return { command: 'powershell', args: ['-NoProfile', '-STA', '-Command', lines] };
  }

  // Linux：zenity 最常见；没有的话会以「找不到命令」落到 error 态，面板提示改用面板内浏览。
  const args = ['--file-selection', `--title=${prompt}`];
  if (extensions.length > 0 && extensions.length <= 12) {
    args.push(`--file-filter=视频 | ${extensions.map((e) => `*.${e}`).join(' ')}`);
  }
  if (startPath) args.push(`--filename=${startPath}/`);
  return { command: 'zenity', args };
}

/**
 * 解读选择器进程的退出码/输出。**纯函数**，覆盖「选中 / 取消 / 真失败」三态，
 * 免得把「用户点了取消」误报成错误。
 */
export function interpretPickResult({ code, stdout, stderr }) {
  const out = String(stdout ?? '').trim();
  const err = String(stderr ?? '').trim();
  if (code === 0 && out) return { path: out };
  // macOS：用户取消时 osascript 退出码 1，stderr 里是 "User canceled. (-128)"
  if (code === 1 && /-128|user cancel/i.test(err)) return { cancelled: true };
  // zenity：取消时退出码 1，且没有任何输出
  if (code === 1 && out === '' && err === '') return { cancelled: true };
  if (/-128|user cancel/i.test(err)) return { cancelled: true };
  return { error: err || `选择器退出码 ${code}` };
}

function sweepPicks() {
  const now = Date.now();
  for (const [id, entry] of picks) {
    if (entry.settledAt !== null && now - entry.settledAt > PICK_KEEP_MS) picks.delete(id);
  }
}

function publicPick(entry) {
  return {
    id: entry.id,
    state: entry.state,
    path: entry.path,
    error: entry.error,
    startedAt: entry.startedAt,
    settledAt: entry.settledAt,
  };
}

async function startPickFile(params) {
  sweepPicks();
  const id = `pick-${Date.now().toString(36)}-${(pickSeq += 1).toString(36)}`;
  const entry = { id, state: 'waiting', path: null, error: null, startedAt: Date.now(), settledAt: null };
  picks.set(id, entry);

  // 起始目录：显式传入 > 源视频所在目录 > home。写入前必须确认真实存在。
  const candidates = [
    typeof params.startPath === 'string' ? params.startPath : undefined,
    typeof params.input?.source === 'string' && params.input.source.trim()
      ? dirname(resolve(params.input.source.trim()))
      : undefined,
    homedir(),
  ];
  let startPath = '';
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await stat(resolve(candidate))).isDirectory()) { startPath = resolve(candidate); break; }
    } catch { /* 换下一个候选 */ }
  }

  const { command, args } = buildPickFileCommand(process.platform, {
    prompt: params.prompt,
    startPath,
    extensions: Array.isArray(params.extensions) ? params.extensions : [...VIDEO_EXT].map((e) => e.slice(1)),
  });

  let child;
  try {
    child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    entry.state = 'error';
    entry.error = `起不了选择器 ${command}：${error?.message ?? error}`;
    entry.settledAt = Date.now();
    return entry;
  }

  let stdout = '';
  let stderr = '';
  let settled = false;
  const settle = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    entry.state = result.cancelled ? 'cancelled' : result.error ? 'error' : 'done';
    entry.path = result.path ?? null;
    if (result.error) entry.error = result.error;
    entry.settledAt = Date.now();
  };

  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* 已经退出 */ }
    entry.error = '等待选择超时（5 分钟），已自动关闭';
    settle({ cancelled: true });
  }, PICK_TIMEOUT_MS);

  child.stdout?.on('data', (d) => { stdout += d; });
  child.stderr?.on('data', (d) => { stderr += d; });
  child.on('error', (error) => {
    settle({ error: `找不到 ${command}（${error?.code ?? error?.message ?? error}）` });
  });
  child.on('close', (code) => {
    settle(interpretPickResult({ code, stdout, stderr }));
  });

  return entry;
}

/* ───────────────────────── action 实现 ───────────────────────── */

/** 把面板传来的 input 收敛成 cloneVideo 认得的形状（顺手剔掉 undefined）。 */
function normalizeInput(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const put = (key, value) => {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  };
  put('input', typeof src.source === 'string' ? src.source.trim() : undefined);
  put('outputDir', typeof src.outputDir === 'string' ? src.outputDir.trim() : undefined);
  if (src.count !== undefined) out.count = Number(src.count);
  put('mode', src.mode);
  put('verify', src.verify);
  if (src.padBytes !== undefined) out.padBytes = Number(src.padBytes);
  put('namePattern', src.namePattern);
  if (typeof src.namePattern === 'string' && src.namePattern.length === 0) delete out.namePattern;
  if (src.strictSize === true) out.strictSize = true;
  if (src.deriveFromLabel === true) out.deriveFromLabel = true;
  if (src.overwrite === false) out.overwrite = false;
  if (typeof src.ffmpegPath === 'string' && src.ffmpegPath.trim()) out.ffmpegPath = src.ffmpegPath.trim();

  if (typeof src.labels === 'string') {
    const labels = src.labels.split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean);
    if (labels.length > 0) out.labels = labels;
  } else if (Array.isArray(src.labels)) {
    const labels = src.labels.map((s) => String(s).trim()).filter(Boolean);
    if (labels.length > 0) out.labels = labels;
  }
  if (typeof src.guids === 'string') {
    const guids = src.guids.split(/[\n,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
    if (guids.length > 0) out.guids = guids;
  } else if (Array.isArray(src.guids) && src.guids.length > 0) {
    out.guids = src.guids.map(String);
  }
  return out;
}

/** 默认浏览起点：源文件所在目录 > 工作目录 > home。 */
function defaultBrowsePath(input) {
  const candidate = typeof input?.source === 'string' && input.source.trim()
    ? dirname(resolve(input.source.trim()))
    : undefined;
  for (const p of [candidate, process.cwd(), homedir()]) {
    if (typeof p === 'string' && p) return p;
  }
  return homedir();
}

async function listDirectory(requested, input) {
  const path = resolve(requested || defaultBrowsePath(input));
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`不是目录：${path}`);

  const entries = await readdir(path, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // 隐藏文件不列，面板是用来挑视频的
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: full });
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!VIDEO_EXT.has(ext)) continue;
    let size = null;
    try { size = (await stat(full)).size; } catch { /* 读不到就留 null */ }
    files.push({ name: entry.name, path: full, ext, size });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, dirs, files, truncated: entries.length > 2000 };
}

async function revealPath(target) {
  const path = resolve(target);
  const info = await stat(path);
  const dir = info.isDirectory() ? path : dirname(path);
  const [command, args] = process.platform === 'darwin'
    ? ['open', [dir]]
    : process.platform === 'win32'
      ? ['explorer', [dir]]
      : ['xdg-open', [dir]];
  await new Promise((ok) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => ok());
    child.on('close', () => ok());
    child.unref();
  });
  return { path: dir };
}

function startClone(input) {
  sweepJobs();
  const id = `vc-${Date.now().toString(36)}-${(jobSeq += 1).toString(36)}`;
  const job = {
    id,
    state: 'running',
    phase: 'starting',
    index: 0,
    total: Number(input.count) || 0,
    file: null,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    result: null,
    cancelled: false,
  };
  jobs.set(id, job);

  const onProgress = (event) => {
    if (job.cancelled) throw new JobCancelled();
    job.phase = event.phase;
    if (event.total !== undefined) job.total = event.total;
    if (event.index !== undefined) job.index = event.index;
    if (event.file !== undefined) job.file = event.file;
  };

  job.promise = cloneVideo({ ...input, onProgress })
    .then((result) => {
      job.state = 'done';
      job.phase = 'done';
      job.result = result;
      return result;
    })
    .catch((error) => {
      job.state = job.cancelled ? 'cancelled' : 'failed';
      job.phase = job.state;
      job.error = job.cancelled ? '任务已取消（已写出的副本保留在原处）' : String(error?.message ?? error);
      return null;
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });

  return publicJob(job);
}

/* ───────────────────────── 调度 ───────────────────────── */

const ACTIONS = {
  async state() {
    const ffmpeg = await ffmpegAvailable();
    return {
      version: TOOL_VERSION,
      platform: process.platform,
      cwd: process.cwd(),
      home: homedir(),
      ffmpeg: { available: ffmpeg, command: 'ffmpeg' },
      videoExtensions: [...VIDEO_EXT],
      defaults: { count: 5, mode: 'both', verify: 'media', padBytes: 192, namePattern: '{name}_{i:03}{ext}' },
    };
  },

  async browse(params) {
    return listDirectory(params.path, params.input);
  },

  async plan(params) {
    const input = normalizeInput(params.input);
    if (!input.input) throw new Error('缺少源视频路径');
    const preview = await previewPlan(input.input, {
      mode: input.mode ?? 'both',
      padBytes: input.padBytes ?? 192,
    });
    return { ...preview, source: resolve(input.input) };
  },

  async clone(params) {
    const input = normalizeInput(params.input);
    if (!input.input) throw new Error('缺少源视频路径');
    const job = startClone(input);
    return { jobId: job.id, job };
  },

  async job(params) {
    const job = jobs.get(String(params.jobId ?? ''));
    if (!job) return { missing: true };
    return publicJob(job);
  },

  async cancel(params) {
    const job = jobs.get(String(params.jobId ?? ''));
    if (!job) return { missing: true };
    if (job.state === 'running') job.cancelled = true;
    return publicJob(job);
  },

  async jobs() {
    sweepJobs();
    return { jobs: [...jobs.values()].map(publicJob).sort((a, b) => b.startedAt - a.startedAt) };
  },

  /** 弹出宿主系统的原生文件选择框；立刻返回，面板轮询 pickPoll。 */
  async pickFile(params) {
    // dryRun：只回报「将要执行什么命令」，不起进程。
    // 有了它，测试可以在不往用户屏幕上弹窗的前提下，走完整条 HTTP 路径验证命令构造。
    if (params?.dryRun === true) {
      const built = buildPickFileCommand(process.platform, {
        prompt: params.prompt,
        startPath: typeof params.startPath === 'string' ? params.startPath : '',
        extensions: Array.isArray(params.extensions) ? params.extensions : undefined,
      });
      return { dryRun: true, command: built.command, args: built.args };
    }
    const entry = await startPickFile(params ?? {});
    return { pickId: entry.id, pick: publicPick(entry) };
  },

  async pickPoll(params) {
    sweepPicks();
    const entry = picks.get(String(params.pickId ?? ''));
    if (!entry) return { missing: true };
    return publicPick(entry);
  },

  async scan(params) {
    const list = Array.isArray(params.files)
      ? params.files.map((f) => String(f ?? '').trim()).filter(Boolean)
      : [];
    if (list.length === 0) throw new Error('没有要扫描的文件');
    const results = await scanMarkers(list.map((f) => resolve(f)));
    return {
      files: results.map((r) => ({
        path: r.path,
        size: r.size,
        markers: r.markers.map((m) => ({
          offset: m.offset,
          guid: m.guid,
          valid: m.valid,
          marker: m.marker,
        })),
      })),
    };
  },

  async reveal(params) {
    return revealPath(params.path);
  },
};

/**
 * 挂载路由。
 * @param {object} ctx 已注入 webServer 的 Context
 * @param {{ logger?: object, trustedHosts?: string[] }} [options]
 * @returns {() => void} disposer
 */
export function mountWebRoutes(ctx, options = {}) {
  // 不探 ctx.logger：那是一个未声明的服务读取，在真实 Cordis ctx 上会直接抛
  // 「cannot get property ... without inject」——正是本插件栽过的那个坑。
  const logger = options.logger ?? console;
  const trustedHosts = options.trustedHosts ?? [];

  const disposer = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedWebRequest(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, error: '请求未通过同源信任检查' });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: '只接受 POST' });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }

      const action = String(body.action ?? '');
      const handler = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : undefined;
      if (typeof handler !== 'function') {
        writeJson(res, 400, { ok: false, error: `未知 action：${action || '(空)'}` });
        return;
      }

      try {
        const data = await handler(body ?? {});
        writeJson(res, 200, { ok: true, data });
      } catch (error) {
        const message = String(error?.message ?? error);
        logger?.warn?.(`[video-clone] ${action} 失败：${message}`);
        writeJson(res, 200, { ok: false, error: message });
      }
    },
  });

  return () => {
    try { disposer?.(); } catch { /* 已经卸下 */ }
  };
}

/** 供测试与诊断：当前在跑/已结束的任务快照。 */
export function listJobs() {
  return [...jobs.values()].map(publicJob);
}

/** 供测试：清空任务表。 */
export function clearJobs() {
  jobs.clear();
}

/** 供测试：当前的选择框快照。 */
export function listPicks() {
  return [...picks.values()].map(publicPick);
}

/** 供测试：清空选择框表。 */
export function clearPicks() {
  picks.clear();
}

export { normalizeInput, listDirectory };