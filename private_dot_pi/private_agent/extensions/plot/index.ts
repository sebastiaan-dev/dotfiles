import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BenchmarkStore, repository } from "../bench/results.ts";
import { PlotStore, benchmarkPlots, plotSummary } from "./store.ts";
import { PlotView, toolPreview } from "./view.ts";

const store = () => new PlotStore(path.join(getAgentDir(), "plots"));
const help = [
	"/plot — browse this repository's saved charts",
	"/plot import <chart.json> — render a chart spec and save PNG/SVG",
	"/plot view [latest|id] — open a saved plot",
	"/plot bench [latest|benchmark-id] — plot saved Hyperfine means, distributions and run order",
	"View keys: ↑↓ history, ←→/Tab charts, PgUp/PgDn scroll, o open PNG, Esc close",
	"Ask Pi to plot CSV/TSV with named columns, or create a chart JSON spec and call plot_chart.",
].join("\n");

async function show(ctx: ExtensionCommandContext, id?: string) {
	const current = store();
	const key = repository(ctx.cwd).key;
	if (ctx.mode === "tui") {
		await ctx.ui.custom<void>((tui, theme, _keys, done) => new PlotView(current, key, tui, theme, done, id), {
			overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center", margin: 1 },
		});
	} else {
		const selected = id && id !== "latest" ? id : current.list(key)[0]?.id;
		process.stderr.write((selected ? plotSummary(current.load(selected)) : "No saved plots. " + help) + "\n");
	}
}

export async function showBenchmarkPlots(ctx: ExtensionCommandContext, id?: string) {
	const benchmarks = new BenchmarkStore(path.join(getAgentDir(), "benchmarks"));
	const selected = id && id !== "latest" ? id : benchmarks.list(repository(ctx.cwd).key).runs[0]?.id;
	if (!selected) throw new Error("No saved benchmarks. Run /bench or import a Hyperfine export first.");
	const run = benchmarks.load(selected);
	const saved = await store().create(benchmarkPlots(run), `benchmark:${selected}`, ctx.cwd, ctx.signal);
	await show(ctx, saved.manifest.id);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "plot_chart",
		label: "Plot chart",
		description: "Render local numerical data as a terminal chart and save Kanso PNG/SVG artifacts. Reads a chart JSON spec or CSV/TSV with named columns. Returns only a compact summary and file paths; raw data and image bytes stay outside model context.",
		parameters: Type.Object({
			file: Type.String({ description: "Chart JSON spec or CSV/TSV file path, relative to cwd." }),
			kind: Type.Optional(Type.Union(["line", "scatter", "bar", "histogram", "box"].map((kind) => Type.Literal(kind)))),
			xColumn: Type.Optional(Type.String({ description: "CSV/TSV numeric x column, or category label column for bar." })),
			yColumns: Type.Optional(Type.Array(Type.String(), { description: "CSV/TSV numeric value columns; one series per column." })),
			title: Type.Optional(Type.String()),
			xLabel: Type.Optional(Type.String()),
			yLabel: Type.Optional(Type.String()),
			xScale: Type.Optional(Type.Union([Type.Literal("linear"), Type.Literal("log")])),
			yScale: Type.Optional(Type.Union([Type.Literal("linear"), Type.Literal("log")])),
			bins: Type.Optional(Type.Integer({ minimum: 2, maximum: 100 })),
		}),
		promptGuidelines: [
			"Use plot_chart for numerical plots, scaling curves, benchmark charts and distributions. Prefer existing data files and named CSV/TSV columns; never paste large datasets into tool arguments or chat.",
			"For a JSON spec, pass only file. Schema: {kind:'line'|'scatter'|'bar'|'histogram'|'box', title?, xLabel?, yLabel?, xScale?:'linear'|'log', yScale?:'linear'|'log', series:[{name, x?:number[], y?:number[], yError?:(number|null)[], values?:number[]}], labels?:string[], bins?:number}. Line/scatter use x/y (omitted x means 1-based sample indices); bars use labels/y; histograms/box plots use values. Errors are symmetric nonnegative amounts; null means unavailable. A bundle is {plots:[spec,...]}. JSON requires finite numbers; no executed code.",
			"Measure benchmarks with Hyperfine, save them with benchmark_results, then use /bench plot or a JSON chart spec based on the saved export. Label units, failed/unverified exits and sample counts. Error bars require observed dispersion; sample SD is not a confidence interval.",
			"Plots are rendered locally; PNG/SVG and full input remain private under ~/.pi/agent/plots. Terminal previews use YouPlot; logarithmic terminal axes are explicitly labeled log10. Cite saved artifact paths without returning raw data or base64.",
		],
		async execute(_id, { file, ...options }, signal, _update, ctx) {
			const supplied = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
			const run = await store().import(file, ctx.cwd, supplied, signal);
			return { content: [{ type: "text", text: plotSummary(run) }], details: { id: run.manifest.id } };
		},
		renderResult(result, _options, theme, context) {
			if (result.details?.id) {
				try {
					// Native Pi reuses components between redraws.
					return context.lastComponent ?? toolPreview(store(), store().load(result.details.id), theme, context.invalidate, context.showImages);
				} catch (error) { return new Text(theme.fg("error", String(error)), 0, 0); }
			}
			return new Text(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), 0, 0);
		},
	});
	pi.registerCommand("plot", {
		description: "Browse numerical plots, render a chart spec, or chart saved benchmarks",
		async handler(args, ctx) {
			try {
				const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
				const action = match?.[1];
				const rest = match?.[2]?.trim() ?? "";
				if (action === "help") {
					if (ctx.mode === "tui") ctx.ui.notify(help, "info");
					else process.stderr.write(help + "\n");
				} else if (!action || action === "list" || action === "view" || action === "latest") {
					await show(ctx, action === "view" && rest !== "latest" ? rest || undefined : undefined);
				} else if (action === "bench") await showBenchmarkPlots(ctx, rest);
				else if (action === "import") {
					if (!rest) throw new Error("Usage: /plot import <chart.json>");
					const file = /^(['"])[\s\S]*\1$/.test(rest) ? rest.slice(1, -1) : rest;
					await show(ctx, (await store().import(file, ctx.cwd, {}, ctx.signal)).manifest.id);
				} else throw new Error(help);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.mode === "tui") ctx.ui.notify(message, "error");
				else process.stderr.write(message + "\n");
			}
		},
	});
}
