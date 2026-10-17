import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";

export function privateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
}

export function writeJson(file: string, value: unknown): void {
	privateDir(path.dirname(file));
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

export function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function processStamp(pid: number): string | undefined {
	try {
		return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
		}).trim() || undefined;
	} catch { return undefined; }
}

export function alive(pid?: number, started?: string): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		const current = started ? processStamp(pid) : undefined;
		// A restricted host can prohibit ps; retain its live PID lease rather than stealing it.
		return !started || !current || current === started;
	}
	catch (error: any) { return error.code !== "ESRCH"; }
}

export function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

export function repository(cwd: string): { root: string; common: string; head: string } | undefined {
	try {
		return {
			root: fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim()),
			common: fs.realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()),
			head: git(cwd, ["rev-parse", "HEAD"]).trim(),
		};
	} catch { return undefined; }
}

export function inside(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function scopePaths(files?: string[]): string[] {
	if (!files?.length) throw new Error("Workers require files: repository-relative files or directory prefixes ending in '/'.");
	return files.map((file) => {
		if (!file || file.includes("\\") || path.posix.isAbsolute(file) ||
			file.split("/").some((part) => part === ".." || part === ".git") ||
			path.posix.normalize(file) === "." || file.startsWith("./")) {
			throw new Error(`Invalid file ownership: ${file}`);
		}
		return path.posix.normalize(file);
	});
}

export function owns(files: string[], relative: string): boolean {
	return files.some((file) => file.endsWith("/") ? relative.startsWith(file) : relative === file);
}

/** Resolve existing ancestors too: an in-tree symlink must not redirect an edit outside the tree. */
export function resolvedTarget(file: string): string {
	let ancestor = file;
	const suffix: string[] = [];
	while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		suffix.unshift(path.basename(ancestor));
		ancestor = parent;
	}
	return path.join(fs.realpathSync(ancestor), ...suffix);
}

export function writeAllowed(cwd: string, files: string[], file: string): boolean {
	const lexical = path.resolve(cwd, file);
	try {
		if (!inside(cwd, lexical) || !inside(cwd, resolvedTarget(lexical))) return false;
	} catch { return false; }
	return owns(files, path.relative(cwd, lexical).split(path.sep).join("/"));
}

function changedFiles(cwd: string): string[] {
	return [...new Set([
		...git(cwd, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "HEAD"]).split("\0"),
		...git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
	].filter(Boolean))];
}

export function fileState(file: string): string {
	if (!fs.existsSync(file) && !fs.lstatSync(path.dirname(file), { throwIfNoEntry: false })) return "missing";
	const stat = fs.lstatSync(file, { throwIfNoEntry: false });
	if (!stat) return "missing";
	if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(file)}`;
	if (!stat.isFile()) throw new Error(`Unsupported changed file: ${file}`);
	return `${stat.mode & 0o777}:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

export function baseline(cwd: string): Record<string, string> {
	return Object.fromEntries(changedFiles(cwd).map((file) => [file, fileState(path.join(cwd, file))]));
}

export function changedSince(cwd: string, before: Record<string, string>): string[] {
	const current = new Set(changedFiles(cwd));
	return [...new Set([...current, ...Object.keys(before)])].filter((file) =>
		file in before ? fileState(path.join(cwd, file)) !== before[file] : current.has(file));
}

export function snapshot(source: string, dir: string): void {
	privateDir(dir);
	const patch = git(source, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD"]);
	fs.writeFileSync(path.join(dir, "baseline.patch"), patch, { mode: 0o600 });
	const files = git(source, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
	const states: Record<string, string> = {};
	for (const file of files) {
		const src = path.join(source, file);
		const dst = path.join(dir, "untracked", file);
		privateDir(path.dirname(dst));
		const stat = fs.lstatSync(src);
		if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
		else if (stat.isFile()) fs.copyFileSync(src, dst);
		else throw new Error(`Cannot carry this untracked file into a worktree: ${file}`);
		states[file] = fileState(src);
	}
	writeJson(path.join(dir, "untracked.json"), states);
	writeJson(path.join(dir, "state.json"), baseline(source));
	if (patch !== git(source, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD"]) ||
		files.some((file) => fileState(path.join(source, file)) !== states[file])) {
		throw new Error("The source changed while its baseline was captured. Retry delegation.");
	}
}

export function applySnapshot(cwd: string, dir: string): void {
	const patch = fs.readFileSync(path.join(dir, "baseline.patch"), "utf8");
	if (patch) git(cwd, ["apply", "--binary", "--whitespace=nowarn", "-"], patch);
	for (const file of Object.keys(readJson<Record<string, string>>(path.join(dir, "untracked.json")))) {
		const src = path.join(dir, "untracked", file);
		const dst = path.join(cwd, file);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		if (fs.lstatSync(src).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
		else {
			fs.copyFileSync(src, dst);
			fs.chmodSync(dst, fs.statSync(src).mode & 0o777);
		}
	}
}

type Owner = { pid: number; started?: string; host: string; job: string; task: string; mode: "read" | "write" };

/** A short atomic gate protects the shared-reader/exclusive-writer lease records. */
export class LeaseStore {
	root: string;
	constructor(root: string) { this.root = root; privateDir(root); }

	async acquire(cwd: string, job: string, task: string, mode: Owner["mode"]): Promise<() => Promise<void>> {
		const key = createHash("sha256").update(cwd).digest("hex");
		const owner: Owner = { pid: process.pid, started: processStamp(process.pid), host: hostname(), job, task, mode };
		const mutate = async (update: (records: Owner[]) => Owner[]) => {
			const gate = path.join(this.root, `${key}.gate`);
			for (let attempt = 0; ; attempt++) {
				try {
					fs.mkdirSync(gate, { mode: 0o700 });
					writeJson(path.join(gate, "owner.json"), { pid: process.pid, started: owner.started, host: hostname() });
					break;
				} catch (error: any) {
					if (error.code !== "EEXIST") throw error;
					try {
						const previous = readJson<Owner>(path.join(gate, "owner.json"));
						if (previous.host === hostname() && !alive(previous.pid, previous.started)) {
							fs.rmSync(gate, { recursive: true, force: true });
							continue;
						}
					} catch {
						// Another process may be writing the owner record; wait instead of stealing it.
						const stat = fs.statSync(gate, { throwIfNoEntry: false });
						if (stat && Date.now() - stat.mtimeMs > 30_000) fs.rmSync(gate, { recursive: true, force: true });
					}
					if (attempt >= 100) throw new Error(`Worktree coordination is busy: ${cwd}`);
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			}
			try {
				const file = path.join(this.root, `${key}.json`);
				const records = fs.existsSync(file) ? readJson<Owner[]>(file) : [];
				const active = records.filter((record) => {
					if (record.host !== hostname() || alive(record.pid, record.started)) return true;
					try {
						const job = readJson<any>(path.join(path.dirname(this.root), "jobs", record.job, "job.json"));
						const child = job.tasks.find((item: any) => item.id === record.task);
						return alive(child?.childPid, child?.childStarted);
					} catch { return false; }
				});
				writeJson(file, update(active));
			} finally { fs.rmSync(gate, { recursive: true, force: true }); }
		};
		await mutate((records) => {
			if (records.some((record) => mode === "write" || record.mode === "write")) {
				throw new Error(`Worktree is already in use by a subagent: ${cwd}`);
			}
			return [...records, owner];
		});
		return () => mutate((records) => records.filter((record) =>
			record.job !== job || record.task !== task || record.pid !== process.pid));
	}
}
