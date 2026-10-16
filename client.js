/**
 * dsh-video-clone 客户端半边 —— DSH Web GUI 里的「视频唯一化」工作台。
 *
 * 这是宿主 ModuleLoader 直接加载的裸模块，**没有构建步骤**：
 *   · 外层是 window.__ModuleLoader__.load({ id, factory }) 的工厂包装；
 *   · 工厂里用 require("react") 拿 React，用 React.createElement（不写 JSX，免得要编译器）；
 *   · 导出 apply / inject 两个名字，契约与宿主半边一致。
 *
 * 界面语言：拉丁字形 + 中文，与 DSH 的 zh 界面一致；颜色全部走主题 token
 * （--dsw-alias-*），因此亮/暗主题自动跟随，不必自己判断。
 *
 * 面板只通过 fetch 调 /video-clone/api，不直接碰任何克隆逻辑——
 * 三条路径（CLI / 工具 / 面板）共用宿主那一份实现。
 */

window.__ModuleLoader__.load({
	id: 'dsh-video-clone',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;
		const { useState, useEffect, useCallback, useRef } = React;

		const PANEL_ID = 'video-clone';
		const API = '/video-clone/api';

		/** 面板需要的能力：只要 slot 席位。侧边栏行由宿主自己渲染成按钮，
 *  选中/取消选中也归宿主管，插件不必（也不该）去碰布局服务。 */
		const inject = ['slots'];

		/* ───────────────────────── 宿主调用 ───────────────────────── */

		async function call(action, params) {
			const response = await fetch(API, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				cache: 'no-store',
				body: JSON.stringify({ action, ...(params ?? {}) }),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			if (!payload || payload.ok !== true) throw new Error(payload?.error || '宿主返回了失败结果');
			return payload.data;
		}

		/* ───────────────────────── 小工具 ───────────────────────── */

		function fmtBytes(n) {
			if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
			const units = ['B', 'KB', 'MB', 'GB', 'TB'];
			let v = n;
			let i = 0;
			while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
			return `${i === 0 ? v : v.toFixed(2)} ${units[i]}`;
		}

		function fmtDuration(ms) {
			if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
			const s = Math.floor(ms / 1000);
			if (s < 60) return `${s}s`;
			return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
		}

		function shortHash(value, n = 12) {
			if (typeof value !== 'string') return '—';
			return value.length <= n ? value : `${value.slice(0, n)}…`;
		}

		/* ───────────────────────── 面板状态持久化 ─────────────────────────
		 * 面板是 slot 组件：一切换到别的侧边栏条目，React 就把它卸载了，
		 * 再点回来 useState 全部归零——填好的源路径、份数、标签、上一轮的结果
		 * 全都丢。所以表单与最后一次结果落 localStorage，回来还是离开时的样子。
		 */

		const STORE_PREFIX = 'dsh-video-clone:';

		function storage() {
			try {
				return typeof window !== 'undefined' ? window.localStorage ?? null : null;
			} catch {
				return null; // 隐私模式 / 被策略禁用
			}
		}

		function loadStored(key, fallback) {
			const box = storage();
			if (!box) return fallback;
			try {
				const raw = box.getItem(STORE_PREFIX + key);
				return raw === null ? fallback : JSON.parse(raw);
			} catch {
				return fallback;
			}
		}

		function useStored(key, fallback) {
			const [value, setValue] = useState(() => loadStored(key, fallback));
			useEffect(() => {
				const box = storage();
				if (!box) return;
				try { box.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch { /* 配额满就算了 */ }
			}, [key, value]);
			return [value, setValue];
		}

		/** 从源路径推出默认输出目录（必须与宿主 cloneVideo 的默认规则逐字一致）。 */
		function defaultOutputDir(source) {
			const path = String(source ?? '').trim();
			if (!path) return '';
			const cut = path.lastIndexOf('/');
			if (cut <= 0) return '';
			const dir = path.slice(0, cut);
			const base = path.slice(cut + 1);
			// 等价于 Node 的 path.basename(p, path.extname(p))：只剥**最后一个**扩展名，
			// 而且点在开头（.hidden 这种）不算扩展名——用 /\.[^.]+$/ 会把整个名字吃掉。
			const dot = base.lastIndexOf('.');
			const stem = dot > 0 ? base.slice(0, dot) : base;
			return `${dir}/${stem}_clones`;
		}

		/** 把一串标签拆成数组，兼容中英文逗号、分号、换行。 */
		function splitList(text) {
			return String(text ?? '').split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean);
		}

		const PHASE_TEXT = {
			starting: '准备中',
			copy: '写出副本',
			stream: '校验编码流',
			frames: '校验解码帧',
			done: '完成',
		};

		function phaseLabel(job) {
			const base = PHASE_TEXT[job.phase] || job.phase || '运行中';
			if (job.total > 0 && job.index > 0) return `${base} ${job.index}/${job.total}`;
			return base;
		}

		/* ───────────────────────── 样式 ───────────────────────── */

		const STYLE_ID = 'dsh-video-clone-panel-style';
		const CSS = `
.vc-root { height: 100%; overflow: auto; padding: 20px 24px 40px; color: var(--dsw-alias-label-primary); }
.vc-shell { max-width: 1320px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.vc-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.vc-head h1 { font-size: 17px; font-weight: 600; margin: 0; }
.vc-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.vc-spacer { flex: 1 1 auto; }
.vc-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.vc-card > h2 { font-size: 13px; font-weight: 600; margin: 0; letter-spacing: .02em; }
.vc-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.vc-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.vc-field > label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vc-field.grow { flex: 1 1 320px; }
.vc-input, .vc-select, .vc-area {
  font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px; padding: 7px 9px; outline: none; min-width: 0; box-sizing: border-box; width: 100%;
}
.vc-input:focus, .vc-select:focus, .vc-area:focus { border-color: var(--dsw-alias-brand-primary); }
.vc-area { resize: vertical; min-height: 62px; font-family: inherit; line-height: 1.5; }
.vc-num { width: 84px; }
.vc-btn {
  font: inherit; font-size: 13px; cursor: pointer; border-radius: 7px; padding: 7px 14px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); white-space: nowrap; transition: opacity .12s, border-color .12s;
}
.vc-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.vc-btn:disabled { opacity: .45; cursor: not-allowed; }
/* 主按钮必须用主题自己的「对比色对」。
   --dsw-alias-brand-primary 是个**会翻转**的 token：浅色主题下是 #0f1115（近黑），
   深色主题下是 #f9fafb（近白）。所以它不能配写死的 #fff —— 深色主题里就成了
   白底白字，字完全看不见（实测踩过，两个主按钮的文案都没了）。
   平台自己的 toast 用的是这一对：
     背景 button-contrast-fill + 前景 label-primary-inverted
   两者在每套主题里都被定义成彼此对比，跟着走就不会翻车。 */
.vc-btn.primary {
  background: var(--dsw-alias-button-contrast-fill);
  border-color: var(--dsw-alias-button-contrast-fill);
  color: var(--dsw-alias-label-primary-inverted);
  font-weight: 600;
}
.vc-btn.ghost { background: transparent; }
.vc-btn.sm { font-size: 12px; padding: 4px 9px; }
.vc-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.vc-badge.ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.vc-badge.bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.vc-badge.warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.vc-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); line-height: 1.55; white-space: pre-wrap; word-break: break-all; }
.vc-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.vc-progress { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.vc-progress > i { display: block; height: 100%; background: var(--dsw-alias-brand-primary); transition: width .2s; }
.vc-browse { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); max-height: 300px; overflow: auto; }
.vc-browse-bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); position: sticky; top: 0; background: var(--dsw-alias-bg-layer-2); }
.vc-browse-path { font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.vc-item { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 12.5px; cursor: pointer; border: 0; background: transparent; width: 100%; text-align: left; color: inherit; font-family: inherit; }
.vc-item:hover { background: var(--dsw-alias-bg-layer-2); }
.vc-item .vc-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vc-item .vc-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; flex: 0 0 auto; }
.vc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.vc-table th, .vc-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.vc-table th { font-weight: 600; color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }
.vc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; word-break: break-all; }
.vc-scroll-x { overflow-x: auto; }
.vc-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.vc-split { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.vc-empty { font-size: 12.5px; color: var(--dsw-alias-label-secondary); padding: 6px 0; }
.vc-kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 12px; }
.vc-kv dt { color: var(--dsw-alias-label-secondary); }
.vc-kv dd { margin: 0; word-break: break-all; }
`;

		function installStyles() {
			// 面板只在浏览器里跑；这个守卫让 client.js 能在无 DOM 的环境（自检脚本）里被装载。
			if (typeof document === 'undefined') return () => {};
			if (document.getElementById(STYLE_ID)) return () => {};
			const el = document.createElement('style');
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
			return () => { el.remove(); };
		}

		/* ───────────────────────── 小组件 ───────────────────────── */

		function Field(props) {
			return h('div', { className: `vc-field${props.grow ? ' grow' : ''}` },
				props.label ? h('label', null, props.label) : null,
				props.children);
		}

		function Badge(props) {
			return h('span', { className: `vc-badge${props.tone ? ` ${props.tone}` : ''}`, title: props.title || undefined }, props.children);
		}

		/** 三项自证：布局 / 哈希互异 / 媒体层。 */
		function VerificationBadges({ verification }) {
			if (!verification) return null;
			const media = verification.media ?? {};
			const mediaText = media.ok === null || media.ok === undefined
				? `媒体层未校验`
				: media.ok ? `媒体层 OK（${media.level}）` : `媒体层失败（${media.level}）`;
			return h('div', { className: 'vc-tags' },
				h(Badge, { tone: verification.layoutOk ? 'ok' : 'bad' }, `字节布局 ${verification.layoutOk ? 'OK' : '失败'}`),
				h(Badge, { tone: verification.hashesAllDistinct ? 'ok' : 'bad' }, `哈希两两互异 ${verification.hashesAllDistinct ? 'OK' : '失败'}`),
				h(Badge, { tone: media.ok === null || media.ok === undefined ? '' : media.ok ? 'ok' : 'bad' }, mediaText),
				verification.ffmpegAvailable ? null : h(Badge, { tone: 'warn' }, '无 ffmpeg，已降级'));
		}

		function CopyTable({ copies }) {
			if (!copies || copies.length === 0) return null;
			return h('div', { className: 'vc-scroll-x' },
				h('table', { className: 'vc-table' },
					h('thead', null, h('tr', null,
						h('th', null, '#'),
						h('th', null, '标签'),
						h('th', null, '文件'),
						h('th', null, '大小'),
						h('th', null, 'GUID'),
						h('th', null, 'sha256'))),
					h('tbody', null, copies.map((c) => h('tr', { key: c.index },
						h('td', null, String(c.index + 1)),
						h('td', null, c.label || '—'),
						h('td', { className: 'vc-mono' }, c.file),
						h('td', { title: `${c.size} 字节（+${c.sizeDelta}）` }, fmtBytes(c.size)),
						h('td', { className: 'vc-mono' }, c.guid),
						h('td', { className: 'vc-mono', title: c.sha256 }, shortHash(c.sha256)))))));
		}

		/** 反查结果表：一个文件可能命中多个标记（可见元数据 + 尾部填充各一份）。 */
		function ScanTable({ files }) {
			const rows = [];
			for (const file of files) {
				const name = String(file.path).split('/').pop();
				if (file.markers.length === 0) {
					rows.push(h('tr', { key: `${file.path}#none` },
						h('td', { className: 'vc-mono' }, name),
						h('td', { colSpan: 3, className: 'vc-hint' }, '未找到标记')));
					continue;
				}
				for (const marker of file.markers) {
					rows.push(h('tr', { key: `${file.path}#${marker.offset}` },
						h('td', { className: 'vc-mono' }, name),
						h('td', null, String(marker.offset)),
						h('td', { className: 'vc-mono' }, marker.guid),
						h('td', null, marker.valid
							? h(Badge, { tone: 'ok' }, 'OK')
							: h(Badge, { tone: 'bad' }, 'MISMATCH'))));
				}
			}
			return h('div', { className: 'vc-scroll-x' },
				h('table', { className: 'vc-table' },
					h('thead', null,
						h('tr', null,
							h('th', null, '文件'),
							h('th', null, '偏移'),
							h('th', null, 'GUID'),
							h('th', null, 'CRC'))),
					h('tbody', null, rows)));
		}

		/* ───────────────────────── 目录浏览 ───────────────────────── */

		function DirectoryBrowser({ data, loading, error, onOpen, onPick, onClose }) {
			return h('div', { className: 'vc-browse' },
				h('div', { className: 'vc-browse-bar' },
					h('button', { className: 'vc-btn sm', onClick: () => onOpen(data?.parent), disabled: !data?.parent }, '↑ 上级'),
					h('span', { className: 'vc-browse-path', title: data?.path || '' }, data?.path || '…'),
					h('span', { className: 'vc-spacer', style: { flex: '1 1 auto' } }),
					h('button', { className: 'vc-btn sm ghost', onClick: onClose }, '关闭')),
				loading ? h('div', { className: 'vc-empty' }, '读取中…') : null,
				error ? h('div', { className: 'vc-error', style: { padding: '8px 10px' } }, error) : null,
				!loading && !error ? data?.dirs?.map((d) => h('button', {
					key: d.path, className: 'vc-item', onClick: () => onOpen(d.path),
				}, h('span', null, '📁'), h('span', { className: 'vc-name' }, d.name))) : null,
				!loading && !error ? data?.files?.map((f) => h('button', {
					key: f.path, className: 'vc-item', onClick: () => onPick(f.path),
				}, h('span', null, '🎬'), h('span', { className: 'vc-name' }, f.name), h('span', { className: 'vc-meta' }, fmtBytes(f.size)))) : null,
				!loading && !error && data && data.dirs.length === 0 && data.files.length === 0
					? h('div', { className: 'vc-empty', style: { padding: '8px 10px' } }, '这个目录里没有子目录，也没有常见格式的视频') : null);
		}

		/* ───────────────────────── 主面板 ───────────────────────── */

		function Panel(props) {
			const [host, setHost] = useState(null);
			const [hostError, setHostError] = useState(null);

			const [source, setSource] = useStored('source', '');
			const [count, setCount] = useStored('count', 5);
			const [mode, setMode] = useStored('mode', 'both');
			const [verify, setVerify] = useStored('verify', 'media');
			const [labels, setLabels] = useStored('labels', '');
			const [namePattern, setNamePattern] = useStored('namePattern', '');
			const [outputDir, setOutputDir] = useStored('outputDir', '');
			const [deriveFromLabel, setDeriveFromLabel] = useStored('deriveFromLabel', true);

			const [browse, setBrowse] = useState({ open: false, data: null, loading: false, error: null });
			const [picking, setPicking] = useState(false);
			const [showPrinciple, setShowPrinciple] = useStored('showPrinciple', false);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			const [job, setJob] = useState(null);
			const [result, setResult] = useStored('lastResult', null);
			const [plan, setPlan] = useState(null);

			const [scanInput, setScanInput] = useStored('scanInput', '');
			const [scanResult, setScanResult] = useStored('scanResult', null);
			const [scanError, setScanError] = useState(null); // 报错是瞬态，不持久化

			const jobIdRef = useRef(null);
			/** 面板卸载后别再往已经不在的组件里写状态。 */
			const aliveRef = useRef(true);
			useEffect(() => () => { aliveRef.current = false; }, []);

			/* 启动时读一次宿主状态 */
			useEffect(() => {
				let alive = true;
				call('state')
					.then((data) => { if (alive) setHost(data); })
					.catch((e) => { if (alive) setHostError(String(e.message ?? e)); });
				return () => { alive = false; };
			}, []);

			/* 任务进行中：轮询进度 */
			useEffect(() => {
				if (!job || job.state !== 'running') return undefined;
				let alive = true;
				const timer = setInterval(async () => {
					try {
						const next = await call('job', { jobId: job.id });
						if (!alive) return;
						if (next.missing) { setJob(null); return; }
						setJob(next);
						if (next.state === 'done') { setResult(next.result); jobIdRef.current = null; }
						if (next.state === 'failed' || next.state === 'cancelled') { setError(next.error); jobIdRef.current = null; }
					} catch (e) {
						if (alive) setError(String(e.message ?? e));
					}
				}, 700);
				return () => { alive = false; clearInterval(timer); };
			}, [job]);

			const openBrowse = useCallback(async (path) => {
				setBrowse((b) => ({ ...b, open: true, loading: true, error: null }));
				try {
					const data = await call('browse', { path: path || undefined, input: { source } });
					setBrowse({ open: true, data, loading: false, error: null });
				} catch (e) {
					setBrowse((b) => ({ ...b, loading: false, error: String(e.message ?? e) }));
				}
			}, [source]);

			/**
			 * 弹出宿主系统的**原生文件选择框**（macOS 走 osascript choose file，
			 * Windows 走 OpenFileDialog，Linux 走 zenity）。
			 * 对话框能开着好几分钟，所在宿主那边是后台进程，这里拿 pickId 轮询：
			 * 既不挂死 HTTP 请求，用户点「取消」也能安静地退回原状。
			 */
			const doPickFile = useCallback(async () => {
				if (picking) return;
				setPicking(true);
				setError(null);
				try {
					const started = await call('pickFile', { prompt: '选择源视频', input: { source } });
					for (;;) {
						await new Promise((r) => setTimeout(r, 500));
						if (!aliveRef.current) return;
						const st = await call('pickPoll', { pickId: started.pickId });
						if (st.missing) throw new Error('选择任务已过期，请重试');
						if (st.state === 'waiting') continue;
						if (st.state === 'done' && st.path) { setSource(st.path); break; }
						if (st.state === 'cancelled') break; // 用户自己取消，不算错误
						throw new Error(st.error || '选择失败');
					}
				} catch (e) {
					if (aliveRef.current) setError(String(e.message ?? e));
				} finally {
					if (aliveRef.current) setPicking(false);
				}
			}, [picking, source]);

			const inputPayload = useCallback(() => ({
				source,
				count: Number(count) || 5,
				mode,
				verify,
				labels,
				outputDir: outputDir || undefined,
				namePattern: namePattern || undefined,
				deriveFromLabel,
			}), [source, count, mode, verify, labels, outputDir, namePattern, deriveFromLabel]);

			const doPlan = useCallback(async () => {
				setBusy(true); setError(null); setPlan(null);
				try {
					setPlan(await call('plan', { input: inputPayload() }));
				} catch (e) {
					setError(String(e.message ?? e));
				} finally {
					setBusy(false);
				}
			}, [inputPayload]);

			const doClone = useCallback(async () => {
				setBusy(true); setError(null); setResult(null); setPlan(null);
				try {
					const started = await call('clone', { input: inputPayload() });
					jobIdRef.current = started.jobId;
					setJob(started.job);
				} catch (e) {
					setError(String(e.message ?? e));
				} finally {
					setBusy(false);
				}
			}, [inputPayload]);

			const doCancel = useCallback(async () => {
				if (!jobIdRef.current) return;
				try { await call('cancel', { jobId: jobIdRef.current }); } catch { /* 下一轮 job 会带回结果 */ }
			}, []);

			const doScan = useCallback(async () => {
				setScanError(null); setScanResult(null);
				const files = splitList(scanInput);
				if (files.length === 0) { setScanError('先填一个或多个文件路径'); return; }
				try {
					setScanResult(await call('scan', { files }));
				} catch (e) {
					setScanError(String(e.message ?? e));
				}
			}, [scanInput]);

			const labelCount = splitList(labels).length;
			const running = job?.state === 'running';
			const percent = running && job.total > 0 ? Math.min(100, Math.round((job.index / job.total) * 100)) : 0;

			return h('div', { className: 'vc-root' },
				h('div', { className: 'vc-shell' },

					/* 头部 */
					h('div', { className: 'vc-head' },
						h('h1', null, '视频唯一化分发'),
						host ? h(Badge, null, `v${host.version}`) : null,
						host ? h(Badge, { tone: host.ffmpeg.available ? 'ok' : 'warn' },
							host.ffmpeg.available ? 'ffmpeg 可用' : '无 ffmpeg') : null,
						h('span', { className: 'vc-spacer' }),
						h('button', {
							className: 'vc-btn sm ghost',
							onClick: () => { call('state').then(setHost).catch(() => {}); },
						}, '刷新状态')),

					h('div', { className: 'vc-sub' },
						'把一支视频复制成 N 份，每份写入一个唯一 GUID，文件哈希两两不同——画面与音轨一个字节都不改。'),

					hostError ? h('div', { className: 'vc-error' }, `读不到宿主状态：${hostError}`) : null,

					/* 源视频 */
					h('div', { className: 'vc-card' },
						h('h2', null, '1 · 源视频'),
						h('div', { className: 'vc-row' },
							h(Field, { label: '源视频绝对路径', grow: true },
								h('input', {
									className: 'vc-input', value: source, spellCheck: false,
									placeholder: '/Users/you/Movies/素材.mp4',
									onChange: (e) => setSource(e.target.value),
								})),
							h('button', {
								className: 'vc-btn primary',
								onClick: doPickFile,
								disabled: picking,
								title: '弹出系统原生的文件选择框',
							}, picking ? '等待选择…' : '选择文件…'),
							h('button', {
								className: 'vc-btn',
								onClick: () => (browse.open
									? setBrowse({ open: false, data: null, loading: false, error: null })
									: openBrowse()),
								disabled: browse.loading,
							}, browse.open ? '收起目录' : '浏览目录')),
						h('div', { className: 'vc-hint' },
							picking
								? '已弹出系统文件选择框，选完会自动填进上面的输入框；不想选就点对话框的取消。'
								: '「选择文件…」调的是你系统的原生对话框（macOS 的访达面板）；「浏览目录」是在面板内列目录，能顺带看文件大小。'),
						browse.open ? h(DirectoryBrowser, {
							data: browse.data, loading: browse.loading, error: browse.error,
							onOpen: (p) => openBrowse(p),
							onPick: (p) => { setSource(p); setBrowse({ open: false, data: null, loading: false, error: null }); },
							onClose: () => setBrowse({ open: false, data: null, loading: false, error: null }),
						}) : null),

					/* 参数 */
					h('div', { className: 'vc-card' },
						h('h2', null, '2 · 参数'),
						h('div', { className: 'vc-row' },
							h(Field, { label: '份数' },
								h('input', {
									className: 'vc-input vc-num', type: 'number', min: 1, max: 500, value: count,
									onChange: (e) => setCount(e.target.value),
								})),
							h(Field, { label: '写入策略' },
								h('select', { className: 'vc-select', value: mode, onChange: (e) => setMode(e.target.value) },
									h('option', { value: 'both' }, 'both · 元数据 + 尾部填充'),
									h('option', { value: 'meta' }, 'meta · 只写可见元数据'),
									h('option', { value: 'pad' }, 'pad · 只写隐形填充'))),
							h(Field, { label: '校验级别' },
								h('select', { className: 'vc-select', value: verify, onChange: (e) => setVerify(e.target.value) },
									h('option', { value: 'frames' }, 'frames · 逐帧解码比对（最硬）'),
									h('option', { value: 'media' }, 'media · 编码流哈希'),
									h('option', { value: 'hash' }, 'hash · 只比文件哈希'),
									h('option', { value: 'off' }, 'off · 不自证'))),
							h(Field, { label: '输出目录（留空 = 源旁 <名字>_clones）' },
								h('input', {
									className: 'vc-input', value: outputDir, spellCheck: false,
									placeholder: defaultOutputDir(source) || '（先选源视频）',
									onChange: (e) => setOutputDir(e.target.value),
								}),
								// 默认目录原来只写「（默认）」，根本看不出文件会落在哪。
								// 直接把宿主真会用的那条路径显示出来。
								!outputDir && defaultOutputDir(source)
									? h('div', { className: 'vc-hint vc-mono', style: { marginTop: 4 } },
										`将输出到 ${defaultOutputDir(source)}`)
									: null)),
						h('div', { className: 'vc-row' },
							h(Field, { label: `标签 · 每行一个（已填 ${labelCount} 个，少于份数时其余无标签）`, grow: true },
								h('textarea', {
									className: 'vc-area', value: labels, spellCheck: false,
									placeholder: '抖音号A\n视频号B\n小红书C',
									onChange: (e) => setLabels(e.target.value),
								})),
							h(Field, { label: '文件名模板' },
								h('input', {
									className: 'vc-input', value: namePattern, spellCheck: false,
									placeholder: '{name}_{i:03}{ext}',
									onChange: (e) => setNamePattern(e.target.value),
								}))),
						h('div', { className: 'vc-split' },
							h('label', { className: 'vc-hint', style: { display: 'flex', gap: 6, alignItems: 'center' } },
								h('input', {
									type: 'checkbox', checked: deriveFromLabel,
									onChange: (e) => setDeriveFromLabel(e.target.checked),
								}),
								'用标签确定性推导 GUID（同一标签永远得到同一 GUID，账本丢了也能重算比对）'))),

					/* 动作 */
					h('div', { className: 'vc-row' },
						h('button', { className: 'vc-btn primary', onClick: doClone, disabled: busy || running || !source }, '开始生成'),
						h('button', { className: 'vc-btn', onClick: doPlan, disabled: busy || running || !source }, '预估（不写文件）'),
						running ? h('button', { className: 'vc-btn', onClick: doCancel }, '取消') : null),

					/* 预估结果：原来挤在按钮右边一行小字里，基本看不见 */
					plan ? h('div', { className: 'vc-card' },
						h('div', { className: 'vc-split' },
							h('strong', { style: { fontSize: 12.5 } }, '预估结果'),
							h(Badge, null, `容器 ${plan.container}`),
							h(Badge, null, `策略 ${plan.strategy}`),
							h(Badge, { tone: plan.sizeDelta === 0 ? 'ok' : '' },
								`体积差 ${plan.sizeDelta >= 0 ? '+' : ''}${plan.sizeDelta} 字节`),
							plan.degraded ? h(Badge, { tone: 'warn' }, '已降级') : null),
						plan.notes?.length
							? h('div', { className: 'vc-hint' }, plan.notes.join('；'))
							: null,
						h('div', { className: 'vc-hint' },
							'还没写任何文件。点「开始生成」才会落盘。')) : null,

					/* 进度 */
					running ? h('div', { className: 'vc-card' },
						h('div', { className: 'vc-split' },
							h('span', { className: 'vc-hint' }, phaseLabel(job)),
							h('span', { className: 'vc-spacer' }),
							h('span', { className: 'vc-hint' }, fmtDuration(job.elapsedMs))),
						h('div', { className: 'vc-progress' }, h('i', { style: { width: `${percent}%` } })),
						job.file ? h('div', { className: 'vc-hint vc-mono' }, job.file) : null) : null,

					error ? h('div', { className: 'vc-card' }, h('div', { className: 'vc-error' }, error)) : null,

					/* 结果 */
					result ? h('div', { className: 'vc-card' },
						h('h2', null, '3 · 结果'),
						h(VerificationBadges, { verification: result.verification }),
						h('dl', { className: 'vc-kv' },
							h('dt', null, '源文件'), h('dd', { className: 'vc-mono' }, `${result.source.path}（${fmtBytes(result.source.size)}）`),
							h('dt', null, '容器'), h('dd', null, `${result.container}　策略 ${result.copies[0]?.strategy ?? '—'}　写入 ${result.mode}`),
							h('dt', null, '输出目录'), h('dd', { className: 'vc-mono' }, result.outputDir),
							h('dt', null, '账本'), h('dd', { className: 'vc-mono' }, result.ledgerPath)),
						h('div', { className: 'vc-row' },
							h('button', { className: 'vc-btn sm', onClick: () => call('reveal', { path: result.outputDir }).catch(() => {}) }, '在访达中打开输出目录'),
							h('button', {
								className: 'vc-btn sm ghost',
								onClick: () => {
									const paths = result.copies.map((c) => `${result.outputDir}/${c.file}`).join('\n');
									setScanInput(paths);
								},
							}, '把这批文件填进反查框')),
						h(CopyTable, { copies: result.copies })) : null,

					/* 反查 */
					h('div', { className: 'vc-card' },
						h('h2', null, '反查 · 谁发的'),
						h('div', { className: 'vc-hint' }, '贴一个或多个文件路径（每行一个），读出里面写的 GUID 与来源标签。'),
						h('textarea', {
							className: 'vc-area', value: scanInput, spellCheck: false,
							placeholder: '/Users/you/Movies/素材_clones/素材_001.mp4',
							onChange: (e) => setScanInput(e.target.value),
						}),
						h('div', { className: 'vc-row' },
							h('button', { className: 'vc-btn', onClick: doScan, disabled: !scanInput.trim() }, '扫描')),
						scanError ? h('div', { className: 'vc-error' }, scanError) : null,
						scanResult ? h(ScanTable, { files: scanResult.files }) : null),

					/* 说明：原来是一整段常驻小字，读过一次就是噪音。折叠起来，默认只留标题。 */
					h('div', { className: 'vc-card' },
						h('button', {
							className: 'vc-btn sm ghost',
							style: { alignSelf: 'flex-start', padding: '2px 0', border: 0 },
							onClick: () => setShowPrinciple(!showPrinciple),
						}, showPrinciple ? '▾ 原理与边界' : '▸ 原理与边界'),
						showPrinciple ? h('div', { className: 'vc-hint', style: { display: 'grid', gap: 6 } },
							h('div', null, '只改容器层：MP4 写 moov/udta 注释 + 尾部 free box，MKV 写 Void + Tags，AVI 写 JUNK，TS 写 null packet，FLV 写 script tag。媒体数据区间永远不被触碰，副本可与源逐字节比对。'),
							h('div', null, 'meta 模式写的注释可以被转码或 -map_metadata -1 剥掉；尾部填充因为动到它就等于动文件结构，反而更耐操。所以默认 both：两处都写，剥掉一处仍能溯源。'),
							h('div', { className: 'vc-error', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
								'边界：这不会影响平台的内容层查重。像素与音频采样一个都没变，感知哈希仍然相同——它给的是唯一标识与事后溯源，不是过查重。')) : null)));
		}

		/* ───────────────────────── 侧边栏图标 ───────────────────────── */

		function SidebarIcon(props) {
			// ownerProps 由宿主的 sidebar.panellist 目录给定：{ size: number, active: boolean }
			const size = Number.isFinite(props?.size) ? props.size : 16;
			const active = props?.active === true;
			return h('svg', {
				viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
				stroke: 'currentColor', 'aria-hidden': 'true', style: { display: 'block' },
			},
				h('rect', {
					x: 2, y: 3.5, width: 9, height: 9, rx: 1.2, strokeLinejoin: 'round',
					fill: active ? 'currentColor' : 'none',
					fillOpacity: active ? 0.18 : 0,
				}),
				h('path', { d: 'M12.5 5.5v7a1 1 0 0 1-1 1h-6', strokeLinecap: 'round' }),
				h('path', { d: 'M4.5 6.5h4', strokeLinecap: 'round' }),
				h('path', { d: 'M4.5 9h2.5', strokeLinecap: 'round' }));
		}

		/* ───────────────────────── 装载 ───────────────────────── */

		function apply(ctx) {
			ctx.effect(() => installStyles(), 'video-clone: panel styles');

			// main 必须先于 panellist 行就绪：宿主会拒绝选中一张还没有页面的侧边栏行。
			// 不声明 inject：main 的实测目录里 ownerProps 是空的，宿主不喂任何 prop，
			// 面板需要的状态全部自己在组件里拿，声明 inject 只是噪音。
			ctx.slots.inject('main', () => ctx.slots.register({
				name: 'main',
				key: PANEL_ID,
			}, Panel));

			// id 必须与 main 的 key 逐字相同 —— 侧边栏行就是按这个 id 去 main 里找页面的。
			ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
				name: 'sidebar.panellist',
				id: PANEL_ID,
				order: 45,
				label: '视频唯一化',
			}, SidebarIcon));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.PANEL_ID = PANEL_ID;
		exports.ROUTE_PREFIX = API;
		// 纯函数的测试出口。放在 __test 下，免得看起来像对外 API。
		exports.__test = { defaultOutputDir, splitList, fmtBytes, fmtDuration, shortHash };
		return module.exports;
	},
});