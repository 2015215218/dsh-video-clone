#!/usr/bin/env node
/**
 * 版本管理与包装清单的守卫。
 *
 * 单独一套，因为它测的不是「功能对不对」，而是「这个包有没有被正确地说成它
 * 自己」—— 版本号、清单、changelog、发出去的文件。这类东西出错时功能全绿、
 * 用户那边却坏掉，所以必须单独钉住：
 *
 *   node test/version-tests.js
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

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
const section = (t) => console.log(`\n== ${t} ==`);

const pkg = JSON.parse(read('package.json'));
const log = read('CHANGELOG.md');

/* ── 版本号只有一个来源 ─────────────────────────────────────────────── */

section('版本号的事实源');

const SEMVER = /^\d+\.\d+\.\d+$/;
ok('package.json 的 version 是 x.y.z 形式', SEMVER.test(pkg.version), pkg.version);

let TOOL_VERSION = null;
try {
  ({ TOOL_VERSION } = await import('../lib/clone.js'));
} catch (err) {
  ok('能加载 lib/clone.js', false, String(err.message));
}
ok('TOOL_VERSION 能取到', typeof TOOL_VERSION === 'string', String(TOOL_VERSION));

// 这一条是整套里最重要的：TOOL_VERSION 会流进**溯源账本**的 version 字段。
// 两处漂移 = 账本记下一个根本不存在的版本，是溯源完整性问题，不是笔误。
ok('TOOL_VERSION 与 package.json 完全一致',
  TOOL_VERSION === pkg.version, `TOOL_VERSION=${TOOL_VERSION} pkg=${pkg.version}`);

const cloneSrc = read('lib/clone.js');

// 防回退：曾经 lib/clone.js 里硬编码过 '1.0.0'。允许它出现在**注释**里讲道理，
// 但不允许在**代码**里再出现一个与当前版本号相同的字面量 —— 那正是漂移的开始。
//
// 先剥注释再扫（理由同 web-tests 里的主题 token 审计：注释里引用旧值是为了讲清
// 道理，不是声明）。只剥块注释与「整行以 // 开头」的行 —— 不碰行内，免得把
// 字符串里的 `https://` 之类误伤，那反而会漏掉真问题。
const cloneCode = cloneSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const literal = [...cloneCode.matchAll(/'(\d+\.\d+\.\d+)'/g)].map((m) => m[1]);
ok('lib/clone.js 的代码里没有硬编码的版本号字面量',
  !literal.includes(pkg.version), `发现字面量 ${JSON.stringify(literal)}`);

// 反过来确证这条守卫真的在扫东西 —— 否则「没发现问题」可能是因为根本没扫到内容
ok('（自检）剥注释后仍然扫得到代码', cloneCode.includes('createRequire'), `${cloneCode.length} 字符`);

// 账本里那条 version 必须是 TOOL_VERSION，不能是别的
const cloneSrcUses = /version:\s*TOOL_VERSION/.test(cloneSrc);
ok('账本写入的是 TOOL_VERSION（不是另写的常量）', cloneSrcUses);

/* ── CHANGELOG ─────────────────────────────────────────────────────── */

section('CHANGELOG');

ok('存在 CHANGELOG.md', existsSync(join(ROOT, 'CHANGELOG.md')));
ok('有 `## [Unreleased]` 段落（发版脚本要靠它滚动）', /^## \[Unreleased\]$/m.test(log));

const headings = [...log.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?$/gm)]
  .map((m) => ({ version: m[1], date: m[2] }));

ok('至少有一个版本段落', headings.length >= 1, JSON.stringify(headings.map((h) => h.version)));

const released = headings.filter((h) => h.version !== 'Unreleased');
ok(`当前版本 ${pkg.version} 在 CHANGELOG 里有条目`,
  released.some((h) => h.version === pkg.version),
  `CHANGELOG 里只有 ${JSON.stringify(released.map((h) => h.version))}`);

const current = released.find((h) => h.version === pkg.version);
ok('当前版本的条目带日期', Boolean(current?.date), JSON.stringify(current));

ok('每个已发布版本都有日期', released.every((h) => Boolean(h.date)),
  JSON.stringify(released.filter((h) => !h.date)));

// 版本段落必须降序 —— 顺带能抓出「插错位置」
const nums = released.map((h) => h.version.split('.').map(Number));
const descending = nums.every((v, i) => i === 0 || (() => {
  const p = nums[i - 1];
  for (let k = 0; k < 3; k += 1) if (p[k] !== v[k]) return p[k] > v[k];
  return false;
})());
ok('版本段落按从新到旧排列', descending, JSON.stringify(released.map((h) => h.version)));

// 底部链接引用要齐 —— 缺了不会报错，只会悄悄不显示
const linkRefs = new Set([...log.matchAll(/^\[([^\]]+)\]: /gm)].map((m) => m[1]));
ok('底部有 [Unreleased] 链接', linkRefs.has('Unreleased'));
for (const h of released) {
  ok(`底部有 [${h.version}] 链接`, linkRefs.has(h.version));
}

/* ── 包装清单：发出去的那份里到底有没有运行必需的东西 ────────────────── */

section('包装清单（git 安装同样只带 files 白名单里的东西）');

const files = pkg.files ?? [];
const covered = (p) => files.some((f) => {
  const entry = f.replace(/\/$/, '');
  return p === entry || p.startsWith(`${entry}/`);
});

// 这些是运行时真的会被读到的路径。少任何一个，装下来就是个坏包 ——
// 而本地开发时察觉不到，因为本地有完整仓库。
const runtimePaths = [
  ['main 入口', pkg.main],
  ['exports["."]', pkg.exports?.['.']],
  ['exports["./client"]', pkg.exports?.['./client']],
  ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
  ...Object.entries(pkg.bin ?? {}).map(([n, p]) => [`bin.${n}`, p]),
];

for (const [label, p] of runtimePaths) {
  ok(`${label} 被 files 覆盖（${p}）`, Boolean(p) && covered(p.replace(/^\.\//, '')));
}

ok('files 里的每一条都真的存在',
  files.every((f) => existsSync(join(ROOT, f.replace(/\/$/, '')))),
  JSON.stringify(files.filter((f) => !existsSync(join(ROOT, f.replace(/\/$/, ''))))));

// README 里写着 `npm test` 能跑 4 套。装下来（npm 或 git 安装都只带 files 白名单）
// 如果 test/ 不在里面，那句话对装包的人就是假的 —— 顺手钉住。
ok('test/ 被 files 覆盖（否则 README 里的 `npm test` 对装下来的包是假的）',
  ['test/run-tests.js', 'test/plugin-tests.js', 'test/web-tests.js', 'test/version-tests.js'].every(covered));

/* ── 清单声明 ──────────────────────────────────────────────────────── */

section('清单声明');

ok('声明了 engines.node', typeof pkg.engines?.node === 'string', JSON.stringify(pkg.engines));
ok('声明了 license', typeof pkg.license === 'string', pkg.license);
ok('有 repository 字段（发版脚本要用它拼链接）', Boolean(pkg.repository?.url), JSON.stringify(pkg.repository));
ok('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web');
ok('dshhub.schemaVersion 存在', pkg.dshhub?.schemaVersion === 1);
ok('有 test 脚本', typeof pkg.scripts?.test === 'string', pkg.scripts?.test);
ok('有 release 脚本', typeof pkg.scripts?.release === 'string', pkg.scripts?.release);

console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}