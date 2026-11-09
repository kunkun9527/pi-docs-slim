import type { BeforeAgentStartEvent, ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";

type Message = ContextWithSystemEvent["messages"][number];
type PromptOptions = BeforeAgentStartEvent["systemPromptOptions"];
type SystemMessage = Extract<Message, { role: "system" }>;
type UserMessage = Extract<Message, { role: "user" }>;

// A truthy override is necessary: Pi 0.87.1 regenerates docs for ""/undefined.
// The saved sections keep this marker: Pi diffs them against the next request's
// desired sections, so a cleared docs section would re-add a patch every request.
// It is removed from every request before the provider sees it.
export const OMIT_DOCS = "<!-- pi-slim:omit -->";
const PROBE = "<!-- pi-slim:probe -->";
const normalize = (body: string) => body.replace(/\r\n/g, "\n").trim();

// Exact guidance bodies this host rendered itself. Pi's wording changes between versions and builds
// (Pi 1.5 rewrote it, Pi-Bolt adds its own line), so it is learned at runtime instead of hardcoded.
const nativeDocs = new Set<string>();

/**
 * Learn the host's own guidance by rendering the prompt twice with no forced/custom prompt and no
 * custom sections: once with docs absent (Pi fills in its own) and once with a probe marker. The two
 * renderings differ only in the guidance. Any doubt learns nothing; the options are always restored.
 */
export function learnNativeDocs(options: PromptOptions, render: () => unknown): void {
	const keys = ["forceSystemPrompt", "customPrompt", "sections"] as const;
	const saved = keys.map(key => Object.getOwnPropertyDescriptor(options, key));
	const set = (key: string, value: unknown) => Object.defineProperty(options, key, { value, writable: true, enumerable: true, configurable: true });
	try {
		set("forceSystemPrompt", undefined);
		set("customPrompt", undefined);
		set("sections", {});
		const plain = render();
		set("sections", { docs: PROBE });
		const marked = render();
		if (typeof plain !== "string" || typeof marked !== "string") return;
		const probe = `<docs>\n${PROBE}\n</docs>`;
		const at = marked.indexOf(probe);
		if (at < 0 || marked.indexOf(probe, at + 1) >= 0) return;
		const prefix = marked.slice(0, at);
		const suffix = marked.slice(at + probe.length);
		if (plain.length < prefix.length + suffix.length || !plain.startsWith(prefix) || !plain.endsWith(suffix)) return;
		const block = plain.slice(prefix.length, plain.length - suffix.length);
		if (!block.startsWith("<docs>\n") || !block.endsWith("\n</docs>")) return;
		const body = normalize(block.slice("<docs>\n".length, -"\n</docs>".length));
		if (body && !body.includes("\n</docs>")) nativeDocs.add(body);
	} catch {
		// Hosts without a live prompt getter, locked options, or throwing renders keep the frozen legacy rule.
	} finally {
		keys.forEach((key, i) => saved[i] ? Object.defineProperty(options, key, saved[i]) : Reflect.deleteProperty(options, key));
	}
}

/** Pi's own guidance as this host renders it (or the frozen pre-1.5 wording), not project-owned <docs>. */
export function isBuiltinDocs(body: string): boolean {
	return nativeDocs.has(normalize(body)) || isLegacyDocs(body);
}

// Frozen: the 8-line guidance of Pi 0.87-1.4, kept for old session history and hosts where learning
// fails. Do not extend it for new wording; learnNativeDocs covers current hosts.
const LEGACY_HEADER = "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
function isLegacyDocs(body: string): boolean {
	const lines = body.trim().split(/\r?\n/);
	return lines.length === 8 && lines[0] === LEGACY_HEADER
		&& lines[1].startsWith("- Main documentation: ")
		&& lines[2].startsWith("- Additional docs: ")
		&& lines[3].startsWith("- Examples: ") && lines[3].endsWith(" (extensions, custom tools, SDK)")
		&& lines[4] === "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory"
		&& lines[5].startsWith("- When asked about: extensions (docs/extensions.md, examples/extensions/), ")
		// Pi 1.0 appended MCP/codemode topics; tolerate future additions to this list.
		&& lines[5].includes("environment variables (docs/environment-variables.md)")
		&& lines[6] === "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing"
		&& lines[7] === "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
}

/**
 * Only visit top-level blocks. Nested instructions and fenced examples are user content.
 * `removed` collects the guidance that was stripped (not omission markers), in order.
 */
export function stripPiDocs(text: string, removed?: string[]): string {
	const pattern = /^<([a-z][a-z0-9_-]*)(?:[ \t]+[^>\r\n]*)?>\r?\n|^ {0,3}(`{3,}|~{3,})([^\r\n]*)|^Pi documentation \(read only[^\r\n]*/gm;
	let fence: string | undefined;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		const marker = match[2];
		if (marker !== undefined) {
			if (fence === undefined) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length && match[3].trim() === "") fence = undefined;
			continue;
		}
		if (fence !== undefined) continue;
		let end: number;
		if (match[1]) {
			const closing = new RegExp(`\\r?\\n</${match[1]}>(?=\\r?\\n|$)`, "g");
			closing.lastIndex = pattern.lastIndex;
			const close = closing.exec(text);
			if (!close) continue;
			end = closing.lastIndex;
			const body = text.slice(pattern.lastIndex, close.index);
			pattern.lastIndex = end;
			if (!/^<docs>\r?\n$/.test(match[0]) || (body.trim() !== OMIT_DOCS && !isBuiltinDocs(body))) continue;
			if (body.trim() !== OMIT_DOCS) removed?.push(body.trim());
		} else {
			// Legacy/extension-produced unwrapped guidance: only the frozen eight-line wording, never a
			// looser line count, which would swallow the project instructions that follow.
			const block = text.slice(match.index).match(/^(?:[^\r\n]*\r?\n){7}[^\r\n]*/)?.[0];
			if (!block || !isLegacyDocs(block)) continue;
			removed?.push(block.trim());
			end = match.index + block.length;
			pattern.lastIndex = end;
		}
		const before = text.slice(0, match.index).replace(/(?:\r?\n){2}$/, "");
		const after = text.slice(end);
		text = before + (before ? after : after.replace(/^(?:\r?\n){1,2}/, ""));
		pattern.lastIndex = before.length;
	}
	return text;
}

/** The omission marker, bare or wrapped exactly as Pi renders a custom docs section. */
export function isOmitMarkerSection(value: string): boolean {
	const text = value.trim();
	if (text === OMIT_DOCS) return true;
	const match = /^<docs>\r?\n([\s\S]*?)\r?\n<\/docs>$/.exec(text);
	return match?.[1].trim() === OMIT_DOCS;
}

/** Return an owned copy; null sections remove docs left by an earlier /pi run. */
export function cleanSystemMessage(message: SystemMessage): SystemMessage {
	const content = typeof message.content === "string" ? stripPiDocs(message.content) : message.content.map(block => {
		const text = stripPiDocs(block.text);
		if (text === block.text) return block;
		const { textSignature: _signature, ...rest } = block;
		return { ...rest, text };
	});
	const sections = message.sections && Object.fromEntries(Object.entries(message.sections).map(([name, value]) => {
		if (value === null) return [name, value];
		// Keep the marker as built: clearing it here makes Pi's section diff patch the
		// prompt again on every request, which litters the transcript with empty system messages.
		if (name === "docs" && isOmitMarkerSection(value)) return [name, value];
		const clean = name === "docs" && isBuiltinDocs(value) ? "" : stripPiDocs(value);
		return [name, clean === value ? value : clean || null];
	}));
	return { ...message, content, ...(sections && { sections }) };
}

/** Clean old history too, retaining custom docs, tool declarations and system-message ordering. */
export function cleanRequestMessages(messages: Message[]): Message[] {
	let customDocsPresent = false;
	return messages.flatMap<Message>((message, index) => {
		if (message.role !== "system") return [message];
		const clean = cleanSystemMessage(message);
		if (clean.sections?.docs !== undefined) {
			const docs = clean.sections.docs;
			// The marker means "no docs": a removal only when custom docs are in effect, otherwise nothing.
			const omitted = typeof docs === "string" && isOmitMarkerSection(docs);
			if (omitted) clean.sections.docs = null;
			if (clean.sections.docs === null && !customDocsPresent) delete clean.sections.docs;
			customDocsPresent = !omitted && docs !== null;
		}
		// Do not send redundant empty system updates or "remove docs" instructions.
		return index > 0 && isEmptySystem(clean) ? [] : [clean];
	});
}

/** Pi's own guidance, handed to the model inside its own message instead of the system prompt. */
export function renderDocsBlock(docs: string): string {
	return `<pi_docs>\nPi's built-in documentation guidance, provided for this request instead of the system prompt:\n${docs}\n</pi_docs>`;
}

/** Pi's own guidance in a rendered prompt: exactly what stripPiDocs would remove from it. */
export function extractBuiltinDocs(prompt: string): string | undefined {
	const removed: string[] = [];
	stripPiDocs(prompt, removed);
	return removed[0];
}

/** The /pi run's message; `timestamp` anchors it once found, so later turns reuse the same one. */
export interface RunPrompt { prompt: string; timestamp?: number }

/**
 * Put the guidance in front of the user message that started the /pi run. The system prompt is
 * untouched, so the request keeps the prefix of every earlier request and the provider's prompt
 * cache survives; only this message and what follows it are new tokens. Every turn of the run
 * prepends to the same anchored message, so steering messages (even ones that start with the
 * same text) can't move the guidance and break the prefix cached by the run's earlier turns.
 */
export function prependDocsToRunPrompt(messages: Message[], run: RunPrompt, block: string): Message[] {
	let index = run.timestamp === undefined ? -1 : messages.findLastIndex(m => m.role === "user" && m.timestamp === run.timestamp);
	// First turn, or a compaction dropped the anchor: find the prompt, else the last user message.
	for (let i = messages.length - 1; index < 0 && i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" && userText(message).startsWith(run.prompt)) index = i;
	}
	for (let i = messages.length - 1; index < 0 && i >= 0; i--) if (messages[i].role === "user") index = i;
	if (index < 0) return messages;
	run.timestamp = messages[index].timestamp;
	return messages.map((message, i) => i === index ? withDocs(message as UserMessage, block) : message);
}

function userText(message: UserMessage): string {
	return typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("");
}

function withDocs(message: UserMessage, block: string): UserMessage {
	if (typeof message.content === "string") return { ...message, content: `${block}\n\n${message.content}` };
	return { ...message, content: [{ type: "text", text: block }, ...message.content] };
}

function isEmptySystem(message: SystemMessage): boolean {
	const emptyContent = typeof message.content === "string" ? message.content.length === 0 : message.content.every(block => block.text.length === 0);
	return emptyContent && !Object.keys(message.sections ?? {}).length && !message.toolsAdded?.length && !message.toolsRemoved?.length;
}
