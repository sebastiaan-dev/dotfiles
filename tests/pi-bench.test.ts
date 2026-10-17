import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { sdk, tui } from "./helpers/pi-sdk.ts";
import {
	BenchmarkStore, parseExport, statistics, relativeChange, repository, MAX_EXPORT_BYTES,
} from "../private_dot_pi/private_agent/extensions/bench/results.ts";
import { benchmarkMarkdown } from "../private_dot_pi/private_agent/extensions/bench/markdown.ts";

const extension = fileURLToPath(new URL("../private_dot_pi/private_agent/extensions/bench", import.meta.url));
const prompt = fileURLToPath(new URL("../private_dot_pi/private_agent/prompts/bench.md", import.meta.url));
const runPrompt = fileURLToPath(new URL("../private_dot_pi/private_agent/prompts/bench-run.md", import.meta.url));
const palette = fileURLToPath(new URL("../private_dot_pi/private_agent/themes/kanso-mist.json", import.meta.url));
const raw = (times = [1, 2, 3, 4], exits: number[] | null = [0, 0, 0, 0]) => Buffer.from(JSON.stringify({
	results: [{ command: "baseline", times, exit_codes: exits === null ? undefined : exits }],
}));
const plain = (lines: string[]) => lines.map(stripVTControlCharacters).join("\n");

async function fixture(t: any) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "pi-bench-")));
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	fs.mkdirSync(cwd);
	fs.cpSync(extension, path.join(agentDir, "extensions/bench"), { recursive: true });
	fs.cpSync(path.join(path.dirname(extension), "plot"), path.join(agentDir, "extensions/plot"), {
		recursive: true, filter: (source) => !source.split(path.sep).includes(".venv") && !source.split(path.sep).includes("__pycache__"),
	});
	fs.mkdirSync(path.join(agentDir, "prompts"));
	fs.copyFileSync(prompt, path.join(agentDir, "prompts/bench.md"));
	fs.copyFileSync(runPrompt, path.join(agentDir, "prompts/bench-run.md"));
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
	assert(loader.getPrompts().prompts.some((entry: any) => entry.name === "bench"));
	assert(loader.getPrompts().prompts.some((entry: any) => entry.name === "bench-run"));
	const bench = loaded.extensions.find((entry: any) => entry.tools.has("benchmark_results"));
	assert(bench?.commands.has("bench"));
	assert.equal(bench.handlers.size, 0, "Imports and browsing must not add background session hooks.");
	const { session } = await sdk.createAgentSession({
		cwd, agentDir, settingsManager, resourceLoader: loader, tools: ["bash", "benchmark_results"],
		sessionManager: sdk.SessionManager.inMemory(cwd),
	});
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "tui" });
	const messages: any[] = [];
	loaded.runtime.sendMessage = (message: any, options: any) => messages.push({ message, options });
	loaded.runtime.sendUserMessage = (content: any, options: any) => messages.push({ content, options });
	const notifications: any[] = [];
	const theme = loader.getThemes().themes.find((entry: any) => entry.name === "kanso-mist");
	assert(theme);
	let view: any;
	let renders = 0, closed = 0;
	const terminal = { rows: 36 };
	const ctx = {
		cwd, mode: "tui", hasUI: true,
		ui: {
			notify: (text: string, level: string) => notifications.push({ text, level }),
			custom: async (factory: any) => {
				view = factory({ terminal, requestRender: () => renders++ }, theme, {}, () => closed++);
			},
		},
	};
	const command = bench.commands.get("bench").handler;
	const tool = session.agent.state.tools.find((entry: any) => entry.name === "benchmark_results");
	assert(tool);
	assert(session.systemPrompt.includes("--export-json"));
	const source = path.join(cwd, "hyperfine fixture.json");
	fs.writeFileSync(source, raw());
	return {
		base, cwd, agentDir, loader, session, command, tool, source, ctx, terminal, theme, messages, notifications,
		store: new BenchmarkStore(path.join(agentDir, "benchmarks")),
		view: () => view, renders: () => renders, closed: () => closed,
	};
}

test("real Hyperfine exports pass native Pi import and survive sessions with exact private samples", async (t) => {
	const f = await fixture(t);
	execFileSync("hyperfine", [
		"--warmup", "1", "--runs", "3", "--command-name", "baseline", "--command-name", "candidate",
		"--export-json", f.source, "sleep 0.005", "sleep 0.01",
	], { cwd: f.cwd, stdio: "ignore" });
	const result = await f.tool.execute("bench-fixture", {
		file: f.source, title: "Hyperfine integration fixture", baseline: 1, warmup: 1,
		conditions: "Sleep fixture; shell overhead is not a production workload.",
		environment: "Local integration fixture", invocation: "hyperfine 1.20.0 --warmup 1 --runs 3 ...",
		cases: [{ name: "base", command: "sleep 0.005", build: "No compilation" }, { name: "candidate", command: "sleep 0.01" }],
	}, undefined, undefined);
	const text = result.content[0].text;
	assert(text.includes("n=3")); assert(text.includes("/bench view"));
	assert(text.length < 1500); assert(!text.includes('"times"'));
	assert(!JSON.stringify(result.details).includes('"times"'));
	const run = new BenchmarkStore(f.store.root).load(result.details.id);
	assert.equal(run.cases.length, 2);
	assert(run.cases.every((entry) => entry.status === "passed"));
	assert.deepEqual(fs.readFileSync(path.join(run.directory, "hyperfine.json")), fs.readFileSync(f.source));
	assert.equal(run.cases[0].info.command, "sleep 0.005", "Named exports must retain the actual measured command separately.");
	assert.equal(run.manifest.options.baseline, 1);
	for (const name of ["hyperfine.json", "manifest.json"]) assert.equal(fs.statSync(path.join(run.directory, name)).mode & 0o777, 0o600);
	assert.equal(fs.statSync(run.directory).mode & 0o777, 0o700);
	assert.equal(fs.statSync(f.store.root).mode & 0o777, 0o700);
	assert.equal(f.store.list(repository(f.cwd).key).runs.length, 1);
	await f.command(`view ${run.manifest.id}`, f.ctx);
	assert(plain(f.view().render(120)).includes("Summary"));
	assert.equal(f.messages.length, 0, "Opening the terminal dashboard adds no model messages.");
});

test("computed sample statistics and relative changes have defined semantics", () => {
	const stats = statistics([1, 2, 3, 4]);
	assert.equal(stats.mean, 2.5); assert.equal(stats.median, 2.5);
	assert.equal(stats.q1, 1.75); assert.equal(stats.q3, 3.25);
	assert(Math.abs(stats.p95 - 3.85) < 1e-12);
	assert(Math.abs(stats.stddev! - Math.sqrt(5 / 3)) < 1e-12);
	const base = parseExport(raw())[0];
	const faster = parseExport(raw([0.5, 1, 1.5, 2]))[0];
	assert.equal(relativeChange(faster, base), -50);
	assert.equal(relativeChange(base), undefined);
	assert.equal(relativeChange(base, parseExport(raw([0, 0, 0, 0]))[0]), undefined);
	assert.equal(statistics([1]).stddev, undefined);
	assert.equal(statistics([0]).cv, undefined);
});

test("failed or missing exits remain inspectable but never produce performance comparisons", () => {
	const base = parseExport(raw())[0];
	const failed = parseExport(raw([1, 2, 3, 4], [0, 7, 0, 0]))[0];
	const unverified = parseExport(raw([1, 2, 3, 4], null))[0];
	assert.equal(failed.status, "failed");
	assert.equal(unverified.status, "unverified");
	assert.equal(relativeChange(failed, base), undefined);
	assert.equal(relativeChange(base, failed), undefined);
	assert.equal(relativeChange(unverified, base), undefined);
	for (const data of [
		{ results: [] }, { results: [{ command: "", times: [1] }] },
		{ results: [{ command: "bad", times: [-1] }] },
		{ results: [{ command: "bad", times: [1], exit_codes: [0, 0] }] },
		{ results: [{ command: "bad", times: [1, 2], mean: 50 }] },
		{ results: [{ command: "bad", times: [1, 2], memory_usage_byte: [100] }] },
	]) assert.throws(() => parseExport(Buffer.from(JSON.stringify(data))));
	assert.throws(() => parseExport(raw(), { baseline: 2 }), /Baseline/);
	assert.throws(() => parseExport(raw(), { cases: [] }), /order and count/);
	assert.throws(() => parseExport(Buffer.alloc(MAX_EXPORT_BYTES + 1)), /16 MiB/);
});

test("foreign imports keep unknown provenance explicit and detect corrupted saved artifacts", async (t) => {
	const f = await fixture(t);
	const run = f.store.import(f.source, f.cwd);
	assert.equal(run.manifest.options.warmup, undefined);
	assert.equal(run.manifest.options.environment, undefined);
	assert.equal(run.cases[0].info.command, undefined);
	assert.equal(run.cases[0].info.revision, undefined);
	assert.equal(run.manifest.repository.cwd, f.cwd);
	await f.command(`view ${run.manifest.id}`, f.ctx);
	f.view().handleInput("\x1b[C"); f.view().handleInput("\x1b[C");
	f.terminal.rows = 100;
	const details = plain(f.view().render(100));
	assert(details.includes("Measurement environment: Not recorded"));
	assert(details.includes("Exact measured command: Not recorded"));
	assert(details.includes("not necessarily the measurement host"));
	assert(details.includes("Recorder system:"));
	fs.appendFileSync(path.join(run.directory, "hyperfine.json"), "\n");
	assert.throws(() => f.store.load(run.manifest.id), /integrity/);
	await f.command(`view ${run.manifest.id}`, f.ctx);
	assert(plain(f.view().render(80)).includes("integrity"));
	const malformed = JSON.parse(fs.readFileSync(path.join(run.directory, "manifest.json"), "utf8"));
	malformed.repository = null;
	fs.writeFileSync(path.join(run.directory, "manifest.json"), JSON.stringify(malformed));
	assert.equal(f.store.list(repository(f.cwd).key).skipped, 1);
	assert.throws(() => f.store.load("../outside"), /ID/);
});

test("Kanso dashboard resizes, switches tabs/cases/baselines/history and scrolls samples", async (t) => {
	const f = await fixture(t);
	fs.writeFileSync(f.source, JSON.stringify({ results: [
		{ command: "base with a long label", times: Array.from({ length: 300 }, (_, i) => 1 + i / 100), exit_codes: Array(300).fill(0) },
		{ command: "候補 candidate", times: [0.5, 1, 1.5, 2], exit_codes: [0, 0, 0, 0] },
	] }));
	f.store.import(f.source, f.cwd, { title: "Older fixture" });
	const run = f.store.import(f.source, f.cwd, { title: "Newest \x1b]0;untrusted title\x07 fixture", baseline: 1 });
	await f.command("", f.ctx);
	const view = f.view();
	f.terminal.rows = 100;
	for (const width of [1, 15, 30, 50, 99, 100, 120, 180]) {
		const lines = view.render(width);
		assert(lines.every((line: string) => tui.visibleWidth(line) <= width), `overflow at ${width}`);
		assert(lines.length <= 88);
		assert(!lines.join("\n").includes("\x1b]0;"), "Imported text must not emit terminal control sequences.");
	}
	const first = view.render(120);
	assert(first.some((line: string) => line.includes("\x1b[")), "Uses native Kanso theme styling.");
	assert(plain(first).includes("Mean")); assert(plain(first).includes("p95"));
	view.handleInput("b");
	assert(plain(view.render(120)).includes("Baseline: 候補"));
	view.handleInput("b"); assert(plain(view.render(120)).includes("None selected"));
	view.handleInput("\x1b[C");
	const runs = plain(view.render(80));
	assert(runs.includes("Distribution")); assert(runs.includes("execution order"));
	view.handleInput("\x1b[6~");
	assert(plain(view.render(80)) !== runs);
	view.handleInput("\x1b[F");
	assert(plain(view.render(80)).includes("first 200 of 300"));
	view.handleInput("c");
	assert(plain(view.render(80)).includes("2/2")); assert(plain(view.render(80)).includes("4 samples"));
	view.handleInput("\x1b[B");
	view.handleInput("\x1b[C");
	assert(plain(view.render(120)).includes("Title: Older fixture"));
	view.handleInput("r");
	assert(f.renders() > 5);
	view.handleInput("\x1b");
	assert.equal(f.closed(), 1);
	assert.equal(f.messages.length, 0);
	assert.equal(f.store.load(run.manifest.id).manifest.options.baseline, 1, "View selection never changes provenance.");
});

test("Markdown tables include every result and compare the view's selected baseline with current cases", async (t) => {
	const f = await fixture(t);
	fs.writeFileSync(f.source, JSON.stringify({ results: [
		{ command: "base | <input>", times: [1, 2, 3, 4], exit_codes: [0, 0, 0, 0] },
		{ command: "candidate", times: [0.5, 1, 1.5, 2], exit_codes: [0, 0, 0, 0] },
		{
			command: "second candidate", times: [0.75, 1.5, 2.25, 3], exit_codes: [0, 0, 0, 0],
			user: 0.001, system: 0.002, memory_usage_byte: [1048576, 2097152, 3145728, 4194304],
		},
	] }));
	const command = "printf '%s\\n' '``` | <input>'\nprintf 'second line'";
	const run = f.store.import(f.source, f.cwd, {
		title: "Benchmark\n## injected heading", baseline: 1, warmup: 0,
		conditions: "Warm caches\nthreads=2", environment: "Measured on fixture host",
		cases: [{ command, revision: "fixture", build: "No compilation" }, {}, {}],
	});
	const report = benchmarkMarkdown(run, 0);
	const tokens = new tui.Marked().lexer(report).filter((token: any) => token.type !== "space");
	assert.equal(tokens.length, 1, "The clipboard contains only a table.");
	const table = tokens[0];
	assert.equal(table.type, "table");
	assert.equal(table.header.length, 4);
	assert(table.header[1].text.startsWith("Baseline: "));
	assert.equal(table.header[2].text, "Current: candidate");
	assert.equal(table.header[3].text, "Current: second candidate");
	assert(table.rows.every((row: any[]) => row.length === 4), "Pipes in case names cannot split table cells.");
	const row = (label: string) => table.rows.find((cells: any[]) => cells[0].text === label);
	assert.deepEqual(row("Mean").slice(1).map((cell: any) => cell.text), ["2.500 s", "1.250 s", "1.875 s"]);
	assert.equal(row("Mean change vs baseline")[2].text, "-50.00%");
	assert.equal(row("Mean change vs baseline")[3].text, "-25.00%");
	assert.equal(row("Runs").at(-1).text, "4");
	assert(row("Median")); assert(row("SD")); assert(row("p95 estimate")); assert(row("Minimum")); assert(row("Maximum"));
	assert(row("Q1")); assert(row("Q3")); assert(row("CV")); assert(row("Status"));
	assert.equal(row("Mean CPU user").at(-1).text, "1.000 ms");
	assert.equal(row("Mean CPU system").at(-1).text, "2.000 ms");
	assert.equal(row("RSS median").at(-1).text, "2.50 MiB");
	assert.equal(row("RSS peak").at(-1).text, "4.00 MiB");
	assert.equal(row("RSS peak")[1].text, "—");
	assert(!report.includes("Warm caches"));
	assert(!report.includes("Exact measured command"));
	assert(!report.includes("Recorder context"));
	assert(!report.includes(run.manifest.id));
	assert(!report.includes('"times"'));
	const none = new tui.Marked().lexer(benchmarkMarkdown(run, undefined)).find((token: any) => token.type === "table");
	assert(none.header.slice(1).every((cell: any) => cell.text.startsWith("Current: ")));
	assert(none.rows.find((cells: any[]) => cells[0].text === "Mean change vs baseline").slice(1).every((cell: any) => cell.text === "—"),
		"An explicit no-baseline view must not fall back to saved metadata.");
	const reversed = new tui.Marked().lexer(benchmarkMarkdown(run, 1)).find((token: any) => token.type === "table");
	assert.equal(reversed.header[1].text, "Baseline: candidate");
	assert.equal(reversed.rows.find((cells: any[]) => cells[0].text === "Mean change vs baseline")[2].text, "+100.00%");
	run.cases[1].status = "failed";
	const failed = new tui.Marked().lexer(benchmarkMarkdown(run, 0)).find((token: any) => token.type === "table");
	assert.equal(failed.rows.find((cells: any[]) => cells[0].text === "Mean change vs baseline")[2].text, "—");
});

test("y copies Markdown inside the native dashboard and reports clipboard failures without closing", async (t) => {
	const f = await fixture(t);
	const run = f.store.import(f.source, f.cwd, { title: "Copy fixture", baseline: 1 });
	await f.command(`view ${run.manifest.id}`, f.ctx);
	const View = f.view().constructor;
	const copied: string[] = [];
	let closed = 0, redraws = 0;
	const view = new View(f.store, repository(f.cwd).key,
		{ terminal: f.terminal, requestRender: () => redraws++ }, f.theme, () => closed++, run.manifest.id,
		async (value: string) => { copied.push(value); });
	await view.handleInput("y");
	assert.equal(copied.length, 1);
	assert(copied[0].startsWith("| Metric | Baseline: baseline |"));
	assert(!copied[0].includes("Copy fixture"));
	assert(!copied[0].includes("Recorder context"));
	assert(new tui.Marked().lexer(copied[0]).filter((token: any) => token.type !== "space").every((token: any) => token.type === "table"));
	assert(plain(view.render(120)).includes("Copied Markdown table."));
	assert(plain(view.render(120)).includes("y copy table"));
	view.handleInput("b");
	await view.handleInput("y");
	assert(copied[1].startsWith("| Metric | Current: baseline |"));
	assert.equal(f.store.load(run.manifest.id).manifest.options.baseline, 1);
	assert.equal(closed, 0);
	assert.equal(f.messages.length, 0);
	assert(redraws >= 4);
	const failed = new View(f.store, repository(f.cwd).key,
		{ terminal: f.terminal, requestRender() {} }, f.theme, () => closed++, run.manifest.id,
		async () => { throw new Error("Clipboard unavailable"); });
	await failed.handleInput("y");
	assert(plain(failed.render(120)).includes("Copy failed: Clipboard unavailable"));
	assert.equal(closed, 0);
});

test("native /bench dispatch preserves literal workload text without recursive command expansion", async (t) => {
	const f = await fixture(t);
	const workload = 'compare "baseline --input data" with "candidate --input data" and literal $ARGUMENTS `$1`';
	await f.session.prompt(`/bench ${workload}`);
	assert.equal(f.messages.length, 1);
	const sent = f.messages[0];
	assert(sent.content.includes(workload));
	assert(sent.content.includes("### 3. Save validated results"));
	assert(sent.content.includes("benchmark_results"));
	assert(!sent.content.includes("<!-- pi-bench-workflow -->"));
	assert.equal(sent.options.expandPromptTemplates, false);
	assert.equal(sent.options.deliverAs, "followUp");
	await f.command("run help benchmark", f.ctx);
	assert(f.messages[1].content.includes("help benchmark"));
	await f.command("help", f.ctx);
	assert.equal(f.messages.length, 2);
	assert(f.notifications.some((entry: any) => entry.level === "info"));
	await f.command("import", f.ctx);
	assert(f.notifications.some((entry: any) => entry.level === "error"));
});

test("quoted import paths work without executing exported commands; print mode stays compact", async (t) => {
	const f = await fixture(t);
	fs.writeFileSync(f.source, JSON.stringify({ results: [{ command: "touch should-never-exist", times: [1, 2], exit_codes: [0, 0] }] }));
	await f.command(`import "${f.source}"`, f.ctx);
	assert(f.view());
	assert(!fs.existsSync(path.join(f.cwd, "should-never-exist")));
	await f.command("view latest", { ...f.ctx, mode: "json", hasUI: false });
	assert.equal(f.messages.length, 1);
	assert.equal(f.messages[0].options.triggerTurn, false);
	assert(f.messages[0].message.content.includes("n=2"));
	assert(!f.messages[0].message.content.includes('"times"'));
	assert(f.messages[0].message.content.length < 1500);
	await f.command("run sleep 0.01", { ...f.ctx, mode: "json", hasUI: false });
	assert(f.messages[1].message.content.includes("/bench-run sleep 0.01"));
	assert(f.loader.getPrompts().prompts.some((entry: any) => entry.name === "bench-run"));
	const cli = spawnSync("pi", [
		"--offline", "--print", "--no-session", "--no-skills", "--no-context-files",
		"--no-extensions", "--extension", path.join(f.agentDir, "extensions/bench/index.ts"),
		"--tools", "benchmark_results", "/bench view latest",
	], { cwd: f.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir }, encoding: "utf8", timeout: 15_000 });
	assert.equal(cli.status, 0, cli.stderr);
	const output = cli.stderr;
	assert(output.includes("n=2"), "The actual print-mode CLI must emit its compact report.");
	assert(output.includes("/bench view"));
	assert(output.length < 2000);
});
