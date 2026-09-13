/**
 * dsh-apollo — 工程模式设置面板 + 实时代理树（浏览器半边）。
 *
 * 本文件即最终产物（closure-factory 格式，与 dsh-web 生态 tsdown client 预设
 * 的输出同构）：执行时向 window.__ModuleLoader__ 注册工厂，externals（react）
 * 经注入的 require 从浏览器模块表解析。两个座位：
 *
 * 1. 官方 Plugins 设置分区的 `settings.plugins.tab` ——「工程模式」标签页
 *    （dsh-plugin-manager 同款注入方式）：退出守卫开关，经 host 半边的
 *    /eng-panel/api/config 读写；
 * 2. 会话标题栏的 `conversation.session.header.actions` ——「子代理树」按钮，
 *    展开右下角浮动面板。目录来自 `sessions` 服务的 subagentsByParent 快照，
 *    每个运行中节点的最后一行输出/最后一个工具来自 `remote.session.follow`
 *    的推送流（不是轮询）。
 *
 * 注册 id 必须等于包名：client-modules 按包名建图行，校验脚本注册的 id
 * 与图行一致，否则启动即报 "loaded without registering"。
 *
 * 零构建（手写 createElement，不用 JSX）；文案经 ctx.locale 注册 zh/en。
 * apply 期与座位渲染期自身不抛（读取服务/目录/流的调用一律 try/catch 后 log）：
 * 框架为每个 entry 备了错误边界，但我们自己的座位不把异常甩给它——外部插件抛错
 * 会让整个 Web shell 启动失败。
 */

window.__ModuleLoader__.load({
	id: 'dsh-apollo',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const { createElement: h, useEffect, useRef, useState } = require('react');

		const NS = 'eng-panel';

		const zh = {
			tab: '工程模式',
			title: '工程模式',
			description: '工程模式预设的运行时配置，保存至 ~/.dsh/eng.json，保存后即时生效（无需重启）。',
			guardLabel: '退出守卫',
			guardHint: '仍有运行中的子代理或后台命令时，阻止回合结束并提醒用 wait_subagent / job_output 等待收取、job_kill 停止；全部处理完再收尾。用户中断（Esc）不受影响。',
			save: '保存',
			saving: '保存中…',
			saved: '已保存',
			loading: '加载中…',
			loadFailed: '读取配置失败',
			retry: '重试',
			saveFailed: '保存失败：',
			treeButton: '🌳 子代理',
			treeTitle: '子代理树',
			treeClose: '关闭',
			treeEmpty: '暂无子代理',
			treeLoading: '加载中…',
			treeLoadFailed: '子代理目录读取失败',
			treeCatalogUnavailable: '目录不可用',
			treeReadFailed: '读取失败',
			treeLiveUnavailable: '实时不可用',
			treeRunning: '运行中',
			treeInactive: '已结束',
			treeLastActive: '最后活动',
			treeAgeSeconds: '{n} 秒前',
			treeAgeMinutes: '{n} 分钟前',
			treeAgeHours: '{n} 小时前',
			treeLastTool: '最后工具',
			treeExpand: '展开',
			treeCollapse: '收起',
		};

		const en = {
			tab: 'Eng Mode',
			title: 'Eng Mode',
			description: 'Runtime configuration for the eng preset, persisted to ~/.dsh/eng.json and applied immediately (no restart needed).',
			guardLabel: 'Exit guard',
			guardHint: 'Blocks turn end while subagents or background jobs are still running, prompting wait_subagent / job_output to collect and job_kill to stop; interrupt (Esc) always passes through.',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved',
			loading: 'Loading…',
			loadFailed: 'Failed to load configuration',
			retry: 'Retry',
			saveFailed: 'Save failed: ',
			treeButton: '🌳 Subagents',
			treeTitle: 'Subagent tree',
			treeClose: 'Close',
			treeEmpty: 'No subagents',
			treeLoading: 'Loading…',
			treeLoadFailed: 'Failed to load the subagent catalog',
			treeCatalogUnavailable: 'Catalog unavailable',
			treeReadFailed: 'Read failed',
			treeLiveUnavailable: 'Live updates unavailable',
			treeRunning: 'running',
			treeInactive: 'finished',
			treeLastActive: 'Last active',
			treeAgeSeconds: '{n}s ago',
			treeAgeMinutes: '{n}m ago',
			treeAgeHours: '{n}h ago',
			treeLastTool: 'Last tool',
			treeExpand: 'Expand',
			treeCollapse: 'Collapse',
		};

		/** 词条插值：{n} 由 params 填充，缺席的占位符原样保留。 */
		function interpolate(template, params) {
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
		}

		// 默认中文；apply 挂上 locale 服务后由 ctx.locale.bind 接管。
		let t = (key, params) => interpolate(zh[key] ?? key, params);

		/** apply 捕获的客户端 ctx：座位在渲染时经它读取实时服务。 */
		let clientCtx;

		/**
		 * 折叠窗口：`maxMessages` 的切点锚在倒数第 N 条 `user/message`（上游
		 * `nthMessageCut` 的语义），不是"N 条事件"。子代理会话通常只有 1–4 条
		 * user 消息，所以这 4 条的下场是**整段日志**的开场快照（实测单个子代理
		 * ~38 万字节）；正因为一次重开等于重付整段日志，流必须按节点增量管理
		 * （见 SubagentTreePanel 的流 effect），不能因任一节点翻转就全量重开。
		 */
		const FOLLOW_MAX_MESSAGES = 4;

		/**
		 * 一路 follow 的请求体：`SessionAddress` 是判别联合，子代理地址必须带
		 * `kind: 'subagent'`；`assistantStream` 在类型上是字面量 `true`，本面板
		 * 不要 token 级增量，所以整字段省略（省略等价于未订阅；写 `false` 既不
		 * 满足类型、真实链路上也已被验证会让网关按参数拒收这一路请求）。提成
		 * 纯函数是为了让单测钉住这个线上契约。
		 */
		function followRequest(parentSessionId, childSessionId, mode) {
			return {
				address: { kind: 'subagent', parentSessionId, childSessionId, mode },
				maxMessages: FOLLOW_MAX_MESSAGES,
			};
		}
		/** "最后一行"展示上限（字符）。 */
		const LAST_LINE_LIMIT = 120;
		/** 秒/分钟分界：小于 90 秒报秒，否则报整分钟。 */
		const AGE_SECONDS_LIMIT = 90;
		/** 分钟/小时分界：不足 60 分钟报分钟，否则报整小时。 */
		const AGE_MINUTES_LIMIT = 60;

		/** 共享空目录：选择器返回 undefined 时保持同一引用，避免无谓重渲染。 */
		const NO_CATALOG = Object.freeze({});

		const styles = {
			wrap: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary, inherit)' },
			hint: { margin: 0, color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '13px', lineHeight: '20px' },
			row: { display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '14px' },
			checkbox: { marginTop: '3px' },
			actions: { display: 'flex', alignItems: 'center', gap: '10px' },
			button: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2, #555)', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'inherit', padding: '4px 12px' },
			ok: { color: 'var(--dsw-alias-state-success-primary, #3c3)', fontSize: '13px' },
			error: { color: 'var(--dsw-alias-state-error-primary, #c33)', fontSize: '13px' },
			seat: { display: 'inline-flex', alignItems: 'center' },
			headerButton: { font: 'inherit', fontSize: '13px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', border: '1px solid var(--dsw-alias-border-l2, #555)', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'var(--dsw-alias-label-primary, inherit)', padding: '2px 8px' },
			badge: { display: 'inline-block', minWidth: '16px', padding: '0 4px', borderRadius: '8px', background: 'var(--dsw-alias-state-success-primary, #3c3)', color: '#fff', fontSize: '11px', lineHeight: '16px', textAlign: 'center' },
			treePanel: { position: 'fixed', right: '16px', bottom: '16px', width: '380px', maxHeight: '45vh', display: 'flex', flexDirection: 'column', zIndex: 40, border: '1px solid var(--dsw-alias-border-l2, #555)', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2, #1b1b1b)', color: 'var(--dsw-alias-label-primary, inherit)', boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)', fontSize: '13px' },
			treePanelHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2, #555)' },
			treePanelTitle: { fontWeight: 600 },
			treeClose: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', padding: '0 4px', fontSize: '16px', lineHeight: '16px' },
			treePanelBody: { overflow: 'auto', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: '6px' },
			treeEmpty: { margin: 0, color: 'var(--dsw-alias-label-tertiary, #888)' },
			treeError: { margin: 0, color: 'var(--dsw-alias-state-error-primary, #c33)' },
			treeRow: { display: 'flex', flexDirection: 'column', gap: '2px' },
			treeRowHead: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
			treeToggle: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', padding: 0, width: '14px' },
			treeToggleSpacer: { display: 'inline-block', width: '14px' },
			treeLabel: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '170px', textAlign: 'left' },
			treeMeta: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '12px', whiteSpace: 'nowrap' },
			dotRunning: { color: 'var(--dsw-alias-state-success-primary, #3c3)', fontSize: '10px' },
			dotIdle: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '10px' },
			treeDetail: { color: 'var(--dsw-alias-label-secondary, #aaa)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: '20px' },
		};

		/** 记一条诊断：外部插件的异常只能进 console，不能进渲染。 */
		function logWarn(message, error) {
			try {
				console.warn(`[dsh-apollo] ${message}`, error);
			} catch {
				// console 不可用时静默：诊断本身不值得让调用方失败。
			}
		}

		/** 读取客户端服务；ctx 缺失或服务未挂载时给 undefined，不抛。 */
		function service(name) {
			try {
				return typeof clientCtx?.get === 'function' ? clientCtx.get(name) : undefined;
			} catch (error) {
				logWarn(`service ${name}`, error);
				return undefined;
			}
		}

		/** 座位的翻译函数：props.t 缺失或行为异常时退回本模块词条，永远返回字符串。 */
		function translator(candidate) {
			return (key, params) => {
				try {
					const value = typeof candidate === 'function' ? candidate(key, params) : t(key, params);
					return typeof value === 'string' ? value : String(value ?? key);
				} catch (error) {
					logWarn(`translate ${key}`, error);
					return key;
				}
			};
		}

		/** 把一段文本压平成单行并截断；非字符串或空白给 undefined。 */
		function clampText(value) {
			if (typeof value !== 'string') return undefined;
			const flat = value.replace(/\s+/g, ' ').trim();
			if (flat === '') return undefined;
			return flat.length > LAST_LINE_LIMIT ? `${flat.slice(0, LAST_LINE_LIMIT - 1)}…` : flat;
		}

		/** 事件时间：非有限数值时保持上一次的时间。 */
		function eventTime(event, fallback) {
			return typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : fallback;
		}

		/**
		 * 折叠单条事件；不是本面板渲染的两类事件、或 data 形状不符时原样返回。
		 *
		 * `user/message` 是**回合边界**：新的用户输入意味着上一轮的助手文本与
		 * 工具名已经过期，必须清空（只推进 lastTime）。少了这个重置，带 fork
		 * 种子前缀的子代理在自己还没产出时会把父会话的最后一行/最后一个工具
		 * 显示成自己的——面板在撒谎；continuable 子代理被再次唤醒时同样会继续
		 * 显示上一轮的旧回复。
		 *
		 * @param state - 当前 { lastText, lastTool, lastTime }。
		 * @param event - SessionWireEvent（{ type, time, data }）。
		 * @returns 新的折叠状态，或原状态。
		 */
		function foldOne(state, event) {
			if (event === null || typeof event !== 'object') return state;
			const data = event.data;
			if (data === null || typeof data !== 'object') return state;
			if (event.type === 'user/message') {
				return { lastText: undefined, lastTool: undefined, lastTime: eventTime(event, state.lastTime) };
			}
			if (event.type === 'assistant/message') {
				const content = data.message?.content;
				if (!Array.isArray(content)) return state;
				const parts = [];
				for (const block of content) {
					if (block === null || typeof block !== 'object' || block.type !== 'text') continue;
					if (typeof block.text === 'string') parts.push(block.text);
				}
				// 块按顺序拼接（不插分隔符）；块间的换行由 clampText 压平。
				const text = clampText(parts.join(''));
				if (text === undefined) return state;
				return { lastText: text, lastTool: state.lastTool, lastTime: eventTime(event, state.lastTime) };
			}
			if (event.type === 'tool/call') {
				if (typeof data.name !== 'string' || data.name === '') return state;
				return { lastText: state.lastText, lastTool: data.name, lastTime: eventTime(event, state.lastTime) };
			}
			return state;
		}

		/**
		 * 从 Session 事件序列折叠出节点的展示状态：最后一行助手文本、最后一个
		 * 工具名、最后一次被识别事件的时间。其余事件类型忽略；data 来自 JSON
		 * 边界，形状不符的事件跳过而不是抛出。
		 *
		 * 同时接受裸事件与 snapshot 的记录信封（{ type: 'event', event }），
		 * 因为开场快照给的是后者、增量帧给的是前者。
		 *
		 * @param events - 事件数组（可为任意形状，非数组视为空）。
		 * @param previous - 上一次的折叠状态；省略即从空开始。
		 * @returns { lastText, lastTool, lastTime }，undefined 表示"还没见过"。
		 */
		function foldEvents(events, previous) {
			let state = {
				lastText: previous?.lastText,
				lastTool: previous?.lastTool,
				lastTime: previous?.lastTime,
			};
			if (!Array.isArray(events)) return state;
			for (const raw of events) {
				const event = raw !== null && typeof raw === 'object' && 'event' in raw ? raw.event : raw;
				state = foldOne(state, event);
			}
			return state;
		}

		/**
		 * 把"距今多久"分档给本地化文案用：小于 90 秒报秒，否则报整分钟；满 60
		 * 分钟改报整小时（扇出跑几十分钟是常态，纯分钟档会给出"412 分钟前"）。
		 * @param elapsedMs - 距最后一次活动事件的毫秒数；非有限值与负数按 0 处理。
		 * @returns {{ unit: 'seconds'|'minutes'|'hours', value: number }} 对应 treeAge* 词条。
		 */
		function formatAge(elapsedMs) {
			const ms = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) ? elapsedMs : 0;
			const seconds = Math.max(0, Math.floor(ms / 1000));
			if (seconds < AGE_SECONDS_LIMIT) return { unit: 'seconds', value: seconds };
			const minutes = Math.floor(seconds / 60);
			return minutes < AGE_MINUTES_LIMIT ? { unit: 'minutes', value: minutes } : { unit: 'hours', value: Math.floor(minutes / 60) };
		}

		/**
		 * 展开集合：Set 原样返回，可迭代对象（数组、`Map.prototype.keys()` 这类
		 * 迭代器）转 Set，其余给空集。
		 */
		function idSet(value) {
			if (value instanceof Set) return value;
			if (value !== null && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') return new Set(value);
			return new Set();
		}

		/**
		 * 可订阅目标（三元组）的稳定 key：每个目标一路流，key 是流的身份。
		 * 分隔符用 `\u0000`——session id 是 UUID、mode 是枚举，都不含这个字符。
		 * @param target - { parentSessionId, childSessionId, mode }。
		 * @returns 稳定字符串 key。
		 */
		function targetKey(target) {
			return `${target.parentSessionId}\u0000${target.childSessionId}\u0000${target.mode}`;
		}

		/**
		 * 增量订阅差分：按 key 比较"当前活着的流"与"当前该有的目标"，只给出要
		 * 新开的目标和要停掉的 key。任一节点 activity 翻转时，其余节点的 key
		 * 不变，因而**不被触碰**——一次重开等于重付该子代理的整段日志开场快照
		 * （见 FOLLOW_MAX_MESSAGES），全量重开在扇出下是 O(N×M)。
		 * @param activeKeys - 正在消费的 key（Set、数组或 `Map.prototype.keys()` 迭代器）。
		 * @param desired - 当前渲染中且 running 的目标数组。
		 * @returns {{ stop: string[], start: Array<{ key, target }> }} 均为稳定顺序。
		 */
		function subscriptionDiff(activeKeys, desired) {
			const active = idSet(activeKeys);
			const wanted = new Map();
			const start = [];
			for (const target of Array.isArray(desired) ? desired : []) {
				if (target === null || typeof target !== 'object') continue;
				const key = targetKey(target);
				if (wanted.has(key)) continue;
				// 已有的流也算"该有"：否则它会被下面的 stop 当成多余的而 abort。
				wanted.set(key, target);
				if (active.has(key)) continue;
				start.push({ key, target });
			}
			// 按 active 自身的顺序给 stop，让同一份输入产生同一份输出。
			const stop = [];
			for (const key of active) if (!wanted.has(key)) stop.push(key);
			return { stop, start };
		}

		/**
		 * 从 follow 帧里取出要折叠的事件列表：snapshot 给 `records`（信封数组），
		 * event 给单条裸事件；其他帧类型（assistant-stream）与畸形帧给 undefined。
		 * @param frame - SessionFollowFrame。
		 * @returns 事件数组，或 undefined 表示这一帧没有可折叠的内容。
		 */
		function targetRecords(frame) {
			if (frame === null || typeof frame !== 'object') return undefined;
			if (frame.type === 'snapshot') return Array.isArray(frame.records) ? frame.records : undefined;
			if (frame.type === 'event') return [frame];
			return undefined;
		}

		/**
		 * 调用方给的目录选择器：缺席或抛错都给 undefined，让调用方退回空目录。
		 * 选择器是外部 store 的入口，异常不得逃出座位渲染——框架虽为 entry 备了
		 * 错误边界，座位自身也不该把异常甩出去。
		 * @param useSessions - props.useSessions（可能缺席或不是函数）。
		 * @returns 选择器结果，或 undefined。
		 */
		function catalogFrom(useSessions) {
			if (typeof useSessions !== 'function') return undefined;
			try {
				return useSessions((state) => (state !== null && typeof state === 'object' ? state.subagentsByParent : undefined));
			} catch (error) {
				logWarn('catalog selector', error);
				return undefined;
			}
		}

		/**
		 * 把客户端目录摊平成面板渲染的深度优先行。
		 *
		 * 目录按父会话一层的粒度缓存：某个子节点的下一层，只有它自己出现在
		 * expanded 里才会渲染。`diagnostic` 条目描述的是不可用的候选（没有可
		 * 打开/可订阅的地址），因此不是这里的行。目录来自外部 store，任何形状
		 * 都要容错；visited 同时挡住损坏目录里的自环/祖先环导致的无尽递归。
		 *
		 * @param catalog - sessions 快照的 subagentsByParent 记录。
		 * @param rootSessionId - 根会话 id（第一层的父）。
		 * @param expanded - 已展开的节点 id 集合（Set 或数组）。
		 * @returns 行数组 { id, parentSessionId, mode, label, activity, hasChildren, depth }。
		 */
		function treeRows(catalog, rootSessionId, expanded) {
			const rows = [];
			if (catalog === null || typeof catalog !== 'object') return rows;
			const open = idSet(expanded);
			const visited = new Set();
			const walk = (parentId, depth) => {
				if (visited.has(parentId)) return;
				visited.add(parentId);
				const level = catalog[parentId];
				if (level === null || typeof level !== 'object' || !Array.isArray(level.entries)) return;
				for (const entry of level.entries) {
					if (entry === null || typeof entry !== 'object' || entry.kind !== 'child') continue;
					if (typeof entry.id !== 'string' || entry.id === '') continue;
					rows.push({
						id: entry.id,
						parentSessionId: parentId,
						mode: entry.mode === 'continuable' ? 'continuable' : 'one-shot',
						label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : undefined,
						activity: entry.activity === 'running' ? 'running' : 'inactive',
						hasChildren: entry.hasChildren === true,
						depth,
					});
					if (open.has(entry.id)) walk(entry.id, depth + 1);
				}
			};
			walk(rootSessionId, 0);
			return rows;
		}

		/** 已加载层级里的运行中节点数（徽标）；更深的层没拉过就数不到。 */
		function countRunning(catalog, rootSessionId) {
			if (catalog === null || typeof catalog !== 'object') return 0;
			let count = 0;
			for (const row of treeRows(catalog, rootSessionId, Object.keys(catalog))) {
				if (row.activity === 'running') count += 1;
			}
			return count;
		}

		function EngAtlasPanelTab() {
			const [state, setState] = useState({ status: 'loading' });

			useEffect(() => {
				void (async () => {
					try {
						const res = await fetch('/eng-panel/api/config');
						const body = await res.json();
						if (!res.ok || body?.ok !== true) throw new Error(`HTTP ${res.status}`);
						setState({ status: 'ready', exitGuard: body.value.exitGuard === true, saving: false, saved: false, saveError: undefined });
					} catch (error) {
						setState({ status: 'error', message: String(error?.message ?? error) });
					}
				})();
			}, []);

			if (state.status === 'loading') return h('p', { style: styles.hint }, t('loading'));
			if (state.status === 'error') {
				return h('div', { style: styles.wrap },
					h('p', { style: styles.error }, `${t('loadFailed')} (${state.message})`),
					h('button', { style: styles.button, onClick: () => location.reload() }, t('retry')));
			}

			const save = async () => {
				setState((prev) => ({ ...prev, saving: true, saved: false, saveError: undefined }));
				try {
					const res = await fetch('/eng-panel/api/config', {
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ exitGuard: state.exitGuard }),
					});
					const body = await res.json();
					if (!res.ok || body?.ok !== true) throw new Error(`HTTP ${res.status}`);
					setState((prev) => ({ ...prev, saving: false, saved: true, exitGuard: body.value.exitGuard === true }));
				} catch (error) {
					setState((prev) => ({ ...prev, saving: false, saveError: String(error?.message ?? error) }));
				}
			};

			return h('div', { style: styles.wrap },
				h('h3', { style: { margin: 0 } }, t('title')),
				h('p', { style: styles.hint }, t('description')),
				h('label', { style: styles.row },
					h('input', {
						style: styles.checkbox,
						type: 'checkbox',
						checked: state.exitGuard,
						onChange: (event) => setState((prev) => ({ ...prev, exitGuard: event.target.checked, saved: false })),
					}),
					h('span', null, t('guardLabel'))),
				h('p', { style: styles.hint }, t('guardHint')),
				h('div', { style: styles.actions },
					h('button', { style: styles.button, onClick: () => void save(), disabled: state.saving }, state.saving ? t('saving') : t('save')),
					state.saved ? h('span', { style: styles.ok }, t('saved')) : null,
					state.saveError !== undefined ? h('span', { style: styles.error }, t('saveFailed') + state.saveError) : null));
		}

		/**
		 * 右下角浮动面板：按层级渲染已加载的子代理树，并为每个可见的 running
		 * 节点开一路 remote.session.follow 推送流。
		 *
		 * 面板只持有一个每秒的展示时钟（见组件内的 `now`）：它只重渲染已有的
		 * 时间戳，不取数据；内容与状态一律由推送驱动。
		 *
		 * 流按节点增量管理（`activeStreams` 里的 Map + `subscriptionDiff`）：目录
		 * 里任一节点 activity 翻转只会 start/stop 那一个目标，其余流原样保留。
		 */
		function SubagentTreePanel(props) {
			const { sessionId, catalog, catalogUnavailable, text, onClose } = props;
			const [expanded, setExpanded] = useState(() => new Set());
			const [feeds, setFeeds] = useState({});
			// key → AbortController：当前活着的流。ref 而非 state——abort 句柄不进
			// 渲染，标签/徽标只需 feeds。
			const activeStreams = useRef(new Map());
			// 已声明"正在被消费"的层 id（见下面的差分 effect）。
			const declaredLevels = useRef(new Set());
			// 展示时钟：每秒只重渲染已有的时间戳，不取任何数据（数据仍由 follow 推送），
			// 所以它不是轮询。没有它，"最后活动 N 秒前"会冻结在最后一次推送的时刻——
			// 一个正在跑但暂时没有新事件的子代理会被误读成"停住了"，恰好是这块面板
			// 要回答的问题。
			const [now, setNow] = useState(() => Date.now());
			useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, []);
			const rows = treeRows(catalog, sessionId, expanded);
			const running = rows.filter((row) => row.activity === 'running');
			const expandedKey = [...expanded].sort().join('\n');

			// 声明一层"正在被消费"；展开时再补一次拉取。声明本身让 store 在成员
			// 变化时去抖刷新，这就是树保持实时而不需要本组件轮询的原因。
			const declareLevel = (id, open) => {
				try {
					service('sessions')?.setSubagentCatalogOpen?.(id, open);
				} catch (error) {
					logWarn(`catalog ${id}`, error);
				}
			};
			const refreshLevel = (id) => {
				try {
					const pending = service('sessions')?.refreshSubagents?.(id);
					if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
						pending.then(undefined, (error) => logWarn(`refresh ${id}`, error));
					}
				} catch (error) {
					logWarn(`refresh ${id}`, error);
				}
			};

			// 面板打开即声明根这一层；关闭/卸载即撤销声明。根层只由本 effect 声明
			// ——`setSubagentCatalogOpen` 是单例布尔，两个 effect 都声明根层就会互相
			// 释放（展开层 effect 收尾时的 false 会把面板自己的声明一起关掉）。
			useEffect(() => {
				declareLevel(sessionId, true);
				refreshLevel(sessionId);
				return () => { declareLevel(sessionId, false); };
			}, [sessionId]);

			// 展开某一层 = 声明该层被消费并拉一次它的目录；收起即撤销声明。这里只动
			// **差分**：已声明过的层不重复声明、不重拉，只有真的不再需要的层才释放。
			// 根层跳过（它的声明由上面那个 effect 独占）。
			useEffect(() => {
				const declared = declaredLevels.current;
				const wanted = new Set(expandedKey === '' ? [] : expandedKey.split('\n'));
				wanted.delete(sessionId);
				for (const id of wanted) {
					if (declared.has(id)) continue;
					declareLevel(id, true);
					refreshLevel(id);
				}
				for (const id of declared) if (!wanted.has(id)) declareLevel(id, false);
				declaredLevels.current = wanted;
			}, [expandedKey, sessionId]);

			// 释放放在**卸载专用** effect 里。React 在依赖变化时先跑上一个 effect 的
			// cleanup：若把释放写在上面那个 effect 的返回值里，declaredLevels 每次都会
			// 被清空、差分记忆归零，展开第二个层级就会把所有已展开层释放再重拉（多出
			// 的 RPC + 这些层闪现"加载中"）。空依赖让 ref 跨依赖变化存活。
			useEffect(() => () => {
				for (const id of declaredLevels.current) declareLevel(id, false);
				declaredLevels.current = new Set();
			}, []);

			/** 更新某节点的折叠状态：update 是要合并的字段，或 (prevFeed) => 新 feed。 */
			const setFeed = (childSessionId, update) => {
				setFeeds((prev) => {
					const previous = prev[childSessionId] ?? {};
					const next = typeof update === 'function' ? update(previous) : { ...previous, ...update };
					return { ...prev, [childSessionId]: next };
				});
			};

			// 每个正在渲染的 running 节点一路流；按 key 差分，只动变化的那几个：
			// 新目标开流、消失/停止的目标 abort，其余 Map 里的流原样留着。面板卸载
			// 时 cleanup 全部 abort。任一路失败只标该节点的 status，其余流不受影响。
			useEffect(() => {
				const streams = activeStreams.current;
				// 服务属性访问必须自带守卫：inject 缺席时 cordis 的反射代理在取
				// 属性（而非 get）时抛错，整个座位会被错误边界摘掉。
				let sessionApi;
				try {
					// `remote.session` 是网关按命名空间注册的独立服务（官方客户端同样
					// 以 `inject: ['remote', 'remote.session']` 声明）；从 `remote`
					// 命名空间对象上取属性会走 inject 检查并抛错。
					sessionApi = service('remote.session');
				} catch (error) {
					logWarn('remote.session', error);
					return undefined;
				}
				const follow = sessionApi?.follow;
				const desired = typeof follow === 'function' ? running.map((row) => ({ parentSessionId: row.parentSessionId, childSessionId: row.id, mode: row.mode })) : [];
				const { stop, start } = subscriptionDiff(streams.keys(), desired);
				for (const key of stop) {
					streams.get(key)?.abort();
					streams.delete(key);
				}
				// 这条路是否仍归本次执行所有：被 stop/卸载 abort 掉的流不再是，
				// 它的收场不得再改写 feeds（旧流的迟到结果会覆盖新流的状态）。
				const owned = (key, controller) => streams.get(key) === controller && !controller.signal.aborted;
				if (start.length === 0) return undefined;
				// 先标"等着第一帧"，再开流：follow 可能同步抛错，那样失败状态必须
				// 覆盖 pending，而不是被随后的 pending 批次吞掉。
				setFeeds((prev) => {
					const next = { ...prev };
					for (const { target } of start) next[target.childSessionId] = { ...(next[target.childSessionId] ?? {}), status: 'pending' };
					return next;
				});
				for (const { key, target } of start) {
					const controller = new AbortController();
					streams.set(key, controller);
					void (async () => {
						try {
							const stream = follow.call(sessionApi, followRequest(target.parentSessionId, target.childSessionId, target.mode), controller.signal);
							for await (const frame of stream) {
								if (!owned(key, controller)) return;
								const records = targetRecords(frame);
								if (records === undefined) continue;
								setFeed(target.childSessionId, (prev) => foldEvents(records, prev));
							}
						} catch (error) {
							if (!owned(key, controller)) return;
							// 一次机会：失败只标"读取失败"并记账，不自动重试——本面板唯一的
							// 定时器是展示时钟，重连要额外的退避计时，留给下一次面板重开。
							setFeed(target.childSessionId, { status: 'failed' });
							logWarn(`follow ${target.childSessionId}`, error);
							return;
						}
						// 流自然收尾（子代理结束）：仍归本次执行才标 idle，否则说明它
						// 已被 abort/替换，收场状态由新的那一路负责。
						if (!owned(key, controller)) return;
						streams.delete(key);
						setFeed(target.childSessionId, { status: 'idle' });
					})();
				}
				// 本 effect 的 cleanup 不 abort：依赖变化（目录推送）时 abort 全部
				// 正是"任一节点翻转打断所有流"的老毛病。abort 只发生在两处——目标
				// 从目录里消失（上面的 stop）与面板卸载（下面的 unmount effect）。
				return undefined;
			}, [running.length, expandedKey, sessionId, catalog]);

			// 面板卸载：abort 全部活流。必须与上面的 effect 分开——同一个 effect 的
			// cleanup 每次依赖变化都会跑，那样 diff 就白做了。
			useEffect(() => () => {
				for (const controller of activeStreams.current.values()) controller.abort();
				activeStreams.current.clear();
			}, []);

			const openRow = (row) => {
				try {
					service('sessions')?.openSubagent?.({ parentSessionId: row.parentSessionId, childSessionId: row.id, mode: row.mode });
				} catch (error) {
					logWarn(`open ${row.id}`, error);
				}
			};

			const toggleRow = (id) => {
				setExpanded((prev) => {
					const next = new Set(prev);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					return next;
				});
			};

			// 展开层的加载态/失败态：目录里那一层的 state 说了算。只看根层会漏报
			// 深层的失败——展开的那一层自己得说出它的状态。
			const levelStatusText = (level) => {
				if (level === null || typeof level !== 'object') return null;
				if (level.state === 'loading') return text('treeLoading');
				if (level.state === 'error') return text('treeLoadFailed');
				return null;
			};

			// follow 服务整个不可用（此时不为任何节点开流）：running 行若留白就与
			// "还没有任何事件"同貌。属性访问自带守卫（注入缺席时反射代理会抛）。
			let liveUnavailable = false;
			try {
				liveUnavailable = running.length > 0 && typeof service('remote.session')?.follow !== 'function';
			} catch (error) {
				logWarn('remote.session', error);
				liveUnavailable = running.length > 0;
			}

			// 当前可见层的状态行：目录里没有行的层（空的/失败的/加载中的）也得说出
			// 它自己的状态，否则展开一个空层什么也看不到。可见 = 根层，或它本身也
			// 展开着（收起的分支不该在面板里报状态）。
			const visibleStatuses = [];
			if (catalog !== null && typeof catalog === 'object') {
				for (const levelId of Object.keys(catalog)) {
					if (!expanded.has(levelId) || levelId === sessionId) continue;
					const status = levelStatusText(catalog[levelId]);
					if (status !== null) visibleStatuses.push({ levelId, status });
				}
			}
			const statusFor = (levelId) => visibleStatuses.find((entry) => entry.levelId === levelId)?.status ?? null;

			const renderRow = (row) => {
				const feed = feeds[row.id];
				const parts = [];
				if (feed?.lastTool !== undefined) parts.push(`${text('treeLastTool')} ${feed.lastTool}`);
				if (feed?.lastText !== undefined) parts.push(feed.lastText);
				const data = parts.join(' · ');
				// 已折叠出来的内容优先于状态文案：状态是"还没有内容"的说明，不是它的
				// 替代品。这一行自己没内容时才轮到自己那一路的流状态，然后才是它所在
				// 层的状态；"实时不可用"整层说一次就够（它不属于某一行）。
				let detail = data;
				if (detail === '') detail = feed?.status === 'failed' ? text('treeReadFailed') : feed?.status === 'pending' ? text('treeLoading') : null;
				if (detail === null) detail = statusFor(row.parentSessionId);
				if (detail === null && liveUnavailable) detail = text('treeLiveUnavailable');
				if (detail === null) detail = '';
				const age = feed?.lastTime === undefined ? undefined : formatAge(now - feed.lastTime);
				const isOpen = expanded.has(row.id);
				const ageKey = age?.unit === 'hours' ? 'treeAgeHours' : age?.unit === 'minutes' ? 'treeAgeMinutes' : 'treeAgeSeconds';
				const rowNode = h('div', { key: row.id, style: { ...styles.treeRow, paddingLeft: `${row.depth * 16}px` } },
					h('div', { style: styles.treeRowHead },
						row.hasChildren
							? h('button', {
								type: 'button',
								style: styles.treeToggle,
								title: isOpen ? text('treeCollapse') : text('treeExpand'),
								onClick: () => toggleRow(row.id),
							}, isOpen ? '▾' : '▸')
							: h('span', { style: styles.treeToggleSpacer }),
						h('button', { type: 'button', style: styles.treeLabel, title: row.id, onClick: () => openRow(row) }, row.label ?? row.id),
						h('span', { style: row.activity === 'running' ? styles.dotRunning : styles.dotIdle }, '●'),
						h('span', { style: styles.treeMeta }, text(row.activity === 'running' ? 'treeRunning' : 'treeInactive')),
						age === undefined ? null : h('span', { style: styles.treeMeta }, `${text('treeLastActive')} ${text(ageKey, { n: age.value })}`)),
					detail === '' || detail === undefined ? null : h('div', { style: styles.treeDetail }, detail));
				// 展开层自己的状态行：跟在它父行之后，缩进一层。
				const levelStatus = statusFor(row.id);
				return levelStatus === null
					? rowNode
					: [rowNode, h('div', { key: `${row.id}:level`, style: { ...styles.treeDetail, paddingLeft: `${(row.depth + 1) * 16}px` } }, levelStatus)];
			};

			const level = catalog?.[sessionId];
			const rootState = level !== null && typeof level === 'object' ? level.state : undefined;
			const body = rows.length > 0
				? rows.map(renderRow)
				: catalogUnavailable
					? h('p', { style: styles.treeError }, text('treeCatalogUnavailable'))
					: rootState === 'loading'
						? h('p', { style: styles.treeEmpty }, text('treeLoading'))
						: rootState === 'error'
							? h('p', { style: styles.treeError }, text('treeLoadFailed'))
							: h('p', { style: styles.treeEmpty }, text('treeEmpty'));

			return h('div', { style: styles.treePanel, role: 'dialog', 'aria-label': text('treeTitle') },
				h('div', { style: styles.treePanelHead },
					h('span', { style: styles.treePanelTitle }, text('treeTitle')),
					h('button', { type: 'button', style: styles.treeClose, title: text('treeClose'), onClick: onClose }, '×')),
				h('div', { style: styles.treePanelBody }, body));
		}

		/**
		 * 会话标题栏座位：树形按钮 + 运行中数量徽标；展开时挂载浮动面板。
		 * 面板收起/卸载即卸载面板组件，其订阅随 effect 清理一并 release。
		 */
		function SubagentTreeSeat(props) {
			const [open, setOpen] = useState(false);
			const sessionId = props?.sessionId;
			const text = translator(props?.t);
			// 目录选择器抛错或 props.useSessions 缺席时退回共享空目录，并把"目录
			// 不可用"与"暂无子代理"分开：读不到目录不等于没有子代理。
			const selected = catalogFrom(props?.useSessions);
			const catalogUnavailable = selected === undefined;
			const catalog = selected ?? NO_CATALOG;
			const running = countRunning(catalog, sessionId);

			return h('span', { style: styles.seat },
				h('button', {
					type: 'button',
					style: styles.headerButton,
					title: text('treeTitle'),
					'aria-expanded': open ? 'true' : 'false',
					onClick: () => setOpen((value) => !value),
				},
					h('span', null, text('treeButton')),
					running > 0 ? h('span', { style: styles.badge }, String(running)) : null),
				// key=sessionId：座位万一跨会话存活，展开集合、已声明层与 feeds 必须随
				// 根会话一起换新，否则旧层的"正在被消费"声明会一直挂到关面板。
				open ? h(SubagentTreePanel, { key: sessionId, sessionId, catalog, catalogUnavailable, text, onClose: () => setOpen(false) }) : null);
		}

		const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.session'];

		/** 两个座位各自 try/catch：一个座位注册失败不得连累另一个。 */
		function mount(ctx) {
			try {
				const dispose = ctx.locale.register(NS, { zh, en });
				t = ctx.locale.bind(NS);
				ctx.effect(() => dispose, 'eng-panel: dictionaries');
			} catch {
				// locale 服务缺失时保持中文默认。
			}
			ctx.slots.inject('settings.plugins.tab', () => {
				try {
					return ctx.slots.register({
						name: 'settings.plugins.tab',
						id: 'eng',
						order: 30,
						label: () => t('tab'),
						locale: NS,
						inject: () => ({}),
					}, EngAtlasPanelTab);
				} catch {
					return () => {};
				}
			});
			ctx.slots.inject('conversation.session.header.actions', () => {
				try {
					return ctx.slots.register({
						name: 'conversation.session.header.actions',
						id: 'eng-subagent-tree',
						order: 40,
						locale: NS,
						inject: () => ({}),
					}, SubagentTreeSeat);
				} catch (error) {
					logWarn('register subagent tree seat', error);
					return () => {};
				}
			});
		}

		function apply(ctx) {
			clientCtx = ctx;
			try {
				mount(ctx);
			} catch (error) {
				logWarn('mount', error);
			}
		}

		exports.inject = inject;
		exports.apply = apply;
		/**
		 * node 单测接缝：纯折叠/格式化/树形摊平函数与两个组件，浏览器半边不读取它。
		 * 组件导出是为了让测试用最小 hooks 运行时驱动真实 effect（流差分/abort/失败
		 * 标记都只在 effect 里发生，纯函数测不到）。
		 * @see tests/subagent-tree.test.mjs
		 */
		exports.__test = {
			foldEvents, formatAge, treeRows, followRequest,
			subscriptionDiff, targetKey, targetRecords,
			SubagentTreePanel, SubagentTreeSeat,
			zh, en,
		};
		return module.exports;
	},
});
