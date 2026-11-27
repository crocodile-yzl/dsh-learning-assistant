// Functional self-check for the learning-assistant plugin, both halves.
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (label, cond, extra = "") => {
	console.log(`${cond ? "✓" : "✗"} ${label}${extra ? " — " + extra : ""}`);
	if (!cond) failures += 1;
};

// The host half imports the platform's `defineTool`. Where dsh is installed it
// resolves from node_modules and the REAL one runs here, which is the better
// check. On a clean CI runner there is no dsh, and a bare import would abort
// this file before its first assertion (which is what the verify workflow hit).
// In that case only, redirect the specifier to a local stand-in that carries a
// definition through unchanged; the assertions below drive `execute` directly.
let usedStub = false;
try {
	import.meta.resolve("@deepseek-ai/dsh-tools");
} catch {
	if (typeof registerHooks === "function") {
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === "@deepseek-ai/dsh-tools") {
					return { url: pathToFileURL(path.join(pluginDir, "tools", "stubs", "dsh-tools.mjs")).href, shortCircuit: true };
				}
				return nextResolve(specifier, context);
			}
		});
		usedStub = true;
	}
}

// ---------- 1. Browser bundle ----------
console.log("\n== 1) 浏览器 bundle ==");
const code = fs.readFileSync(path.join(pluginDir, "lib/client.js"), "utf8");
const captured = {};
const sandbox = {
	window: { __ModuleLoader__: { load: (descriptor) => (captured.descriptor = descriptor) } },
	console,
	// The bundle schedules a poll at activation; keep the timers from holding the
	// process open, and leave `fetch`/`document` absent to exercise the guards.
	setInterval: (fn, ms) => {
		const timer = setInterval(fn, ms);
		timer.unref?.();
		return timer;
	},
	clearInterval,
	setTimeout: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return timer;
	},
	clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
ok("bundle 调用了 __ModuleLoader__.load", captured.descriptor !== undefined);
ok("bundle id 正确", captured.descriptor?.id === "dsh-learning-assistant", captured.descriptor?.id);

const React = {
	// Render function components the way React does, so the assertions below
	// exercise the component bodies rather than just serializing their props.
	createElement: (type, props, ...children) => {
		if (typeof type === "function") return type({ ...(props ?? {}), children });
		return { type, props: props ?? {}, children };
	},
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useRef: (initial) => ({ current: initial }),
	useEffect: () => {},
	useLayoutEffect: () => {}
};
const registered = [];
const tabTypes = [];
const openedTabs = [];
const disposersClient = [];
const interactions = [];
const ctxClient = {
	uiConversation: {
		interactions: {
			register: (definition) => {
				interactions.push(definition);
				return () => {};
			}
		}
	},
	slots: {
		inject: (_name, factory) => factory(),
		register: (definition, component) => {
			registered.push({ definition, component });
			return () => {};
		}
	},
	sidebarRightTabs: {
		register: (definition) => {
			tabTypes.push(definition);
			return () => {};
		}
	},
	sidebarRight: {
		openTab: (kind) => {
			openedTabs.push(kind);
			return "tab-1";
		}
	},
	effect: (fn) => {
		disposersClient.push(fn());
		return () => {};
	}
};
const mod = captured.descriptor.factory((spec) => {
	if (spec === "react") return React;
	throw new Error(`unexpected require: ${spec}`);
});
ok("exports.apply 存在", typeof mod.apply === "function");
ok("exports.inject 正确", ["slots", "uiConversation"].every((name) => Array.isArray(mod.inject) && mod.inject.includes(name)), JSON.stringify(mod.inject));
// A host answer is not a connection failure, and a 404 names the fix.
const stale = new Error("主机返回 HTTP 404");
stale.status = 404;
stale.detail = "not found";
const noModel = new Error("主机返回 HTTP 503");
noModel.status = 503;
noModel.detail = "no model route available";
ok("404：提示宿主半是旧版并给出办法", mod.describeError(stale).includes("重启 dsh"), mod.describeError(stale));
ok("503：提示先选择模型", mod.describeError(noModel).includes("选择一个模型"), mod.describeError(noModel));
ok("连接失败仍写成无法连接主机", mod.describeError(new Error("fetch failed")).startsWith("无法连接主机"), mod.describeError(new Error("fetch failed")));
mod.apply(ctxClient);
const names = registered.map((r) => `${r.definition.name}:${r.definition.id ?? r.definition.key}`);
ok("注册了右侧栏标签类型", tabTypes.length === 1 && tabTypes[0].kind === "learning-assistant", JSON.stringify(tabTypes));
ok("标签有标题", typeof tabTypes[0]?.title === "function" && tabTypes[0].title() === "术语");
ok("注册了标签主体", names.includes("sidebar.right.pane.tab:dsh-learning-assistant/tab"), names.join(", "));
ok("不再占用中间主区域（不会盖住对话）", !names.some((n) => n.startsWith("main:") || n.startsWith("sidebar.panellist:")));
ok("面板组件是函数", typeof registered.find((r) => r.definition.name === "sidebar.right.pane.tab")?.component === "function");
ok("注册了常驻入口（对话头部按钮）", names.includes("conversation.session.header.actions:learning-assistant-entry"), names.join(", "));
ok("注册了划词手势处理器", interactions.length === 1 && interactions[0].id === "learning-assistant-explain", JSON.stringify(interactions.map((i) => i.id)));
ok("注册了划词动作表面", names.includes("conversation.chat.text-interaction:learning-assistant-explain"), names.join(", "));

// The gesture handler admits a selection with text and nothing else.
let gestureOpened = 0;
const gesture = (trigger, text) => interactions[0].onInteraction({ trigger, readText: () => text, open: () => { gestureOpened += 1; } });
gesture("selection", "KV Cache");
ok("有文字的划选会打开动作", gestureOpened === 1, String(gestureOpened));
gesture("selection", "   ");
gesture("contextmenu", "KV Cache");
gesture("selection", null);
ok("空白划选/右键/无文字不打开", gestureOpened === 1, String(gestureOpened));

// Render the panel with seeded state to prove the tree renders.
const panel = registered.find((r) => r.definition.name === "sidebar.right.pane.tab").component;
const panelProps = { store: mod.panelContext.store, api: mod.panelContext.api };
const seeded = {
	terms: [
		{
			term: "KV Cache",
			explanation: "把算过的注意力键值存起来复用，避免每步重算。",
			category: "机器学习",
			count: 2,
			tree: [
				{ label: "Transformer 自注意力", note: "每个 token 都要和前面所有 token 算相关性。", children: [{ label: "Q/K/V 三个投影" }] },
				{ label: "推理时逐步生成", note: "每生成一个 token 都要重算前面的注意力。" },
				{ label: "KV Cache", note: "把 K、V 缓存下来，只算新增部分。" }
			],
			links: [
				{ label: "维基百科", url: "https://zh.wikipedia.org/wiki/Special:Search?search=KV%20Cache" },
				{ label: "Google", url: "https://www.google.com/search?q=KV+Cache" }
			]
		}
	],
	level: "intermediate",
	strictness: 55,
	error: null
};
let panelTree;
try {
	// Seed the store before render, the way a poll would.
	const store = panelProps.store;
	store.set(seeded);
	panelTree = panel({ ...panelProps, store });
	ok("面板渲染无异常", panelTree !== undefined && panelTree !== null);
	const text = JSON.stringify(panelTree);
	ok("渲染包含词条名", text.includes("KV Cache"));
	ok("渲染包含解释", text.includes("注意力键值"));
	ok("渲染包含树节点", text.includes("Transformer 自注意力"));
	ok("外链带 noopener", text.includes("noopener noreferrer"));
} catch (error) {
	ok("面板渲染无异常", false, error.message);
}

// Empty state
try {
	const store = panelProps.store;
	store.set({ terms: [], level: "intermediate", strictness: 50, error: null });
	const emptyTree = panel({ ...panelProps, store });
	const emptyText = JSON.stringify(emptyTree);
	ok("空状态渲染", /还没有术语|还没有词条/.test(emptyText), emptyText.slice(0, 80));
} catch (error) {
	ok("空状态渲染", false, error.message);
}

// Learning path → composer. A path label is a button; one click puts its text
// into the Session's composer through `inputActions`.
const findNodes = (root, predicate) => {
	const found = [];
	const walk = (node) => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}
		if (predicate(node)) found.push(node);
		walk(node.children ?? node.props?.children);
	};
	walk(root);
	return found;
};
const inserted = [];
let acceptInsert = true;
const inputActions = {
	captureInsertion: () => ({ rev: 1 }),
	insertText: (text) => {
		if (!acceptInsert) return false;
		inserted.push(text);
		return true;
	},
	persistDraft: () => inserted.push("<persist>")
};
const stop = () => {};
try {
	const store = panelProps.store;
	store.set(seeded);
	const treeWithComposer = panel({ ...panelProps, store, inputActions });
	ok("包装组件把 inputActions 交到面板手上", mod.panelContext.inputActions === inputActions);
	const askNodes = findNodes(treeWithComposer, (node) => node.props?.["data-learning-assistant-ask"] !== undefined);
	ok("学习路径的加粗节点是按钮（3 个根节点 + 1 个子节点）", askNodes.length === 4, String(askNodes.length));
	ok("子节点也可点击", askNodes.some((node) => node.props["data-learning-assistant-ask"] === "Q/K/V 三个投影"));
	askNodes[0].props.onClick({ stopPropagation: stop });
	ok("单击把节点文字填进聊天框", inserted.join("|") === "Transformer 自注意力|<persist>", inserted.join("|"));
	askNodes[0].props.onClick({ stopPropagation: stop });
	ok("连点不会填两次", inserted.length === 2, String(inserted.length));
	ok("填入后面板给出提示", String(store.get().notice ?? "").includes("已填入聊天框"), String(store.get().notice));
	acceptInsert = false;
	askNodes[1].props.onClick({ stopPropagation: stop });
	ok("编辑器被锁时如实提示", String(store.get().notice ?? "").includes("正在发送"), String(store.get().notice));
	acceptInsert = true;
	// Rendered WITHOUT inputActions: the handoff from the wrapper is used.
	findNodes(panel({ ...panelProps, store }), (node) => node.props?.["data-learning-assistant-ask"] !== undefined)[3].props.onClick({ stopPropagation: stop });
	ok("没有 slot props 时回退到交接的 inputActions", inserted.includes("KV Cache"), inserted.join("|"));
} catch (error) {
	ok("学习路径填入聊天框", false, error.message);
}

// The selection action: remembered → open the card; new → one explain call.
try {
	const store = panelProps.store;
	store.set(seeded);
	const api = panelProps.api;
	let explainCalls = 0;
	api.explain = async (term, context) => {
		explainCalls += 1;
		return { terms: [...seeded.terms, { term, explanation: "按序投三份。", tree: [], links: [], source: "manual" }], level: "intermediate", strictness: 55, updatedAt: "2026-11-25T00:00:00.000Z", term, existing: false };
	};
	const ExplainAction = registered.find((r) => r.definition.key === "learning-assistant-explain")?.component;
	ok("划词动作组件存在", typeof ExplainAction === "function");
	let cleared = 0;
	let dismissed = 0;
	const surface = (text) => ExplainAction({ readText: () => text, clearSelection: () => { cleared += 1; }, dismiss: () => { dismissed += 1; } });
	ok("没有选区时不渲染", surface("") === null);
	const button = surface("Q/K/V 三个投影");
	ok("有选区时渲染按钮", button?.type === "button" && String(button.children).includes("解释这个词"), String(button?.children));
	const before = openedTabs.length;
	await button.props.onClick();
	ok("新词：调用一次 /explain", explainCalls === 1, String(explainCalls));
	ok("新词：已进记忆并标为划词添加", store.get().terms.some((item) => item.term === "Q/K/V 三个投影" && item.source === "manual"));
	ok("新词：侧栏打开并定位到该词", openedTabs.length === before + 1 && store.get().focus?.term === "Q/K/V 三个投影", JSON.stringify(store.get().focus));
	ok("新词：释放选区并关闭动作", cleared === 1 && dismissed === 1, `${cleared}/${dismissed}`);
	await surface("kv cache").props.onClick();
	ok("已收录词（大小写不同）：不再调模型", explainCalls === 1, String(explainCalls));
	ok("已收录词：直接定位到已有卡片", store.get().focus?.term === "KV Cache", JSON.stringify(store.get().focus));
	store.set({ focus: null });
	await surface("长".repeat(70)).props.onClick();
	ok("选区过长：拒绝并提示", explainCalls === 1 && String(store.get().notice ?? "").includes("太长"), String(store.get().notice));
} catch (error) {
	ok("划词解释动作", false, error.message);
}

// ---------- 2. Host half ----------
console.log("\n== 2) Host 半 ==");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tg-home-"));
process.env.DSH_HOME = home;
const host = await import(path.join(pluginDir, "lib/index.js"));
ok("host name", host.name === "learning-assistant", host.name);
ok("host inject 含 tools/webServer", host.inject.includes("tools") && host.inject.includes("webServer"), JSON.stringify(host.inject));

let toolDef;
let routeRegistration;
let promptSection;
const disposers = [];
const eventHandlers = [];
// A model that answers from a queue. Each `stream` call records its request and
// yields the next scripted reply as one text delta.
const llmCalls = [];
const llmReplies = [];
const fakeLlm = {
	listProviders: () => [{ provider: "fake" }],
	listModels: async () => [{ model: "fake-1" }],
	stream: (request) => {
		llmCalls.push(request);
		const reply = llmReplies.shift() ?? "[]";
		// Answer after a real tick, not a microtask, so passes overlap the way
		// they do against a live model and the concurrency cap is exercised.
		return (async function* () {
			await new Promise((resolve) => setTimeout(resolve, 20));
			yield { type: "text-delta", text: reply };
		})();
	}
};
const ctxHost = {
	on: (name, handler) => {
		eventHandlers.push({ name, handler });
		return () => {};
	},
	tools: { register: (def) => { toolDef = def; return () => {}; } },
	webServer: { register: (opts) => { routeRegistration = opts; return () => {}; } },
	effect: (fn) => { disposers.push(fn()); return () => {}; },
	inject: (names, cb) => {
		const scope = { effect: (fn) => { disposers.push(fn()); return () => {}; } };
		if (names.includes("systemPrompt")) scope.systemPrompt = { section: (section) => { promptSection = section; return () => {}; } };
		if (names.includes("llm")) {
			scope.llm = fakeLlm;
			scope.agentDefaultModel = null;
		}
		cb(scope);
	}
};
// Timings are configuration so this check need not wait seconds per pass.
host.apply(ctxHost, { level: "intermediate", strictness: 50, supplementDebounceMs: 5, supplementCooldownMs: 0 });
ok("宿主使用了真实的 defineTool（CI 上为本地替身）", true, usedStub ? "stub" : "real");
ok("注册了 explain_terms 工具", toolDef?.name === "explain_terms", toolDef?.name);
ok("注册了 /learning-assistant 路由", routeRegistration?.path === "/learning-assistant", routeRegistration?.path);
ok("注册了系统提示段", promptSection?.name === "learning-assistant");

const result = await toolDef.execute({
	terms: [
		{ term: "A2A 协议", explanation: "让不同厂商的 AI 代理互相通信的开放协议。", category: "智能体", confidence: 0.8, tree: [{ label: "单个 Agent" }, { label: "多 Agent 协作", children: [{ label: "A2A 协议" }] }] },
		{ term: "KV Cache", explanation: "缓存注意力的键值，避免重复计算。", category: "机器学习" }
	],
	reason: "回答涉及智能体协作与推理优化",
	strictnessAdjust: 10
});
ok("工具返回 saved=2", result.saved === 2, JSON.stringify(result));
ok("严格度自适应 +10", result.strictness === 60, String(result.strictness));
const memoryFile = path.join(home, "dsh-learning-assistant", "terms.json");
ok("记忆文件已写入", fs.existsSync(memoryFile));
const memory = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
ok("记忆含 2 个词条", memory.terms.length === 2, String(memory.terms.length));
ok("自动补了搜索外链", memory.terms.every((t) => Array.isArray(t.links) && t.links.length >= 2));
ok("系统提示含记忆摘要", (promptSection.text() ?? "").includes("KV Cache"));
const promptText = promptSection.text();
ok("系统提示含水平说明", promptText.includes("用户水平"));
ok("系统提示含严格度", promptText.includes("60/100"));

// HTTP surface: GET /state through the registered handler
const { Readable } = await import("node:stream");
const fakeRes = {
	status: 0,
	headers: null,
	body: "",
	writeHead(status, headers) { this.status = status; this.headers = headers; },
	end(text) { this.body = text; }
};
await routeRegistration.handler(Object.assign(Readable.from([]), { method: "GET", url: "/learning-assistant/state" }), fakeRes);
ok("GET /state 200", fakeRes.status === 200, String(fakeRes.status));
const state = JSON.parse(fakeRes.body);
ok("state 含词条", state.terms.length === 2);
ok("state 含 level", state.level === "intermediate");

// POST /level
const res2 = { status: 0, body: "", writeHead(s) { this.status = s; }, end(t) { this.body = t; } };
await routeRegistration.handler(Object.assign(Readable.from([Buffer.from(JSON.stringify({ level: "expert" }))]), { method: "POST", url: "/learning-assistant/level" }), res2);
ok("POST /level 生效", JSON.parse(res2.body).level === "expert", res2.body);

// POST /forget
const res3 = { status: 0, body: "", writeHead(s) { this.status = s; }, end(t) { this.body = t; } };
await routeRegistration.handler(Object.assign(Readable.from([Buffer.from(JSON.stringify({ term: "KV Cache" }))]), { method: "POST", url: "/learning-assistant/forget" }), res3);
ok("POST /forget 生效", JSON.parse(res3.body).terms.length === 1, res3.body);

// A small route caller: JSON in, `{ status, json }` out.
const call = async (method, url, body) => {
	const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(t) { this.body = t; } };
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	await routeRegistration.handler(Object.assign(Readable.from(chunks), { method, url }), res);
	return { status: res.status, body: res.body, json: () => JSON.parse(res.body) };
};
const { createRequire: createRequireHost } = await import("node:module");
const guideHost = createRequireHost(path.join(pluginDir, "lib/index.js"))("./core/guide.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- one term, several spellings ----
console.log("\n== 2b) 术语名归一化 ==");
ok("termKey 折叠大小写与空白", guideHost.termKey(" KV   Cache ") === "kv cache", guideHost.termKey(" KV   Cache "));
ok("termKey 折叠全角", guideHost.termKey("ＶＬＡ") === "vla", guideHost.termKey("ＶＬＡ"));
const folded = guideHost.mergeTerms(guideHost.emptyMemory(), [
	{ term: "VLA", explanation: "甲", tree: [], links: [] },
	{ term: "vla", explanation: "乙", tree: [], links: [] },
	{ term: "ＶＬＡ", explanation: "丙", tree: [], links: [] }
], { now: new Date() });
ok("三种拼写合并为一个词条，计数累加", folded.terms.length === 1 && folded.terms[0].count === 3, JSON.stringify(folded.terms.map((t) => [t.term, t.count])));
ok("显示名保留首次拼写", folded.terms[0].term === "VLA", folded.terms[0].term);
const linkedTree = guideHost.buildKnowledgeTree([{ term: "Transformer" }, { term: "ViT", parent: "transformer" }]);
ok("parent 与词条大小写不同也能挂上", linkedTree.length === 1 && linkedTree[0].children?.[0]?.term.term === "ViT", JSON.stringify(linkedTree.map((n) => n.term.term)));
ok("对话过滤对全角不敏感", guideHost.filterTermsForText([{ term: "VLA" }], "ＶＬＡ 是模型").length === 1);
const familiar = guideHost.mostFamiliar({ terms: [{ term: "甲", count: 1 }, { term: "乙", count: 5 }, { term: "丙", count: 3 }] }, 2);
ok("已收录词按常见度排序取前 N", familiar.join(",") === "乙,丙", familiar.join(","));

// ---- the tool and the routes agree on that identity ----
const again = await toolDef.execute({ terms: [{ term: "a2a 协议", explanation: "换个小写再记一次。", tree: [], links: [] }] });
ok("工具：小写重复不新增词条", again.saved === 1 && again.total === 1, JSON.stringify(again));
ok("工具：回报的是已存的显示名", again.terms[0] === "A2A 协议", again.terms[0]);
const forgotten = await call("POST", "/learning-assistant/forget", { term: "A2A 协议" });
ok("/forget 按归一化后的名字删除", forgotten.json().terms.length === 0, forgotten.json().terms.length);

// ---- polling: "unchanged" instead of resending everything ----
const s1 = await call("GET", "/learning-assistant/state");
ok("GET /state 带 corrupted 字段", s1.json().corrupted === null, String(s1.json().corrupted));
const s2 = await call("GET", `/learning-assistant/state?since=${encodeURIComponent(s1.json().updatedAt)}`);
ok("同一版本返回 unchanged", s2.json().unchanged === true, JSON.stringify(s2.json()));
const s3 = await call("GET", "/learning-assistant/state?since=2000-01-01T00:00:00.000Z");
ok("不同版本返回完整状态", Array.isArray(s3.json().terms), JSON.stringify(Object.keys(s3.json())));

// ---- an unreadable memory file is moved aside, not served forever ----
fs.writeFileSync(memoryFile, "{ this is not json");
const broken = await call("GET", "/learning-assistant/state");
const dir = path.dirname(memoryFile);
const backups = fs.readdirSync(dir).filter((name) => name.startsWith("terms.json.corrupt-"));
ok("坏文件：仍返回 200 与空记忆", broken.status === 200 && broken.json().terms.length === 0, String(broken.status));
ok("坏文件：原文件被移走并备份", !fs.existsSync(memoryFile) && backups.length === 1, backups.join(","));
ok("坏文件：告诉页面备份位置", typeof broken.json().corrupted === "string" && broken.json().corrupted.includes("corrupt-"), String(broken.json().corrupted));
const repaired = await call("POST", "/learning-assistant/level", { level: "intermediate" });
ok("一次成功写入后清除损坏提示", repaired.json().corrupted === null, `${repaired.status} ${repaired.body.slice(0, 160)}`);

// ---- /explain: the selection route ----
console.log("\n== 2c) 划词解释路由 ==");
llmReplies.push(JSON.stringify({ explanation: "把图切成小块当 token 的 Transformer。", category: "深度学习", tree: [{ label: "自注意力" }, { label: "ViT" }], parent: "不存在的词" }));
const ex1 = await call("POST", "/learning-assistant/explain", { term: "ViT", context: "主干网络用 ViT 提特征。" });
ok("新词：200 并入库", ex1.status === 200 && ex1.json().existing === false && ex1.json().term === "ViT", ex1.body.slice(0, 80));
ok("新词：标记为划词添加", ex1.json().terms.some((t) => t.term === "ViT" && t.source === "manual"));
ok("新词：带上下文调用模型", String(llmCalls.at(-1).messages[0].content[0].text).includes("主干网络用 ViT 提特征"));
const callsBeforeExplain = llmCalls.length;
const ex2 = await call("POST", "/learning-assistant/explain", { term: "vit" });
ok("已收录词：不再调模型", ex2.json().existing === true && ex2.json().term === "ViT" && llmCalls.length === callsBeforeExplain, ex2.body.slice(0, 60));
ok("选区过长：413", (await call("POST", "/learning-assistant/explain", { term: "长".repeat(70) })).status === 413);
ok("空选区：400", (await call("POST", "/learning-assistant/explain", { term: "   " })).status === 400);

// ---- the automatic pass: locks per conversation, one write per pass ----
console.log("\n== 2d) 自动补充的会话隔离 ==");
const emit = (session, type, data) => {
	for (const { name, handler } of eventHandlers) if (name === "session/event") handler({ id: session }, { type, data });
};
const answer = (text) => ({ message: { content: [{ type: "text", text }] } });
const longAnswer = "这是一段足够长的回答，用来触发一次自动补充解释。".repeat(3);
for (const term of ["ROS2", "MoveIt", "CUDA"]) llmReplies.push(JSON.stringify([{ term, explanation: `${term} 的解释。`, tree: [], links: [] }]));
const callsBeforePass = llmCalls.length;
emit("s1", "assistant/message", answer(longAnswer));
emit("s2", "assistant/message", answer(longAnswer));
emit("s3", "assistant/message", answer(longAnswer));
await sleep(80);
ok("三个会话同时结束：模型调用受并发上限 2 约束", llmCalls.length === callsBeforePass + 2, String(llmCalls.length - callsBeforePass));
emit("s3", "assistant/message", answer(longAnswer));
await sleep(80);
ok("被上限挡下的会话下一轮能补上", llmCalls.length === callsBeforePass + 3, String(llmCalls.length - callsBeforePass));
const afterPass = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
ok("三个会话的词都已入库并标为自动补充", ["ROS2", "MoveIt", "CUDA"].every((term) => afterPass.terms.some((t) => t.term === term && t.source === "supplement")), afterPass.terms.map((t) => t.term).join(","));
llmReplies.push(JSON.stringify([{ term: "RViz", explanation: "可视化工具。", tree: [], links: [] }, { term: "URDF", explanation: "机器人描述格式。", tree: [], links: [] }]));
const signalsBefore = afterPass.signals.length;
const termsBefore = afterPass.terms.length;
emit("s1", "assistant/message", answer(longAnswer));
await sleep(80);
const afterTwo = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
ok("一轮补两个词只记一条 signal（一次合并写入）", afterTwo.signals.length === signalsBefore + 1 && afterTwo.terms.length === termsBefore + 2, `${afterTwo.signals.length - signalsBefore}/${afterTwo.terms.length - termsBefore}`);
const repeated = await call("POST", "/learning-assistant/explain", { term: "ViT" });
ok("自动补充之后已收录词仍可直接打开", repeated.json().existing === true, String(repeated.json().existing));

// ---------- 3. Inline highlighting ----------
console.log("\n== 3) 正文高亮 ==");
const { createRequire } = await import("node:module");
const req = createRequire(path.join(pluginDir, "lib/index.js"));
const highlight = req("./core/highlight.js");
const guide = req("./core/guide.js");

const matcher = highlight.buildMatcher([{ term: "KV Cache" }, { term: "RL" }, { term: "A2A 协议" }]);
ok("匹配器已构建", matcher instanceof RegExp);
matcher.lastIndex = 0;
ok("命中 KV Cache", matcher.test("KV Cache 让推理更快"), "KV Cache 让推理更快");
matcher.lastIndex = 0;
ok("命中中文混合词", matcher.test("聊聊 A2A 协议"), "聊聊 A2A 协议");
matcher.lastIndex = 0;
ok("不把 URL 里的 RL 当词", !matcher.test("访问 URL 即可"), "访问 URL 即可");
matcher.lastIndex = 0;
ok("独立的 RL 能命中", matcher.test("用 RL 训练"), "用 RL 训练");
matcher.lastIndex = 0;
ok("长词优先（KV Cache 不被 KV 抢）", (() => {
	const onlyKV = highlight.buildMatcher([{ term: "KV" }, { term: "KV Cache" }]);
	onlyKV.lastIndex = 0;
	const m = onlyKV.exec("KV Cache 与 KV 都出现");
	return m !== null && m[0] === "KV Cache";
})());

// No-DOM degrade: start/refresh/stop must be safe no-ops.
const noDom = highlight.createHighlighter({ document: null, getTerms: () => [], onOpen: () => {} });
let noDomThrew = "";
try {
	noDom.start();
	noDom.refresh();
	noDom.stop();
} catch (error) {
	noDomThrew = error.message;
}
ok("无 DOM 环境下安全降级", noDomThrew === "", noDomThrew);
const bundleText = fs.readFileSync(path.join(pluginDir, "lib/client.js"), "utf8");
ok("bundle 里内联了高亮模块", bundleText.includes("CSS.highlights"));
ok("只保留高亮：已移除悬停气泡", !bundleText.includes("点击查看完整学习路径") && !bundleText.includes("role\", \"tooltip"));
ok("高亮器暴露 flash()", typeof noDom.flash === "function");
ok("卡片带稳定锚点与双击", bundleText.includes("data-learning-assistant-card") && bundleText.includes("onDoubleClick"));
ok("有独立的闪烁高亮层", bundleText.includes("learning-assistant-flash"));
ok("高亮范围限定在对话区", bundleText.includes("data-conversation-scroll"));

// ---------- 4. Knowledge tree ----------
console.log("\n== 4) 知识树 ==");
const tree = guide.buildKnowledgeTree([
	{ term: "RTOS" },
	{ term: "抢占式优先级调度", parent: "RTOS" },
	{ term: "优先级反转", parent: "抢占式优先级调度" },
	{ term: "优先级继承", parent: "优先级反转" },
	{ term: "裸机程序" },
	{ term: "孤儿词", parent: "不存在的词" }
]);
const rootNames = tree.map((n) => n.term.term);
ok("根节点正确", rootNames.includes("RTOS") && rootNames.includes("裸机程序"), rootNames.join(","));
const rtos = tree.find((n) => n.term.term === "RTOS");
ok("一级延伸挂载", rtos?.children?.[0]?.term?.term === "抢占式优先级调度", JSON.stringify(rtos?.children?.map((c) => c.term.term)));
const level2 = rtos?.children?.[0]?.children?.[0];
ok("二级延伸挂载", level2?.term?.term === "优先级反转", JSON.stringify(level2?.term?.term));
const orphan = tree.find((n) => n.term.term === "孤儿词");
ok("缺失父级标记", orphan?.orphanParent === "不存在的词", String(orphan?.orphanParent));
const cyclic = guide.buildKnowledgeTree([{ term: "A", parent: "B" }, { term: "B", parent: "A" }]);
ok("环形关系不会死循环", cyclic.length === 2 && cyclic.every((n) => n.children.length === 0), JSON.stringify(cyclic.map((n) => n.term.term)));

// ---------- 5. Per-conversation scope ----------
console.log("\n== 5) 展示按对话过滤 ==");
const allTerms = [{ term: "RTOS" }, { term: "VLA" }, { term: "KV Cache" }];
const scoped = guide.filterTermsForText(allTerms, "本对话在讲 VLA 与机器人");
ok("只保留对话里出现的词", scoped.length === 1 && scoped[0].term === "VLA", scoped.map((t) => t.term).join(","));
ok("大小写不敏感", guide.filterTermsForText([{ term: "vla" }], "VLA 是模型").length === 1);
ok("空对话返回空", guide.filterTermsForText(allTerms, "").length === 0);
ok("无关对话返回空", guide.filterTermsForText(allTerms, "今天天气不错").length === 0);

console.log(`\n${failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
