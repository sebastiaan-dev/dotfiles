import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir, parseFrontmatter, type ExtensionAPI, type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BenchmarkStore, repository, summary } from "./results.ts";
import { BenchmarkView } from "./view.ts";
import { showBenchmarkPlots } from "../plot/index.ts";

const help = [
	"/bench — open this repository's saved benchmarks",
	"/bench <workload> [comparison] — benchmark with Hyperfine and save results",
	"/bench run <workload> — explicit workflow dispatch",
	"/bench-run <workload> — prompt-only workflow for scripts and print mode",
	"/bench view [latest|id] — inspect a saved benchmark",
	"/bench import <path to hyperfine.json> — save an existing export and open it",
	"/bench plot [latest|id] — plot means, sample distributions and measured run order",
	"View keys: ↑↓ history, ←→ tabs, b baseline, c case, y copy table, PgUp/PgDn scroll, Esc close",
].join("\n");

export default function (pi: ExtensionAPI) {
	const store = () => new BenchmarkStore(path.join(getAgentDir(), "benchmarks"));
	const report = (ctx: ExtensionCommandContext, text: string, error = false) => {
		// Pi reserves stdout for provider text / structured events; extension reports use stderr.
		if (ctx.mode === "print") process.stderr.write(text + "\n");
		else if (ctx.mode === "tui") ctx.ui.notify(text, error ? "error" : "info");
		else pi.sendMessage({ customType: "benchmark-view", display: true, content: text }, { triggerTurn: false });
	};
	const show = async (ctx: ExtensionCommandContext, id?: string) => {
		const current = store();
		const key = repository(ctx.cwd).key;
		if (ctx.mode === "tui") {
			await ctx.ui.custom<void>((tui, theme, _keys, done) => new BenchmarkView(current, key, tui, theme, done, id), {
				overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center", margin: 1 },
			});
		} else {
			const selected = id ?? current.list(key).runs[0]?.id;
			report(ctx, selected ? summary(current.load(selected)) : "No saved benchmarks for this repository. " + help);
		}
	};
	pi.registerTool({
		name: "benchmark_results",
		label: "Save benchmark",
		description: "Validate and save an existing Hyperfine JSON export for /bench. Computes statistics from samples, retains raw data privately, and returns a compact summary. Does not execute commands. Record exact commands if --command-name was used; unknown metadata stays unrecorded.",
		parameters: Type.Object({
			file: Type.String({ description: "Path to a completed Hyperfine --export-json file; relative to the current working directory." }),
			title: Type.Optional(Type.String()),
			baseline: Type.Optional(Type.Integer({ minimum: 1, description: "One-based baseline case in export order. Omit when no comparison was requested." })),
			warmup: Type.Optional(Type.Integer({ minimum: 0, description: "Actual Hyperfine warmup count per case." })),
			conditions: Type.Optional(Type.String({ description: "Workload, inputs, thread count, cache state, setup/reset and relevant output handling." })),
			environment: Type.Optional(Type.String({ description: "Actual measurement host, OS, CPU, RAM and relevant toolchain information; not the importing host if different." })),
			invocation: Type.Optional(Type.String({ description: "Exact Hyperfine invocation and version." })),
			cases: Type.Optional(Type.Array(Type.Object({
				name: Type.Optional(Type.String()),
				command: Type.Optional(Type.String({ description: "Exact measured command, not just its --command-name label." })),
				revision: Type.Optional(Type.String({ description: "Measured source revision and whether the measured tree was dirty." })),
				build: Type.Optional(Type.String({ description: "Compiler/toolchain, build profile and flags." })),
				notes: Type.Optional(Type.String()),
			}), { description: "One entry per exported result, in the same order." })),
		}),
		promptGuidelines: [
			"For benchmarks use Hyperfine with --export-json, then benchmark_results with that file path and observed provenance. Keep raw samples in the file rather than reading them into conversation.",
			"benchmark_results saves compact statistics and a /bench view ID. Only provide baseline when the user requested a comparison; preserve exact commands, build settings, measured revisions, warmups and cache/input conditions.",
		],
		async execute(_id, { file, ...options }, signal, _update, ctx) {
			if (signal?.aborted) throw new Error("Benchmark import cancelled.");
			const run = store().import(file, ctx.cwd, options);
			return {
				content: [{ type: "text", text: summary(run) }],
				details: { id: run.manifest.id, directory: run.directory, statuses: run.cases.map((entry) => entry.status) },
			};
		},
	});
	pi.registerCommand("bench", {
		description: "Benchmark a workload or browse timing statistics, samples and provenance",
		async handler(args, ctx) {
			try {
				const input = args.trim();
				const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input);
				const action = match?.[1];
				const rest = match?.[2]?.trim() ?? "";
				if (action === "help") { report(ctx, help); return; }
				if (action === "plot") { await showBenchmarkPlots(ctx, rest); return; }
				if (!action || action === "list" || action === "latest" || action === "view") {
					await show(ctx, action === "view" && rest && rest !== "latest" ? rest : undefined);
				} else if (action === "import") {
					if (!rest) throw new Error("Usage: /bench import <path to hyperfine.json>");
					// Paths are passed directly to fs, never a shell; optional outer quotes allow spaces.
					const file = /^(['"])[\s\S]*\1$/.test(rest) ? rest.slice(1, -1) : rest;
					await show(ctx, store().import(file, ctx.cwd).manifest.id);
				} else {
					const workload = action === "run" ? rest : input;
					if (!workload) throw new Error("Usage: /bench run <workload>");
					// Pi's print runner does not await turns dispatched by sendUserMessage.
					// The prompt-only alias stays inside its normal awaited prompt lifecycle.
					if (ctx.mode !== "tui") {
						report(ctx, "To benchmark in print, JSON or RPC mode, submit /bench-run " + workload);
						return;
					}
					const prompt = pi.getCommands().find((command) => command.name === "bench" && command.source === "prompt");
					const promptFile = prompt?.sourceInfo.path ?? path.join(getAgentDir(), "prompts/bench.md");
					let body = parseFrontmatter(fs.readFileSync(promptFile, "utf8")).body;
					if (body.includes("<!-- pi-bench-workflow -->")) {
						const sop = fs.readFileSync(path.join(getAgentDir(), "extensions/bench/benchmark.sop.md"), "utf8");
						body = body.replace("<!-- pi-bench-workflow -->", () => sop);
					}
					// The managed template uses $ARGUMENTS. Substitution callbacks preserve literal $ and backticks.
					body = body.replace(/\$ARGUMENTS/g, () => workload);
					pi.sendUserMessage(body, { deliverAs: "followUp", expandPromptTemplates: false });
				}
			} catch (error) { report(ctx, error instanceof Error ? error.message : String(error), true); }
		},
	});
}
