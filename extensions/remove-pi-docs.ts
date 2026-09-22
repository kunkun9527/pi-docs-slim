import { AsyncLocalStorage } from "node:async_hooks";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanRequestMessages, cleanSystemMessage, isBuiltinDocs, OMIT_DOCS, stripPiDocs } from "./docs.ts";

export default function piSlim(pi: ExtensionAPI) {
	// Correlate the actual async submission, not whichever input happens to run next.
	const requests = new AsyncLocalStorage<{ consumed: boolean }>();
	let preserveDocs = false;
	let options: BeforeAgentStartEvent["systemPromptOptions"] | undefined;
	let restorePresentation: (() => void) | undefined;
	const restore = () => {
		const callback = restorePresentation;
		restorePresentation = undefined;
		callback?.();
	};

	pi.registerCommand("pi", {
		description: "Run a request with Pi's built-in documentation guidance enabled",
		handler: async (args, ctx) => {
			const request = args.trim();
			if (!request) {
				ctx.ui.notify("Usage: /pi <request about Pi>", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current response to finish before using /pi.", "warning");
				return;
			}
			requests.run({ consumed: false }, () => pi.sendUserMessage(request));
		},
	});

	pi.on("before_agent_start", event => {
		restore();
		const token = requests.getStore();
		preserveDocs = token !== undefined && !token.consumed;
		if (token) token.consumed = true;
		options = event.systemPromptOptions;
		if (preserveDocs) return;

		const docs = options.sections.docs;
		if (!docs || isBuiltinDocs(docs)) options.sections.docs = OMIT_DOCS;
		// Never return a full systemPrompt or fold tools/rules into customPrompt.
		// Pi still owns their generation, including refreshes between tool calls.
	});

	pi.on("agent_start", (_event, ctx) => {
		if (preserveDocs || !options) return;
		const current = ctx.getSystemPrompt();
		const clean = stripPiDocs(current);
		if (clean === current) return;

		// context-view captures ctx.getSystemPrompt() in its first context handler.
		// Temporarily expose the clean rendering AFTER all before_agent_start hooks.
		// Restore BEFORE Pi's forced-prompt projection (which follows emitContext),
		// so this presentation bridge never freezes tools or collapses the transcript.
		const runOptions = options;
		const originalForce = runOptions.forceSystemPrompt;
		runOptions.forceSystemPrompt = clean;
		restorePresentation = () => {
			if (runOptions.forceSystemPrompt === clean) {
				runOptions.forceSystemPrompt = originalForce === undefined ? undefined : stripPiDocs(originalForce);
			} else if (runOptions.forceSystemPrompt !== undefined) {
				runOptions.forceSystemPrompt = stripPiDocs(runOptions.forceSystemPrompt);
			}
		};
	});

	pi.on("message_end", event => {
		if (preserveDocs || event.message.role !== "system") return;
		// Public replacement API: Pi persists the replacement, not the docs/marker.
		return { message: cleanSystemMessage(event.message) };
	});

	pi.on("context_with_system", event => {
		restore();
		if (preserveDocs) return;
		return { messages: cleanRequestMessages(event.messages) };
	});

	// Also restore if cancellation/error bypasses context_with_system entirely.
	pi.on("agent_end", restore);
	pi.on("agent_settled", () => { restore(); options = undefined; preserveDocs = false; });
	pi.on("session_shutdown", restore);
}
