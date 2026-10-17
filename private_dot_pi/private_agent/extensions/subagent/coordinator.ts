import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import {
	alive, applySnapshot, baseline, changedSince, git, LeaseStore, owns,
	privateDir, processStamp, readJson, repository, scopePaths, snapshot, writeJson,
} from "./store.ts";

export type Agent = {
	name: string; source: string; systemPrompt: string; tools?: string[]; model?: string;
};
export type TaskInput = { agent: string; task: string; cwd?: string; files?: string[]; worktreeFrom?: number };
export type Parameters = TaskInput & {
	tasks?: TaskInput[]; chain?: TaskInput[]; resume?: string; status?: string;
	agentScope?: "user" | "project" | "both"; confirmProjectAgents?: boolean;
};
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number; turns: number };
type State = "queued" | "running" | "completed" | "failed" | "aborted";
export type Task = TaskInput & {
	id: string; agentConfig: Agent; writer: boolean; status: State; attempts: number;
	model?: string; thinking?: string; cwd?: string; branch?: string; prepared?: boolean;
	baseline?: Record<string, string>; head?: string; childPid?: number; childStarted?: string; messages: any[];
	usage: Usage; exitCode: number; stderr: string; errorMessage?: string; stopReason?: string;
};
export type Job = {
	version: 1; id: string; mode: "single" | "parallel" | "chain";
	cwd: string; repo?: { root: string; common: string; head: string };
	agentScope: string; projectAgentsDir: string | null; created: string; updated: string;
	pid?: number; pidStarted?: string; host?: string; tasks: Task[]; snapshot?: string; snapshotCaptured?: boolean;
};
type Update = (result: any) => void;
type Defaults = { model?: string; thinking?: string };
type Options = {
	root: string;
	invocation: { command: string; args: string[] } | (() => { command: string; args: string[] });
	// Tests can provide an empty Worktrunk config without changing the user's config.
	wtArgs?: string[];
};

const exec = promisify(execFile);
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"];
const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
const failed = (task: Task) => task.status !== "completed";

export function output(task: Task): string {
	for (const message of task.messages.toReversed()) {
		if (message.role === "assistant") {
			const text = message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
			if (text) return text;
		}
	}
	return task.errorMessage || task.stderr || "(no output)";
}

function writer(agent: Agent): boolean {
	return agent.name === "worker" || !agent.tools || agent.tools.some((tool) =>
		["edit", "write", "powershell"].includes(tool) || (tool === "bash" && agent.name !== "reviewer"));
}

function jobId(id: string): string {
	if (!/^[\d]{8}T[\d]{6}-[a-f\d]{8}$/.test(id)) throw new Error(`Invalid subagent job ID: ${id}`);
	return id;
}

function taskResult(task: Task, mode: Job["mode"], index: number) {
	return {
		...task, agentSource: task.agentConfig.source, step: mode === "chain" ? index + 1 : undefined,
		exitCode: task.status === "running" || task.status === "queued" ? -1 : task.exitCode,
	};
}

export class Coordinator {
	options: Options;
	leases: LeaseStore;
	preparation: Promise<void> = Promise.resolve();
	constructor(options: Options) {
		this.options = options;
		privateDir(path.join(options.root, "jobs"));
		this.leases = new LeaseStore(path.join(options.root, "locks"));
	}
	jobDir(id: string) { return path.join(this.options.root, "jobs", jobId(id)); }
	taskDir(job: Job, task: Task) { return path.join(this.jobDir(job.id), `task-${task.id}`); }
	save(job: Job) {
		job.updated = new Date().toISOString();
		writeJson(path.join(this.jobDir(job.id), "job.json"), job);
	}
	load(id: string): Job {
		const job = readJson<Job>(path.join(this.jobDir(id), "job.json"));
		if (job.version !== 1 || job.id !== id) throw new Error("Unsupported or inconsistent subagent job manifest.");
		return job;
	}
	list(cwd: string): Job[] {
		const current = repository(cwd);
		return fs.readdirSync(path.join(this.options.root, "jobs")).flatMap((id) => {
			try {
				const job = this.load(id);
				return (current ? job.repo?.common === current.common : job.cwd === fs.realpathSync(cwd)) ? [job] : [];
			} catch { return []; }
		}).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 20);
	}
	inspect(job: Job): string {
		return [
			`Subagent job ${job.id} (${job.mode})`,
			...job.tasks.map((task) => `${task.id}. ${task.agent}: ${task.status}${task.status === "running" && !this.live(job) ? " (interrupted)" : ""}; attempts=${task.attempts}${task.cwd ? `; cwd=${task.cwd}` : ""}${task.branch ? `; branch=${task.branch}` : ""}`),
			`Artifacts: ${this.jobDir(job.id)}`,
			`Resume unfinished work: /subagents resume ${job.id}`,
		].join("\n");
	}
	live(job: Job): boolean {
		return (!!job.pid && (job.host !== hostname() || alive(job.pid, job.pidStarted))) ||
			job.tasks.some((task) => task.status === "running" && alive(task.childPid, task.childStarted));
	}
	result(job: Job, partial = false) {
		const results = job.tasks.map((task, index) => taskResult(task, job.mode, index));
		let content = `${job.tasks.filter((task) => task.status === "completed").length}/${job.tasks.length} completed; job ${job.id}`;
		if (!partial) {
			for (const task of job.tasks) {
				const text = output(task);
				content += `\n\n### ${task.id}. ${task.agent} — ${task.status}\n${text.slice(0, 24_000)}`;
				if (text.length > 24_000) content += "\n[Full response saved in the task summary.]";
				if (task.errorMessage && task.errorMessage !== text) content += `\nError: ${task.errorMessage}`;
				if (task.cwd) content += `\nDirectory: ${task.cwd}`;
				content += `\nSummary: ${path.join(this.taskDir(job, task), "summary.md")}`;
			}
			content += `\n\nManifest: ${path.join(this.jobDir(job.id), "job.json")}`;
		}
		return {
			content: [{ type: "text", text: content }], isError: !partial && job.tasks.some(failed),
			details: { mode: job.mode, agentScope: job.agentScope, projectAgentsDir: job.projectAgentsDir, results, jobId: job.id },
		};
	}
	create(cwd: string, params: Parameters, agents: Agent[], defaults: Defaults, projectAgentsDir: string | null): Job {
		const modes = [!!(params.agent && params.task), !!params.tasks?.length, !!params.chain?.length].filter(Boolean).length;
		if (modes !== 1) throw new Error("Provide exactly one mode: agent + task, tasks, chain, resume, or status.");
		const mode = params.chain?.length ? "chain" : params.tasks?.length ? "parallel" : "single";
		const inputs = params.chain ?? params.tasks ?? [params];
		if (inputs.length > 8) throw new Error("A job supports at most 8 tasks, with 4 running concurrently.");
		const tasks = inputs.map((input, index): Task => {
			const agent = agents.find((candidate) => candidate.name === input.agent);
			if (!agent) throw new Error(`Unknown agent: ${input.agent}. Available: ${agents.map((item) => item.name).join(", ")}`);
			if (!input.task?.trim()) throw new Error("Each subagent needs a non-empty task.");
			const tools = (agent.tools ?? BUILTINS.filter((tool) => tool !== "powershell")).filter((tool) => BUILTINS.includes(tool));
			if (!tools.length || tools.length !== (agent.tools ?? tools).length) {
				throw new Error(`Agent ${agent.name} must specify built-in tools only; MCP and coordination remain in the parent.`);
			}
			const writing = writer(agent);
			if (input.worktreeFrom !== undefined &&
				(mode !== "chain" || input.cwd || input.worktreeFrom < 1 || input.worktreeFrom > index)) {
				throw new Error("worktreeFrom must refer to an earlier chain step and cannot be combined with cwd.");
			}
			return {
				agent: input.agent, task: input.task, cwd: input.cwd,
				worktreeFrom: input.worktreeFrom, files: writing ? scopePaths(input.files) : undefined,
				id: String(index + 1), agentConfig: { ...agent, tools }, writer: writing,
				status: "queued", attempts: 0, model: agent.model ?? defaults.model,
				thinking: agent.model ? undefined : defaults.thinking, messages: [],
				usage: emptyUsage(), exitCode: -1, stderr: "",
			};
		});
		const root = fs.realpathSync(cwd);
		const repo = repository(root);
		if (tasks.some((task) => task.writer) && !repo) throw new Error("Worker delegation requires a Git repository.");
		const job: Job = {
			version: 1, id: `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`,
			mode, cwd: root, repo, tasks, created: new Date().toISOString(), updated: new Date().toISOString(),
			agentScope: params.agentScope ?? "user", projectAgentsDir,
		};
		// Reject unsafe explicitly assigned directories before starting any child.
		for (const task of tasks) {
			if (task.cwd) {
				if (!path.isAbsolute(task.cwd)) throw new Error("Task cwd must be an absolute path.");
				task.cwd = fs.realpathSync(task.cwd);
				this.validateDirectory(job, task);
			}
		}
		if (mode === "parallel") {
			for (const task of tasks.filter((item) => item.writer && item.cwd)) {
				if (tasks.some((other) => other !== task && other.cwd === task.cwd)) {
					throw new Error(`Parallel tasks cannot share a writer's worktree: ${task.cwd}`);
				}
			}
		}
		this.save(job);
		return job;
	}
	validateDirectory(job: Job, task: Task) {
		if (!task.writer) return;
		const target = repository(task.cwd!);
		if (!target || target.root !== task.cwd || target.common !== job.repo?.common ||
			target.root === job.repo.root) throw new Error("Workers require a distinct worktree of the same repository.");
		const registered = git(job.repo.root, ["worktree", "list", "--porcelain", "-z"])
			.split("\0").filter((line) => line.startsWith("worktree ")).map((line) => fs.realpathSync(line.slice(9)));
		if (!registered.includes(task.cwd!)) throw new Error("Worker directory is not a registered Git worktree.");
	}
	async prepare(job: Job, task: Task, signal?: AbortSignal) {
		signal?.throwIfAborted();
		if (task.worktreeFrom) {
			const previous = job.tasks[task.worktreeFrom - 1];
			if (!previous.prepared || !previous.cwd) throw new Error("The referenced worktree is not ready.");
			task.cwd = previous.cwd;
		}
		if (task.writer && (!task.cwd || (task.branch && !task.prepared))) {
			let done!: () => void;
			const preceding = this.preparation;
			this.preparation = new Promise((resolve) => { done = resolve; });
			await preceding;
			try {
				signal?.throwIfAborted();
				if (!task.cwd) {
					task.branch = `pi-${job.id.toLowerCase()}-${task.id}`;
					// A cancelled wt call can leave its branch/worktree behind; reuse that assignment.
					const exists = git(job.repo!.root, ["branch", "--list", task.branch]).trim().length > 0;
					const { stdout } = await exec("wt", [
						...(this.options.wtArgs ?? []), "-C", job.repo!.root,
						"switch", ...(exists ? [] : ["--create"]), task.branch,
						...(exists ? [] : [`--base=${job.repo!.head}`]), "--no-cd", "--no-hooks", "--format=json",
					], { signal, timeout: 120_000, maxBuffer: 1024 * 1024 });
					task.cwd = fs.realpathSync(JSON.parse(stdout).path);
					this.save(job);
				}
				const actual = baseline(task.cwd!);
				const expected = readJson<Record<string, string>>(path.join(job.snapshot!, "state.json"));
				if (Object.keys(actual).length === 0) applySnapshot(task.cwd!, job.snapshot!);
				else if ([...new Set([...Object.keys(actual), ...Object.keys(expected)])].some((file) => actual[file] !== expected[file])) {
					throw new Error("Worktree setup was interrupted with unexpected changes. Inspect its retained directory before retrying.");
				}
			} finally { done(); }
		}
		task.cwd ??= job.cwd;
		this.validateDirectory(job, task);
		task.prepared = true;
		privateDir(this.taskDir(job, task));
		this.save(job);
	}
	async execute(job: Job, onUpdate?: Update, signal?: AbortSignal): Promise<any> {
		if (this.live(job)) throw new Error(`Subagent job ${job.id} still has a live coordinator or child.`);
		const lock = path.join(this.jobDir(job.id), "run.lock");
		const started = processStamp(process.pid);
		try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started, host: hostname() }), { flag: "wx", mode: 0o600 }); }
		catch (error: any) {
			if (error.code !== "EEXIST") throw error;
			const owner = readJson<{ pid: number; started?: string; host: string }>(lock);
			if (owner.host !== hostname() || alive(owner.pid, owner.started)) throw new Error(`Job ${job.id} is already running.`);
			fs.rmSync(lock);
			return this.execute(job, onUpdate, signal);
		}
		try {
			job.pid = process.pid; job.pidStarted = started; job.host = hostname();
			for (const task of job.tasks) {
				if (task.status === "running") task.status = "aborted";
				if (task.status !== "completed") task.status = "queued";
			}
			this.save(job);
			if (job.tasks.some((task) => task.writer && !task.cwd && !task.worktreeFrom)) {
				if (!job.snapshotCaptured) {
					job.snapshot = path.join(this.jobDir(job.id), `baseline-${randomUUID().slice(0, 8)}`);
					snapshot(job.repo!.root, job.snapshot);
					if (repository(job.repo!.root)?.head !== job.repo!.head) throw new Error("Source HEAD changed before worktree creation.");
					job.snapshotCaptured = true; this.save(job);
				}
			}
			const run = async (task: Task, index: number) => {
				if (task.status === "completed") return;
				if (signal?.aborted) { task.status = "aborted"; task.exitCode = 1; this.save(job); return; }
				let release: (() => Promise<void>) | undefined;
				try {
					await this.prepare(job, task, signal);
					release = await this.leases.acquire(task.cwd!, job.id, task.id, task.writer ? "write" : "read");
					if (task.attempts === 0) {
						task.baseline = job.repo ? baseline(task.cwd!) : {};
						task.head = repository(task.cwd!)?.head;
						this.save(job);
					}
					if (job.mode === "chain" && index > 0) {
						const preceding = job.tasks[index - 1];
						fs.writeFileSync(path.join(this.taskDir(job, task), "previous.md"), output(preceding), { mode: 0o600 });
					}
					await this.child(job, task, onUpdate, signal);
					if (task.writer) {
						const outside = changedSince(task.cwd!, task.baseline!).filter((file) => !owns(task.files!, file));
						if (outside.length) throw new Error(`Changes outside assigned ownership: ${outside.join(", ")}. Inspect the retained worktree; changes were preserved.`);
						if (repository(task.cwd!)?.head !== task.head) throw new Error("Worker changed HEAD. Integration and commits belong to the parent; inspect the retained worktree.");
					}
				} catch (error: any) {
					task.status = signal?.aborted ? "aborted" : "failed"; task.exitCode = 1;
					task.errorMessage = error.message ?? String(error);
				} finally {
					if (release) await release();
					delete task.childPid;
					delete task.childStarted;
					privateDir(this.taskDir(job, task));
					writeJson(path.join(this.taskDir(job, task), "result.json"), task);
					fs.writeFileSync(path.join(this.taskDir(job, task), "summary.md"),
						`${output(task)}${task.errorMessage ? `\n\nError: ${task.errorMessage}` : ""}\n`, { mode: 0o600 });
					this.save(job); onUpdate?.(this.result(job, true));
				}
			};
			if (job.mode === "parallel") {
				let next = 0;
				await Promise.all(Array.from({ length: Math.min(4, job.tasks.length) }, async () => {
					while (next < job.tasks.length) { const index = next++; await run(job.tasks[index], index); }
				}));
			} else {
				for (const [index, task] of job.tasks.entries()) {
					await run(task, index);
					if (task.status !== "completed") break;
				}
			}
			return this.result(job);
		} catch (error: any) {
			for (const task of job.tasks.filter((task) => task.status === "queued")) {
				task.status = signal?.aborted ? "aborted" : "failed"; task.exitCode = 1; task.errorMessage = error.message;
			}
			return this.result(job);
		} finally {
			delete job.pid; delete job.pidStarted; delete job.host;
			this.save(job);
			fs.rmSync(lock, { force: true });
		}
	}
	async child(job: Job, task: Task, onUpdate?: Update, signal?: AbortSignal): Promise<void> {
		const dir = this.taskDir(job, task);
		task.attempts++; task.status = "running"; task.stderr = ""; delete task.errorMessage; delete task.stopReason;
		writeJson(path.join(dir, "context.json"), {
			cwd: task.cwd, files: task.files ?? [], writer: task.writer,
			parentPid: process.pid, parentStarted: job.pidStarted, taskId: task.id, jobId: job.id,
		});
		const instructions = [
			task.agentConfig.systemPrompt, `Assigned directory: ${task.cwd}`,
			task.writer ? `Owned paths: ${task.files!.join(", ")}. Preserve other files and Git HEAD.` : "",
			"Return a concise result with checks and limitations. The coordinator saves your response and session.",
		].filter(Boolean).join("\n\n");
		fs.writeFileSync(path.join(dir, "instructions.md"), instructions, { mode: 0o600 });
		const session = path.join(dir, "session.jsonl");
		if (!fs.existsSync(session)) fs.writeFileSync(session, "", { mode: 0o600 });
		const args = ["--mode", "json", "-p", "--session", session, "--tools", task.agentConfig.tools!.join(","),
			"--append-system-prompt", path.join(dir, "instructions.md")];
		if (task.model) args.push("--model", task.model);
		if (task.thinking) args.push("--thinking", task.thinking);
		const preceding = path.join(dir, "previous.md");
		const taskText = task.task.replaceAll("{previous}", fs.existsSync(preceding) ? `Read prior findings from ${preceding}` : "");
		args.push(task.attempts > 1 ?
			`Continue the interrupted or failed task. Inspect the current files and prior session before repeating work.\nTask: ${taskText}` :
			`Task: ${taskText}`);
		const stdout = fs.openSync(path.join(dir, `attempt-${task.attempts}.jsonl`), "a", 0o600);
		const stderr = fs.openSync(path.join(dir, `attempt-${task.attempts}.stderr.log`), "a", 0o600);
		try {
			await new Promise<void>((resolve, reject) => {
				const invocation = typeof this.options.invocation === "function" ? this.options.invocation() : this.options.invocation;
				const proc = spawn(invocation.command, [...invocation.args, ...args], {
					cwd: task.cwd, shell: false, detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, PI_SUBAGENT_CONTEXT: path.join(dir, "context.json") },
				});
				task.childPid = proc.pid; task.childStarted = proc.pid ? processStamp(proc.pid) : undefined; this.save(job);
				let buffer = "";
				const decoder = new StringDecoder("utf8");
				let closed = false;
				let killTimer: NodeJS.Timeout | undefined;
				const kill = (signal: NodeJS.Signals) => {
					try {
						if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
						else proc.kill(signal);
					} catch (error: any) { if (error.code !== "ESRCH") throw error; }
				};
				const abort = () => {
					kill("SIGTERM");
					killTimer ??= setTimeout(() => { if (!closed) kill("SIGKILL"); }, 1500);
					killTimer.unref();
				};
				const onExit = () => kill("SIGTERM");
				process.on("exit", onExit);
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				const line = (text: string) => {
					try {
						const event = JSON.parse(text);
						if (event.type !== "message_end" || !event.message) return;
						const message = event.message;
						task.messages.push(message);
						if (message.role === "assistant") {
							task.usage.turns++;
							for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
								task.usage[key] += message.usage?.[key] ?? 0;
							}
							task.usage.cost += message.usage?.cost?.total ?? 0;
							task.usage.contextTokens = message.usage?.totalTokens ?? 0;
							task.stopReason = message.stopReason;
							task.errorMessage = message.errorMessage;
						}
						this.save(job); onUpdate?.(this.result(job, true));
					} catch (error) {
						if (!(error instanceof SyntaxError)) {
							task.errorMessage = `Unable to retain child progress: ${error}`;
							abort();
						}
					}
				};
				proc.stdout.on("data", (chunk: Buffer) => {
					fs.writeSync(stdout, chunk);
					buffer += decoder.write(chunk);
					const lines = buffer.split("\n"); buffer = lines.pop()!;
					for (const text of lines) line(text);
				});
				proc.stderr.on("data", (chunk: Buffer) => {
					fs.writeSync(stderr, chunk); task.stderr = `${task.stderr}${chunk.toString()}`.slice(-32_000);
				});
				proc.on("error", (error) => { task.errorMessage = error.message; });
				proc.on("close", (code) => {
					closed = true;
					if (killTimer) clearTimeout(killTimer);
					signal?.removeEventListener("abort", abort); process.off("exit", onExit);
					buffer += decoder.end();
					if (buffer.trim()) line(buffer);
					task.exitCode = code ?? 1;
					task.status = signal?.aborted ? "aborted" :
						task.exitCode !== 0 || task.errorMessage || ["error", "aborted"].includes(task.stopReason ?? "") ?
							"failed" : "completed";
					if (!task.messages.some((message) => message.role === "assistant") && task.status === "completed") {
						task.status = "failed"; task.exitCode = 1; task.errorMessage = "Child exited without an assistant response.";
					}
					if (task.status !== "completed" && task.exitCode === 0) task.exitCode = 1;
					this.save(job);
					resolve();
				});
			});
		} finally { fs.closeSync(stdout); fs.closeSync(stderr); }
	}
}
