import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { sdk, tui } from "./helpers/pi-sdk.ts";
import { BenchmarkStore } from "../private_dot_pi/private_agent/extensions/bench/results.ts";
import { PlotStore, benchmarkPlots } from "../private_dot_pi/private_agent/extensions/plot/store.ts";

const source = fileURLToPath(new URL("../private_dot_pi/private_agent/extensions/plot", import.meta.url));
const bench = fileURLToPath(new URL("../private_dot_pi/private_agent/extensions/bench", import.meta.url));
const palette = fileURLToPath(new URL("../private_dot_pi/private_agent/themes/kanso-mist.json", import.meta.url));
const plain = (lines: string[]) => lines.map(stripVTControlCharacters).join("\n");

async function fixture(t: any) {
	assert(fs.existsSync(path.join(source, ".venv/bin/python")), "Run uv sync --locked --python 3.11 --project private_dot_pi/private_agent/extensions/plot.");
	const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "pi-plot-")));
	const agentDir = path.join(base, "agent"), cwd = path.join(base, "project");
	fs.mkdirSync(cwd);
	fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
	const destination = path.join(agentDir, "extensions/plot");
	fs.cpSync(source, destination, { recursive: true,
		filter: (file) => !file.split(path.sep).includes(".venv") && !file.split(path.sep).includes("__pycache__") });
	fs.symlinkSync(path.join(source, ".venv"), path.join(destination, ".venv"), "dir");
	fs.cpSync(bench, path.join(agentDir, "extensions/bench"), { recursive: true });
	fs.mkdirSync(path.join(agentDir, "themes"));
	fs.copyFileSync(palette, path.join(agentDir, "themes/kanso-mist.json"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(base, { recursive: true, force: true });
	});
	const settingsManager = sdk.SettingsManager.inMemory({ defaultProjectTrust: "never" });
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions.find((entry: any) => entry.tools.has("plot_chart"));
	assert(extension?.commands.has("plot"));
	const { session } = await sdk.createAgentSession({
		cwd, agentDir, settingsManager, resourceLoader: loader, tools: ["bash", "plot_chart"],
		sessionManager: sdk.SessionManager.inMemory(cwd),
	});
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "tui" });
	const messages: any[] = [];
	loaded.runtime.sendMessage = (...args: any[]) => messages.push(args);
	loaded.runtime.sendUserMessage = (...args: any[]) => messages.push(args);
	const theme = loader.getThemes().themes.find((entry: any) => entry.name === "kanso-mist");
	const notifications: any[] = [];
	let view: any, renders = 0, closed = 0;
	const terminal = { rows: 40 };
	const ctx = { cwd, mode: "tui", hasUI: true, signal: undefined, ui: {
		notify: (text: string, level: string) => notifications.push({ text, level }),
		custom: async (factory: any) => {
			view = factory({ terminal, requestRender: () => renders++ }, theme, {}, () => closed++);
		},
	} };
	const input = (name: string, content: string) => {
		const file = path.join(cwd, name); fs.writeFileSync(file, content); return file;
	};
	return { base, cwd, agentDir, extension, session, messages, theme, terminal, ctx, notifications, input,
		command: extension.commands.get("plot").handler,
		benchCommand: loaded.extensions.find((entry: any) => entry.commands.has("bench")).commands.get("bench").handler,
		tool: session.agent.state.tools.find((entry: any) => entry.name === "plot_chart"),
		store: new PlotStore(path.join(agentDir, "plots")),
		view: () => view, renders: () => renders, closed: () => closed };
}

test("native Pi plots real CSV data with YouPlot and Matplotlib without returning datasets/images to the model", async (t) => {
	const f = await fixture(t);
	const csv = "size,baseline,current\n1,4,2\n2,8,3\n4,16,5\n8,32,9\n";
	const file = f.input("scaling  fixture.csv", csv);
	const result = await f.tool.execute("plot-fixture", {
		file, kind: "line", xColumn: "size", yColumns: ["baseline", "current"],
		title: "Parser scaling", xLabel: "Input size", yLabel: "Runtime (ms)",
	});
	assert.equal(result.content.length, 1); assert.equal(result.content[0].type, "text");
	assert(result.content[0].text.length < 1500); assert(!result.content[0].text.includes("32,9"));
	assert.deepEqual(Object.keys(result.details), ["id"]);
	const run = f.store.load(result.details.id);
	assert.equal(run.manifest.charts[0].pointCount, 8);
	assert.equal(fs.readFileSync(path.join(run.directory, "input.csv"), "utf8"), csv);
	const spec = JSON.parse(fs.readFileSync(path.join(run.directory, "spec.json"), "utf8")).plots[0];
	assert.deepEqual(spec.series[1].y, [2, 3, 5, 9]);
	const svg = fs.readFileSync(path.join(run.directory, "chart-1.svg"), "utf8");
	assert(svg.includes("Parser scaling")); assert(svg.includes("Runtime (ms)")); assert(svg.includes("#14171d"));
	const png = fs.readFileSync(path.join(run.directory, "chart-1.png"));
	assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	assert.equal(png.readUInt32BE(16), 1600);
	const terminal = stripVTControlCharacters(fs.readFileSync(path.join(run.directory, "chart-1.txt"), "utf8"));
	assert(terminal.includes("baseline")); assert(terminal.includes("current")); assert(/[⠁-⣿]/.test(terminal));
	assert(f.session.systemPrompt.includes("plot_chart")); assert(f.session.systemPrompt.includes("yError"));
	for (const name of fs.readdirSync(run.directory)) assert.equal(fs.statSync(path.join(run.directory, name)).mode & 0o777, 0o600);
	assert.equal(fs.statSync(run.directory).mode & 0o777, 0o700);
	assert.equal(fs.statSync(f.store.root).mode & 0o777, 0o700);
});

test("bench charts preserve failed exits, sample SD, unequal sample counts and explicit baseline labels", async (t) => {
	const f = await fixture(t);
	const file = f.input("hyperfine.json", JSON.stringify({ results: [
		{ command: "baseline", times: [1, 2, 3, 4], exit_codes: [0, 0, 0, 0] },
		{ command: "current", times: [.5, 1, 1.5], exit_codes: [0, 0, 0] },
		{ command: "touch must-never-run", times: [2], exit_codes: [9] },
	] }));
	const benchmarks = new BenchmarkStore(path.join(f.agentDir, "benchmarks"));
	const bench = benchmarks.import(file, f.cwd, { title: "Parser comparison", baseline: 1 });
	await f.benchCommand(`plot ${bench.manifest.id}`, f.ctx);
	assert.deepEqual(f.notifications, []);
	assert(f.view());
	const manifest = f.store.list(f.cwd)[0]; assert(manifest);
	const run = f.store.load(manifest.id);
	assert.equal(run.manifest.charts.length, 3);
	const specs = JSON.parse(fs.readFileSync(path.join(run.directory, "spec.json"), "utf8")).plots;
	assert.deepEqual(specs.map((spec: any) => spec.kind), ["bar", "box", "line"]);
	assert.deepEqual(specs[0].series[0].y, [2.5, 1, 2]);
	assert(Math.abs(specs[0].series[0].yError[0] - Math.sqrt(5 / 3)) < 1e-12);
	assert.equal(specs[0].series[0].yError[2], null, "One sample has unavailable SD, not a fabricated zero.");
	assert(specs[0].labels[0].includes("(baseline)")); assert(specs[0].labels[2].includes("[failed]"));
	assert(fs.readFileSync(path.join(run.directory, "chart-1.svg"), "utf8").includes("baseline (baseline)"),
		"Scaling must not reset categorical bar tick labels.");
	assert(fs.readFileSync(path.join(run.directory, "chart-2.svg"), "utf8").includes("current"),
		"Horizontal box plot case labels must survive axis setup.");
	assert(specs[0].notes.some((note: string) => note.includes("not confidence intervals")));
	assert.deepEqual(specs[1].series[1].values, [.5, 1, 1.5]);
	const terminalParts = JSON.parse(fs.readFileSync(path.join(run.directory, "rendered.json"), "utf8"));
	assert.equal(terminalParts[2].parts.length, 3, "Unequal-length series get separate previews, without invented zeros.");
	assert(terminalParts[1].parts[0].flags.includes("--transpose"));
	assert(!fs.existsSync(path.join(f.cwd, "must-never-run")));
	assert.equal(f.messages.length, 0, "Opening benchmark plots starts no model turn.");
});

test("scatter, bars, common histogram bins, box samples and labeled logarithmic previews render through both libraries", async (t) => {
	const f = await fixture(t);
	const cases = [
		{ kind: "scatter", title: "Scatter", xScale: "log", yScale: "log", series: [{ name: "curve", x: [1, 10, 100], y: [2, 20, 200] }] },
		{ kind: "bar", title: "Bars", labels: ["A", "B"], series: [{ name: "mean", y: [1, 3], yError: [null, .5] }] },
		{ kind: "histogram", title: "Histogram", bins: 4, series: [{ name: "baseline", values: [1, 2, 3, 4] }, { name: "current", values: [1.5, 2, 2.5] }] },
		{ kind: "box", title: "Box", series: [{ name: "samples", values: [1, 2, 2, 3, 4, 9] }] },
	];
	const run = await f.store.create({ plots: cases }, "fixture", f.cwd);
	assert.equal(run.manifest.charts.length, 4);
	const rendered = JSON.parse(fs.readFileSync(path.join(run.directory, "rendered.json"), "utf8"));
	assert.equal(rendered[0].parts[0].xLabel, "log10 x");
	assert.equal(rendered[0].parts[0].yLabel, "log10 y");
	assert.deepEqual(rendered[2].parts.map((part: any) => part.data.split("\n").slice(0, 4).map((row: string) => row.split("\t")[0])),
		[rendered[2].parts[0].data.split("\n").slice(0, 4).map((row: string) => row.split("\t")[0]),
		 rendered[2].parts[0].data.split("\n").slice(0, 4).map((row: string) => row.split("\t")[0])]);
	assert(run.manifest.charts[1].notes.some((note) => note.includes("Error bars")));
	for (let i = 1; i <= 4; i++) assert(fs.statSync(path.join(run.directory, `chart-${i}.png`)).size > 10_000);
});

test("invalid data, ambiguous CSV columns and cancelled renders leave no published plots", async (t) => {
	const f = await fixture(t);
	for (const spec of [
		{ kind: "line", series: [{ y: [1, 2], x: [1] }] },
		{ kind: "line", xScale: "log", series: [{ x: [0], y: [1] }] },
		{ kind: "bar", labels: ["one"], series: [{ y: [1, 2] }] },
		{ kind: "scatter", series: [{ y: [true] }] },
		{ kind: "line", title: "unsafe\x1b]0;title\x07", series: [{ y: [1] }] },
		{ kind: "line", series: [{ y: [1], yError: [-1] }] },
		{ kind: "box", series: [{ values: [] }] },
	]) await assert.rejects(f.store.create(spec, "invalid", f.cwd));
	const blank = f.input("blank.csv", "x,y\n1,\n");
	await assert.rejects(f.store.import(blank, f.cwd, { yColumns: ["y"] }), /empty\/nonnumeric/);
	await assert.rejects(f.store.import(blank, f.cwd, { yColumns: ["y", "y"] }), /distinct/);
	const duplicate = f.input("duplicate.csv", "x,y,y\n1,2,3\n");
	await assert.rejects(f.store.import(duplicate, f.cwd, { yColumns: ["y"] }), /distinct/);
	const ragged = f.input("ragged.csv", "x,y\n1,2,3\n");
	await assert.rejects(f.store.import(ragged, f.cwd, { yColumns: ["y"] }), /same number/);
	const controller = new AbortController();
	const render = f.store.create({ kind: "line", series: [{ y: Array.from({ length: 50_000 }, (_, i) => i) }] }, "cancelled", f.cwd, controller.signal);
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(render, /cancelled/);
	assert.equal(f.store.list(f.cwd).length, 0);
	assert.deepEqual(fs.readdirSync(f.store.root).filter((name) => !name.startsWith(".")), []);
});

test("native Kanso plot view browses charts, resizes and uses local image rendering without model messages", async (t) => {
	const f = await fixture(t);
	const spec = { plots: [
		{ kind: "line", title: "Scaling", series: [{ name: "baseline", x: [1, 2, 3], y: [2, 4, 8] }] },
		{ kind: "histogram", title: "Distribution", series: [{ name: "samples", values: [1, 2, 3, 4] }] },
	] };
	const input = f.input("chart  fixture.json", JSON.stringify(spec));
	await f.command(`import "${input}"`, f.ctx);
	assert.deepEqual(f.notifications, []);
	const view = f.view(); assert(view);
	for (const width of [1, 15, 40, 80, 120]) {
		const lines = view.render(width);
		assert(lines.every((line: string) => tui.visibleWidth(line) <= width), `overflow at ${width}`);
		assert(lines.length <= 36);
	}
	await view.preview.ready();
	view.render(120); await view.preview.ready();
	const rendered = view.render(120);
	assert(plain(rendered).includes("Scaling"));
	assert(rendered.some((line: string) => line.includes("20;23;29")), "Uses Kanso Ink background.");
	view.handleInput("\x1b[C");
	assert(plain(view.render(100)).includes("Distribution"));
	view.handleInput("\x1b[6~");
	assert(f.renders() > 0);
	view.handleInput("\x1b");
	assert.equal(f.closed(), 1); assert.equal(f.messages.length, 0);
	const run = f.store.load(f.store.list(f.cwd)[0].id);
	const registered = f.extension.tools.get("plot_chart");
	const definition = registered.definition ?? registered;
	const before = tui.getCapabilities();
	try {
		tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const component = definition.renderResult({ content: [{ type: "text", text: "compact" }], details: { id: run.manifest.id } },
			{ isPartial: false, expanded: true }, f.theme,
			{ showImages: true, invalidate() {}, lastComponent: undefined });
		assert(component.render(100).some((line: string) => line.includes("\x1b_G")), "Uses Pi's native Kitty image component.");
	} finally { tui.setCapabilities(before); }
});

test("saved artifacts detect tampering and print mode remains concise", async (t) => {
	const f = await fixture(t);
	const run = await f.store.create({ kind: "line", series: [{ y: [1, 2, 3] }] }, "fixture", f.cwd);
	const writes: string[] = [];
	const previous = process.stderr.write;
	process.stderr.write = ((text: string) => { writes.push(text); return true; }) as any;
	try { await f.command(`view ${run.manifest.id}`, { ...f.ctx, mode: "print" }); }
	finally { process.stderr.write = previous; }
	assert(writes.join("").includes("PNG:")); assert(writes.join("").length < 1500);
	assert(!writes.join("").includes("⠁"));
	assert.equal(f.messages.length, 0);
	fs.appendFileSync(path.join(run.directory, "chart-1.svg"), "\n");
	assert.throws(() => f.store.load(run.manifest.id), /integrity/);
	assert.equal(f.store.list(f.cwd).length, 0);
	assert.throws(() => f.store.load("../outside"), /Invalid plot ID/);
});
