/**
 * dsh-apollo — 工程模式设置面板 + `wait_subagent` 工具卡（浏览器半边）。
 *
 * 本文件即最终产物（closure-factory 格式，与 dsh-web 生态 tsdown client 预设
 * 的输出同构）：执行时向 window.__ModuleLoader__ 注册工厂，externals（react）
 * 经注入的 require 从浏览器模块表解析。两个座位：
 *
 * 1. 官方 Plugins 设置分区的 `settings.plugins.tab` ——「工程模式」标签页
 *    （dsh-plugin-manager 同款注入方式）：退出守卫开关，经 host 半边的
 *    /eng-panel/api/config 读写；
 * 2. `tool.call.toolview` 的 `wait_subagent` 键 —— 接管该工具的工具卡：卡里不是
 *    原始 JSON，而是 `subagent_id` 里每个 id 的实时信息（标签/状态/最后活动/
 *    最后一个工具/最后一行助手文本），内容来自 `remote.session.follow` 的推送流
 *    （不是轮询）；工具结算后显示工具返回文本并冻结已折叠出的信息。
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
		// 复用官方通用工具行组件（`GenericToolCard`）：折叠态与 bash 等工具完全同源，
		// 本插件只提供展开体。导出缺席（旧 harness）时降级为自带渲染。
		let uiToolModule;
		try {
			uiToolModule = require('@deepseek-ai/dsh-client-ui-tool');
		} catch (error) {
			logWarn('ui-tool module', error);
		}

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
			waitTitleRunning: '等待 {n} 个子代理',
			waitTitleSettled: '等待结束',
			waitMore: '另有 {n} 个未展示',
			waitResult: '结果',
			dispatchDefaultModel: '默认模型',
			dispatchBackground: '后台派发',
			dispatchForeground: '前台等待',
			dispatchPrompt: '提示词',
			dispatchShowAll: '展开全部',
			dispatchCollapse: '收起',
			treeLoading: '加载中…',
			treeReadFailed: '读取失败',
			treeLiveUnavailable: '实时不可用',
			treeRunning: '运行中',
			treeInactive: '已结束',
			treeLastActive: '最后活动',
			treeAgeSeconds: '{n} 秒前',
			treeAgeMinutes: '{n} 分钟前',
			treeAgeHours: '{n} 小时前',
			treeLastTool: '最后工具',
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
			waitTitleRunning: 'Waiting for {n} subagent(s)',
			waitTitleSettled: 'Wait finished',
			waitMore: '{n} more not shown',
			waitResult: 'Result',
			dispatchDefaultModel: 'default model',
			dispatchBackground: 'background dispatch',
			dispatchForeground: 'foreground wait',
			dispatchPrompt: 'Prompt',
			dispatchShowAll: 'Show all',
			dispatchCollapse: 'Collapse',
			treeLoading: 'Loading…',
			treeReadFailed: 'Read failed',
			treeLiveUnavailable: 'Live updates unavailable',
			treeRunning: 'running',
			treeInactive: 'finished',
			treeLastActive: 'Last active',
			treeAgeSeconds: '{n}s ago',
			treeAgeMinutes: '{n}m ago',
			treeAgeHours: '{n}h ago',
			treeLastTool: 'Last tool',
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
		 * ~38 万字节）；正因为一次重开等于重付整段日志，流必须按目标增量管理
		 * （见 WaitSubagentCard 的流 effect），不能因任一 id 的状态变化就全量重开。
		 */
		const FOLLOW_MAX_MESSAGES = 4;

		/**
		 * 一张卡最多跟随的子代理数。每个 id 一路 `remote.session.follow` 流，而
		 * 每路流的开场快照按 FOLLOW_MAX_MESSAGES 回放该子代理的整段日志，所以
		 * 畸形或超长的 `subagent_id` 必须在开流之前就被挡住；被挡掉的条数在卡上
		 * 明说（waitMore），不假装名单只有这么长。
		 */
		const WAITED_IDS_LIMIT = 8;

		/**
		 * 一路 follow 的请求体：`SessionAddress` 是判别联合，子代理地址必须带
		 * `kind: 'subagent'`；`assistantStream` 在类型上是字面量 `true`，本卡
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
		/**
		 * 本插件接管工具卡的全部 wire 工具名：官方 `wait_subagent` 加派发工具。
		 * 派发面由 eng/research preset 的官方 `tool-subagent` 行提供：`subagent`
		 * 是通用派发行，其余是各角色行（每行自带 `models` 别名表，表内子集就是该
		 * 行的授权面）。座位按 wire 工具名分发，没有 entry 认领的键从来不会出现——
		 * 列多了只是几个空注册，列少了那个工具的卡就退回通用行。名字是配置事实：
		 * preset 里加了角色行，这里要跟着加。
		 */
		const DISPATCH_TOOL_NAMES = [
			'subagent',
			'researcher',
			'scout',
			'tdd-tester',
			'implementer',
			'reviewer',
			'code-quality-reviewer',
			'lark',
		];

		/**
		 * 收纳态提示词预览保留的行数：超过就夹断，点「展开全部」看全文。派发提示词
		 * 动辄数千字，整段铺开会把下面的实时行推出视野；截断又会让人看不到内容，所以
		 * 只折叠、不丢字。
		 */
		const PROMPT_PREVIEW_LINES = 20;

		/** "最后一行"展示上限（字符）。 */
		const LAST_LINE_LIMIT = 120;
		/** 秒/分钟分界：小于 90 秒报秒，否则报整分钟。 */
		const AGE_SECONDS_LIMIT = 90;
		/** 分钟/小时分界：不足 60 分钟报分钟，否则报整小时。 */
		const AGE_MINUTES_LIMIT = 60;

		/** 共享空目录：选择器返回 undefined 时保持同一引用，避免无谓重渲染。 */
		const NO_CATALOG = Object.freeze({});

		/** 展开体正文的字体栈：与通用行的 ioText 同族（等宽）。 */
		const MONO_FONT = '"SF Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

		const styles = {
			wrap: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary, inherit)' },
			hint: { margin: 0, color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '13px', lineHeight: '20px' },
			row: { display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '14px' },
			checkbox: { marginTop: '3px' },
			actions: { display: 'flex', alignItems: 'center', gap: '10px' },
			button: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2, #555)', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'inherit', padding: '4px 12px' },
			ok: { color: 'var(--dsw-alias-state-success-primary, #3c3)', fontSize: '13px' },
			error: { color: 'var(--dsw-alias-state-error-primary, #c33)', fontSize: '13px' },
			// 展开体容器：展开后由通用行的 bodyWrap 承载，这里只负责行间距。
			// 展开体一律沿用通用行正文（ioText）的规格：等宽栈、11px、次级/三级色。
			// 自造字号或字体族会让这块文字"长不到"卡片里（实测过 16px 无衬线 vs
			// 11px 等宽的混排）。
			body: { display: 'flex', flexDirection: 'column', gap: '6px', fontFamily: MONO_FONT, fontSize: '11px', lineHeight: 1.5 },
			// standalone 降级时的一行摘要（正常路径下摘要由通用行的折叠行提供）。
			standaloneHead: { fontWeight: 600 },
			// 与通用工具的正文同款排版：13px 继承、次级色；细节行再降一档、缩进对齐。
			waitLine: { display: 'flex', flexDirection: 'column', gap: '2px' },
			waitLineHead: { color: 'var(--dsw-alias-label-secondary, #b9c6e0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			waitLineDetail: { color: 'var(--dsw-alias-label-tertiary, #8a94ab)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: '12px' },
			fallbackArgs: { fontFamily: MONO_FONT, color: 'var(--dsw-alias-label-secondary, #aaa)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			resultBox: { display: 'flex', flexDirection: 'column', gap: '2px', paddingTop: '6px', borderTop: '1px solid var(--dsw-alias-border-l2, #555)' },
			resultLabel: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '12px' },
			resultText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--dsw-alias-label-secondary, #aaa)' },
			resultFailed: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--dsw-alias-state-error-primary, #c33)' },
			// 派发展开体的三块静态内容：描述、模型/前后台、提示词正文。与通用工具的
			// 正文同款排版（纯文本行，次级色；提示词保留换行）。
			dispatchDescription: { color: 'var(--dsw-alias-label-secondary, #aaa)' },
			dispatchMeta: { color: 'var(--dsw-alias-label-tertiary, #8a94ab)' },
			dispatchPrompt: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--dsw-alias-label-secondary, #aaa)' },
			// 收纳态：PROMPT_PREVIEW_LINES 行 × 正文 1.5 行高 = 30em 处夹断。用 em 而不是
			// `-webkit-line-clamp`：React 只认识无单位属性白名单里的 `lineClamp`，写成
			// `WebkitLineClamp: <number>` 会被补成非法的 `20px`，夹断静默失效。
			dispatchPromptPreview: { maxHeight: `${PROMPT_PREVIEW_LINES * 1.5}em`, overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--dsw-alias-label-secondary, #aaa)' },
			dispatchPromptHead: { display: 'flex', alignItems: 'center', gap: '8px' },
			dispatchPromptToggle: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-tertiary, #8a94ab)', padding: 0, textDecoration: 'underline' },
			dispatchLabel: { color: 'var(--dsw-alias-label-tertiary, #8a94ab)' },
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
		 * 折叠单条事件；不是本卡渲染的两类事件、或 data 形状不符时原样返回。
		 *
		 * `user/message` 是**回合边界**：新的用户输入意味着上一轮的助手文本与
		 * 工具名已经过期，必须清空（只推进 lastTime）。少了这个重置，带 fork
		 * 种子前缀的子代理在自己还没产出时会把父会话的最后一行/最后一个工具
		 * 显示成自己的——卡在撒谎；continuable 子代理被再次唤醒时同样会继续
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
		 * 新开的目标和要停掉的 key。目标清单不变时（子代理 activity 翻转、目录
		 * 推送重渲染）每个 key 都不变，因而**不被触碰**——一次重开等于重付该
		 * 子代理的整段日志开场快照（见 FOLLOW_MAX_MESSAGES），全量重开在扇出下
		 * 是 O(N×M)。
		 * @param activeKeys - 正在消费的 key（Set、数组或 `Map.prototype.keys()` 迭代器）。
		 * @param desired - 当前该有流的全部目标（等待中的工具调用覆盖名单上每个 id）。
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
		 * 本会话那一层目录的条目索引（子会话 id → entry）。
		 *
		 * 卡只需要三件事：标签、活动态、follow 地址的 mode。`diagnostic` 条目
		 * 不是可等待的子代理，不进索引。目录来自外部 store，任何形状都容错。
		 *
		 * @param catalog - sessions 快照的 subagentsByParent 记录。
		 * @param sessionId - 卡所在会话 id（即等待的父会话）。
		 * @returns Map<子会话 id, 目录条目>。
		 */
		function childEntries(catalog, sessionId) {
			const entries = new Map();
			if (catalog === null || typeof catalog !== 'object' || typeof sessionId !== 'string') return entries;
			const level = catalog[sessionId];
			if (level === null || typeof level !== 'object' || !Array.isArray(level.entries)) return entries;
			for (const entry of level.entries) {
				if (entry === null || typeof entry !== 'object' || entry.kind !== 'child') continue;
				if (typeof entry.id !== 'string' || entry.id === '') continue;
				entries.set(entry.id, entry);
			}
			return entries;
		}

		/** 目录条目的活动态；条目缺席或取值不符给 undefined（不替 store 猜状态）。 */
		function entryActivity(entry) {
			if (entry === null || typeof entry !== 'object') return undefined;
			return entry.activity === 'running' ? 'running' : entry.activity === 'inactive' ? 'inactive' : undefined;
		}

		/**
		 * follow 地址的 mode：目录条目说了算；查不到（快照还没到、窗口外的历史卡、
		 * 目录不可用）按 `continuable`——`wait_subagent` 只等待 continuable 直系
		 * 子代理，这是唯一有依据的默认值。
		 */
		function entryMode(entry) {
			return entry !== null && typeof entry === 'object' && entry.mode === 'one-shot' ? 'one-shot' : 'continuable';
		}

		/**
		 * `wait_subagent` 的等待名单：解析工具参数里的 `subagent_id`，去重保序，再按
		 * WAITED_IDS_LIMIT 截断。参数来自 JSON 边界（窗口截断时整段缺席），任何形状
		 * 都不抛；畸形一律给空名单，由卡退回朴素行。
		 *
		 * @param argsRaw - 工具调用的原始参数文本（运行中取 block.argsRaw，已结算取
		 *   block.call?.argsRaw，窗口截断时为 null/undefined）。
		 * @returns {{ ids: string[], truncated: number }} ids 为可跟随的名单；
		 *   truncated 为被上限挡掉的条数（0 表示名单完整）。
		 */
		function waitedIds(argsRaw) {
			if (typeof argsRaw !== 'string' || argsRaw === '') return { ids: [], truncated: 0 };
			let parsed;
			try {
				parsed = JSON.parse(argsRaw);
			} catch {
				// 工具参数是流式写入的原始文本：截断/畸形都只能退回朴素行。
				return { ids: [], truncated: 0 };
			}
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ids: [], truncated: 0 };
			const raw = parsed.subagent_id;
			if (!Array.isArray(raw)) return { ids: [], truncated: 0 };
			const unique = [];
			const seen = new Set();
			for (const value of raw) {
				if (typeof value !== 'string' || value === '' || seen.has(value)) continue;
				seen.add(value);
				unique.push(value);
			}
			return { ids: unique.slice(0, WAITED_IDS_LIMIT), truncated: Math.max(0, unique.length - WAITED_IDS_LIMIT) };
		}

		/**
		 * 已结算卡的结果文本：`content` 里的 text 块按顺序换行拼接；一个 text 块
		 * 都没有时退回错误码，让失败的调用也不留空白。
		 * @param block - ToolResultNode。
		 * @returns 结果文本，或 undefined 表示这次调用没有可展示的返回内容。
		 */
		function resultTextOf(block) {
			const content = block !== null && typeof block === 'object' ? block.content : undefined;
			if (Array.isArray(content)) {
				const parts = [];
				for (const part of content) {
					if (part === null || typeof part !== 'object' || part.type !== 'text') continue;
					if (typeof part.text === 'string' && part.text !== '') parts.push(part.text);
				}
				if (parts.length > 0) return parts.join('\n');
			}
			const error = block !== null && typeof block === 'object' ? block.error : undefined;
			if (error !== null && typeof error === 'object') {
				if (typeof error.code === 'string' && error.code !== '') return error.code;
				if (typeof error.name === 'string' && error.name !== '') return error.name;
			}
			return undefined;
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

		/** conversation 命名空间的翻译函数：通用行自己用它取文案（工具名、输入/输出…）。 */
		function conversationTranslator() {
			try {
				return typeof clientCtx?.locale?.bind === 'function' ? clientCtx.locale.bind('conversation') : undefined;
			} catch (error) {
				logWarn('locale.bind(conversation)', error);
				return undefined;
			}
		}

		/** 非空字符串取值；空串、非字符串一律 undefined（调用方按"没有这一项"处理）。 */
		function textField(value) {
			return typeof value === 'string' && value !== '' ? value : undefined;
		}

		/**
		 * 工具调用的参数文本：运行中在 `block.argsRaw`，已结算是 `block.call?.argsRaw`
		 * ——窗口截断让调用头落在它外面时 `call` 为 null，两条路径都可能缺席。
		 * @param block - 工具块（运行中的调用或已结算的结果节点）。
		 * @returns 原始参数文本，或 undefined。
		 */
		function argsRawOf(block) {
			if (block === null || typeof block !== 'object') return undefined;
			return block.kind === 'tool-result' ? block.call?.argsRaw : block.argsRaw;
		}

		/**
		 * 派发工具的调用参数：`subagent` 与各角色工具共用
		 * `{ description, prompt, model?, run_in_background? }`。参数来自 JSON 边界
		 * （流式写入中、调用头被窗口截断、历史日志），任何形状都不抛：畸形一律给空
		 * 参数，由卡退回"只有工具名"的降级形态。
		 *
		 * @param argsRaw - 工具调用的原始参数文本（运行中取 block.argsRaw，已结算取
		 *   block.call?.argsRaw；窗口截断时两条路径都可能缺席）。
		 * @returns {{ description, prompt, model, background }} 前三个是字符串或
		 *   undefined；background 为 true 表示后台派发（`run_in_background` 缺席时
		 *   与插件默认一致：continuable 后台）。
		 */
		function dispatchArgs(argsRaw) {
			const empty = { description: undefined, prompt: undefined, model: undefined, background: true };
			if (typeof argsRaw !== 'string' || argsRaw === '') return empty;
			let parsed;
			try {
				parsed = JSON.parse(argsRaw);
			} catch {
				// 流式写入的中间态：半个 JSON 解析不出任何字段。
				return empty;
			}
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
			return {
				description: textField(parsed.description),
				prompt: textField(parsed.prompt),
				model: textField(parsed.model),
				background: parsed.run_in_background !== false,
			};
		}

		/**
		 * 派发工具的折叠摘要：`工具名 · 模型 · 描述`。模型缺席时整段省掉（不留空
		 * 分隔符），描述缺席时用压平成单行、截断到 LAST_LINE_LIMIT 的提示词顶上。
		 * 两项都拿不到（参数还在流式写入、被窗口截断、或 JSON 畸形）时给 undefined
		 * ——通用行会退回显示原始参数 JSON，与其它工具一致；这里不编一句空摘要。
		 *
		 * 通用行对没有可读摘要键的工具会把参数 JSON 当摘要（派发工具正是这种），所以
		 * 摘要必须由接管展开体的这一侧给。
		 *
		 * @param toolName - 座位的 wire 工具名（props.toolName）。
		 * @param args - dispatchArgs 的解析结果。
		 * @returns 单行摘要，或 undefined。
		 */
		function dispatchSummary(toolName, args) {
			const label = args?.description ?? clampText(args?.prompt);
			if (label === undefined) return undefined;
			return [textField(toolName) ?? 'subagent', args?.model, label]
				.filter((segment) => segment !== undefined)
				.join(' · ');
		}

		/**
		 * 子会话 id 的形态：可选的 `session-` 前缀 + UUID，或 dsh-sdk 提供方那种
		 * `session-` + 32 位无连字符 UUID。锚到 UUID 本体而不是 `session-` 之后的任意
		 * 字符：正文里的 `session-persistence-sqlite` 这类词不是会话 id。
		 */
		const CHILD_ID_PATTERN = /\b(?:session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\bsession-[0-9a-f]{32}\b/i;

		/**
		 * 从已结算的返回文本里取第一个像子会话 id 的 token。派发工具成功时回
		 * `started subagent <id>`（continuable）或子代理自己的收尾输出（前台）；
		 * 后台 one-shot 回的是 job id，取不到——取不到就只是没有实时行。
		 *
		 * @param value - 结果文本。
		 * @returns 会话 id，或 undefined。
		 */
		function childIdFromText(value) {
			if (typeof value !== 'string' || value === '') return undefined;
			const match = CHILD_ID_PATTERN.exec(value);
			return match === null ? undefined : match[0];
		}

		/**
		 * 多路 `remote.session.follow` 的共用机制：按目标清单增量开流，把帧折叠成每个
		 * 子会话的展示状态，并在有"最后活动"可走动时持一个每秒的展示时钟。等待中的
		 * `wait_subagent` 与已派发、仍在运行的子代理（派发工具的卡）共用它——两个卡
		 * 只决定"当前该有哪些目标"，差分、abort、所有权守卫与定时器都在这里，没有
		 * 第二套流实现。
		 *
		 * 必须在组件顶层无条件调用（hook 顺序）：目标为空集时它什么都不开。
		 *
		 * @param targets - 当前该有流的目标（{ parentSessionId, childSessionId, mode }）。
		 * @returns {{ feeds, now, followAvailable }} feeds 按 childSessionId 索引；
		 *   now 是展示时钟的当前毫秒值；followAvailable 是 `remote.session.follow`
		 *   是否可用（调用方据此渲染"实时不可用"）。
		 */
		function useFollowFeeds(targets) {
			const [feeds, setFeeds] = useState({});
			// key → AbortController：当前活着的流。ref 而非 state——abort 句柄不进渲染。
			const activeStreams = useRef(new Map());
			const [now, setNow] = useState(() => Date.now());
			// 流的身份 = 整份目标清单（父/子/mode）。用字符串做 effect 依赖：目录快照
			// 的身份与流的存活无关，目标清单不变就不该重跑差分。
			const targetsKey = (Array.isArray(targets) ? targets : []).map(targetKey).join('\u0001');

			// follow 服务是否可用：决定渲染哪条降级文案，并作为流 effect 的第二个依赖
			// ——服务晚到一步时依赖翻转会让 effect 重跑，把该开的流补上（effect 自己
			// 再探一次服务，不复用这个布尔值）。属性访问自带守卫（注入缺席时反射代理
			// 在取属性时会抛）。
			let followAvailable = false;
			try {
				followAvailable = typeof service('remote.session')?.follow === 'function';
			} catch (error) {
				logWarn('remote.session', error);
			}

			// 展示时钟：只要还有一行在显示"最后活动"就走；没有可走动的时间戳（参数
			// 畸形的朴素行、结算后才挂载的历史卡）就不建定时器。**结算后不停表**是
			// 有意的：`timed out … it is still running` 这类结果恰恰要靠"最后活动
			// 越走越久"来表达子代理没再产出；代价是每张曾活过的卡各持一个 1s 定时器
			// （只重渲染已有时间戳，不取数据）。
			const hasAges = Object.values(feeds).some((feed) => feed?.lastTime !== undefined);
			useEffect(() => {
				if (!hasAges) return undefined;
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, [hasAges]);

			/** 更新某个子代理的折叠状态：update 是要合并的字段，或 (prevFeed) => 新 feed。 */
			const setFeed = (childSessionId, update) => {
				setFeeds((prev) => {
					const previous = prev[childSessionId] ?? {};
					const next = typeof update === 'function' ? update(previous) : { ...previous, ...update };
					return { ...prev, [childSessionId]: next };
				});
			};

			// 每个目标一路流；按 key 差分，只动变化的那几个：新目标开流、不再需要的
			// 目标（名单/mode 变化、工具已结算、卡卸载）abort，其余 Map 里的流原样留着。
			// 任一路失败只标该 id 的 status，其余流不受影响。
			useEffect(() => {
				const streams = activeStreams.current;
				// 服务属性访问必须自带守卫：inject 缺席时 cordis 的反射代理在取属性
				// （而非 get）时抛错，整个座位会被错误边界摘掉。
				let sessionApi;
				let follow;
				try {
					// `remote.session` 是网关按命名空间注册的独立服务（官方客户端同样
					// 以 `inject: ['remote', 'remote.session']` 声明）；从 `remote`
					// 命名空间对象上取属性会走 inject 检查并抛错。
					sessionApi = service('remote.session');
					follow = sessionApi?.follow;
				} catch (error) {
					// 属性访问被反射代理拒了：与"服务缺席"同一种处理——拿不到 follow
					// 就本轮的 desired 为空，已开的流照常停掉，异常只进 console。
					logWarn('remote.session', error);
					sessionApi = undefined;
					follow = undefined;
				}
				const desired = typeof follow === 'function' ? (Array.isArray(targets) ? targets : []) : [];
				const { stop, start } = subscriptionDiff(streams.keys(), desired);
				for (const key of stop) {
					streams.get(key)?.abort();
					streams.delete(key);
				}
				// 这条路是否仍归本次执行所有：被 stop/卸载 abort 掉的流不再是，它的
				// 收场不得再改写 feeds（旧流的迟到结果会覆盖新流的状态）。
				const owned = (key, controller) => streams.get(key) === controller && !controller.signal.aborted;
				if (start.length === 0) return undefined;
				// 先标"等着第一帧"，再开流：follow 可能同步抛错，那样失败状态必须覆盖
				// pending，而不是被随后的 pending 批次吞掉。
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
							// 一次机会：失败只标"读取失败"并记账，不自动重试——重连要
							// 额外的退避计时，留给下一次重挂。
							setFeed(target.childSessionId, { status: 'failed' });
							logWarn(`follow ${target.childSessionId}`, error);
							return;
						}
						// 流干净收尾（服务端关掉这一路，或 carrier 重置）：仍归本次执行才
						// 标 idle，否则说明它已被 abort/替换，收场状态由新的那一路负责。
						// idle 只表示"这一行没有活流了"，不表示子代理已结束——running 位
						// 在目录快照里，流的收尾推不出它。
						if (!owned(key, controller)) return;
						streams.delete(key);
						setFeed(target.childSessionId, { status: 'idle' });
					})();
				}
				// 本 effect 的 cleanup 不 abort：依赖变化时 abort 全部正是"任一 id 变化
				// 打断所有流"的老毛病。abort 只发生在两处——目标不再需要（上面的 stop）
				// 与卡卸载（下面的 unmount effect）。
				return undefined;
			}, [targetsKey, followAvailable]);

			// 卡卸载：abort 全部活流。必须与上面的 effect 分开——同一个 effect 的
			// cleanup 每次依赖变化都会跑，那样 diff 就白做了。
			useEffect(() => () => {
				for (const controller of activeStreams.current.values()) controller.abort();
				activeStreams.current.clear();
			}, []);

			return { feeds, now, followAvailable };
		}

		/**
		 * 一行子代理实时信息：首行是标签（目录条目的 label，缺席用 id）加上状态与
		 * "最后活动"，次行是最后一个工具与最后一行助手文本。等待中的 `wait_subagent`
		 * 与派发工具的卡共用它。
		 *
		 * @param options - { id, entry, feed, now, streaming, liveUnavailable, text }。
		 *   entry 是目录条目（可缺席）；feed 是该 id 的折叠状态；now 是展示时钟；
		 *   streaming 表示这一行此刻有活流（决定"加载中"是不是残留）；
		 *   liveUnavailable 表示整卡拿不到 follow 服务；text 是翻译函数。
		 * @returns 行元素。
		 */
		function subagentRowElement(options) {
			const { id, entry, feed, now, streaming, liveUnavailable, text } = options;
			const label = typeof entry?.label === 'string' && entry.label !== '' ? entry.label : id;
			// 状态只认目录快照：子代理的 running 位由 store 用推送帧折进已加载的目录
			// （session-controller 的 updateCatalogActivity），所以这一列是实时的，
			// 官方子代理界面同样只看这一处。快照里没有这个 id 就不声称状态（中性
			// 圆点）——follow 流本身不携带 running 位，"流还开着"推断不出"还在跑"，
			// 刚派发、尚未启动的子代理就会被说成运行中。
			const activity = entryActivity(entry);
			const parts = [];
			if (feed?.lastTool !== undefined) parts.push(`${text('treeLastTool')} ${feed.lastTool}`);
			if (feed?.lastText !== undefined) parts.push(feed.lastText);
			// 已折叠出来的内容优先于状态文案：状态是"还没有内容"的说明，不是它的
			// 替代品。这一行自己没内容时才轮到自己那一路的流状态；"实时不可用"
			// 整卡说一次就够（它不属于某一行）。
			let detail = parts.join(' · ');
			// 没有活流时 `pending` 是"第一帧还没到"的残留（工具对早已完成的子代理会在
			// 首帧到达前就返回），再显示"加载中"就是永久谎报。
			if (detail === '') {
				detail = feed?.status === 'failed'
					? text('treeReadFailed')
					: feed?.status === 'pending' && streaming ? text('treeLoading') : null;
			}
			if (detail === null && liveUnavailable) detail = text('treeLiveUnavailable');
			if (detail === null) detail = '';
			const age = feed?.lastTime === undefined ? undefined : formatAge(now - feed.lastTime);
			const ageKey = age?.unit === 'hours' ? 'treeAgeHours' : age?.unit === 'minutes' ? 'treeAgeMinutes' : 'treeAgeSeconds';
			// 与通用工具行的正文同一套排版：纯文本行，不引入第二套视觉（圆点/主色
			// 标签/分栏），免得一条自造控件夹在标准"输入/输出"卡片上方。
			const meta = [];
			if (activity !== undefined) meta.push(text(activity === 'running' ? 'treeRunning' : 'treeInactive'));
			if (age !== undefined) meta.push(`${text('treeLastActive')} ${text(ageKey, { n: age.value })}`);
			return h('div', { key: id, style: styles.waitLine },
				h('div', { style: styles.waitLineHead, title: id }, meta.length === 0 ? label : `${label} · ${meta.join(' · ')}`),
				detail === '' ? null : h('div', { style: styles.waitLineDetail }, detail));
		}

		/**
		 * standalone 降级（没有通用行外壳，结果没有 OUTPUT 段）时的结果块；有外壳时
		 * 给 null——结果由通用行展示，与其它工具一致。
		 *
		 * @param block - 工具块。
		 * @param text - 翻译函数。
		 * @param standalone - 是否处于无通用行的降级形态。
		 * @returns 结果元素，或 null。
		 */
		function resultSection(block, text, standalone) {
			if (standalone !== true) return null;
			if (block === null || typeof block !== 'object' || block.kind !== 'tool-result') return null;
			const result = resultTextOf(block);
			if (result === undefined) return null;
			return h('div', { key: 'result', style: styles.resultBox },
				h('div', { style: styles.resultLabel }, text('waitResult')),
				h('div', { style: block.isError === true ? styles.resultFailed : styles.resultText }, result));
		}

		/**
		 * 工具卡的共用外壳：**折叠态是 harness 的通用工具行**（`GenericToolCard`，与
		 * bash 等工具同一套行组件、同一套展开/收起、同一套样式），展开体由本插件给。
		 * 两个卡（`wait_subagent` 与派发工具）都走这里，接线只有这一份。
		 *
		 * 展开体由 `ToolRow` 的 `{open && children}` 渲染：收起时不挂载，所以流随展开
		 * 建立、随收起释放，生命周期天然对齐，本插件不自己维护折叠状态。
		 *
		 * harness 未导出 `GenericToolCard`（旧版本）时降级：直接渲染展开体，功能不
		 * 丢，只是少了通用行外壳——展开体因此需要知道自己处在哪种形态（`standalone`）。
		 *
		 * @param props - 座位 props：callId/toolName/block/cwd/home/openFile/loadImage/
		 *   inspect 原样透传给通用行。
		 * @param summary - 折叠行摘要；undefined 时通用行退回显示参数 JSON。
		 * @param buildBody - `(standalone) => 展开体元素`。
		 * @returns 卡元素（通用行，或降级时的展开体本身）。
		 */
		function genericToolShell(props, summary, buildBody) {
			const generic = uiToolModule !== null && typeof uiToolModule === 'object' && typeof uiToolModule.GenericToolCard === 'function'
				? uiToolModule.GenericToolCard
				: undefined;
			const conversationText = conversationTranslator();
			const standalone = generic === undefined || conversationText === undefined;
			const body = buildBody(standalone);
			if (standalone) return body;
			return h(generic, {
				callId: props?.callId,
				toolName: props?.toolName,
				block: props?.block,
				cwd: props?.cwd,
				home: props?.home,
				openFile: props?.openFile,
				loadImage: props?.loadImage,
				inspect: props?.inspect,
				t: conversationText,
				summary,
				bodyContent: body,
			});
		}

		/**
		 * `wait_subagent` 的工具卡：折叠态是通用工具行，展开体是 `WaitSubagentBody`
		 * ——被等待子代理的实时信息，而不是参数 JSON。
		 */
		function WaitSubagentCard(props) {
			const text = translator(props?.t);
			const block = props?.block;
			const settled = block !== null && typeof block === 'object' && block.kind === 'tool-result';
			// 折叠摘要只用两种说法：等待 N 个子代理 / 已结束。通用行对"参数里没有可读
			// 摘要键"的工具会把参数 JSON 当摘要（`wait_subagent` 正好是这种），而 Web
			// 客户端不消费 host 的 presentCall，所以只能由接管展开体的这一侧给摘要。
			const waited = waitedIds(argsRawOf(block));
			const summary = waited.ids.length === 0
				? undefined
				: settled ? text('treeInactive') : text('waitTitleRunning', { n: waited.ids.length });
			return genericToolShell(props, summary, (standalone) => h(WaitSubagentBody, {
				block: props?.block,
				sessionId: props?.sessionId,
				useSessions: props?.useSessions,
				text,
				standalone,
			}));
		}

		/**
		 * `wait_subagent` 的展开体：把工具参数里的每个 subagent id 渲染成一行实时信息
		 * （标签/状态/最后活动/最后一个工具/最后一行助手文本），而不是原始 JSON。
		 *
		 * 只对**运行中**的工具调用开流：等待中意味着这些子代理正在跑，所以名单上每个
		 * id 各开一路 `remote.session.follow` 推送流；工具一旦结算就 diff 掉全部流
		 * （结算后才挂载的历史卡不开任何流），并保留结束前已折叠出的最后信息。结果
		 * 文本由通用行的 OUTPUT 段展示；standalone 降级时本组件自己补一行标题与结果。
		 *
		 * 流与展示时钟都在 `useFollowFeeds` 里（与派发工具的卡共用），这里只决定
		 * "当前该有哪些目标"：等待中的名单，每个 id 各一路。
		 */
		function WaitSubagentBody(props) {
			const text = translator(props?.text);
			const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined;
			const block = props?.block;
			const settled = block !== null && typeof block === 'object' && block.kind === 'tool-result';
			const argsRaw = argsRawOf(block);
			const waited = waitedIds(argsRaw);
			// 目录只用来补标签/活动态/follow 地址的 mode；选择器抛错或缺席时退回共享
			// 空目录，卡照常按 id 渲染。
			const entries = childEntries(catalogFrom(props?.useSessions) ?? NO_CATALOG, sessionId);
			const waiting = !settled && waited.ids.length > 0 && sessionId !== undefined;
			// 本组件只在展开体里挂载（`ToolRow` 的 `{open && children}`）：挂载即开流，
			// 收起/卸载即 abort。也避免为从不展开的卡付整段子代理日志的快照代价
			// （子代理地址没有有界窗口，见 README 已知限制）。
			const targets = waiting
				? waited.ids.map((id) => ({ parentSessionId: sessionId, childSessionId: id, mode: entryMode(entries.get(id)) }))
				: [];
			const { feeds, now, followAvailable } = useFollowFeeds(targets);
			const liveUnavailable = waiting && !followAvailable;

			const renderRow = (id) => subagentRowElement({
				id, entry: entries.get(id), feed: feeds[id], now, streaming: waiting, liveUnavailable, text,
			});

			// 工具已结束：展开体留空，展开后就是标准的「输出」卡片（和其它工具结算后
			// 一模一样）。实时行只在等待中才有信息量。
			if (settled && props?.standalone !== true) return null;

			const children = [];
			// standalone 降级（没有通用行外壳）时补一行摘要，替代工具行的折叠摘要。
			if (props?.standalone === true) {
				const heading = waited.ids.length > 0
					? text(settled ? 'waitTitleSettled' : 'waitTitleRunning', { n: waited.ids.length })
					: typeof props?.toolName === 'string' && props.toolName !== '' ? props.toolName : 'wait_subagent';
				children.push(h('div', { key: 'head', style: styles.standaloneHead }, heading));
			}
			if (waited.truncated > 0) children.push(h('div', { key: 'more', style: styles.fallbackArgs }, text('waitMore', { n: waited.truncated })));
			if (waited.ids.length > 0) {
				children.push(...waited.ids.map(renderRow));
			} else {
				// 参数畸形、subagent_id 为空或调用头落在窗口外：退回"工具名 + 原始
				// 参数"的朴素行，既不开流也不留空白。
				const argsText = clampText(argsRaw);
				const argsTitle = typeof argsRaw === 'string' && argsRaw !== '' ? argsRaw : undefined;
				if (argsText !== undefined) children.push(h('div', { key: 'args', style: styles.fallbackArgs, title: argsTitle }, argsText));
			}
			// 结果文本：有通用行外壳时由它的 OUTPUT 段展示（与其它工具一致），
			// standalone 降级时自己补一块，保证结果永远可见。
			const result = resultSection(block, text, props?.standalone);
			if (result !== null) children.push(result);

			return h('div', { style: styles.body }, children);
		}

		/**
		 * 派发工具（`subagent` 与各角色工具）的工具卡：与 `wait_subagent` 同一套外壳
		 * ——折叠态是通用工具行，展开体是 `DispatchToolBody`。摘要由这一侧给（通用行
		 * 读不出 `description`/`prompt`，会把整个参数 JSON 当摘要显示）。
		 */
		function DispatchToolCard(props) {
			const block = props?.block;
			const settled = block !== null && typeof block === 'object' && block.kind === 'tool-result';
			const args = dispatchArgs(argsRawOf(block));
			const text = translator(props?.t);
			return genericToolShell(props, dispatchSummary(props?.toolName, args), (standalone) => h(DispatchToolBody, {
				block: props?.block,
				sessionId: props?.sessionId,
				useSessions: props?.useSessions,
				toolName: props?.toolName,
				text,
				standalone,
			}));
		}

		/**
		 * 派发工具的展开体：描述、模型与前后台、提示词正文，以及**这次派发出来的
		 * 子代理**那一行实时信息——而不是参数 JSON。
		 *
		 * 子代理 id 从已结算的返回文本里解析（`started subagent <id>`）：取不到就只显示
		 * 前三块，不开流也不报错。id 还要在目录快照里认领得到（本会话的直接子代理）
		 * 才成行——正则只是形状匹配，前台派发的返回文本是子代理自己的输出，里面可能
		 * 正好有一个 UUID；目录是"这个 id 真的是我派出去的"的唯一依据。
		 *
		 * 订阅要三个事实同时成立——卡在展开体里挂载（本组件只在展开时挂载）、目录认领
		 * 这个 id、且目录说它**仍在运行**。目录说已结束时不订阅：流本身不携带 running
		 * 位，"流还开着"推断不出"还在跑"，而给一个已经跑完的子代理回放整段日志不值得
		 * （见 README 已知限制）。此时那一行照常显示（状态列写"已结束"），结束前折叠出
		 * 的信息一并留在上面。
		 */
		function DispatchToolBody(props) {
			const text = translator(props?.text);
			const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined;
			const block = props?.block;
			const settled = block !== null && typeof block === 'object' && block.kind === 'tool-result';
			const args = dispatchArgs(argsRawOf(block));
			// 目录与等待卡同一份来源：标签/状态/follow 地址的 mode 都取自快照。
			const entries = childEntries(catalogFrom(props?.useSessions) ?? NO_CATALOG, sessionId);
			const childId = settled ? childIdFromText(resultTextOf(block)) : undefined;
			const entry = childId === undefined ? undefined : entries.get(childId);
			const running = entry !== undefined && entryActivity(entry) === 'running';
			const targets = running && sessionId !== undefined
				? [{ parentSessionId: sessionId, childSessionId: childId, mode: entryMode(entry) }]
				: [];
			const { feeds, now, followAvailable } = useFollowFeeds(targets);
			// 提示词不截断：默认收成 PROMPT_PREVIEW_LINES 行预览，点「展开全部」看全文，
			// 可再收起——截断会让人看不到内容，折叠不会。
			const prompt = args.prompt;
			const [promptOpen, setPromptOpen] = useState(false);

			const children = [];
			// standalone 降级（没有通用行外壳）时补一行摘要，替代工具行的折叠摘要。
			if (props?.standalone === true) {
				children.push(h('div', { key: 'head', style: styles.standaloneHead },
					dispatchSummary(props?.toolName, args) ?? textField(props?.toolName) ?? 'subagent'));
			}
			if (args.description !== undefined) {
				children.push(h('div', { key: 'description', style: styles.dispatchDescription }, args.description));
			}
			// 元信息行：模型缺席时说"默认模型"（插件按白名单的 defaultModel 解析），
			// `run_in_background` 缺席即后台派发。
			children.push(h('div', { key: 'meta', style: styles.dispatchMeta },
				`${args.model ?? text('dispatchDefaultModel')} · ${text(args.background ? 'dispatchBackground' : 'dispatchForeground')}`));
			if (prompt !== undefined) {
				children.push(h('div', { key: 'promptHead', style: styles.dispatchPromptHead },
					h('span', { style: styles.dispatchLabel }, text('dispatchPrompt')),
					h('button', {
						type: 'button',
						style: styles.dispatchPromptToggle,
						onClick: () => setPromptOpen((value) => !value),
						'aria-expanded': promptOpen,
					}, text(promptOpen ? 'dispatchCollapse' : 'dispatchShowAll'))));
				children.push(h('div', {
					key: 'prompt',
					style: promptOpen ? styles.dispatchPrompt : styles.dispatchPromptPreview,
					title: promptOpen ? undefined : prompt,
				}, prompt));
			}
			if (entry !== undefined) {
				children.push(subagentRowElement({
					id: childId, entry, feed: feeds[childId], now, streaming: running, liveUnavailable: running && !followAvailable, text,
				}));
			}
			const result = resultSection(block, text, props?.standalone);
			if (result !== null) children.push(result);

			return h('div', { style: styles.body }, children);
		}
		/**
		 * 客户端服务依赖：实时内容来自 `ctx.get('remote.session')`（网关按命名空间
		 * 注册的独立服务，取属性要通过 inject 检查，故必须成对声明——官方客户端
		 * 同样写 `['remote', 'remote.session']`）。子代理目录**不**在这里声明：行的
		 * 标签/状态/mode 全部来自框架派发的标准钩子 `props.useSessions`，与插件
		 * inject 无关；声明 `sessions` 只会让本插件在该服务缺席时整体不加载，反而
		 * 挡住卡片与设置页的降级路径。
		 */
		const inject = ['slots', 'locale', 'remote', 'remote.session'];

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
			ctx.slots.inject('tool.call.toolview', () => {
				// key 是 wire 工具名本身：这个座位按工具名分发，注册即接管该工具的卡
				// （没有 entry 认领的键才退回通用工具行）。每个键一份注册、各自
				// try/catch——一个键注册失败不得让其余键失去卡。注册项除 key 与组件
				// 外逐字相同：`wait_subagent` 用自己的展开体，派发工具共用一份。
				const seats = [
					{ key: 'wait_subagent', component: WaitSubagentCard },
					...DISPATCH_TOOL_NAMES.map((key) => ({ key, component: DispatchToolCard })),
				];
				const disposers = [];
				for (const seat of seats) {
					try {
						disposers.push(ctx.slots.register({
							name: 'tool.call.toolview',
							key: seat.key,
							order: 10,
							locale: NS,
						}, seat.component));
					} catch (error) {
						logWarn(`register ${seat.key} card`, error);
					}
				}
				return () => {
					for (const dispose of disposers) dispose();
				};
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
		 * node 单测接缝：纯解析/折叠/格式化函数与卡片组件，浏览器半边不读取它。
		 * 组件导出是为了让测试用最小 hooks 运行时驱动真实 effect（流差分/abort/失败
		 * 标记都只在 effect 里发生，纯函数测不到）。
		 * @see tests/wait-subagent-card.test.mjs
		 */
		exports.__test = {
			foldEvents, formatAge, followRequest, subscriptionDiff, targetKey, targetRecords,
			waitedIds, WaitSubagentCard, WaitSubagentBody,
			childIdFromText, dispatchArgs, dispatchSummary, dispatchToolNames: DISPATCH_TOOL_NAMES,
			DispatchToolCard, DispatchToolBody, PROMPT_PREVIEW_LINES,
			zh, en,
		};
		return module.exports;
	},
});
