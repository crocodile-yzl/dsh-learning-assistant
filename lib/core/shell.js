"use strict";

/**
 * Browser half of the term guide: the entry the Client module system serves
 * through `package.json`'s `exports["./client"]`.
 *
 * It owns four things:
 *  - the API client over the host's `/learning-assistant` routes;
 *  - a tiny external store the panel renders from;
 *  - the right-sidebar tab (`sidebarRightTabs` + `sidebar.right.pane.tab`),
 *    which docks beside the conversation instead of covering it;
 *  - the panel itself: term cards, the exploration tree, and search links.
 *
 * React only: the host module table seeds `react`, and no other package is
 * required. Elements are built with `React.createElement`, so the build step is
 * template substitution rather than a JSX transform.
 */

const React = require("react");
const guide = require("./guide.js");
const { createHighlighter } = require("./highlight.js");

const h = React.createElement;

/** Services required by the browser half. */
const inject = ["slots", "sidebarRight", "sidebarRightTabs"];

/** The tab type's id and kind: the registry key and what `openTab` names. */
const TAB_ID = "dsh-learning-assistant/tab";
const TAB_KIND = "learning-assistant";

/** Module-scope handoff: `apply` fills it, the panel body reads it. */
const panelContext = { store: null, api: null, highlighter: null, openLink: null, openPanel: null };

/** Route namespace owned by this plugin; the host registers the same prefix. */
const ROUTE_PREFIX = "/learning-assistant";

/** Poll interval while the panel is mounted. */
const POLL_MS = 5000;

/** Palette tuned for the client's dark chrome; every value is inline. */
const T = {
	text: "var(--dsw-alias-label-primary, #e6edf3)",
	muted: "var(--dsw-alias-label-secondary, #8b98ad)",
	faint: "var(--dsw-alias-label-tertiary, #5b6678)",
	line: "var(--dsw-alias-border-l2, rgba(255,255,255,0.10))",
	fill: "var(--dsw-alias-bg-l2, rgba(255,255,255,0.04))",
	accent: "#58a6ff",
	accentSoft: "rgba(88,166,255,0.14)"
};

/**
 * A small clickable chip (provenance links on a card).
 * @param palette - the theme palette.
 * @returns a style object.
 */
function chipButton(palette) {
	return {
		font: "inherit",
		fontSize: 11.5,
		padding: "2px 9px",
		borderRadius: 999,
		border: `1px solid ${palette.line}`,
		background: "transparent",
		color: palette.muted,
		cursor: "pointer",
		whiteSpace: "nowrap"
	};
}

/**
 * Build the API client. Every call answers a promise; the panel renders the
 * failure text instead of crashing when the host is unreachable.
 * @returns `{ state, setLevel, setStrictness, forget, clear }`.
 */
function createApiClient() {
	function base() {
		const location = typeof globalThis === "object" ? globalThis.location : undefined;
		return location && typeof location.origin === "string" ? location.origin : "";
	}

	/**
	 * One JSON call.
	 * @param path - route below {@link ROUTE_PREFIX}.
	 * @param init - fetch init.
	 * @returns the parsed body.
	 */
	async function call(path, init) {
		const fetchImpl = typeof globalThis === "object" && typeof globalThis.fetch === "function" ? globalThis.fetch : null;
		if (fetchImpl === null) throw new Error("当前环境不支持 fetch");
		const response = await fetchImpl(`${base()}${ROUTE_PREFIX}${path}`, {
			...init,
			headers: { "content-type": "application/json" }
		});
		if (!response.ok) throw new Error(`主机返回 HTTP ${response.status}`);
		return response.json();
	}

	return {
		available: () => typeof globalThis === "object" && typeof globalThis.fetch === "function",
		state: () => call("/state", { method: "GET" }),
		setLevel: (level) => call("/level", { method: "POST", body: JSON.stringify({ level }) }),
		setStrictness: (value) => call("/strictness", { method: "POST", body: JSON.stringify({ value }) }),
		forget: (term) => call("/forget", { method: "POST", body: JSON.stringify({ term }) }),
		clear: () => call("/clear", { method: "POST", body: "{}" })
	};
}

/**
 * A minimal external store: one snapshot, many listeners.
 * @param initial - the first state.
 * @returns `{ get, set, subscribe }`.
 */
function createStore(initial) {
	let state = initial;
	const listeners = new Set();
	return {
		get: () => state,
		set(patch) {
			state = { ...state, ...patch };
			for (const listener of listeners) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}

/**
 * Subscribe a component to a store.
 * @param store - the store.
 * @returns the current state.
 */
function useStore(store) {
	const [snapshot, setSnapshot] = React.useState(store.get);
	React.useEffect(() => store.subscribe(() => setSnapshot(store.get())), [store]);
	return snapshot;
}

/**
 * One node of the exploration tree, with a connector to its children.
 * @param props - `{ node, depth, last }`.
 * @returns the node and its subtree.
 */
function TreeNode(props) {
	const { node, depth, last } = props;
	return h(
		"li",
		{ style: { position: "relative", listStyle: "none", paddingLeft: depth === 0 ? 0 : 18 } },
		depth > 0
			? h("span", {
					"aria-hidden": "true",
					style: {
						position: "absolute",
						left: 4,
						top: 0,
						bottom: last ? 14 : 0,
						width: 1,
						background: T.line
					}
			  })
			: null,
		depth > 0
			? h("span", {
					"aria-hidden": "true",
					style: { position: "absolute", left: 4, top: 13, width: 10, height: 1, background: T.line }
			  })
			: null,
		h(
			"div",
			{ style: { display: "flex", gap: 8, alignItems: "baseline", padding: "3px 0" } },
			h("span", {
				"aria-hidden": "true",
				style: {
					width: 6,
					height: 6,
					borderRadius: 999,
					flex: "0 0 auto",
					marginTop: 7,
					background: depth === 0 ? T.accent : "rgba(88,166,255,0.45)"
				}
			}),
			h(
				"div",
				{ style: { minWidth: 0 } },
				h("div", { style: { fontSize: 13.5, fontWeight: 600, color: T.text, lineHeight: 1.45 } }, node.label),
				node.note ? h("div", { style: { fontSize: 12.5, color: T.muted, marginTop: 2, lineHeight: 1.5 } }, node.note) : null
			)
		),
		Array.isArray(node.children) && node.children.length > 0
			? h(
					"ul",
					{ style: { margin: 0, padding: 0 } },
					node.children.map((child, index) =>
						h(TreeNode, { key: index, node: child, depth: depth + 1, last: index === node.children.length - 1 })
					)
			  )
			: null
	);
}

/**
 * The exploration tree card body.
 * @param props - `{ nodes }`.
 * @returns the tree list, or null when empty.
 */
function TreeView(props) {
	const nodes = Array.isArray(props.nodes) ? props.nodes : [];
	if (nodes.length === 0) {
		return h("div", { style: { fontSize: 12.5, color: T.faint } }, "（本次没有生成学习路径）");
	}
	return h(
		"ul",
		{ style: { margin: 0, padding: 0 } },
		nodes.map((node, index) => h(TreeNode, { key: index, node, depth: 0, last: index === nodes.length - 1 }))
	);
}

/**
 * One term card.
 * @param props - `{ item, onForget }`.
 * @returns the card.
 */
function TermCard(props) {
	const { item, onForget, onPick } = props;
	const links = Array.isArray(item.links) ? item.links : [];
	return h(
		"article",
		{
			"data-learning-assistant-card": item.term,
			title: "双击定位到正文中的这个词",
			onDoubleClick: () => {
				panelContext.highlighter?.flash?.(item.term);
			},
			style: {
				border: `1px solid ${T.line}`,
				borderRadius: 12,
				padding: "14px 16px",
				background: T.fill,
				display: "flex",
				flexDirection: "column",
				gap: 10
			}
		},
		// Title row
		h(
			"div",
			{ style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
			h("h3", { style: { margin: 0, fontSize: 16, fontWeight: 700, color: T.text, lineHeight: 1.4 } }, item.term),
			item.category
				? h(
						"span",
						{
							style: {
								fontSize: 11,
								padding: "1px 8px",
								borderRadius: 999,
								background: T.accentSoft,
								color: T.accent,
								border: `1px solid rgba(88,166,255,0.25)`
							}
						},
						item.category
				  )
				: null,
			item.source === "supplement"
				? h(
						"span",
						{
							title: "这个词由插件在你回答后自动补充",
							style: { fontSize: 10.5, color: T.muted, border: `1px dashed ${T.line}`, borderRadius: 999, padding: "0 7px" }
						},
						"自动补充"
				  )
				: null,
			item.count > 1
				? h("span", { style: { fontSize: 11, color: T.faint } }, `已见 ${item.count} 次`)
				: null,
			h(
				"button",
				{
					type: "button",
					onClick: () => onForget(item.term),
					title: "从记忆中移除，以后不再提示",
					style: {
						marginLeft: "auto",
						border: "none",
						background: "transparent",
						color: T.faint,
						cursor: "pointer",
						fontSize: 11.5,
						padding: 0
					}
				},
				"不再提示"
			)
		),
		// Explanation
		item.explanation
			? h("p", { style: { margin: 0, fontSize: 13.5, lineHeight: 1.65, color: T.text } }, item.explanation)
			: null,
		// Tree
		h(
			"div",
			{ style: { display: "flex", flexDirection: "column", gap: 6 } },
			h(
				"div",
				{ style: { fontSize: 11.5, fontWeight: 700, letterSpacing: "0.04em", color: T.muted, textTransform: "uppercase" } },
				"学习路径"
			),
			h(TreeView, { nodes: item.tree })
		),
		// Provenance: what it derives from, and what sits beside it.
		item.parent || (Array.isArray(item.related) && item.related.length > 0)
			? h(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 11.5, color: T.faint } },
					item.parent
						? h(
								"button",
								{
									type: "button",
									onClick: () => onPick(item.parent),
									title: "跳到它隶属的词",
									style: chipButton(T)
								},
								`↖ 隶属 ${item.parent}`
						  )
						: null,
					(Array.isArray(item.related) ? item.related : []).map((name) =>
						h(
							"button",
							{
								key: name,
								type: "button",
								onClick: () => onPick(name),
								title: "跳到相关词",
								style: chipButton(T)
							},
							`↔ ${name}`
						)
					)
			  )
			: null,
		// Links
		links.length > 0
			? h(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 2 } },
					links.map((link, index) =>
						h(
							"a",
							{
								key: index,
								href: link.url,
								target: "_blank",
								rel: "noopener noreferrer",
								onClick: (event) => {
									// `target=_blank` inside the dsh shell can navigate the app
									// itself away; route the URL through the plugin's opener.
									if (typeof panelContext.openLink === "function") {
										event.preventDefault();
										const result = panelContext.openLink(link.url);
										if (result !== null && result !== undefined && typeof result.then === "function") {
											result
												.then((status) => {
													if (status === "copied") panelContext.store?.set?.({ notice: `新窗口被拦截，链接已复制：${link.url}` });
													else if (status === "blocked") panelContext.store?.set?.({ notice: `新窗口被拦截，请手动复制：${link.url}` });
												})
												.catch(() => {});
										}
									}
								},
								style: {
									fontSize: 12,
									color: T.accent,
									textDecoration: "none",
									border: `1px solid rgba(88,166,255,0.28)`,
									borderRadius: 999,
									padding: "2px 10px"
								}
							},
							`${link.label} ↗`
						)
					)
			  )
			: null
	);
}

/**
 * One knowledge-tree node and its subtree.
 * @param props - `{ node, depth, last, onPick }`.
 * @returns the branch.
 */
function TreeBranch(props) {
	const { node, depth, last, onPick } = props;
	const term = node.term;
	const childCount = Array.isArray(node.children) ? node.children.length : 0;
	return h(
		"li",
		{ style: { position: "relative", listStyle: "none", paddingLeft: depth === 0 ? 0 : 18 } },
		depth > 0
			? h("span", {
					"aria-hidden": "true",
					style: { position: "absolute", left: 4, top: 0, bottom: last && childCount === 0 ? 16 : 0, width: 1, background: T.line }
			  })
			: null,
		depth > 0
			? h("span", { "aria-hidden": "true", style: { position: "absolute", left: 4, top: 15, width: 10, height: 1, background: T.line } })
			: null,
		h(
			"div",
			{
				"data-learning-assistant-tree-node": term.term,
				role: "button",
				tabIndex: 0,
				title: "查看该词条",
				onClick: () => onPick(term.term),
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") onPick(term.term);
				},
				style: {
					display: "flex",
					gap: 8,
					alignItems: "flex-start",
					padding: "6px 8px",
					borderRadius: 9,
					cursor: "pointer",
					border: `1px solid ${depth === 0 ? T.line : "transparent"}`,
					background: depth === 0 ? T.fill : "transparent",
					marginBottom: 2
				}
			},
			h("span", {
				"aria-hidden": "true",
				style: {
					width: 6,
					height: 6,
					borderRadius: 999,
					flex: "0 0 auto",
					marginTop: 7,
					background: depth === 0 ? T.accent : "rgba(88,166,255,0.45)"
				}
			}),
			h(
				"div",
				{ style: { minWidth: 0, flex: "1 1 auto" } },
				h(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" } },
					h("span", { style: { fontSize: 13.5, fontWeight: 600, color: T.text } }, term.term),
					term.category
						? h("span", { style: { fontSize: 10.5, color: T.faint, border: `1px solid ${T.line}`, borderRadius: 999, padding: "0 6px" } }, term.category)
						: null,
					childCount > 0 ? h("span", { style: { fontSize: 10.5, color: T.accent } }, `延伸 ${childCount}`) : null
				),
				term.explanation
					? h(
							"div",
							{ style: { fontSize: 12, color: T.muted, lineHeight: 1.5, marginTop: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } },
							term.explanation
					  )
					: null,
				node.orphanParent
					? h("div", { style: { fontSize: 10.5, color: T.faint, marginTop: 3 } }, `隶属 ${node.orphanParent}（未收录）`)
					: null
			)
		),
		childCount > 0
			? h(
					"ul",
					{ style: { margin: 0, padding: 0 } },
					node.children.map((child, index) => h(TreeBranch, { key: child.term.term, node: child, depth: depth + 1, last: index === node.children.length - 1, onPick }))
			  )
			: null
	);
}

/**
 * The whole forest: roots in memory order, each with its sub-terms.
 * @param props - `{ terms, onPick }`.
 * @returns the tree, or an empty-state note.
 */
function KnowledgeTree(props) {
	const { terms, onPick } = props;
	const forest = guide.buildKnowledgeTree(terms);
	if (forest.length === 0) {
		return h("div", { style: { fontSize: 12.5, color: T.faint, padding: "10px 2px" } }, "还没有词条，暂无知识树。");
	}
	return h(
		"div",
		{ style: { display: "flex", flexDirection: "column", gap: 8 } },
		h(
			"div",
			{ style: { fontSize: 11.5, color: T.faint, lineHeight: 1.6 } },
			"按「隶属 → 延伸」组织：上层是更基础的概念，缩进的是由它延伸出来的词。点击任一节点查看词条。"
		),
		h(
			"ul",
			{ style: { margin: 0, padding: 0 } },
			forest.map((node, index) => h(TreeBranch, { key: node.term.term, node, depth: 0, last: index === forest.length - 1, onPick }))
		)
	);
}

/**
 * The conversation header's 「术语」 button: the permanent entry point.
 *
 * A right-sidebar tab alone is only reachable once that column is open, so a
 * user with no recorded terms has nowhere to click. This button always exists
 * while a Session is on screen and opens (or focuses) the tab.
 * @returns the button.
 */
function LearningAssistantButton() {
	const { store } = panelContext;
	const state = useStore(store);
	const count = Array.isArray(state.terms) ? state.terms.length : 0;
	const [hover, setHover] = React.useState(false);
	return h(
		"button",
		{
			type: "button",
			title: count > 0 ? `术语向导：已收录 ${count} 个词条` : "打开术语向导",
			"aria-label": "术语向导",
			onClick: () => {
				if (typeof panelContext.openPanel === "function") panelContext.openPanel();
			},
			onMouseEnter: () => setHover(true),
			onMouseLeave: () => setHover(false),
			style: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				font: "inherit",
				fontSize: 12.5,
				lineHeight: 1,
				padding: "5px 10px",
				borderRadius: 999,
				cursor: "pointer",
				border: `1px solid ${hover ? "rgba(88,166,255,0.45)" : T.line}`,
				background: hover ? T.accentSoft : "transparent",
				color: hover ? T.accent : T.text,
				whiteSpace: "nowrap"
			}
		},
		h(
			"svg",
			{ width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
			h("path", { d: "M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5v-13Z", stroke: "currentColor", strokeWidth: 1.8 }),
			h("path", { d: "M10 4h8.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H10V4Z", stroke: "currentColor", strokeWidth: 1.8 })
		),
		"术语",
		count > 0 ? h("span", { style: { fontSize: 11, color: hover ? T.accent : T.muted, fontVariantNumeric: "tabular-nums" } }, String(count)) : null
	);
}

/**
 * The panel body. The right sidebar renders it with slot props we do not use,
 * so the store and client come from the module-scope handoff instead.
 * @returns the panel.
 */
function GuidePanel() {
	const { store, api } = panelContext;
	const state = useStore(store);
	const [busy, setBusy] = React.useState("");
	const [view, setView] = React.useState("list");
	const [query, setQuery] = React.useState("");
	const searchInput = React.useRef(null);
	// Memory is global; the panel speaks for the conversation on screen.
	const [scope, setScope] = React.useState("conversation");
	const focus = state.focus;
	const notice = state.notice;

	// A link that could not open a window is copied; say so, then fade.
	React.useEffect(() => {
		if (typeof notice !== "string" || notice === "") return;
		const timer = setTimeout(() => store.set({ notice: null }), 5000);
		return () => clearTimeout(timer);
	}, [notice, store]);

	/** Request a jump from the knowledge tree or a related term. */
	const pick = (term) => {
		if (typeof term !== "string" || term === "") return;
		store.set({ focus: { term, nonce: Date.now() } });
	};

	// The periodic load lives in `apply`, not here: polling only while the panel
	// is mounted would leave both the panel and the inline highlight empty until
	// the user happened to open it.

	// A click on a highlighted word leaves a focus request; scroll that card into
	// view and pulse it. The panel may mount after the request was made, so this
	// runs on mount too and gives the list a moment to render.
	const focusNonce = focus === null || focus === undefined ? null : focus.nonce;
	React.useEffect(() => {
		if (focusNonce === null) return;
		const doc = typeof globalThis === "object" ? globalThis.document : undefined;
		if (doc === undefined) return;
		const wanted = store.get().focus?.term;
		if (typeof wanted !== "string" || wanted === "") return;

		const target = store.get().terms?.find((item) => item.term === wanted);
		if (target !== undefined) {
			// Reveal the card before the scroll attempt if search filtered it out.
			setView("list");
			setQuery((current) => guide.matchesTermQuery(target, current) ? current : "");
		}

		let tries = 0;
		let timer = null;

		/** Pulse the card so the user sees which one was chosen. */
		const pulseCard = (node) => {
			try {
				node.animate(
					[
						{ boxShadow: "0 0 0 0 rgba(88,166,255,0)" },
						{ boxShadow: "0 0 0 3px rgba(88,166,255,0.38)" },
						{ boxShadow: "0 0 0 0 rgba(88,166,255,0)" }
					],
					{ duration: 880, iterations: 2 }
				);
			} catch (error) {
				void error;
			}
		};

		/** Centre the card, clamped to the scrollable range. */
		const targetTop = (scroller, card) => {
			const box = scroller.getBoundingClientRect();
			const rect = card.getBoundingClientRect();
			const wantedTop = scroller.scrollTop + (rect.top - box.top) - (scroller.clientHeight - rect.height) / 2;
			return Math.max(0, Math.min(wantedTop, scroller.scrollHeight - scroller.clientHeight));
		};

		const attempt = () => {
			timer = null;
			const scroller = doc.querySelector("[data-learning-assistant-scroll]");
			// A panel that has just mounted can still be 0px tall; centring with
			// that height lands nowhere near the card.
			if (scroller === null || scroller.clientHeight < 40) {
				if (tries < 40) {
					tries += 1;
					timer = setTimeout(attempt, 100);
				}
				return;
			}
			const cards = [...scroller.querySelectorAll("[data-learning-assistant-card]")];
			const card = cards.find((node) => node.getAttribute("data-learning-assistant-card") === wanted);
			if (card === undefined) {
				if (tries < 40) {
					tries += 1;
					timer = setTimeout(attempt, 100);
				}
				return;
			}

			// Measure after the current layout has been committed.
			const top = targetTop(scroller, card);
			try {
				scroller.scrollTo({ top, behavior: "smooth" });
			} catch (error) {
				scroller.scrollTop = top;
				void error;
			}
			pulseCard(card);

			// A smooth scroll can stop short (clamped, interrupted, or re-laid out);
			// correct once it settles instead of trusting the first estimate.
			guide.waitForScrollSettle(scroller, { timeoutMs: 1600 }).then(() => {
				const box = scroller.getBoundingClientRect();
				const rect = card.getBoundingClientRect();
				const drift = rect.top - box.top - (scroller.clientHeight - rect.height) / 2;
				if (Math.abs(drift) > 12) scroller.scrollTop += drift;
			});

			store.set({ focus: null });
		};
		attempt();
		return () => {
			if (timer !== null) clearTimeout(timer);
		};
	}, [focusNonce, store]);

	/**
	 * Run one mutating call, surfacing its failure.
	 * @param name - button identity for the busy state.
	 * @param run - the call.
	 */
	const act = async (name, run) => {
		setBusy(name);
		try {
			const next = await run();
			store.set({ error: null, ...next });
		} catch (error) {
			store.set({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy("");
		}
	};

	const terms = Array.isArray(state.terms) ? state.terms : [];
	// The transcript is the honest definition of "this conversation": a term the
	// memory knows but this thread never mentions does not belong in its panel.
	const transcriptElement = (() => {
		const doc = typeof globalThis === "object" ? globalThis.document : undefined;
		return doc?.querySelector?.("[data-conversation-scroll]") ?? null;
	})();
	// No transcript element at all means we cannot judge the scope (the panel is
	// rendering before the conversation mounts), so fall back to everything
	// rather than claiming the thread has no terms.
	const shown = scope === "conversation" && transcriptElement !== null
		? guide.filterTermsForText(terms, transcriptElement.innerText || "")
		: terms;
	const searching = view === "list" && query.trim() !== "";
	const matches = searching ? shown.filter((item) => guide.matchesTermQuery(item, query)) : shown;
	const level = state.level || "intermediate";
	const strictness = typeof state.strictness === "number" ? state.strictness : 50;

	return h(
		"div",
		{
			"data-learning-assistant-panel": "",
			style: {
				// The right-sidebar tab body is `height:100%; overflow:hidden`; a
				// natural-height root would be clipped with nothing able to scroll.
				display: "flex",
				flexDirection: "column",
				height: "100%",
				minHeight: 0,
				boxSizing: "border-box",
				color: T.text
			}
		},
		// Header (fixed; only the list below scrolls)
		h(
			"header",
			{ style: { display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px 10px", flex: "0 0 auto" } },
			h(
				"div",
				{ style: { display: "flex", alignItems: "baseline", gap: 10 } },
				h("h1", { style: { margin: 0, fontSize: 19, fontWeight: 800 } }, "术语向导"),
				h(
					"span",
					{ role: "status", style: { fontSize: 12.5, color: T.muted } },
					searching
						? `匹配 ${matches.length} / ${shown.length} 个词条`
						: scope === "conversation" ? `本对话 ${shown.length} / 全部 ${terms.length}` : `全部 ${terms.length} 个词条`
				),
				h(
					"div",
					{ style: { marginLeft: "auto", display: "inline-flex", border: `1px solid ${T.line}`, borderRadius: 999, overflow: "hidden" } },
					[
						["conversation", "本对话"],
						["all", "全部"]
					].map(([key, label]) =>
						h(
							"button",
							{
								key,
								type: "button",
								onClick: () => setScope(key),
								"aria-pressed": scope === key,
								style: {
									font: "inherit",
									fontSize: 11.5,
									padding: "3px 10px",
									cursor: "pointer",
									border: "none",
									background: scope === key ? T.accentSoft : "transparent",
									color: scope === key ? T.accent : T.muted
								}
							},
							label
						)
					)
				),
				h(
					"div",
					{ style: { display: "inline-flex", border: `1px solid ${T.line}`, borderRadius: 999, overflow: "hidden" } },
					[
						["list", "词条"],
						["tree", "知识树"]
					].map(([key, label]) =>
						h(
							"button",
							{
								key,
								type: "button",
								onClick: () => setView(key),
								"aria-pressed": view === key,
								style: {
									font: "inherit",
									fontSize: 11.5,
									padding: "3px 10px",
									cursor: "pointer",
									border: "none",
									background: view === key ? T.accentSoft : "transparent",
									color: view === key ? T.accent : T.muted
								}
							},
							label
						)
					)
				),
				h(
					"button",
					{
						type: "button",
						onClick: () => act("refresh", () => api.state()),
						disabled: busy === "refresh",
						style: {
							marginLeft: "auto",
							fontSize: 12,
							color: T.accent,
							background: "transparent",
							border: `1px solid rgba(88,166,255,0.3)`,
							borderRadius: 999,
							padding: "3px 12px",
							cursor: "pointer"
						}
					},
					busy === "refresh" ? "刷新中…" : "刷新"
				)
			),
			view === "list"
				? h(
					"div",
					{ style: { display: "flex", gap: 8 } },
					h("input", {
						ref: searchInput,
						type: "text",
						role: "searchbox",
						"aria-label": "搜索术语",
						placeholder: "搜索术语或解释",
						value: query,
						onChange: (event) => setQuery(event.target.value),
						style: {
							flex: "1 1 auto",
							minWidth: 0,
							font: "inherit",
							fontSize: 13,
							padding: "6px 10px",
							borderRadius: 8,
							border: `1px solid ${T.line}`,
							background: T.fill,
							color: T.text
						}
					}),
					query === "" ? null : h(
						"button",
						{
							type: "button",
							"aria-label": "清空搜索",
							style: chipButton(T),
							onClick: () => {
								setQuery("");
								searchInput.current?.focus();
							}
						},
						"清空"
					)
				)
				: null,
			// Level
			h(
				"div",
				{ style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
				h("span", { style: { fontSize: 12, color: T.muted } }, "我的水平"),
				guide.LEVELS.map((option) =>
					h(
						"button",
						{
							key: option,
							type: "button",
							onClick: () => act(`level:${option}`, () => api.setLevel(option)),
							disabled: busy === `level:${option}`,
							style: {
								fontSize: 12,
								padding: "3px 12px",
								borderRadius: 999,
								cursor: "pointer",
								border: `1px solid ${level === option ? T.accent : T.line}`,
								background: level === option ? T.accentSoft : "transparent",
								color: level === option ? T.accent : T.muted
							}
						},
						guide.LEVEL_CHIPS[option]
					)
				)
			),
			// Strictness
			h(
				"div",
				{ style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
				h("span", { style: { fontSize: 12, color: T.muted } }, "解释倾向"),
				h("input", {
					type: "range",
					min: 0,
					max: 100,
					step: 5,
					value: strictness,
					onChange: (event) => act("strictness", () => api.setStrictness(Number(event.target.value))),
					style: { width: 160, accentColor: T.accent }
				}),
				h("span", { style: { fontSize: 12, color: T.faint } }, `${strictness} / 100`),
				h(
					"span",
					{ style: { fontSize: 11.5, color: T.faint } },
					strictness >= 70 ? "尽量多解释" : strictness <= 30 ? "只在必要时解释" : "均衡"
				)
			),
			state.error
				? h(
						"div",
						{
							style: {
								fontSize: 12.5,
								color: "#ff7b72",
								border: "1px solid rgba(255,123,114,0.35)",
								background: "rgba(255,123,114,0.08)",
								borderRadius: 10,
								padding: "8px 12px"
							}
						},
						`无法连接主机：${state.error}`
				  )
				: null,
			notice
				? h(
						"div",
						{
							style: {
								fontSize: 12,
								color: T.accent,
								border: "1px solid rgba(88,166,255,0.3)",
								background: T.accentSoft,
								borderRadius: 10,
								padding: "8px 12px",
								lineHeight: 1.6,
								wordBreak: "break-all"
							}
						},
						notice
				  )
				: null
		),
		// Body: the pane body clips overflow, so this element is the scroller.
		h(
			"div",
			{
				"data-learning-assistant-scroll": "",
				style: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "2px 16px 28px", overscrollBehavior: "contain" }
			},
			view === "tree"
				? h(KnowledgeTree, { terms: shown, onPick: pick })
				: matches.length === 0
				? h(
					"div",
					{
						style: {
							border: `1px dashed ${T.line}`,
							borderRadius: 14,
							padding: "34px 24px",
							textAlign: "center",
							color: T.muted,
							fontSize: 13.5,
							lineHeight: 1.8
						}
					},
					h(
						"div",
						{ style: { fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 6 } },
						searching ? "没有匹配的词条" : scope === "conversation" ? "本对话还没有术语" : "还没有词条"
					),
					searching ? null : scope === "conversation"
						? h("div", {}, "这个对话里还没出现需要解释的专业词。记忆是全局的——别的对话学过的词不会重复出现在这里。")
						: h("div", {}, "当 AI 判断某个专业术语你未必听得懂时，会把它写进这里：一句话解释 + 从基础到该词的探索路径 + 搜索外链。"),
					searching ? null : h(
						"div",
						{ style: { marginTop: 8, color: T.faint, fontSize: 12.5 } },
						scope === "conversation" ? "去提一个含专业词的问题试试；想翻全部记忆，切到上方「全部」。" : "去对话里提一个问题试试；越追问，它越懂你已经会了什么。"
					)
			  )
			: h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 12 } },
					matches.map((item) =>
						h(TermCard, {
							key: item.term,
							item,
							onForget: (term) => act(`forget:${term}`, () => api.forget(term)),
							onPick: pick
						})
					)
			  )
		)
	);
}

/**
 * Mount the browser half.
 * @param ctx - the client Cordis context.
 */
function apply(ctx) {
	const api = createApiClient();
	const store = createStore({ terms: [], level: "intermediate", strictness: 50, error: null });

	/**
	 * Bring the sidebar entry forward. Used when a new term has just been
	 * recorded, so the panel is not something the user has to go looking for.
	 */
	const openPanel = (term) => {
		try {
			ctx.sidebarRight.openTab(TAB_KIND);
		} catch (error) {
			void error;
		}
		// The panel scrolls to this card once it is mounted; a nonce makes a
		// repeated click on the same term re-trigger the scroll.
		if (typeof term === "string" && term !== "") store.set({ focus: { term, nonce: Date.now() } });
	};

	// ---- the periodic load (independent of whether the panel is mounted) ----
	let disposed = false;
	let hydrated = false;
	/** Term names seen at the previous load, for "is this new?" */
	let known = new Set();

	/**
	 * One state refresh. A term set that grows after the first hydration opens
	 * the panel once; the initial hydration never steals the view.
	 */
	const load = async () => {
		if (disposed) return;
		try {
			const next = await api.state();
			if (disposed) return;
			const terms = Array.isArray(next.terms) ? next.terms : [];
			const names = new Set(terms.map((item) => item.term));
			const fresh = [...names].filter((name) => !known.has(name));
			const wasHydrated = hydrated;
			known = names;
			store.set({ error: null, ...next });
			hydrated = true;
			if (wasHydrated && fresh.length > 0) openPanel();
		} catch (error) {
			if (disposed) return;
			store.set({ error: error instanceof Error ? error.message : String(error) });
		}
	};

	load();
	const timer = setInterval(load, POLL_MS);
	const onFocus = () => {
		if (typeof globalThis === "object" && globalThis.document !== undefined && globalThis.document.visibilityState === "hidden") return;
		load();
	};
	if (typeof globalThis === "object" && typeof globalThis.addEventListener === "function") {
		globalThis.addEventListener("focus", onFocus);
	}

	// Inline highlighting of recorded terms in the transcript. A browser without
	// the Custom Highlight API keeps working: the highlighter no-ops.
	const highlighter = createHighlighter({
		document: typeof globalThis === "object" && globalThis.document !== undefined ? globalThis.document : null,
		getTerms: () => store.get().terms,
		onOpen: (term) => openPanel(term),
		logger: console
	});
	try {
		highlighter.start();
	} catch (error) {
		console.warn("[learning-assistant] highlighter failed to start:", error);
	}
	// Repaint whenever the term set changes (a poll, a forget, a level change).
	store.subscribe(() => {
		try {
			highlighter.refresh();
		} catch (error) {
			void error;
		}
	});
	ctx.effect(() => () => {
		disposed = true;
		clearInterval(timer);
		if (typeof globalThis === "object" && typeof globalThis.removeEventListener === "function") {
			globalThis.removeEventListener("focus", onFocus);
		}
		highlighter.stop();
	}, "learning-assistant: learning-assistant lifecycle");

	// Hand the panel body its store, client and highlighter; the slot renders it
	// without props.
	panelContext.store = store;
	panelContext.api = api;
	panelContext.highlighter = highlighter;

	// External links open in the right sidebar's browser tab when this build has
	// one; `window.open` inside the dsh shell can navigate the app itself away.
	panelContext.openLink = (url) => {
		if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
		try {
			const tabs = typeof ctx.get === "function" ? ctx.get("sidebarRightTabs") : null;
			// Prefer the in-app browser tab: it keeps dsh on screen, while a new
			// window can be captured by an embedding shell and replace the app.
			if (tabs !== null && tabs !== undefined && typeof tabs.entries === "function") {
				const browser = tabs
					.entries()
					.find((type) => type !== null && type !== undefined && (type.kind === "browser" || String(type.id ?? "").includes("browser")));
				if (browser !== undefined) {
					ctx.sidebarRight.openTab(browser.kind, { params: { url } });
					return Promise.resolve("sidebar");
				}
			}
		} catch (error) {
			void error;
		}
		// No in-app browser in this composition: a new window keeps dsh on screen.
		// A blocked popup is a real dead end, so the URL is copied instead and the
		// panel says so — better than a click that appears to do nothing.
		let opened = null;
		try {
			if (typeof globalThis.open === "function") opened = globalThis.open(url, "_blank", "noopener,noreferrer");
		} catch (error) {
			void error;
		}
		if (opened !== null && opened !== undefined) return Promise.resolve("opened");

		// The popup was blocked. Copy the URL so the click still yields something;
		// the exact status decides what the panel claims.
		const clipboard = typeof globalThis === "object" ? globalThis.navigator?.clipboard : undefined;
		if (clipboard !== undefined && typeof clipboard.writeText === "function") {
			return Promise.resolve(clipboard.writeText(url)).then(
				() => "copied",
				() => "blocked"
			);
		}
		return Promise.resolve("blocked");
	};

	// The tab TYPE: a page named by kind. No `patterns` — it is not opened by a
	// resource address, only by `openTab(kind)`.
	ctx.effect(
		() =>
			ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				title: () => "术语"
			}),
		"learning-assistant: right sidebar tab type"
	);

	// The permanent entry point: a header button, so the panel is reachable even
	// before any term exists.
	panelContext.openPanel = openPanel;
	ctx.slots.inject("conversation.session.header.actions", () =>
		ctx.slots.register(
			{
				name: "conversation.session.header.actions",
				id: "learning-assistant-entry",
				order: 20
			},
			LearningAssistantButton
		)
	);

	// The tab BODY, keyed by the type's id.
	ctx.slots.inject("sidebar.right.pane.tab", () =>
		ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, GuidePanel)
	);
}

exports.apply = apply;
exports.inject = inject;
// Test seam: the functional check seeds the store without a browser.
exports.panelContext = panelContext;
