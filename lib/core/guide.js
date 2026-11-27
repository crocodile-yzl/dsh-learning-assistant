"use strict";

/**
 * Shared, environment-free core of the term guide.
 *
 * Both halves load this file: the host through `createRequire` (it owns the
 * memory file) and the browser bundle through its inlined module registry (it
 * renders what the host stored). Keeping normalization and merge rules here
 * means a term the host accepted is a term the panel can render, and a rule
 * proved in a Node test holds in the page.
 *
 * Nothing here touches `node:`, the DOM, or globals.
 */

/** User levels, ordered from least to most specialized. */
const LEVELS = ["beginner", "intermediate", "expert"];

/** Human labels for the panel and the prompt. */
const LEVEL_LABELS = {
	beginner: "初学者（非技术背景，术语几乎都需要解释）",
	intermediate: "中级（懂编程与通用概念，但不是当前领域的专家）",
	expert: "专家（需要解释的只有跨领域的生僻词）"
};

/** Short chips for the UI. */
const LEVEL_CHIPS = { beginner: "初学者", intermediate: "中级", expert: "专家" };

/** Strictness is one integer 0–100; 50 is the neutral default. */
const STRICTNESS_MIN = 0;
const STRICTNESS_MAX = 100;

/** Most terms a single explain_terms call may carry (matches the prompt and schema). */
const MAX_TERMS = 4;

/** Longest explanation the panel will render as a single sentence. */
const MAX_EXPLANATION_CHARS = 120;

/** Longest known-term summary fed to the prompt. */
const MEMORY_SUMMARY_MAX = 24;

/** Cap on remembered terms; the oldest are dropped first. */
const MAX_REMEMBERED_TERMS = 200;

/**
 * Clamp an unknown number into [min, max].
 * @param value - candidate.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param fallback - used when the candidate is not finite.
 * @returns a finite integer.
 */
function clampInt(value, min, max, fallback) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.min(max, Math.max(min, n));
}

/**
 * Normalize a level, falling back to `intermediate`.
 * @param level - candidate string.
 * @returns one of {@link LEVELS}.
 */
function normalizeLevel(level) {
	return LEVELS.includes(level) ? level : "intermediate";
}

/**
 * Trim one string, collapsing whitespace and enforcing a length ceiling.
 * @param value - candidate.
 * @param max - character ceiling.
 * @returns the cleaned text, or "" when the input is not a usable string.
 */
function cleanText(value, max) {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	if (text === "") return "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The identity of a term name: what "the same term" means across spellings.
 *
 * The display keeps the first spelling the memory saw; every LOOKUP goes
 * through this key instead — dedupe on merge, `parent`/`related` links, the
 * knowledge tree, transcript matching, highlight flashing. Without it the
 * model's `VLA`, `vla` and `ＶＬＡ` become three records whose links cannot
 * find each other. NFKC folds full-width Latin and compatibility forms;
 * whitespace collapses so a double space is not a new term.
 * @param term - any term name.
 * @returns the key, or "" when unusable.
 */
function termKey(term) {
	if (typeof term !== "string") return "";
	return term.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The terms worth telling the model about first: the ones met most often.
 *
 * The prompt can only carry a few dozen names. Sorted by repeat count, the
 * names it carries are the familiar ones — exactly the ones the model must
 * not explain again — rather than whichever happen to sit at the top of a
 * newest-first list.
 * @param memory - memory object.
 * @param max - how many names to return.
 * @returns display names, most familiar first.
 */
function mostFamiliar(memory, max) {
	const terms = Array.isArray(memory?.terms) ? memory.terms : [];
	const limit = typeof max === "number" && max > 0 ? max : 40;
	return terms
		.slice()
		.sort((a, b) => (Number(b?.count) || 0) - (Number(a?.count) || 0) || String(b?.lastSeen ?? "").localeCompare(String(a?.lastSeen ?? "")))
		.slice(0, limit)
		.map((item) => item.term);
}

/**
 * Normalize one tree node recursively.
 * @param node - candidate node.
 * @param depth - current depth, guarding runaway nesting.
 * @returns a normalized node, or null when unusable.
 */
function normalizeNode(node, depth) {
	if (node === null || typeof node !== "object" || depth > 4) return null;
	const label = cleanText(node.label, 60);
	if (label === "") return null;
	const out = { label };
	const note = cleanText(node.note, 140);
	if (note !== "") out.note = note;
	if (Array.isArray(node.children)) {
		const children = node.children.map((child) => normalizeNode(child, depth + 1)).filter((child) => child !== null);
		if (children.length > 0) out.children = children;
	}
	return out;
}

/**
 * Normalize the exploration tree: a short, shallow forest.
 * @param tree - candidate array.
 * @returns at most 8 root nodes.
 */
function normalizeTree(tree) {
	if (!Array.isArray(tree)) return [];
	return tree.map((node) => normalizeNode(node, 0)).filter((node) => node !== null).slice(0, 8);
}

/**
 * Search templates. Every term gets at least a Wikipedia and a web-search link,
 * so a node the model left bare is still explorable.
 */
const SEARCH_TEMPLATES = [
	{ label: "维基百科", build: (term) => `https://zh.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(term)}` },
	{ label: "Google", build: (term) => `https://www.google.com/search?q=${encodeURIComponent(`${term} 是什么`)}` },
	{ label: "Bing", build: (term) => `https://www.bing.com/search?q=${encodeURIComponent(`${term} 是什么`)}` }
];

/**
 * Build the link list for a term: model-provided links first, then templates.
 * @param term - the term text.
 * @param links - candidate links from the model.
 * @returns a de-duplicated link list.
 */
function buildLinks(term, links) {
	const out = [];
	const seen = new Set();
	const push = (label, url) => {
		if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
		if (seen.has(url)) return;
		seen.add(url);
		out.push({ label, url });
	};
	if (Array.isArray(links)) {
		for (const link of links.slice(0, 6)) {
			if (link === null || typeof link !== "object") continue;
			push(cleanText(link.label, 30) || "参考", link.url);
		}
	}
	for (const template of SEARCH_TEMPLATES) push(template.label, template.build(term));
	return out.slice(0, 6);
}

/**
 * Normalize one term as the model reported it.
 * @param raw - candidate term object.
 * @returns a term record, or null when it has no usable name.
 */
function normalizeTerm(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const term = cleanText(raw.term, 60);
	if (term === "") return null;
	const record = {
		term,
		explanation: cleanText(raw.explanation, MAX_EXPLANATION_CHARS),
		tree: normalizeTree(raw.tree),
		links: buildLinks(term, raw.links)
	};
	const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : null;
	if (confidence !== null) record.confidence = confidence;
	const category = cleanText(raw.category, 24);
	if (category !== "") record.category = category;
	// Provenance: what this term derives FROM, and what sits beside it. These
	// drive the knowledge tree; a term with neither is a root.
	const key = termKey(term);
	const parent = cleanText(raw.parent, 60);
	if (parent !== "" && termKey(parent) !== key) record.parent = parent;
	if (Array.isArray(raw.related)) {
		const related = [];
		const relatedKeys = new Set([key]);
		for (const item of raw.related.slice(0, 8)) {
			const name = cleanText(item, 60);
			const itemKey = termKey(name);
			if (name === "" || relatedKeys.has(itemKey)) continue;
			relatedKeys.add(itemKey);
			related.push(name);
		}
		if (related.length > 0) record.related = related;
	}
	return record;
}

/**
 * Normalize a whole explain_terms call.
 * @param input - candidate object with a `terms` array.
 * @returns an array of at most {@link MAX_TERMS} records.
 */
function normalizeTerms(input) {
	if (input === null || typeof input !== "object" || !Array.isArray(input.terms)) return [];
	return input.terms
		.map((raw) => normalizeTerm(raw))
		.filter((record) => record !== null)
		.slice(0, MAX_TERMS);
}

/**
 * Create empty memory.
 * @param level - initial level.
 * @param strictness - initial strictness.
 * @returns a memory object.
 */
function emptyMemory(level, strictness) {
	return {
		version: 1,
		level: normalizeLevel(level),
		strictness: clampInt(strictness, STRICTNESS_MIN, STRICTNESS_MAX, 50),
		updatedAt: new Date(0).toISOString(),
		terms: [],
		signals: []
	};
}

/**
 * Merge reported terms into memory.
 *
 * A repeated term keeps its latest explanation and tree (the model rewrote it
 * for a new context) while its `count` accumulates, which is the evidence the
 * prompt uses to decide that a term is now familiar.
 *
 * @param memory - current memory (may be undefined).
 * @param records - normalized terms.
 * @param options - `{ now, level, strictnessAdjust, reason }`.
 * @returns a NEW memory object; the input is not mutated.
 */
function mergeTerms(memory, records, options) {
	const base = memory !== null && typeof memory === "object" ? memory : emptyMemory();
	const now = options?.now instanceof Date ? options.now : new Date();
	const stamp = now.toISOString();

	// Keyed by {@link termKey}: a repeat under another spelling merges into
	// the record already there, which keeps `parent`/`related` resolvable.
	const byName = new Map();
	const order = [];
	for (const existing of Array.isArray(base.terms) ? base.terms : []) {
		if (!existing || typeof existing.term !== "string") continue;
		const key = termKey(existing.term);
		if (key === "") continue;
		if (!byName.has(key)) {
			order.push(key);
			byName.set(key, existing);
		} else if ((Number(existing.count) || 0) > (Number(byName.get(key).count) || 0)) {
			// Two legacy records that differ only by spelling: keep the larger
			// count, keep the first spelling as the display name.
			byName.set(key, { ...existing, term: byName.get(key).term });
		}
	}

	for (const record of records) {
		const key = termKey(record.term);
		if (key === "") continue;
		const previous = byName.get(key);
		if (previous === undefined) {
			order.push(key);
			byName.set(key, {
				...record,
				firstSeen: stamp,
				lastSeen: stamp,
				count: 1
			});
			continue;
		}
		// The first spelling seen stays the display name.
		byName.set(key, {
			...previous,
			explanation: record.explanation || previous.explanation,
			tree: record.tree.length > 0 ? record.tree : previous.tree,
			links: record.links.length > 0 ? record.links : previous.links,
			confidence: record.confidence ?? previous.confidence,
			category: record.category ?? previous.category,
			parent: record.parent ?? previous.parent,
			related: record.related ?? previous.related,
			source: record.source ?? previous.source,
			lastSeen: stamp,
			count: (Number.isFinite(previous.count) ? previous.count : 1) + 1
		});
	}

	// Newest first, capped.
	const terms = order
		.map((key) => byName.get(key))
		.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
		.slice(0, MAX_REMEMBERED_TERMS);

	const adjust = clampInt(options?.strictnessAdjust, -20, 20, 0);
	const strictness = clampInt((base.strictness ?? 50) + adjust, STRICTNESS_MIN, STRICTNESS_MAX, 50);

	const signals = Array.isArray(base.signals) ? base.signals.slice(-40) : [];
	const reason = cleanText(options?.reason, 120);
	if (reason !== "") signals.push({ at: stamp, reason, terms: records.map((r) => r.term) });

	return {
		version: 1,
		level: normalizeLevel(options?.level ?? base.level),
		strictness,
		updatedAt: stamp,
		terms,
		signals
	};
}

/**
 * Render the memory as a short prompt-facing list.
 *
 * Only names and repeat counts are shown: the model needs to know what the
 * user has already met, not re-read old explanations.
 *
 * @param memory - memory object.
 * @returns one line, or "" when nothing is remembered.
 */
function summarizeMemory(memory) {
	const terms = Array.isArray(memory?.terms) ? memory.terms : [];
	if (terms.length === 0) return "";
	return terms
		.slice(0, MEMORY_SUMMARY_MAX)
		.map((item) => (item.count > 1 ? `${item.term}×${item.count}` : item.term))
		.join("、");
}


/**
 * Resolve once a scroll container stops moving.
 *
 * Smooth scrolling has no reliable duration, so a fixed `setTimeout` either
 * pulses too early (the word is still off-screen) or too late. `scrollend` is
 * used when available, with a quiet-period poll as the fallback and a hard cap
 * so a stuck scroll can never hang the caller.
 *
 * @param element - the scrolling element.
 * @param options - `{ timeoutMs, quietMs }`.
 * @returns a promise settled when the scroll stops or the cap is reached.
 */
function waitForScrollSettle(element, options) {
	const timeoutMs = typeof options?.timeoutMs === "number" ? options.timeoutMs : 1400;
	const quietMs = typeof options?.quietMs === "number" ? options.quietMs : 90;
	return new Promise((resolve) => {
		if (element === null || element === undefined) {
			resolve();
			return;
		}
		let settled = false;
		let quiet = 0;
		let last = element.scrollTop;
		let poll = null;
		let cap = null;
		const finish = () => {
			if (settled) return;
			settled = true;
			try {
				element.removeEventListener("scrollend", finish);
			} catch (error) {
				void error;
			}
			if (poll !== null) clearInterval(poll);
			if (cap !== null) clearTimeout(cap);
			resolve();
		};
		try {
			element.addEventListener("scrollend", finish, { once: true });
		} catch (error) {
			void error;
		}
		poll = setInterval(() => {
			const now = element.scrollTop;
			quiet = Math.abs(now - last) < 1 ? quiet + 1 : 0;
			last = now;
			if (quiet * 60 >= quietMs) finish();
		}, 60);
		cap = setTimeout(finish, timeoutMs);
	});
}


/**
 * Build the knowledge forest the panel renders.
 *
 * Each term names the term it derives from (`parent`). A term whose parent is
 * absent from the set is a ROOT with `orphanParent` recorded, so the panel can
 * say "隶属 X（未收录）" instead of silently hiding the relationship. Cycles are
 * cut by tracking the path, and a term is attached at most once.
 *
 * @param terms - term records.
 * @returns an array of `{ term, children, orphanParent }` roots.
 */
function buildKnowledgeTree(terms) {
	const list = (Array.isArray(terms) ? terms : []).filter((item) => item && typeof item.term === "string" && termKey(item.term) !== "");
	// Lookups by {@link termKey}, so a `parent` spelled differently from the
	// record still finds it. The map keeps the first record per key.
	const byKey = new Map();
	for (const item of list) {
		const key = termKey(item.term);
		if (!byKey.has(key)) byKey.set(key, item);
	}

	const children = new Map();
	const roots = [];
	for (const item of list) {
		const ownKey = termKey(item.term);
		const parent = typeof item.parent === "string" ? item.parent : "";
		const parentKey = termKey(parent);
		if (parentKey !== "" && parentKey !== ownKey && byKey.has(parentKey)) {
			const bucket = children.get(parentKey);
			if (bucket === undefined) children.set(parentKey, [item]);
			else bucket.push(item);
		} else {
			roots.push({ term: item, orphanParent: parentKey !== "" && parentKey !== ownKey ? parent : null });
		}
	}

	const seen = new Set();
	/** @param entry - `{ term, orphanParent }` */
	const build = (entry, depth, path) => {
		const node = { term: entry.term, orphanParent: entry.orphanParent ?? null, children: [] };
		const key = termKey(entry.term.term);
		if (depth > 8 || path.has(key)) return node;
		seen.add(key);
		path.add(key);
		for (const child of children.get(key) ?? []) {
			if (path.has(termKey(child.term))) continue;
			node.children.push(build({ term: child, orphanParent: null }, depth + 1, path));
		}
		path.delete(key);
		return node;
	};

	const forest = roots.map((entry) => build(entry, 0, new Set()));
	// A term reachable only through a cycle never became a root; surface it so
	// nothing disappears from the view.
	for (const item of list) {
		if (seen.has(termKey(item.term))) continue;
		forest.push({ term: item, orphanParent: typeof item.parent === "string" ? item.parent : null, children: [] });
	}
	return forest;
}


/**
 * Keep only the terms that actually appear in one conversation's text.
 *
 * The memory file is global by design (a term learned in one thread should not
 * be re-explained in the next), but the panel must describe only the thread on
 * screen. Both sides go through {@link termKey}, so matching ignores case,
 * full/half-width and whitespace runs: a term counts when its key occurs
 * anywhere in the transcript's key.
 *
 * @param terms - term records from memory.
 * @param text - the conversation transcript (may be empty).
 * @returns the subset present in `text`; nothing when `text` is empty.
 */
function filterTermsForText(terms, text) {
	const list = Array.isArray(terms) ? terms : [];
	const haystack = termKey(text);
	if (haystack === "") return [];
	return list.filter((item) => {
		if (item === null || typeof item !== "object" || typeof item.term !== "string") return false;
		const key = termKey(item.term);
		return key !== "" && haystack.includes(key);
	});
}

/** Exported for the host half and the browser bundle alike. */
module.exports = {
	LEVELS,
	LEVEL_LABELS,
	LEVEL_CHIPS,
	STRICTNESS_MIN,
	STRICTNESS_MAX,
	MAX_TERMS,
	MAX_REMEMBERED_TERMS,
	SEARCH_TEMPLATES,
	clampInt,
	normalizeLevel,
	cleanText,
	termKey,
	mostFamiliar,
	normalizeTree,
	buildLinks,
	normalizeTerm,
	normalizeTerms,
	emptyMemory,
	mergeTerms,
	summarizeMemory,
	waitForScrollSettle,
	buildKnowledgeTree,
	filterTermsForText
};
