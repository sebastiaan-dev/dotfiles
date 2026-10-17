import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import upstream from "./upstream.ts";
import { discoverAgents } from "./agents.ts";
import { Coordinator, type Parameters } from "./coordinator.ts";
import { alive, readJson, repository, writeAllowed } from "./store.ts";

const Item = {
	agent: Type.String({ description: "Agent name: scout, planner, reviewer, or worker." }),
	task: Type.String({ description: "Self-contained task; chains may reference prior findings with {previous}." }),
	cwd: Type.Optional(Type.String({ description: "Absolute directory. Writers require a distinct registered worktree; omit to create one with wt." })),
	files: Type.Optional(Type.Array(Type.String(), {
		description: "Required for workers: repository-relative owned files, or directories ending in '/', e.g. ['src/', 'tests/'].",
	})),
	worktreeFrom: Type.Optional(Type.Integer({ minimum: 1, description: "Reuse an earlier chain step's directory; numbered from 1. Cannot combine with cwd." })),
};
const ParametersSchema = Type.Object({
	...Object.fromEntries(Object.entries(Item).map(([key, value]) => [key, Type.Optional(value)])),
	tasks: Type.Optional(Type.Array(Type.Object(Item))),
	chain: Type.Optional(Type.Array(Type.Object(Item))),
	resume: Type.Optional(Type.String({ description: "Resume unfinished tasks in this saved job; completed tasks are retained." })),
	status: Type.Optional(Type.String({ description: "Inspect a saved job without running tasks." })),
	agentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])),
	confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
});

function invocation() {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script] };
	}
	return /^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath)) ?
		{ command: "pi", args: [] } : { command: process.execPath, args: [] };
}

function childGuard(pi: ExtensionAPI, contextFile: string): void {
	let context: { cwd: string; writer: boolean; files: string[]; parentPid: number; parentStarted?: string } | undefined;
	try { context = readJson(contextFile); } catch { /* All tool calls remain blocked below. */ }
	pi.on("tool_call", async (event, ctx) => {
		try {
			if (!context || fs.realpathSync(ctx.cwd) !== context.cwd || !alive(context.parentPid, context.parentStarted)) {
				return { block: true, reason: "The subagent assignment is invalid or its coordinator has exited." };
			}
			if (["subagent", "tool_search", "codemode"].includes(event.toolName)) {
				return { block: true, reason: "Delegation and MCP access belong to the parent session." };
			}
			if (event.toolName === "write" || event.toolName === "edit") {
				const input = event.input as Record<string, unknown>;
				const file = input.path ?? input.file_path;
				if (!context.writer || typeof file !== "string" || !writeAllowed(context.cwd, context.files, file)) {
					return { block: true, reason: `Write outside the assigned worktree or file ownership: ${String(file)}` };
				}
			}
		} catch (error) { return { block: true, reason: `Cannot verify the subagent assignment: ${error}` }; }
	});
	// If the parent is killed, stop orphaned children before a later session resumes their tasks.
	const watchdog = setInterval(() => {
		if (!context || !alive(context.parentPid, context.parentStarted)) {
			try {
				process.kill(process.platform === "win32" ? process.pid : -process.pid, "SIGTERM");
			} catch { process.kill(process.pid, "SIGTERM"); }
		}
	}, 1000);
	watchdog.unref();
	pi.on("session_shutdown", async () => { clearInterval(watchdog); });
}

export default function (pi: ExtensionAPI) {
	const contextFile = process.env.PI_SUBAGENT_CONTEXT;
	if (contextFile) { childGuard(pi, contextFile); return; }
	let coordinator: Coordinator | undefined;
	const getCoordinator = () => coordinator ??= new Coordinator({
		root: path.join(getAgentDir(), "subagents"), invocation,
	});
	upstream(new Proxy(pi, {
		get(target, property) {
			if (property !== "registerTool") return Reflect.get(target, property);
			return (definition: any) => {
				pi.registerTool({
					...definition,
					description: [
						"Delegate single, parallel, or chained tasks with durable sessions, logs, and results.",
						"Workers require files ownership; omit cwd to create a wt worktree carrying the current working contents.",
						"Use worktreeFrom for a subsequent chain reviewer/worker to reuse an earlier step's worktree.",
						"Use resume to continue unfinished tasks, or status to inspect a saved job. No automatic integration or cleanup.",
					].join(" "),
					parameters: ParametersSchema,
					async execute(_id: string, params: Parameters, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
						try {
							const engine = getCoordinator();
							if (params.resume || params.status) {
								if ([params.agent, params.task, params.tasks, params.chain].some(Boolean) || (params.resume && params.status)) {
									throw new Error("Use resume or status alone, without a new task.");
								}
								const job = engine.load(params.resume ?? params.status!);
								if (params.status) return {
									content: [{ type: "text", text: engine.inspect(job) }],
									details: { mode: job.mode, results: [], jobId: job.id },
								};
								const current = repository(ctx.cwd);
								if (job.repo ? current?.common !== job.repo.common : fs.realpathSync(ctx.cwd) !== job.cwd) {
									throw new Error("Resume this job from its source repository.");
								}
								return await engine.execute(job, onUpdate, signal);
							}
							const scope = params.agentScope ?? "user";
							const discovery = discoverAgents(ctx.cwd, scope);
							const inputs = params.chain ?? params.tasks ?? [params];
							const projectNames = inputs.filter((input) =>
								discovery.agents.find((agent) => agent.name === input.agent)?.source === "project")
								.map((input) => input.agent);
							if (projectNames.length && params.confirmProjectAgents !== false && !ctx.isProjectTrusted()) {
								if (!ctx.hasUI || !await ctx.ui.confirm("Run project-local agents?",
									`Agents: ${[...new Set(projectNames)].join(", ")}\nSource: ${discovery.projectAgentsDir}`)) {
									throw new Error("Project-local agents require an explicit trust decision.");
								}
							}
							const job = engine.create(ctx.cwd, params, discovery.agents, {
								model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
								thinking: ctx.thinkingLevel,
							}, discovery.projectAgentsDir);
							return await engine.execute(job, onUpdate, signal);
						} catch (error: any) {
							return {
								content: [{ type: "text", text: error.message ?? String(error) }], isError: true,
								details: { mode: "single", results: [] },
							};
						}
					},
					renderCall(params: Parameters, theme: any, context: any) {
						if (params.resume || params.status) return new Text(
							theme.fg("accent", `${params.resume ? "Resume" : "Inspect"} subagent job ${params.resume ?? params.status}`), 0, 0);
						return definition.renderCall(params, theme, context);
					},
				});
			};
		},
	}));
	pi.registerCommand("subagents", {
		description: "List jobs, inspect <job-id>, or resume <job-id> (also accepts latest).",
		handler: async (args, ctx) => {
			try {
				const engine = getCoordinator();
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const jobs = engine.list(ctx.cwd);
				if (!parts.length) {
					pi.sendMessage({
						customType: "subagent-status", display: true,
						content: jobs.length ? jobs.slice(0, 10).map((job) => engine.inspect(job)).join("\n\n") : "No subagent jobs for this repository.",
					});
					return;
				}
				const resume = parts[0] === "resume";
				if (parts.length !== (resume ? 2 : 1)) throw new Error("Usage: /subagents [job-id | latest | resume job-id | resume latest]");
				const requested = parts[resume ? 1 : 0];
				const id = requested === "latest" ? jobs[0]?.id : requested;
				if (!id) throw new Error("No subagent jobs for this repository.");
				const job = engine.load(id);
				if (resume) {
					await ctx.waitForIdle();
					pi.sendUserMessage(`Resume saved subagent job ${job.id} using the subagent tool with {"resume":"${job.id}"}. Inspect the results and report the outcome.`);
				} else pi.sendMessage({ customType: "subagent-status", display: true, content: engine.inspect(job) });
			} catch (error: any) { ctx.ui.notify(error.message ?? String(error), "error"); }
		},
	});
}
