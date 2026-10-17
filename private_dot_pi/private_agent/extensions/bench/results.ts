import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const ID = /^\d{8}T\d{9}Z-[\da-f]{8}$/;

export interface CaseInfo {
	name?: string;
	command?: string;
	revision?: string;
	build?: string;
	notes?: string;
}
export interface ImportOptions {
	title?: string;
	baseline?: number; // One-based; deliberately absent for a single workload.
	warmup?: number;
	conditions?: string;
	environment?: string;
	invocation?: string;
	cases?: CaseInfo[];
}
export interface Statistics {
	n: number;
	mean: number;
	stddev?: number;
	median: number;
	min: number;
	max: number;
	q1: number;
	q3: number;
	p95: number;
	cv?: number;
}
export interface BenchmarkCase extends Statistics {
	label: string;
	exportedCommand: string;
	info: CaseInfo;
	times: number[];
	exitCodes?: number[];
	status: "passed" | "failed" | "unverified";
	user?: number;
	system?: number;
	memory?: { median: number; peak: number };
}
export interface Repository {
	key: string;
	cwd: string;
	root?: string;
	head?: string;
	dirty?: boolean;
}
export interface Manifest {
	version: 1;
	id: string;
	importedAt: string;
	source: string;
	sha256: string;
	repository: Repository;
	recorder: { hostname: string; os: string; arch: string; cpu: string; ram: number };
	options: ImportOptions;
}
export interface SavedBenchmark {
	manifest: Manifest;
	cases: BenchmarkCase[];
	directory: string;
}

function object(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function number(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${field} must be a finite nonnegative number.`);
	}
	return value;
}
function samples(value: unknown, field: string): number[] {
	if (!Array.isArray(value) || !value.length || value.length > 100_000) {
		throw new Error(`${field} must contain 1–100,000 samples.`);
	}
	return value.map((entry) => number(entry, field));
}
export function quantile(sorted: number[], p: number): number {
	const index = (sorted.length - 1) * p;
	const lo = Math.floor(index);
	return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo);
}
export function statistics(times: number[]): Statistics {
	const sorted = [...times].sort((a, b) => a - b);
	// Online variance avoids cancellation for tightly clustered timings.
	let mean = 0, m2 = 0;
	times.forEach((time, i) => {
		const delta = time - mean;
		mean += delta / (i + 1);
		m2 += delta * (time - mean);
	});
	const stddev = times.length > 1 ? Math.sqrt(Math.max(0, m2 / (times.length - 1))) : undefined;
	return {
		n: times.length, mean, stddev, median: quantile(sorted, 0.5),
		min: sorted[0], max: sorted.at(-1)!, q1: quantile(sorted, 0.25),
		q3: quantile(sorted, 0.75), p95: quantile(sorted, 0.95),
		cv: mean > 0 && stddev !== undefined ? stddev / mean : undefined,
	};
}
function validateOptions(value: unknown, count: number): asserts value is ImportOptions {
	if (!object(value)) throw new Error("Benchmark metadata must be an object.");
	const text = (v: unknown, key: string) => {
		if (v !== undefined && (typeof v !== "string" || v.length > 16_384)) {
			throw new Error(`${key} must be text of at most 16,384 characters.`);
		}
	};
	for (const key of ["title", "conditions", "environment", "invocation"]) text(value[key], key);
	for (const key of ["baseline", "warmup"]) {
		if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < (key === "baseline" ? 1 : 0))) {
			throw new Error(`${key} must be a ${key === "baseline" ? "positive" : "nonnegative"} integer.`);
		}
	}
	if (value.baseline > count) throw new Error("Baseline is outside the exported cases.");
	if (value.cases !== undefined) {
		if (!Array.isArray(value.cases) || value.cases.length !== count) throw new Error("Case metadata must match the export order and count.");
		for (const entry of value.cases) {
			if (!object(entry)) throw new Error("Each case metadata entry must be an object.");
			for (const key of ["name", "command", "revision", "build", "notes"]) text(entry[key], key);
		}
	}
}
export function parseExport(bytes: Buffer, options: ImportOptions = {}): BenchmarkCase[] {
	if (bytes.length > MAX_EXPORT_BYTES) throw new Error("Hyperfine export exceeds 16 MiB.");
	const data = JSON.parse(bytes.toString("utf8"));
	if (!object(data) || !Array.isArray(data.results) || !data.results.length || data.results.length > 128) {
		throw new Error("Expected a Hyperfine JSON export containing 1–128 results.");
	}
	validateOptions(options, data.results.length);
	return data.results.map((entry: unknown, index: number) => {
		if (!object(entry) || typeof entry.command !== "string" || !entry.command.trim() || entry.command.length > 16_384) {
			throw new Error(`Result ${index + 1} has no valid command/name.`);
		}
		const times = samples(entry.times, `Result ${index + 1} times`);
		const stats = statistics(times);
		if (Object.values(stats).some((value) => value !== undefined && !Number.isFinite(value))) {
			throw new Error(`Result ${index + 1} timings exceed the numeric range.`);
		}
		for (const key of ["mean", "median", "min", "max", "stddev"] as const) {
			if (entry[key] === undefined || entry[key] === null && key === "stddev" && times.length === 1) continue;
			const exported = number(entry[key], key);
			if (stats[key] !== undefined && Math.abs(exported - stats[key]) > Math.max(1e-9, stats[key] * 1e-6)) {
				throw new Error(`Result ${index + 1} ${key} disagrees with its samples.`);
			}
		}
		let exitCodes: number[] | undefined;
		if (entry.exit_codes !== undefined) {
			if (!Array.isArray(entry.exit_codes) || entry.exit_codes.length !== times.length ||
				entry.exit_codes.some((code: unknown) => !Number.isSafeInteger(code))) {
				throw new Error(`Result ${index + 1} exit codes must match its samples.`);
			}
			exitCodes = entry.exit_codes;
		}
		let memory: BenchmarkCase["memory"];
		if (entry.memory_usage_byte !== undefined && entry.memory_usage_byte !== null) {
			const rss = samples(entry.memory_usage_byte, "RSS");
			if (rss.length !== times.length) throw new Error("RSS samples must match timing samples.");
			const sorted = rss.sort((a, b) => a - b);
			memory = { median: quantile(sorted, 0.5), peak: sorted.at(-1)! };
		}
		const info = options.cases?.[index] ?? {};
		return {
			...stats, label: info.name || entry.command, exportedCommand: entry.command, info, times, exitCodes,
			status: exitCodes === undefined ? "unverified" : exitCodes.every((code) => code === 0) ? "passed" : "failed",
			user: entry.user === undefined ? undefined : number(entry.user, "user CPU time"),
			system: entry.system === undefined ? undefined : number(entry.system, "system CPU time"), memory,
		};
	});
}
export function relativeChange(candidate: BenchmarkCase, baseline?: BenchmarkCase): number | undefined {
	if (!baseline || candidate.status !== "passed" || baseline.status !== "passed" || baseline.mean <= 0 || candidate.mean <= 0) return undefined;
	const change = (candidate.mean / baseline.mean - 1) * 100;
	return Number.isFinite(change) ? change : undefined;
}
export function repository(cwd: string): Repository {
	const directory = fs.realpathSync(cwd);
	const git = (args: string[]) => {
		try {
			return execFileSync("git", ["-C", directory, ...args], {
				encoding: "utf8", timeout: 2000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "ignore"],
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			}).trim();
		} catch { return undefined; }
	};
	const root = git(["rev-parse", "--show-toplevel"]);
	const common = root ? git(["rev-parse", "--path-format=absolute", "--git-common-dir"]) : undefined;
	const status = root ? git(["status", "--porcelain", "--untracked-files=normal"]) : undefined;
	return {
		key: common ? fs.realpathSync(common) : directory, cwd: directory, root,
		head: root ? git(["rev-parse", "HEAD"]) : undefined, dirty: status === undefined ? undefined : status.length > 0,
	};
}
function readBounded(file: string): Buffer {
	const fd = fs.openSync(file, "r");
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_EXPORT_BYTES) throw new Error("Expected a regular file of at most 16 MiB.");
		const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_EXPORT_BYTES + 1));
		let length = 0;
		while (length < bytes.length) {
			const read = fs.readSync(fd, bytes, length, bytes.length - length, length);
			if (!read) break;
			length += read;
		}
		if (length !== stat.size) throw new Error("Export changed while being read; try again after Hyperfine finishes.");
		return bytes.subarray(0, length);
	} finally { fs.closeSync(fd); }
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export class BenchmarkStore {
	readonly root: string;
	constructor(root: string) { this.root = root; }
	import(file: string, cwd: string, options: ImportOptions = {}): SavedBenchmark {
		const source = path.resolve(cwd, file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file);
		const bytes = readBounded(source);
		const cases = parseExport(bytes, options);
		const importedAt = new Date().toISOString();
		const id = `${importedAt.replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
		const manifest: Manifest = {
			version: 1, id, importedAt, source, sha256: digest(bytes), options, repository: repository(cwd),
			recorder: {
				hostname: os.hostname(), os: `${os.platform()} ${os.release()}`, arch: os.arch(),
				cpu: os.cpus()[0]?.model ?? "Unknown", ram: os.totalmem(),
			},
		};
		fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
		fs.chmodSync(this.root, 0o700);
		const directory = path.join(this.root, id);
		fs.mkdirSync(directory, { mode: 0o700 });
		try {
			fs.writeFileSync(path.join(directory, "hyperfine.json"), bytes, { mode: 0o600, flag: "wx" });
			// Write the manifest last: interrupted imports never appear in history.
			fs.writeFileSync(path.join(directory, "manifest.tmp"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
			fs.renameSync(path.join(directory, "manifest.tmp"), path.join(directory, "manifest.json"));
		} catch (error) {
			fs.rmSync(directory, { recursive: true, force: true });
			throw error;
		}
		return { manifest, cases, directory };
	}
	private manifest(id: string): Manifest {
		if (!ID.test(id)) throw new Error("Invalid benchmark ID.");
		const data = JSON.parse(readBounded(path.join(this.root, id, "manifest.json")).toString("utf8"));
		if (!object(data) || data.version !== 1 || data.id !== id || !object(data.repository) ||
			typeof data.repository.key !== "string" || typeof data.repository.cwd !== "string" ||
			typeof data.importedAt !== "string" || !Number.isFinite(Date.parse(data.importedAt)) ||
			typeof data.source !== "string" || !/^[\da-f]{64}$/.test(data.sha256) ||
			!object(data.recorder) || !object(data.options)) throw new Error("Invalid benchmark manifest.");
		for (const key of ["hostname", "os", "arch", "cpu"]) {
			if (typeof data.recorder[key] !== "string") throw new Error("Invalid recorder metadata.");
		}
		number(data.recorder.ram, "Recorder RAM");
		return data as unknown as Manifest;
	}
	list(key: string, limit = 200): { runs: Manifest[]; skipped: number } {
		if (!fs.existsSync(this.root)) return { runs: [], skipped: 0 };
		const runs: Manifest[] = [];
		let skipped = 0;
		for (const id of fs.readdirSync(this.root).filter((name) => ID.test(name)).sort().reverse()) {
			try {
				const manifest = this.manifest(id);
				if (manifest.repository.key === key) runs.push(manifest);
			} catch { skipped++; }
			if (runs.length >= limit) break;
		}
		return { runs, skipped };
	}
	load(id: string): SavedBenchmark {
		const manifest = this.manifest(id);
		const directory = path.join(this.root, id);
		const bytes = readBounded(path.join(directory, "hyperfine.json"));
		if (digest(bytes) !== manifest.sha256) throw new Error("Saved Hyperfine export changed; its integrity check failed.");
		return { manifest, directory, cases: parseExport(bytes, manifest.options) };
	}
}

export function duration(seconds: number | undefined): string {
	if (seconds === undefined) return "—";
	const [scale, unit] = seconds < 1e-3 ? [1e6, "µs"] : seconds < 1 ? [1e3, "ms"] : [1, "s"];
	return `${(seconds * scale).toFixed(3)} ${unit}`;
}
export function summary(run: SavedBenchmark, baseline = run.manifest.options.baseline): string {
	const reference = baseline === undefined ? undefined : run.cases[baseline - 1];
	const label = (value: string, length: number) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, length);
	return [
		`Saved benchmark ${run.manifest.id}: ${label(run.manifest.options.title || "Hyperfine", 160)}`,
		...run.cases.slice(0, 12).map((entry, index) => {
			const change = index + 1 === baseline ? "baseline" : relativeChange(entry, reference);
			return `${index + 1}. ${label(entry.label, 100)}: ${entry.status}, n=${entry.n}, mean ${duration(entry.mean)}, median ${duration(entry.median)}, SD ${duration(entry.stddev)}` +
				(change === undefined ? "" : typeof change === "string" ? `; ${change}` : `; mean change ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`);
		}),
		run.cases.length > 12 ? `${run.cases.length - 12} more cases in the dashboard.` : "",
		"Changes are descriptive, not significance tests. Unknown measurement conditions remain unrecorded.",
		`Raw results: ${path.join(run.directory, "hyperfine.json")}`,
		`View: /bench view ${run.manifest.id}`,
	].filter(Boolean).join("\n");
}
