import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { Coordinator, output, type Agent, type Parameters } from "../private_dot_pi/private_agent/extensions/subagent/coordinator.ts";
import { LeaseStore, writeAllowed, readJson, writeJson, processStamp } from "../private_dot_pi/private_agent/extensions/subagent/store.ts";

const fixturePi = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
const agents: Agent[] = [
	{name: "scout", source: "user", tools: ["read", "grep", "find", "ls"], systemPrompt: "Investigate."},
	{name: "reviewer", source: "user", tools: ["read", "bash", "grep"], systemPrompt: "Review."},
	{name: "worker", source: "user", tools: ["read", "bash", "write", "edit"], systemPrompt: "Implement."},
];
const defaults = {model: "amazon-bedrock/global.openai.gpt-6-astra", thinking: "off"};
const task = (directive: object) => JSON.stringify(directive);

function fixture(t: any) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "pi-coordinator-")));
	t.after(() => fs.rmSync(base, {recursive: true, force: true}));
	const repo = path.join(base, "repo");
	fs.mkdirSync(repo);
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], {encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]});
	git("init", "-b", "main"); git("config", "user.name", "Pi validation");
	git("config", "user.email", "pi-validation@example.invalid");
	fs.writeFileSync(path.join(repo, "source.txt"), "baseline\n");
	git("add", "source.txt"); git("-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", "Fixture");
	const config = path.join(base, "wt.toml");
	fs.writeFileSync(config, `worktree-path = ${JSON.stringify(path.join(base, "trees/{{ branch }}"))}\n`);
	const options = {root: path.join(base, "agent/subagents"), wtArgs: ["--config", config],
		invocation: {command: process.execPath, args: [fixturePi]}};
	const engine = new Coordinator(options);
	const create = (params: Parameters) => engine.create(repo, params, agents, defaults, null);
	const worktree = (branch: string) => JSON.parse(execFileSync("wt", [
		"--config", config, "-C", repo, "switch", "--create", branch, "--base=@", "--no-cd", "--no-hooks", "--format=json",
	], {encoding: "utf8"})).path as string;
	return {base, repo, git, config, options, engine, create, worktree};
}

async function waitFor(predicate: () => boolean) {
	const end = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("Fixture child did not reach the expected state.");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("parallel workers get distinct wt worktrees carrying staged, unstaged, and untracked contents", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(path.join(f.repo, "source.txt"), "staged\n"); f.git("add", "source.txt");
	fs.writeFileSync(path.join(f.repo, "source.txt"), "current working contents\n");
	fs.writeFileSync(path.join(f.repo, "input-new.txt"), "untracked input\n", {mode: 0o755});
	const originalIndex = f.git("diff", "--cached");
	const job = f.create({tasks: [1, 2].map((n) => ({
		agent: "worker", files: ["result.txt"],
		task: task({file: "result.txt", content: `worker ${n}`, read: "source.txt", extra: "input-new.txt"}),
	}))} as Parameters);
	let updates = 0;
	const result = await f.engine.execute(job, () => { updates++; });
	assert.equal(result.isError, false, result.content[0].text);
	assert.notEqual(job.tasks[0].cwd, job.tasks[1].cwd);
	for (const child of job.tasks) {
		assert.notEqual(child.cwd, f.repo);
		const report = JSON.parse(output(child));
		assert.equal(report.read, "current working contents\n");
		assert.equal(report.extra, "untracked input\n");
		assert.equal(fs.statSync(path.join(child.cwd!, "input-new.txt")).mode & 0o777, 0o755);
		assert(report.args.includes("--session")); assert(!report.args.includes("--no-session"));
		assert.equal(child.model, defaults.model);
		assert.equal(report.args[report.args.indexOf("--thinking") + 1], "off");
		for (const artifact of ["session.jsonl", "summary.md", "result.json", "attempt-1.jsonl", "attempt-1.stderr.log"]) {
			assert.equal(fs.statSync(path.join(f.engine.taskDir(job, child), artifact)).mode & 0o777, 0o600);
		}
	}
	assert(updates > 0);
	assert.equal(fs.readFileSync(path.join(f.repo, "source.txt"), "utf8"), "current working contents\n");
	assert.equal(f.git("diff", "--cached"), originalIndex);
	assert(!fs.existsSync(path.join(f.repo, "result.txt")));
});

test("rejects missing ownership, the parent's worktree, other repos, and concurrent shared writer directories", (t) => {
	const f = fixture(t);
	assert.throws(() => f.create({agent: "worker", task: task({})} as Parameters), /require files/);
	assert.throws(() => f.create({agent: "worker", task: task({}), files: ["../"], cwd: f.repo} as Parameters), /ownership/);
	assert.throws(() => f.create({agent: "worker", task: task({}), files: ["source.txt"], cwd: f.repo} as Parameters), /distinct worktree/);
	const other = path.join(f.base, "other"); fs.mkdirSync(other);
	assert.throws(() => f.create({agent: "worker", task: task({}), files: ["source.txt"], cwd: other} as Parameters), /distinct worktree/);
	const cwd = f.worktree("shared");
	assert.throws(() => f.create({tasks: [
		{agent: "worker", task: task({}), files: ["source.txt"], cwd},
		{agent: "reviewer", task: task({}), cwd},
	]} as Parameters), /cannot share/);
	assert.throws(() => f.create({chain: [{agent: "worker", task: task({}), files: ["source.txt"], worktreeFrom: 1}]} as Parameters), /earlier chain/);
});

test("leases allow parallel readers and exclude writers across coordinator instances", async (t) => {
	const f = fixture(t);
	const one = new LeaseStore(path.join(f.options.root, "locks"));
	const two = new LeaseStore(path.join(f.options.root, "locks"));
	const readOne = await one.acquire(f.repo, "reader-one", "1", "read");
	const readTwo = await two.acquire(f.repo, "reader-two", "1", "read");
	await assert.rejects(two.acquire(f.repo, "writer", "1", "write"), /already in use/);
	await readOne(); await readTwo();
	const write = await one.acquire(f.repo, "writer", "1", "write");
	await assert.rejects(two.acquire(f.repo, "reader-three", "1", "read"), /already in use/);
	await assert.rejects(two.acquire(f.repo, "writer-two", "1", "write"), /already in use/);
	await write();
});

test("resumes only failed and queued chain tasks in their original sessions and worktrees", async (t) => {
	const f = fixture(t);
	const job = f.create({chain: [
		{agent: "scout", task: task({read: "source.txt"})},
		{agent: "worker", files: ["result.txt"], task: task({file: "result.txt", failFirst: true, previous: "{previous}"})},
		{agent: "reviewer", worktreeFrom: 2, task: task({read: "result.txt", previous: "{previous}"})},
	]} as Parameters);
	const first = await f.engine.execute(job);
	assert.equal(first.isError, true);
	assert.deepEqual(job.tasks.map((item) => item.status), ["completed", "failed", "queued"]);
	const workerDirectory = job.tasks[1].cwd;
	const reopened = new Coordinator(f.options);
	const resumed = reopened.load(job.id);
	const result = await reopened.execute(resumed);
	assert.equal(result.isError, false, result.content[0].text);
	assert.deepEqual(resumed.tasks.map((item) => item.attempts), [1, 2, 1]);
	assert.equal(resumed.tasks[1].cwd, workerDirectory);
	assert.equal(resumed.tasks[2].cwd, workerDirectory);
	const report = JSON.parse(output(resumed.tasks[1]));
	assert.equal(report.resumed, true); assert.equal(report.attempt, 2);
	assert(report.previous.includes("previous.md"));
	assert(fs.existsSync(path.join(reopened.taskDir(resumed, resumed.tasks[1]), "attempt-2.jsonl")));
	assert.equal(resumed.tasks[0].usage.turns, 1);
});

test("abort persists partial results, stops children, and resumes unfinished parallel tasks", async (t) => {
	const f = fixture(t);
	const job = f.create({tasks: [
		{agent: "scout", task: task({read: "source.txt"})},
		{agent: "worker", files: ["result.txt"], task: task({file: "result.txt", pauseFirst: 10_000})},
	]} as Parameters);
	const abort = new AbortController();
	const run = f.engine.execute(job, undefined, abort.signal);
	await waitFor(() => job.tasks[0].status === "completed" && job.tasks[1].status === "running" &&
		fs.statSync(path.join(f.engine.taskDir(job, job.tasks[1]), "session.jsonl")).size > 0);
	const childPid = job.tasks[1].childPid;
	await assert.rejects(new Coordinator(f.options).execute(f.engine.load(job.id)), /live coordinator or child/);
	abort.abort();
	await run;
	assert.equal(job.tasks[1].status, "aborted");
	assert.equal(f.engine.load(job.id).tasks[0].status, "completed");
	assert.throws(() => process.kill(childPid!, 0), {code: "ESRCH"});
	const reopened = new Coordinator(f.options);
	const resumed = reopened.load(job.id);
	const result = await reopened.execute(resumed);
	assert.equal(result.isError, false, result.content[0].text);
	assert.deepEqual(resumed.tasks.map((item) => item.attempts), [1, 2]);
});

test("shell changes outside ownership are reported and retained for inspection", async (t) => {
	const f = fixture(t);
	const job = f.create({agent: "worker", files: ["result.txt"], task: task({file: "outside.txt"})} as Parameters);
	const result = await f.engine.execute(job);
	assert.equal(result.isError, true);
	assert.match(job.tasks[0].errorMessage!, /outside assigned ownership: outside.txt/);
	assert(fs.existsSync(path.join(job.tasks[0].cwd!, "outside.txt")));
	assert(!fs.existsSync(path.join(f.repo, "outside.txt")));
});

test("committing in a worker is reported rather than silently integrated", async (t) => {
	const f = fixture(t);
	const original = f.git("rev-parse", "HEAD");
	const job = f.create({agent: "worker", files: ["result.txt"], task: task({file: "result.txt", commit: true})} as Parameters);
	const result = await f.engine.execute(job);
	assert.equal(result.isError, true);
	assert.match(job.tasks[0].errorMessage!, /changed HEAD/);
	assert.equal(f.git("rev-parse", "HEAD"), original);
});

test("file-tool guard checks ownership and rejects symlink escapes", (t) => {
	const f = fixture(t);
	const cwd = fs.realpathSync(f.worktree("guard"));
	fs.mkdirSync(path.join(cwd, "src"));
	fs.symlinkSync(f.repo, path.join(cwd, "src", "outside"));
	fs.symlinkSync(path.join(f.base, "missing"), path.join(cwd, "src", "dangling"));
	assert(writeAllowed(cwd, ["src/"], "src/new.cpp"));
	assert(writeAllowed(cwd, ["source.txt"], "source.txt"));
	assert(!writeAllowed(cwd, ["src/"], "source.txt"));
	assert(!writeAllowed(cwd, ["src/"], path.join(f.repo, "source.txt")));
	assert(!writeAllowed(cwd, ["src/"], "src/outside/source.txt"));
	assert(!writeAllowed(cwd, ["src/"], "src/dangling"));
	assert.equal(readJson<any>(path.join(f.engine.jobDir(f.create({agent: "scout", task: task({})} as Parameters).id), "job.json")).version, 1);
});

test("child event decoding preserves Unicode split across stdout chunks", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(path.join(f.repo, "source.txt"), "✅ working contents");
	const job = f.create({agent: "scout", task: task({read: "source.txt", splitUtf8: true})} as Parameters);
	const result = await f.engine.execute(job);
	assert.equal(result.isError, false, result.content[0].text);
	assert.equal(JSON.parse(output(job.tasks[0])).read, "✅ working contents");
});

test("recovery ignores stale PID numbers belonging to a different process lifetime", async (t) => {
	if (!processStamp(process.pid)) { t.skip("Host policy prohibits querying process start times."); return; }
	const f = fixture(t);
	const job = f.create({agent: "scout", task: task({read: "source.txt"})} as Parameters);
	job.pid = process.pid; job.pidStarted = "a previous process"; job.host = hostname();
	f.engine.save(job);
	writeJson(path.join(f.engine.jobDir(job.id), "run.lock"), {
		pid: process.pid, started: "a previous process", host: hostname(),
	});
	assert.equal(f.engine.live(job), false);
	const result = await f.engine.execute(job);
	assert.equal(result.isError, false, result.content[0].text);
});

test("a worker blocked by a lease captures its starting state only when it can actually run", async (t) => {
	const f = fixture(t);
	const cwd = fs.realpathSync(f.worktree("busy"));
	const busy = await f.engine.leases.acquire(cwd, "another-job", "1", "read");
	const job = f.create({agent: "worker", cwd, files: ["result.txt"], task: task({file: "result.txt"})} as Parameters);
	assert.equal((await f.engine.execute(job)).isError, true);
	assert.equal(job.tasks[0].attempts, 0);
	await busy();
	fs.writeFileSync(path.join(cwd, "source.txt"), "parent edits before retry\n");
	const resumed = await f.engine.execute(f.engine.load(job.id));
	assert.equal(resumed.isError, false, resumed.content[0].text);
	assert.equal(fs.readFileSync(path.join(cwd, "source.txt"), "utf8"), "parent edits before retry\n");
});
