/**
 * 插件装载测试：用一个假的 ctx 跑一遍 apply，确认两个工具都能注册、
 * schema 能通过 dsh-tools 的编译器、execute 能真实产出结果。
 *
 *   node test/plugin-tests.js
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, symlink, mkdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包根目录。注意 `new URL('..')` 已指向包根且带尾斜杠，绝不能再套 dirname
 *  —— 那会多剥一层，把路径带到包外（曾读到 misc/package.json，并把 SDK 软链
 *  建到了 misc/node_modules 而不是包内）。改用 fileURLToPath 顺带兼容 Windows。 */
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * 插件在宿主进程里跑时，`@deepseek-ai/dsh-tools` 由 $DSH_HOME/profiles/node_modules
 * 这个 module fallback 目录解析（宿主启动时会自动维护它）。本地跑测试没有宿主，
 * 所以先把这个目录链到本包根上，让 index.js 能解析到同一个 SDK。
 */
async function ensureSdkResolution() {
  const link = join(pkgRoot, 'node_modules');
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const fallback = join(dshHome, 'profiles', 'node_modules');
  const exists = async (p) => { try { await lstat(p); return true; } catch { return false; } };
  if (await exists(link)) return link;
  if (!(await exists(fallback))) return null;
  await symlink(fallback, link, 'dir');
  return link;
}

const sdkLink = await ensureSdkResolution();
if (sdkLink === null) {
  // 这套测试要装载 index.js，而 index.js 要 `import '@deepseek-ai/dsh-tools'` ——
  // 那个包只存在于宿主安装里。别人 clone 下来跑、或 CI 上跑，没有 DSH 很正常。
  // 此时**显式跳过并以 0 退出**：不是失败，但必须说出来，不能悄悄少测一半
  // （「假通过比不测更危险」—— 这条道理在本项目已经栽过一次）。
  // 想强制要求 DSH 存在，设 REQUIRE_DSH=1。
  console.log('⚠️  跳过插件装载测试：没有可用的 DSH 安装。');
  console.log('     找不到 $DSH_HOME/profiles/node_modules，因此无法解析 @deepseek-ai/dsh-tools，');
  console.log('     也就无法装载 index.js。装上 DSH 后重跑即可；想在缺 DSH 时直接失败，设 REQUIRE_DSH=1。');
  console.log('\n结果：通过 0，失败 0（已跳过）');
  process.exit(process.env.REQUIRE_DSH === '1' ? 1 : 0);
}
const { apply, inject, name, TOOL_NAMES } = await import('../index.js');
const { ROUTE_PREFIX } = await import('../lib/web.js');

/** apply 期间被挂上的 web 路由（真实 kernel 里由 webServer 服务接住）。 */
const mountedRoutes = [];

let passed = 0;
let failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✔ ${label}`); }
  else { failed += 1; failures.push(`${label} ${detail}`); console.log(`  ✘ ${label} ${detail}`); }
};

async function main() {
  console.log('== 插件装载 ==');

  // 关键回归 1：Cordis 要求插件先声明 inject 才能访问 ctx 上的服务。
  // 不声明就 ctx.tools.register(...) 会在**真实宿主**里抛：
  //   Error: cannot get property "tools" without inject
  // 而用普通对象伪造 ctx 的测试**测不出这个契约**——早期 78 项测试全绿，
  // 宿主却一直 failed，根因就在这。所以必须静态断言 inject 已导出且含 "tools"。
  check('导出 inject（Cordis 依赖声明）', Array.isArray(inject), String(inject));
  check('inject 含 "tools"', Array.isArray(inject) && inject.includes('tools'), String(inject));

  // 关键回归 2：宿主装载器按「包名」解析入口（import('dsh-video-clone')），走的是
  // package.json 的 exports["."]，而不是仓库根目录的 index.js。早期 exports["."]
  // 指向 lib/index.js（纯库入口，没有 apply），于是装载器拿到一个没有 apply 的
  // 模块、静默不注册任何工具——工具列表里什么都看不到，宿主也不报错。
  // 这里必须按真实解析路径验证，不能直接 import('../index.js') 抄近路。
  const manifest = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'));
  const resolvedEntry = manifest.exports?.['.'] ?? manifest.main;
  check('package.json 声明了解析入口', typeof resolvedEntry === 'string' && resolvedEntry.length > 0, String(resolvedEntry));
  const byPackage = await import('dsh-video-clone');
  check('按包名解析到的是宿主插件入口（有 apply）', typeof byPackage.apply === 'function', `exports["."]=${resolvedEntry} → apply=${typeof byPackage.apply}`);
  check('按包名解析的 name 一致', byPackage.name === 'video-clone', String(byPackage.name));
  check('按包名解析的 TOOL_NAMES 一致', Array.isArray(byPackage.TOOL_NAMES) && byPackage.TOOL_NAMES.join(',') === TOOL_NAMES.join(','), String(byPackage.TOOL_NAMES));
  check('包名入口与文件入口是同一个 apply', byPackage.apply === apply);

  const registered = [];
  // 伪造的 ctx 必须**模仿 Cordis 的严格性**：未在 inject 里声明的服务，
  // 读取时抛 "cannot get property X without inject"。
  // 早期这里是个普通对象 { tools: {...} }，怎么读都不报错，于是掩盖了
  // 「apply 没声明 inject」这个真故障——宿主里一直 failed，测试却全绿。
  const declared = new Set(Array.isArray(inject) ? inject : []);
  const makeStrictCtx = (services, extraAllowed = new Set()) => new Proxy(services, {
    get(target, prop) {
      const key = typeof prop === 'string' ? prop : '';
      // effect / inject 是 Cordis **核心方法**，不是服务，因此不需要 inject 声明。
      if (key === 'effect') return (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; };
      if (key === 'inject') {
        return (deps, callback) => {
          const list = Array.isArray(deps) ? deps : [deps];
          // 真实语义：依赖不全时回调**根本不执行**，插件照常激活。
          if (!list.every((d) => d in target)) return () => {};
          // 关键语义：回调拿到的是**作用域到这些依赖上的子 ctx**，
          // 所以它可以直接读 ctx.webServer —— 即使 webServer 不在模块级 inject 里。
          // 漏掉这条，可选依赖的正常写法会被误判成违约。
          const scoped = makeStrictCtx(target, new Set([...extraAllowed, ...list]));
          const result = callback(scoped);
          return typeof result === 'function' ? result : () => {};
        };
      }
      if (typeof prop === 'string' && prop in target) {
        if (!declared.has(prop) && !extraAllowed.has(prop)) {
          throw new Error(`cannot get property "${prop}" without inject`);
        }
        return target[prop];
      }
      return target[prop];
    },
  });

  // 情况一：没有 webServer（纯对话部署）。插件必须照样激活，两个工具照样注册。
  const fakeCtx = makeStrictCtx({ tools: { register: (tool) => registered.push(tool) }, on: () => {} });
  try {
    apply(fakeCtx, {});
  } catch (error) {
    check('apply 无异常（含 inject 契约）', false, error.message);
    process.exit(1);
  }
  check('apply 无异常（含 inject 契约）', true);
  check('无 webServer 时不着陆任何路由', mountedRoutes.length === 0, String(mountedRoutes.length));
  check('无 webServer 时两个工具仍全部注册', registered.length === 2, String(registered.length));

  // 情况二：有 webServer（web 部署）。面板路由必须挂上，且路径/类型正确。
  const registered2 = [];
  const webCtx = makeStrictCtx({
    tools: { register: (tool) => registered2.push(tool), on: () => {} },
    webServer: { register: (route) => { mountedRoutes.push(route); return () => {}; } },
  });
  try {
    apply(webCtx, {});
  } catch (error) {
    check('有 webServer 时 apply 无异常', false, error.message);
    process.exit(1);
  }
  check('有 webServer 时 apply 无异常', true);
  check('有 webServer 时两个工具照常注册', registered2.length === 2, String(registered2.length));
  check('有 webServer 时挂上前缀路由 ' + ROUTE_PREFIX,
    mountedRoutes.length === 1 && mountedRoutes[0].kind === 'prefix' && mountedRoutes[0].path === ROUTE_PREFIX,
    JSON.stringify(mountedRoutes.map((r) => ({ kind: r.kind, path: r.path }))));
  check('挂上的路由带 handler', typeof mountedRoutes[0]?.handler === 'function');
  check('注册了两个工具', registered.length === 2, String(registered.length));
  check('工具名与声明一致', registered.map((t) => t.name).join(',') === TOOL_NAMES.join(','), registered.map((t) => t.name).join(','));
  check('插件身份 name 为 video-clone', name === 'video-clone');

  for (const tool of registered) {
    check(`${tool.name} 有 description`, typeof tool.description === 'string' && tool.description.length > 30);
    check(`${tool.name} parameters 编译为 JSON Schema`, tool.parameters?.type === 'object' && typeof tool.parameters.properties === 'object', JSON.stringify(tool.parameters)?.slice(0, 80));
    check(`${tool.name} output.schema 已编译`, tool.output?.schema?.type === 'object');
    check(`${tool.name} 有 execute`, typeof tool.execute === 'function');
    const required = tool.parameters.required ?? [];
    check(`${tool.name} 必填参数正确`, tool.name === 'video_clone' ? required.includes('input') : required.includes('files'), JSON.stringify(required));
  }

  const cloneTool = registered.find((t) => t.name === 'video_clone');
  const scanTool = registered.find((t) => t.name === 'video_clone_scan');

  /* ── 真实执行 ───────────────────────────────────────────────────── */
  const dir = await mkdtemp(join(tmpdir(), 'dsh-video-clone-plugin-'));
  try {
    const src = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k', '-shortest', src]);

    const exec = { agent: { session: { header: { cwd: dir } } }, signal: { throwIfAborted() {} } };
    const result = await cloneTool.execute({
      input: 'clip.mp4', count: 3, labels: ['一号', '二号', '三号'],
      outputDir: 'clones', verify: 'frames', namePattern: '{name}_{label}{ext}',
    }, exec);

    check('execute 返回结构化结果', result && typeof result.ok === 'boolean');
    check('结果 ok=true', result.ok === true);
    check('副本数正确', result.copies.length === 3);
    check('相对路径按会话工作区解析', result.outputDir.startsWith(dir), result.outputDir);
    check('输出摘要非空', typeof result.summary === 'string' && result.summary.includes('guid='));
    check('校验字段齐全', typeof result.verification.layoutOk === 'boolean' && typeof result.verification.hashesAllDistinct === 'boolean');
    check('校验全部通过', result.verification.layoutOk && result.verification.hashesAllDistinct && result.verification.mediaOk === true);
    check('每份都有 32 位 GUID', result.copies.every((c) => /^[0-9a-f]{32}$/.test(c.guid)));
    check('标签随份传递', result.copies.map((c) => c.label).join(',') === '一号,二号,三号');
    check('GUID 两两不同', new Set(result.copies.map((c) => c.guid)).size === 3);
    check('哈希两两不同', new Set(result.copies.map((c) => c.sha256)).size === 3);

    // output schema 的形状必须与返回值一致（required 字段一个都不能少）
    const schema = cloneTool.output.schema;
    for (const key of schema.required) check(`output schema 必填字段 ${key} 存在`, Object.hasOwn(result, key));
    for (const copy of result.copies) {
      for (const key of schema.properties.copies.items.required) check(`copies[] 必填字段 ${key} 存在`, Object.hasOwn(copy, key), key);
    }

    /* ── scan 工具 ─────────────────────────────────────────────────── */
    const scan = await scanTool.execute({ files: [result.copies[0].path, result.copies[1].path] }, exec);
    check('scan 返回两个文件', scan.files.length === 2);
    check('scan 找回 GUID', scan.files.every((f) => f.markers.some((m) => m.valid)));
    check('scan 的 GUID 与 clone 一致', scan.files[0].markers.some((m) => m.guid === result.copies[0].guid));
    check('scan 摘要可读', typeof scan.summary === 'string' && scan.summary.includes('crc=OK'));
    const scanSchema = scanTool.output.schema;
    for (const key of scanSchema.required) check(`scan output 必填字段 ${key} 存在`, Object.hasOwn(scan, key));

    /* ── 无 cwd 时也能跑（绝对路径） ────────────────────────────────── */
    const abs = await cloneTool.execute({ input: src, count: 1, outputDir: join(dir, 'abs'), verify: 'off' }, { agent: undefined, signal: { throwIfAborted() {} } });
    check('无会话工作区时按绝对路径工作', abs.ok === true && abs.copies[0].path.startsWith(dir));

    /* ── 错误路径必须抛出可读异常 ───────────────────────────────────── */
    let threw = false;
    try {
      await cloneTool.execute({ input: join(dir, 'nope.mp4'), count: 1 }, exec);
    } catch (error) { threw = /不存在/.test(error.message); }
    check('源文件不存在时报错', threw);

    /* ── 账本落盘 ──────────────────────────────────────────────────── */
    const ledger = JSON.parse(await readFile(result.ledgerPath, 'utf8'));
    check('账本记录了工具身份与版本', ledger.tool === 'dsh-video-clone' && typeof ledger.version === 'string');
    check('账本副本数与结果一致', ledger.copies.length === 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  if (failures.length) { console.log('失败项：'); for (const f of failures) console.log(`  - ${f}`); }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
