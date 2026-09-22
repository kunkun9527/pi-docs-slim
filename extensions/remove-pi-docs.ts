import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi 0.87 renders built-in docs inside a <docs> section. Remove the wrapper too,
// otherwise the old text-only match leaves an empty <docs></docs> section.
const PI_DOCS_SECTION = /\n<docs>\n[\s\S]*?\n<\/docs>/;

export default function piSlim(pi: ExtensionAPI) {
	let preservePiDocsForNextTurn = false;

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

			preservePiDocsForNextTurn = true;
			pi.sendUserMessage(request);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (preservePiDocsForNextTurn) {
			preservePiDocsForNextTurn = false;
			return { systemPrompt: event.systemPrompt };
		}

		return {
			systemPrompt: event.systemPrompt.replace(PI_DOCS_SECTION, ""),
		};
	});
}
