#!/usr/bin/env node
/**
 * 发版脚本 —— `npm run release -- <patch|minor|major|x.y.z> [--push]`
 *
 * 为什么要有它：发版是「一串必须按顺序做对、漏一步就出错」的动作（升版本 →
 * 记 changelog → 提交 → 打 tag → 推送）。靠人记必然有一天漏掉某一环，而漏掉
 * 的表现是**过一阵子才发现**：tag 指向的提交里版本号没升、或者升了版本号却
 * 没有 changelog 条目。所以这里把每一步都做成断言，宁可现在停下。
 *
 * 默认**不推送**：本地做完提交与 tag，把推送命令打给你，你自己按。
 * 加 --push 才推。远端推错了虽然能删 tag，但没必要冒这个险。
 *
 * 另有 --dry-run 只打印将要发生的事，不动任何文件。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG_PATH = join(ROOT, 'package.json');
const LOG_PATH = join(ROOT, 'CHANGELOG.md');

/* ── 输出 ─────────────────────────────────────────────────────────── */

const say = (...a) => console.log(...a);
const step = (n, t) => console.log(`\n【${n}】${t}`);
function die(msg, hint) {
  console.error(`\n✘ ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/* ── 参数 ─────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));

const DRY = flags.has('--dry-run');
const PUSH = flags.has('--push');
const SKIP_TESTS = flags.has('--skip-tests');
const ALLOW_EMPTY = flags.has('--allow-empty');
const BRANCH = 'main';

const bump = positional[0];
if (!bump) {
  die('用法：npm run release -- <patch|minor|major|x.y.z> [--push] [--dry-run] [--skip-tests] [--allow-empty]');
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/* ── 1. 环境守卫 ───────────────────────────────────────────────────── */

step(1, '检查工作区');

if (!existsSync(join(ROOT, '.git'))) die('这里不是 git 仓库');

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const dirty = git('status', '--porcelain');

// 干跑刻意**不**校验这三项：干跑的用处正是「东西还没提交，先看一眼会怎样」。
// 真发版时才拦 —— 那时工作区不干净 / 不在 main / 落后于远端，都会发出版本事故。
if (DRY) {
  const dirtyCount = dirty ? dirty.split('\n').length : 0;
  say('  ⚠️  --dry-run：跳过「干净 / 在 main / 与远端同步」这三项检查');
  say(`      当前分支 ${branch}，未提交改动 ${dirtyCount} 处`);
} else {
  if (dirty) {
    die('工作区不干净，先提交或 stash 再发版', dirty.split('\n').map((l) => '  ' + l).join('\n'));
  }
  say('  ✔ 工作区干净');

  if (branch !== BRANCH) die(`当前在 ${branch}，发版请在 ${BRANCH} 上`);
  say(`  ✔ 在 ${BRANCH} 上`);

  // 与远端同步，避免发出版本之后才发现落后
  let local = '';
  let remote = '';
  try {
    git('fetch', '--quiet', 'origin', BRANCH);
    local = git('rev-parse', 'HEAD');
    remote = git('rev-parse', `origin/${BRANCH}`);
  } catch (err) {
    say(`  ⚠️  跳过远端同步检查：${String(err.message).split('\n')[0]}`);
  }
  if (local && remote) {
    if (local !== remote) {
      die(`本地 ${local.slice(0, 7)} 与 origin/${BRANCH} ${remote.slice(0, 7)} 不一致`,
        '先 pull / push，别在一个别人没有的基点上册封版本');
    }
    say(`  ✔ 与 origin/${BRANCH} 同步（${local.slice(0, 7)}）`);
  }
}

/* ── 2. 测试 ──────────────────────────────────────────────────────── */

step(2, '跑测试');
if (SKIP_TESTS) {
  say('  ⚠️  --skip-tests，跳过（不推荐）');
} else {
  try {
    execFileSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    die('测试没过，不发版');
  }
  say('  ✔ 测试通过');
}

/* ── 3. 算新版本号 ────────────────────────────────────────────────── */

step(3, '确定新版本号');

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const current = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(current)) die(`当前版本号不是 x.y.z 形式：${current}`);

function nextVersion(from, what) {
  const [maj, min, pat] = from.split('.').map(Number);
  if (what === 'major') return `${maj + 1}.0.0`;
  if (what === 'minor') return `${maj}.${min + 1}.0`;
  if (what === 'patch') return `${maj}.${min}.${pat + 1}`;
  if (/^\d+\.\d+\.\d+$/.test(what)) return what;
  die(`看不懂的版本参数：${what}（要 patch / minor / major / x.y.z）`);
}

const next = nextVersion(current, bump);

function cmp(a, b) {
  const A = a.split('.').map(Number); const B = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
}
if (cmp(next, current) <= 0) die(`新版本 ${next} 不大于当前 ${current}`);
say(`  ${current} → ${next}`);

const tag = `v${next}`;
const existingTags = git('tag', '--list', tag);
if (existingTags) die(`tag ${tag} 已经存在`);

/* ── 4. 滚动 CHANGELOG ────────────────────────────────────────────── */

step(4, '滚动 CHANGELOG');

const log = readFileSync(LOG_PATH, 'utf8');
if (!/^## \[Unreleased\]$/m.test(log)) die('CHANGELOG 里找不到 `## [Unreleased]` 标题');

// 取出 Unreleased 段落正文，确认真的写了东西
const body = log.split(/^## \[Unreleased\]$/m)[1]?.split(/^## \[/m)[0] ?? '';
const changed = body.replace(/\s|<!--[\s\S]*?-->/g, '');
if (!changed && !ALLOW_EMPTY) {
  die('`## [Unreleased]` 下面是空的 —— 没有可记的变更就没什么可发的',
    '确实要发空版本加 --allow-empty');
}
say(`  ✔ Unreleased 段有内容（${changed.length} 字符）`);

const date = new Date().toLocaleDateString('sv-SE'); // sv-SE 直接给 YYYY-MM-DD
let newLog = log
  .replace(/^## \[Unreleased\]$/m, `## [Unreleased]\n\n## [${next}] - ${date}`)
  // 底部链接：Unreleased 的比较基点挪到新 tag，并为新版本补一条链接
  .replace(/^\[Unreleased\]: (\S+)\/compare\/v[^\s.]+(?:\.\d+)*\.\.\.HEAD$/m, `[Unreleased]: $1/compare/${tag}...HEAD`);

if (!newLog.includes(`[${next}]: `)) {
  const base = pkg.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '')
    ?? 'https://github.com/2015215218/dsh-video-clone';
  newLog = newLog.replace(/^\[Unreleased\]: .*$/m, (line) => `${line}\n[${next}]: ${base}/releases/tag/${tag}`);
}
say(`  ✔ 插入 \`## [${next}] - ${date}\``);

/* ── 5. 写入 ──────────────────────────────────────────────────────── */

step(5, '写入并提交');

if (DRY) {
  say('  --dry-run：以下都不会真的执行');
  say(`  会改 package.json  version: ${current} → ${next}`);
  say(`  会改 CHANGELOG.md  插入 [${next}] - ${date}`);
  say(`  会提交  chore(release): ${tag}`);
  say(`  会打 tag ${tag}（附注标签）`);
  if (PUSH) say(`  会推送 origin ${BRANCH} 与 ${tag}`);
  say('\n干跑结束，什么都没动。');
  process.exit(0);
}

// 只替换顶层那一个 version 字段，保持 JSON 其余格式原样
const newPkgText = readFileSync(PKG_PATH, 'utf8')
  .replace(/("version":\s*)"[^"]+"/, `$1"${next}"`);
if (!newPkgText.includes(`"version": "${next}"`)) die('package.json 版本号没写进去');
writeFileSync(PKG_PATH, newPkgText);
writeFileSync(LOG_PATH, newLog);

git('add', 'package.json', 'CHANGELOG.md');
git('commit', '--quiet', '-m', `chore(release): ${tag}`);

// 附注标签，消息里带上 changelog 正文 —— tag 自己就能说清这版改了什么
const note = body.trim() || `Release ${next}`;
git('tag', '-a', tag, '-m', `${tag}\n\n${note}`);

say(`  ✔ 提交 ${git('rev-parse', '--short', 'HEAD')}，tag ${tag}`);

/* ── 6. 推送 ──────────────────────────────────────────────────────── */

step(6, '推送');
if (!PUSH) {
  say('  默认不推。确认无误后执行：');
  say(`\n      git push origin ${BRANCH} && git push origin ${tag}\n`);
  say('  或者下次加 --push 一步到位。');
} else {
  git('push', 'origin', BRANCH);
  git('push', 'origin', tag);
  say(`  ✔ 已推送 ${BRANCH} 与 ${tag}`);
  say(`\n  GitHub Release：https://github.com/2015215218/dsh-video-clone/releases/new?tag=${tag}`);
}

/* ── 7. 装这套东西的那个 profile ──────────────────────────────────── */

const PROF = join(process.env.HOME ?? '', '.dsh', 'profiles', 'desktop');
const profPkg = join(PROF, 'package.json');
if (existsSync(profPkg)) {
  const spec = (JSON.parse(readFileSync(profPkg, 'utf8')).dependencies ?? {})['dsh-video-clone'];
  step(7, '本机 profile 的安装');
  say(`  当前依赖：${spec}`);
  if (spec?.startsWith('github:')) {
    const pinned = spec.includes('#');
    say(pinned
      ? `  钉在某个 ref 上，升级到 ${tag}：\n\n      cd ${PROF} && pnpm add ${spec.split('#')[0]}#${tag}\n`
      : `  跟 main 走，拉到这一版：\n\n      cd ${PROF} && pnpm update dsh-video-clone\n`);
  } else {
    say('  不是 github: 装的，自己看着办。');
  }
}