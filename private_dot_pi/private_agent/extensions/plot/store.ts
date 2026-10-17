import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { repository, type SavedBenchmark } from "../bench/results.ts";

const exec = promisify(execFile);
const renderer = fileURLToPath(new URL(".", import.meta.url));
const ID = /^\d{8}T\d{9}Z-[\da-f]{8}$/;
const MAX_BYTES = 32 * 1024 * 1024;
export interface Chart {
	kind: string; title: string; seriesCount: number; pointCount: number; stem: string; notes: string[];
}
interface TerminalPart {
	command: "bar" | "lines" | "scatter" | "box"; data: string; title: string;
	flags: string[]; xLabel: string; yLabel: string;
}
export interface PlotManifest {
	version: 1; id: string; createdAt: string; repositoryKey: string; source: string;
	renderer: string; charts: Chart[]; hashes: Record<string, string>;
}
export interface SavedPlot { manifest: PlotManifest; directory: string }
export const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function readFile(file: string): Buffer {
	const fd = fs.openSync(file, "r");
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Plot input must be a regular file of at most 32 MiB.");
		const bytes = Buffer.alloc(stat.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const size = fs.readSync(fd, bytes, length, bytes.length - length, length);
			if (!size) break;
			length += size;
		}
		if (length !== stat.size) throw new Error("Plot input changed while being read; try again.");
		return bytes.subarray(0, length);
	} finally { fs.closeSync(fd); }
}

function youplot(args: string[], input: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("youplot", args, { stdio: ["pipe", "pipe", "pipe"], signal });
		const output: Buffer[] = [], errors: Buffer[] = [];
		let size = 0;
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.stdout.on("data", (bytes: Buffer) => {
			size += bytes.length;
			if (size > 256 * 1024) child.kill("SIGKILL");
			else output.push(bytes);
		});
		child.stderr.on("data", (bytes: Buffer) => { if (Buffer.concat(errors).length < 8192) errors.push(bytes); });
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(Buffer.concat(output).toString("utf8"));
			else reject(new Error(`YouPlot failed: ${Buffer.concat(errors).toString("utf8").slice(0, 8192) || code}`));
		});
		// Aborting or an early CLI error can close stdin before it has consumed the dataset.
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

export class PlotStore {
	readonly root: string;
	constructor(root: string) { this.root = root; }
	async import(file: string, cwd: string, options: Record<string, unknown> = {}, signal?: AbortSignal) {
		const source = path.resolve(cwd, file.startsWith("~/") ? path.join(homedir(), file.slice(2)) : file);
		return this.save(readFile(source), path.extname(source).toLowerCase(), source, cwd, options, signal);
	}
	async create(spec: unknown, source: string, cwd: string, signal?: AbortSignal) {
		return this.save(Buffer.from(JSON.stringify(spec)), ".json", source, cwd, {}, signal);
	}
	private async save(bytes: Buffer, extension: string, source: string, cwd: string,
		options: Record<string, unknown>, signal?: AbortSignal): Promise<SavedPlot> {
		signal?.throwIfAborted();
		if (bytes.length > MAX_BYTES) throw new Error("Plot input exceeds 32 MiB.");
		if (![".json", ".csv", ".tsv"].includes(extension)) throw new Error("Expected a chart JSON spec or a CSV/TSV file.");
		const python = path.join(renderer, ".venv/bin/python");
		if (!fs.existsSync(python)) throw new Error(`Plotting setup is missing. Run: uv sync --locked --project ${renderer}`);
		const createdAt = new Date().toISOString();
		const id = `${createdAt.replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
		fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); fs.chmodSync(this.root, 0o700);
		const directory = path.join(this.root, id);
		fs.mkdirSync(directory, { mode: 0o700 });
		try {
			const input = path.join(directory, "input" + extension);
			fs.writeFileSync(input, bytes, { mode: 0o600, flag: "wx" });
			const request = path.join(directory, "request.json");
			fs.writeFileSync(request, JSON.stringify({ input, options }), { mode: 0o600, flag: "wx" });
			const result = await exec(python, [path.join(renderer, "render.py"), request, directory], {
				signal, timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024,
				env: { ...process.env, MPLCONFIGDIR: path.join(this.root, ".matplotlib") },
			});
			const metadata = JSON.parse(result.stdout);
			const rendered = JSON.parse(readFile(path.join(directory, "rendered.json")).toString());
			const charts: Chart[] = rendered.map(({ parts: _parts, ...chart }: any) => chart);
			const manifest: PlotManifest = {
				version: 1, id, createdAt, repositoryKey: repository(cwd).key, source,
				renderer: metadata.renderer, charts, hashes: {},
			};
			const saved = { manifest, directory };
			// Exercise the actual terminal renderer before publishing the manifest.
			for (let i = 0; i < charts.length; i++) {
				fs.writeFileSync(path.join(directory, `${charts[i].stem}.txt`),
					await this.preview(saved, i, 100, 16, signal), { mode: 0o600, flag: "wx" });
			}
			for (const name of fs.readdirSync(directory)) {
				fs.chmodSync(path.join(directory, name), 0o600);
				manifest.hashes[name] = digest(readFile(path.join(directory, name)));
			}
			signal?.throwIfAborted();
			fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
			return saved;
		} catch (error: any) {
			fs.rmSync(directory, { recursive: true, force: true });
			if (signal?.aborted) throw new Error("Plot rendering cancelled.");
			throw new Error(String(error.stderr || error.message || error).slice(0, 8192));
		}
	}
	load(id: string): SavedPlot {
		if (!ID.test(id)) throw new Error("Invalid plot ID.");
		const directory = path.join(this.root, id);
		const manifest = JSON.parse(readFile(path.join(directory, "manifest.json")).toString()) as PlotManifest;
		if (manifest.version !== 1 || manifest.id !== id || typeof manifest.repositoryKey !== "string" ||
			typeof manifest.source !== "string" || !Array.isArray(manifest.charts) || !manifest.charts.length ||
			!manifest.hashes || typeof manifest.hashes !== "object") throw new Error("Invalid plot manifest.");
		for (const [name, hash] of Object.entries(manifest.hashes)) {
			if (!/^(?:input\.(?:json|csv|tsv)|request\.json|spec\.json|rendered\.json|chart-[1-8]\.(?:png|svg|txt))$/.test(name) ||
				digest(readFile(path.join(directory, name))) !== hash) throw new Error("Saved plot failed its integrity check.");
		}
		for (const chart of manifest.charts) {
			if (!/^chart-[1-8]$/.test(chart.stem) || typeof chart.title !== "string" ||
				!Array.isArray(chart.notes) || !manifest.hashes[chart.stem + ".png"] ||
				!manifest.hashes[chart.stem + ".svg"] || !manifest.hashes[chart.stem + ".txt"]) throw new Error("Invalid chart metadata.");
		}
		return { manifest, directory };
	}
	list(key: string): PlotManifest[] {
		if (!fs.existsSync(this.root)) return [];
		const runs: PlotManifest[] = [];
		for (const id of fs.readdirSync(this.root).filter((name) => ID.test(name)).sort().reverse()) {
			try {
				const manifest = this.load(id).manifest;
				if (manifest.repositoryKey === key) runs.push(manifest);
			} catch { /* Interrupted/corrupted imports are not browseable. */ }
			if (runs.length === 100) break;
		}
		return runs;
	}
	async preview(run: SavedPlot, index: number, width: number, height: number, signal?: AbortSignal) {
		const rendered = JSON.parse(readFile(path.join(run.directory, "rendered.json")).toString());
		const chart = rendered[index];
		if (!chart) throw new Error("No such saved chart.");
		const parts: TerminalPart[] = chart.parts;
		const outputs: string[] = [];
		for (const part of parts) {
			const args = [part.command, "--config", path.join(renderer, "youplot.yml"),
				"--output", "-", "--color-output", "--width", String(Math.max(8, Math.min(140, width - 42))),
				...(["lines", "scatter"].includes(part.command) ? ["--height", String(Math.max(4, Math.min(30, height)))] : []),
				"--margin", "0", "--padding", "1",
				...(part.title ? ["--title", part.title] : []),
				...(part.xLabel ? ["--xlabel", part.xLabel] : []),
				...(part.yLabel ? ["--ylabel", part.yLabel] : []), ...part.flags];
			outputs.push(await youplot(args, part.data, signal));
		}
		return outputs.join("\n");
	}
}

export function plotSummary(run: SavedPlot): string {
	return [
		`Saved plot ${run.manifest.id} (${run.manifest.renderer}).`,
		...run.manifest.charts.map((chart) => `${chart.title || chart.kind}: ${chart.seriesCount} series, ${chart.pointCount} points.\nPNG: ${path.join(run.directory, chart.stem + ".png")}\nSVG: ${path.join(run.directory, chart.stem + ".svg")}`),
		`Open /plot view ${run.manifest.id}. Data and previews are saved outside conversation context.`,
	].join("\n");
}

export function benchmarkPlots(run: SavedBenchmark) {
	if (run.cases.length > 32) throw new Error("Benchmark plotting supports at most 32 cases; the benchmark dashboard retains every case.");
	const clean = (value: string, length: number) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, length);
	const labels = run.cases.map((entry, index) => `${clean(entry.label, 65)}${index + 1 === run.manifest.options.baseline ? " (baseline)" : ""}${entry.status === "passed" ? "" : ` [${entry.status}]`}`);
	const title = clean(run.manifest.options.title || "Hyperfine", 100);
	const notes = [
		"Measured samples are descriptive; error bars are sample SD, not confidence intervals.",
		...run.cases.map((entry, index) => `${labels[index]}: n=${entry.n}; ${entry.status}${entry.stddev === undefined ? "; SD unavailable (one sample)" : ""}`),
	];
	return { plots: [
		{ kind: "bar", title: `${title}: mean runtime`, xLabel: "Case", yLabel: "Runtime (s)", labels,
			series: [{ name: "Mean ± sample SD", y: run.cases.map((entry) => entry.mean), yError: run.cases.map((entry) => entry.stddev ?? null) }], notes },
		{ kind: "box", title: `${title}: run distributions`, xLabel: "Runtime (s)",
			series: run.cases.map((entry, index) => ({ name: labels[index], values: entry.times })), notes },
		{ kind: "line", title: `${title}: measured run order`, xLabel: "Measured run", yLabel: "Runtime (s)",
			series: run.cases.map((entry, index) => ({ name: labels[index], y: entry.times })), notes },
	] };
}
