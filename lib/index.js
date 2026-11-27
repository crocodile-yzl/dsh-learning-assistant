/**
 * Host half of the term guide.
 *
 * It owns three things the page cannot own by itself:
 *  1. the durable memory file, under `$DSH_HOME/dsh-learning-assistant/`;
 *  2. the model-facing `explain_terms` tool plus the system-prompt section that
 *     tells the model when to call it;
 *  3. an HTTP surface on the Web carrier, which the page reads and writes.
 *
 * The merge and normalization rules live in `lib/core/guide.js`, loaded through
 * `createRequire` so the host and the page apply exactly the same rules.
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

const require = createRequire(import.meta.url);
const guide = require("./core/guide.js");

/** The package name; also the row id the patch inserts. */
export const name = "learning-assistant";

/** Required services: tools to register, webServer to serve the panel's data. */
export const inject = ["tools", "webServer"];

/** Deadline for one supplemental explanation call. */
const SUPPLEMENT_TIMEOUT_MS = 45_000;

/** How long to wait for the turn to finish before scanning it. */
const SUPPLEMENT_DEBOUNCE_MS = 2_500;

/** Minimum gap between two supplement passes of the SAME session. */
const SUPPLEMENT_COOLDOWN_MS = 15_000;

/** Supplement passes that may call the model at the same time, across sessions. */
const SUPPLEMENT_CONCURRENCY = 2;

/** Longest term a user may select and ask to have explained. */
const MANUAL_TERM_CHARS = 60;

/** Characters of surrounding transcript sent along with a manual term. */
const MANUAL_CONTEXT_CHARS = 400;

/** System prompt for the supplemental explanation call. */
const SUPPLEMENT_SYSTEM = "你是术语补充解释器，只输出 JSON，不写任何多余文字。";

/** Route namespace owned by this plugin. The browser half spells the same string. */
const ROUTE_PREFIX = "/learning-assistant";

/** Largest accepted request body. */
const MAX_BODY_BYTES = 256 * 1024;

/** Prompt section order: after the tool documentation, before the tail. */
const SECTION_ORDER = 150;

/**
 * Resolve the memory file path.
 * @returns absolute path to `terms.json`.
 */
function memoryPath() {
	const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, "dsh-learning-assistant", "terms.json");
}

/**
 * Read the memory file, caching by mtime.
 *
 * Assembly runs once per step, so a stale cache would hide a term the user just
 * forgot; an mtime check keeps that cheap.
 *
 * @param cache - `{ mtimeMs, size, value, corrupted }` holder.
 * @param defaults - level and strictness used when the file is absent.
 * @returns the current memory.
 */
function readMemory(cache, defaults) {
	const path = memoryPath();
	try {
		if (!existsSync(path)) {
			cache.mtimeMs = -1;
			if (cache.value === null) cache.value = guide.emptyMemory(defaults.level, defaults.strictness);
			return cache.value;
		}
		const stat = require("node:fs").statSync(path);
		// mtime alone can miss a rewrite that landed in the same millisecond as
		// the cached read; the size catches a rewrite that changed the length.
		if (stat.mtimeMs !== cache.mtimeMs || stat.size !== cache.size || cache.value === null) {
			const raw = readFileSync(path, "utf8");
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch (error) {
				// A file that no longer parses must not be served again on the next
				// read, or the panel stays empty with nothing said. Move it aside
				// (the user's terms are still in there), start from an empty memory
				// and tell the page where the copy went.
				const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
				try {
					renameSync(path, backup);
				} catch (moveError) {
					console.error("[learning-assistant] could not move the unreadable memory file:", moveError);
				}
				console.error("[learning-assistant] memory file is not valid JSON; moved to", backup);
				cache.mtimeMs = -1;
				cache.value = guide.emptyMemory(defaults.level, defaults.strictness);
				cache.corrupted = backup;
				return cache.value;
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("memory root is not an object");
			cache.value = {
				...guide.emptyMemory(defaults.level, defaults.strictness),
				...parsed,
				terms: Array.isArray(parsed.terms) ? parsed.terms : []
			};
			cache.mtimeMs = stat.mtimeMs;
			cache.size = stat.size;
		}
		return cache.value;
	} catch (error) {
		console.error("[learning-assistant] memory read failed:", error);
		if (cache.value === null) cache.value = guide.emptyMemory(defaults.level, defaults.strictness);
		return cache.value;
	}
}

/**
 * Persist memory atomically (write a sibling temp file, then rename).
 * @param memory - the memory to store.
 * @returns the stored memory.
 */
function writeMemory(memory) {
	const path = memoryPath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
	renameSync(temp, path);
	return memory;
}

/**
 * The state the page reads.
 * @param memory - current memory.
 * @param cache - the cache holder; `corrupted` names a backup made this run.
 * @returns a JSON-safe payload.
 */
function stateOf(memory, cache = null) {
	return {
		terms: Array.isArray(memory.terms) ? memory.terms : [],
		level: memory.level,
		strictness: memory.strictness,
		updatedAt: memory.updatedAt,
		corrupted: typeof cache?.corrupted === "string" ? cache.corrupted : null
	};
}

/**
 * Find a remembered term under any spelling.
 * @param memory - current memory.
 * @param term - the name as written anywhere.
 * @returns the stored record, or undefined.
 */
function findTerm(memory, term) {
	const key = guide.termKey(term);
	if (key === "") return undefined;
	return (Array.isArray(memory.terms) ? memory.terms : []).find((item) => guide.termKey(item?.term) === key);
}

/**
 * Read a JSON request body under a byte ceiling.
 * @param req - incoming request.
 * @returns the parsed object, or null when unusable.
 */
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) return null;
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed !== null && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Send one JSON response.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param body - JSON body.
 */
function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text)
	});
	res.end(text);
}

/**
 * Try to contribute a system-prompt section; a composition without the
 * system-prompt service keeps working through the tool description alone.
 * @param ctx - the host context.
 * @param read - reads the current config defaults.
 * @param cache - the memory cache holder.
 */
function contributePrompt(ctx, read, cache) {
	// The prompt section runs before every model step; cache its text for a few
	// seconds so the memory read stays off the per-step hot path.
	const promptCache = { text: "", builtAt: 0 };
	ctx.inject(["systemPrompt"], (promptCtx) => {
		promptCtx.effect(
			() =>
				promptCtx.systemPrompt.section({
					name: "learning-assistant",
					order: SECTION_ORDER,
					text: () => {
						const now = Date.now();
						if (promptCache.text !== "" && now - promptCache.builtAt < 3000) return promptCache.text;
						const memory = readMemory(cache, read());
						const known = guide.summarizeMemory(memory);
						const text = [
							"## 术语向导",
							"回答时，把正文里出现、且用户（水平：" + guide.LEVEL_LABELS[memory.level] + "，严格度 " + memory.strictness + "/100）可能不懂的专业词，用 explain_terms 记到侧栏。",
							(known === "" ? "记忆：无。" : "已收录（不重复）：" + known + "。"),
							"规则：只收该领域专业词、高于用户水平、与问题相关的；每次≤4个；词给≤60字说人话解释 + 3–5节点学习路径 + 隶属(parent)。",
							"「提到一个词」或「想学某方向」不算已掌握，都要解释；缩写默认解释；拿不准就解释。",
							"不要为了用工具改变回答方式；没调用也不要紧，宿主会自动补齐。"
						].join("\n");
						promptCache.text = text;
						promptCache.builtAt = now;
						return text;
					}
				}),
			"learning-assistant: system prompt section"
		);
	});
}

/**
 * Pull one JSON object out of a model reply, fenced or bare.
 * @param text - the model output.
 * @returns the parsed object, or null.
 */
function parseJsonLoose(text) {
	if (typeof text !== "string") return null;
	let body = text.trim();
	const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced !== null) body = fenced[1].trim();
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(body.slice(start, end + 1));
		return parsed !== null && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Pull a JSON array out of a model reply, fenced or bare.
 * @param text - the model output.
 * @returns the parsed array, or null.
 */
function parseJsonArrayLoose(text) {
	if (typeof text !== "string") return null;
	let body = text.trim();
	const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced !== null) body = fenced[1].trim();
	const start = body.indexOf("[");
	const end = body.lastIndexOf("]");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(body.slice(start, end + 1));
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Mount the host half.
 * @param ctx - the host context.
 * @param config - `{ level, strictness, autoAdapt }` from the cordis row.
 */
export function apply(ctx, config = {}) {
	const defaults = {
		level: guide.normalizeLevel(config.level),
		strictness: guide.clampInt(config.strictness, guide.STRICTNESS_MIN, guide.STRICTNESS_MAX, 50)
	};
	const cache = { mtimeMs: -1, size: -1, value: null, corrupted: null };
	/** Read the defaults the memory falls back to. */
	const read = () => defaults;

	/**
	 * Write memory through and refresh the cache. One place, so every writer
	 * (tool, route, supplement pass) leaves the cache in the same state — and
	 * a successful write is what clears the "file was unreadable" notice.
	 */
	const persist = (memory) => {
		writeMemory(memory);
		cache.value = memory;
		cache.mtimeMs = Date.now();
		cache.corrupted = null;
		return stateOf(memory, cache);
	};

	/** Persist a change and return the new state. */
	const commit = (mutate) => persist(mutate(readMemory(cache, defaults)));

	// ---- model-facing tool ----
	ctx.tools.register(
		defineTool({
			name: "explain_terms",
			description:
				"Record professional terms from your answer that the user may not understand, with a one-sentence explanation and a from-basics exploration path. " +
				"Call it only when a term is domain-specific, above the user's level, and relevant to their current goal. " +
				"When the user says they want to enter or study a field, explain that field's key acronym even if it looks familiar; abbreviations default to being explained. " +
				"At most 4 terms per call; skip the call entirely when nothing needs explaining.",
			parameters: {
				terms: {
					type: "array",
					required: true,
					description: "Terms to explain. At most 4.",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							term: { type: "string", required: true, description: "The exact term as written in the answer." },
							explanation: { type: "string", required: true, description: "One plain-language sentence, at most 60 characters." },
							category: { type: "string", description: "Short domain label, e.g. 机器学习 / 分布式系统 / 法律." },
							parent: {
								type: "string",
								description: "The already-recorded term this one derives from, spelled exactly. Omit when it is a new root."
							},
							related: {
								type: "array",
								description: "Adjacent or sibling terms already recorded, for cross links.",
								items: { type: "string" }
							},
							confidence: { type: "number", description: "0–1: how likely the user does not know this term." },
							tree: {
								type: "array",
								description: "Exploration path from basic concepts to this term, shallow-to-deep.",
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										label: { type: "string", required: true, description: "A concept on the path." },
										note: { type: "string", description: "One line on why this step matters." },
										children: { type: "array", description: "Optional finer steps below this one.", items: { type: "object", additionalProperties: true } }
									}
								}
							},
							links: {
								type: "array",
								description: "Optional authoritative links. Search links are added automatically.",
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										label: { type: "string", required: true },
										url: { type: "string", required: true }
									}
								}
							}
						}
					}
				},
				reason: { type: "string", description: "One short line: why these terms need explaining now." },
				strictnessAdjust: { type: "number", description: "−20…+20. Raise when the user keeps asking about the same concept." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						saved: { type: "number" },
						total: { type: "number" },
						level: { type: "string" },
						strictness: { type: "number" },
						terms: { type: "array", items: { type: "string" } },
						updatedAt: { type: "string" }
					}
				},
				render: (_args, value) => [
					{
						type: "text",
						text:
							value.saved === 0
								? "没有可记录的术语。"
								: `已记录 ${value.saved} 个术语：${value.terms.join("、")}（严格度 ${value.strictness}/100，共 ${value.total} 个词条）`
					}
				]
			},
			async execute(args) {
				const records = guide.normalizeTerms(args);
				if (records.length === 0) {
					const memory = readMemory(cache, defaults);
					return { saved: 0, total: memory.terms.length, level: memory.level, strictness: memory.strictness, terms: [], updatedAt: memory.updatedAt };
				}
				const before = readMemory(cache, defaults);
				const next = guide.mergeTerms(before, records, {
					now: new Date(),
					level: before.level,
					strictnessAdjust: args.strictnessAdjust,
					reason: args.reason
				});
				persist(next);
				return {
					saved: records.length,
					total: next.terms.length,
					level: next.level,
					strictness: next.strictness,
					// The stored spelling, which may be an earlier one.
					terms: records.map((record) => findTerm(next, record.term)?.term ?? record.term),
					updatedAt: next.updatedAt
				};
			}
		})
	);

	contributePrompt(ctx, read, cache);

	// ---- HTTP surface for the panel ----
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: ROUTE_PREFIX,
				handler: async (req, res) => {
					const url = new URL(req.url ?? "/", "http://dsh.invalid");
					const path = url.pathname.slice(ROUTE_PREFIX.length) || "/";
					try {
						if (path === "/state" || path === "/") {
							if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
							const state = stateOf(readMemory(cache, defaults), cache);
							// The page polls; when it already holds this revision there is
							// nothing to ship. `corrupted` still travels, so a notice is never lost.
							const since = url.searchParams.get("since");
							if (since !== null && since === state.updatedAt && state.corrupted === null) {
								return sendJson(res, 200, { unchanged: true, updatedAt: state.updatedAt });
							}
							return sendJson(res, 200, state);
						}
						if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
						const body = await readJson(req);
						if (body === null) return sendJson(res, 400, { error: "a JSON object body is required" });

						if (path === "/level") {
							const level = guide.normalizeLevel(body.level);
							return sendJson(res, 200, commit((memory) => ({ ...memory, level, updatedAt: new Date().toISOString() })));
						}
						if (path === "/strictness") {
							const strictness = guide.clampInt(body.value, guide.STRICTNESS_MIN, guide.STRICTNESS_MAX, 50);
							return sendJson(res, 200, commit((memory) => ({ ...memory, strictness, updatedAt: new Date().toISOString() })));
						}
						if (path === "/forget") {
							const term = guide.cleanText(body.term, 60);
							if (term === "") return sendJson(res, 400, { error: "term is required" });
							const key = guide.termKey(term);
							return sendJson(
								res,
								200,
								commit((memory) => ({
									...memory,
									terms: memory.terms.filter((item) => guide.termKey(item?.term) !== key),
									updatedAt: new Date().toISOString()
								}))
							);
						}
						if (path === "/explain") {
							// The user selected a word and asked for it. A remembered term is
							// returned as it is; a new one gets one explanation call.
							const selected = typeof body.term === "string" ? body.term.replace(/\s+/g, " ").trim() : "";
							if (selected === "") return sendJson(res, 400, { error: "term is required" });
							if (selected.length > MANUAL_TERM_CHARS) return sendJson(res, 413, { error: "selection is too long", limit: MANUAL_TERM_CHARS });
							const context = typeof body.context === "string" ? body.context.slice(0, MANUAL_CONTEXT_CHARS) : "";
							const existing = findTerm(readMemory(cache, defaults), selected);
							if (existing !== undefined) {
								return sendJson(res, 200, { ...stateOf(readMemory(cache, defaults), cache), term: existing.term, existing: true });
							}
							const record = await explainSelected(selected, context, readMemory(cache, defaults));
							if (record === null) return sendJson(res, 503, { error: "no model route available" });
							const next = guide.mergeTerms(readMemory(cache, defaults), [{ ...record, source: "manual" }], {
								now: new Date(),
								level: readMemory(cache, defaults).level,
								strictnessAdjust: 0,
								reason: `用户选中并要求解释 ${record.term}`
							});
							persist(next);
							return sendJson(res, 200, { ...stateOf(next, cache), term: findTerm(next, record.term)?.term ?? record.term, existing: false });
						}
						if (path === "/clear") {
							return sendJson(res, 200, commit((memory) => ({ ...memory, terms: [], updatedAt: new Date().toISOString() })));
						}
						return sendJson(res, 404, { error: "not found" });
					} catch (error) {
						// The log keeps the detail; the page gets a stable line, never a
						// stack trace or a filesystem path.
						console.error("[learning-assistant] route failed:", path, error);
						sendJson(res, 500, { error: "internal error" });
					}
				}
			}),
		`learning-assistant: routes under ${ROUTE_PREFIX}`
	);

	// ---- supplemental explanations -------------------------------------------
	// The model answers however it likes. After the answer settles, this asks
	// the model which professional terms the text left unexplained and writes
	// the explanation itself, so the sidebar never depends on the model
	// remembering to call a tool.
	let llm = null;
	let defaultModel = null;
	ctx.inject(["llm", "agentDefaultModel"], (serviceCtx) => {
		llm = serviceCtx.llm ?? null;
		defaultModel = serviceCtx.agentDefaultModel ?? null;
		ctx.effect(
			() => () => {
				llm = null;
				defaultModel = null;
			},
			"learning-assistant: supplement services detached"
		);
	});

	// Locks are per session: one conversation's long answer must not silence
	// every other conversation. `running` caps the model calls in flight at once.
	const supplement = {
		running: new Set(),
		lastRun: new Map(),
		timers: new Map(),
		pending: new Map(),
		questions: new Map(),
		debounceMs: guide.clampInt(config.supplementDebounceMs, 0, 60_000, SUPPLEMENT_DEBOUNCE_MS),
		cooldownMs: guide.clampInt(config.supplementCooldownMs, 0, 3_600_000, SUPPLEMENT_COOLDOWN_MS)
	};

	/**
	 * Pick the route the agent itself is using, then any provider that has models.
	 * @returns `{ provider, model }`, or null when nothing is mounted.
	 */
	async function resolveTarget() {
		try {
			const current = typeof defaultModel?.currentSelection === "function" ? defaultModel.currentSelection() : null;
			if (current !== null && typeof current.provider === "string" && typeof current.model === "string") {
				return { provider: current.provider, model: current.model };
			}
		} catch (error) {
			void error;
		}
		if (llm === null) return null;
		try {
			const providers = typeof llm.listProviders === "function" ? llm.listProviders() : [];
			for (const provider of providers) {
				const id = provider?.provider ?? provider?.id ?? provider?.name;
				if (typeof id !== "string" || id === "") continue;
				const models = await llm.listModels(id);
				const model = Array.isArray(models) && models.length > 0 ? models[0].model ?? models[0].id : null;
				if (typeof model === "string" && model !== "") return { provider: id, model };
			}
		} catch (error) {
			console.error("[learning-assistant] model route resolution failed:", error);
		}
		return null;
	}

	/**
	 * One model call that must answer with JSON. Shared by the automatic pass
	 * and the manual "explain this" route, so both stream, time out and log
	 * the same way.
	 * @param prompt - the user message.
	 * @param maxTokens - reply budget.
	 * @param shape - `array` or `object`: which JSON top level the prompt asked for.
	 * @returns the parsed value, or null.
	 */
	async function requestModelJson(prompt, maxTokens, shape = "array") {
		if (llm === null) return null;
		const target = await resolveTarget();
		if (target === null) return null;

		const controller = typeof AbortController === "function" ? new AbortController() : null;
		const timer = controller === null ? null : setTimeout(() => controller.abort(), SUPPLEMENT_TIMEOUT_MS);
		try {
			const stream = llm.stream({
				provider: target.provider,
				model: target.model,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
				system: SUPPLEMENT_SYSTEM,
				temperature: 0.2,
				maxTokens,
				...(controller === null ? {} : { signal: controller.signal })
			});
			let textOut = "";
			for await (const chunk of stream) {
				if (chunk !== null && typeof chunk === "object" && chunk.type === "text-delta" && typeof chunk.text === "string") textOut += chunk.text;
			}
			// Parse for the shape that was asked for. An object whose fields hold
			// arrays would otherwise be "found" as the first of those arrays.
			const primary = shape === "array" ? parseJsonArrayLoose(textOut) : parseJsonLoose(textOut);
			if (primary !== null) return primary;
			return shape === "array" ? parseJsonLoose(textOut) : parseJsonArrayLoose(textOut);
		} catch (error) {
			console.error("[learning-assistant] model call failed:", error instanceof Error ? error.message : error);
			return null;
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}

	/**
	 * Scan one finished answer and store what it did not explain.
	 * @param sessionKey - the conversation the answer belongs to.
	 * @param text - the answer text.
	 * @param question - the user's question, for disambiguation.
	 */
	async function runSupplement(sessionKey, text, question) {
		if (supplement.running.has(sessionKey)) return;
		if (supplement.running.size >= SUPPLEMENT_CONCURRENCY) return;
		const last = supplement.lastRun.get(sessionKey) ?? 0;
		if (Date.now() - last < supplement.cooldownMs) return;
		if (llm === null || typeof text !== "string" || text.length < 40) return;

		const memory = readMemory(cache, defaults);
		const limit = memory.strictness >= 70 ? 3 : memory.strictness <= 30 ? 1 : 2;

		supplement.running.add(sessionKey);
		try {
			// Let the model pick the terms it left unexplained, instead of a
			// brittle acronym regex. This catches ViT, CLIP, Transformer, LeRobot,
			// and CJK terms alike — anything a reader at `memory.level` could miss.
			const records = await pickUnexplainedTerms(text, question, memory, limit);
			if (records.length > 0) {
				// One merge, one write: the whole pass lands or nothing does.
				const current = readMemory(cache, defaults);
				persist(
					guide.mergeTerms(
						current,
						records.map((record) => ({ ...record, source: "supplement" })),
						{
							now: new Date(),
							level: current.level,
							strictnessAdjust: 0,
							reason: `自动补充：正文未解释 ${records.map((record) => record.term).join("、")}`
						}
					)
				);
			}
		} catch (error) {
			console.error("[learning-assistant] supplement pass failed:", error);
		} finally {
			supplement.running.delete(sessionKey);
			supplement.lastRun.set(sessionKey, Date.now());
		}
	}

	/**
	 * Explain one term the user selected.
	 * @param term - the selected text.
	 * @param context - transcript around the selection.
	 * @param memory - current memory (level + known names for `parent`).
	 * @returns one normalized record, or null when no model answered.
	 */
	async function explainSelected(term, context, memory) {
		const known = guide.mostFamiliar(memory, 40).join("、");
		const prompt = [
			"用户在 AI 的回答里选中了「" + term + "」，要求解释它。用户水平：" + guide.LEVEL_LABELS[memory.level] + "。",
			"结合下面的上下文判断它在这里的含义（同一个缩写在不同领域意思不同）。",
			context === "" ? "" : "上下文（选中词前后）：\n" + context,
			"已收录的词（隶属关系只能从中选）：" + (known === "" ? "（无）" : known) + "。",
			"",
			"只输出一个 JSON 对象：",
			'{ "term":"' + term + '", "explanation":"≤60字说人话解释", "category":"领域标签",',
			'  "tree":[{"label":"最基础概念","note":"一句话"},{"label":"中间概念","note":"..."},{"label":"' + term + '","note":"..."}],',
			'  "parent":"（可选）已收录词中它隶属的那个，没有就省略",',
			'  "related":["（可选）已收录的相关词"],',
			'  "links":[{"label":"权威来源","url":"https://..."}] }',
			"学习路径 3–5 个节点，由浅入深。只输出 JSON。"
		].join("\n");
		const parsed = await requestModelJson(prompt, 900, "object");
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		// The selection names the term; the model may not rename it.
		const record = guide.normalizeTerm({ ...parsed, term });
		return record === null ? { term, explanation: "", tree: [], links: [] } : record;
	}

	/**
	 * Ask the model which terms in one answer it left unexplained, and return
	 * fully-formed records for up to `limit` of them.
	 * @param text - the answer.
	 * @param question - the user's last question (for disambiguation).
	 * @param memory - current memory (level + known names).
	 * @param limit - how many terms to explain at most.
	 * @returns normalized term records (empty when nothing needs explaining).
	 */
	async function pickUnexplainedTerms(text, question, memory, limit) {
		if (llm === null) return [];
		// The most-met names first: those are the ones the model must not list again.
		const known = guide.mostFamiliar(memory, 40).join("、");
		const prompt = [
			"下面是 AI 的一段回答。请从中挑出「用户（水平：" + guide.LEVEL_LABELS[memory.level] + "）可能不理解的、且这段回答本身没有解释清楚的专业术语」。",
			"标准：该领域的专有名词或缩写（如 ViT、CLIP、Transformer、LeRobot、注意力机制、量化……），不是普通词。",
			"已收录、本次不要再列：" + (known === "" ? "（无）" : known) + "。",
			question === "" ? "" : "用户的原问题（用于消歧）：" + question.slice(0, 300),
			"",
			"回答原文：",
			String(text).slice(0, 4000),
			"",
			"只输出 JSON 数组，每个元素是一个术语对象：",
			'[{ "term":"术语", "explanation":"≤60字说人话解释", "category":"领域标签",',
			'   "tree":[{"label":"最基础概念","note":"一句话"},{"label":"中间概念","note":"..."},{"label":"该术语","note":"..."}],',
			'   "parent":"（可选）已收录词中它隶属的那个，没有就省略",',
			'   "links":[{"label":"权威来源","url":"https://..."}] }]',
			"最多 " + limit + " 个；如果一段话里没有需要解释的专业术语，就输出 []。只输出 JSON。"
		].join("\n");

		const parsed = await requestModelJson(prompt, 1200);
		if (!Array.isArray(parsed)) return [];
		const records = guide.normalizeTerms({ terms: parsed });
		return records.slice(0, limit);
	}

	/** Coalesce the assistant messages of one turn, then scan the whole answer. */
	ctx.on("session/event", (session, event) => {
		if (event === null || typeof event !== "object") return;
		const sessionKey = String(session?.id ?? session?.sessionId ?? "session");

		// The last question disambiguates one acronym from another: `VLA` is a C
		// feature in a C thread and a robotics model elsewhere.
		if (event.type === "user/message") {
			const parts = Array.isArray(event.data?.content) ? event.data.content : [];
			const asked = parts
				.filter((part) => part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join(" ")
				.trim();
			if (asked !== "") supplement.questions.set(sessionKey, asked);
			return;
		}
		if (event.type !== "assistant/message") return;
		const content = event.data?.message?.content;
		if (!Array.isArray(content)) return;
		const text = content
			.filter((part) => part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
		if (text.trim() === "") return;

		const key = sessionKey;
		supplement.pending.set(key, `${supplement.pending.get(key) ?? ""}\n${text}`);
		const existing = supplement.timers.get(key);
		if (existing !== undefined) clearTimeout(existing);
		supplement.timers.set(
			key,
			setTimeout(() => {
				supplement.timers.delete(key);
				const buffered = supplement.pending.get(key) ?? "";
				supplement.pending.delete(key);
				void runSupplement(key, buffered, supplement.questions.get(key) ?? "");
			}, supplement.debounceMs)
		);
	});

	ctx.effect(
		() => () => {
			for (const timer of supplement.timers.values()) clearTimeout(timer);
			supplement.timers.clear();
			supplement.pending.clear();
			supplement.questions.clear();
			supplement.lastRun.clear();
		},
		"learning-assistant: supplement timers cleared"
	);
}
