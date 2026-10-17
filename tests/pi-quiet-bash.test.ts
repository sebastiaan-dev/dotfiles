import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MAX_DIAGNOSTIC_BYTES, failureExcerpt } from "../private_dot_pi/private_agent/extensions/quiet-bash/logs.ts";
import { sdk } from "./helpers/pi-sdk.ts";

const extension = fileURLToPath(new URL("../private_dot_pi/private_agent/extensions/quiet-bash", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t: any, settings: object = {}) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "pi-quiet-check-")));
	const agentDir = path.join(base, "agent");
	const cwd = path.join(base, "project");
	fs.mkdirSync(cwd);
	fs.cpSync(extension, path.join(agentDir, "extensions/quiet-bash"), { recursive: true });
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(base, { recursive: true, force: true });
	});
	const settingsManager = sdk.SettingsManager.inMemory({ defaultProjectTrust: "never", ...settings });
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noThemes: true });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({
		cwd, agentDir, settingsManager, resourceLoader: loader, tools: ["bash"],
		sessionManager: sdk.SessionManager.inMemory(cwd),
	});
	t.after(() => session.dispose());
	const tool = session.agent.state.tools.find((tool: any) => tool.name === "bash");
	assert(tool.parameters.properties.quiet, "The native session must use the overridden Bash schema.");
	assert(session.systemPrompt.includes("quiet=true"));
	const run = (command: string, params: object = {}, signal?: AbortSignal, onUpdate?: any) =>
		tool.execute("check-fixture", { command, quiet: true, ...params }, signal, onUpdate);
	const text = (result: any) => result.content.map((part: any) => part.text ?? "").join("\n");
	const metadata = (result: any) => JSON.parse(fs.readFileSync(path.join(path.dirname(result.details.fullOutputPath), "result.json"), "utf8"));
	return { base, cwd, agentDir, run, text, metadata, tool };
}

test("native Pi suppresses successful stdout/stderr and partial output, retaining exact private logs", async (t) => {
	const f = await fixture(t);
	const updates: string[] = [];
	const result = await f.run("printf 'build progress %s\\n' {1..5000}; printf 'warning: inspect when needed\\n' >&2",
		{}, undefined, (update: any) => updates.push(f.text(update)));
	assert.equal(result.isError, false);
	assert(f.text(result).startsWith("Passed (exit 0,"));
	assert(Buffer.byteLength(f.text(result)) < 500);
	assert(!f.text(result).includes("progress"));
	assert(!updates.some((update) => update.includes("progress") || update.includes("warning:")));
	assert.equal(result.structuredContent.output, "", "Programmatic callers must not leak successful logs either.");
	const file = result.details.fullOutputPath;
	const log = fs.readFileSync(file, "utf8");
	assert(log.includes("build progress 1\n")); assert(log.includes("build progress 5000\n"));
	assert(log.includes("warning: inspect when needed"));
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
	assert.equal(fs.statSync(path.join(path.dirname(file), "result.json")).mode & 0o777, 0o600);
	assert.equal(f.metadata(result).status, "passed");
	const normal = await f.run("printf 'useful benchmark measurement\\n'", { quiet: false });
	assert.equal(f.text(normal), "useful benchmark measurement\n");
	assert(!normal.details?.fullOutputPath);
});

test("failed checks retain early compiler diagnostics and a bounded tail with full logs available", async (t) => {
	const f = await fixture(t);
	const result = await f.run("printf 'src/query.cpp:42:7: error: missing_symbol\\n  return missing_symbol;\\n'; printf 'continuing build %s\\n' {1..5000}; printf 'ninja: build stopped\\n'; exit 2");
	assert.equal(result.isError, true);
	assert.equal(result.structuredContent.exit_code, 2);
	assert(f.text(result).includes("missing_symbol"));
	assert(f.text(result).includes("ninja: build stopped"));
	assert(f.text(result).includes("1: src/query.cpp"));
	assert(Buffer.byteLength(result.structuredContent.output) <= MAX_DIAGNOSTIC_BYTES);
	assert(!f.text(result).includes("continuing build 3000\n"));
	assert(fs.readFileSync(result.details.fullOutputPath, "utf8").includes("continuing build 3000\n"));
	assert.equal(f.metadata(result).exitCode, 2);
});

test("quiet pipelines propagate failure, and configured shell prefixes still work", async (t) => {
	const f = await fixture(t, { shellCommandPrefix: "export PI_CHECK_PREFIX=expected" });
	const result = await f.run("printf '%s\\n' \"$PI_CHECK_PREFIX\"; (printf 'pipeline failure\\n'; exit 7) | tee pipeline.log");
	assert.equal(result.structuredContent.exit_code, 7);
	assert.equal(result.isError, true);
	assert(f.text(result).includes("expected"));
	assert(f.text(result).includes("pipeline failure"));
	assert.equal(fs.readFileSync(path.join(f.cwd, "pipeline.log"), "utf8"), "pipeline failure\n");
});

test("real C++ Ninja builds, CTest failures, compiler errors, and clang-format checks", async (t) => {
	const f = await fixture(t);
	fs.writeFileSync(path.join(f.cwd, "CMakeLists.txt"), `cmake_minimum_required(VERSION 3.20)
project(quiet_check LANGUAGES CXX)
add_executable(quiet_check main.cpp)
enable_testing()
add_test(NAME quiet_check COMMAND quiet_check)
`);
	const source = path.join(f.cwd, "main.cpp");
	fs.writeFileSync(source, '#include <iostream>\nint main(){std::cerr<<"cpp failing test detail\\n";return 1;}\n');
	const build = await f.run("cmake -S . -B build/reldebug -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo && cmake --build build/reldebug --parallel 2");
	assert.equal(build.isError, false, f.text(build));
	assert(!f.text(build).includes("Building CXX"));
	assert(fs.readFileSync(build.details.fullOutputPath, "utf8").includes("Building CXX"));
	const ctest = await f.run("ctest --test-dir build/reldebug");
	assert.equal(ctest.isError, true);
	assert(f.text(ctest).includes("cpp failing test detail"), "CTest must show failed-test output even without an explicit flag.");
	const format = await f.run("clang-format --dry-run --Werror main.cpp");
	assert.equal(format.isError, true);
	assert(f.text(format).includes("clang-formatted"));
	assert.equal((await f.run("clang-format -i main.cpp && clang-format --dry-run --Werror main.cpp")).isError, false);
	fs.writeFileSync(source, "int main() { return missing_cpp_symbol; }\n");
	const compile = await f.run("cmake --build build/reldebug --parallel 2");
	assert.equal(compile.isError, true);
	assert(f.text(compile).includes("missing_cpp_symbol"));
	fs.writeFileSync(source, "int missing_cpp_linker();\nint main() { return missing_cpp_linker(); }\n");
	const link = await f.run("cmake --build build/reldebug --parallel 2");
	assert.equal(link.isError, true);
	assert(f.text(link).includes("missing_cpp_linker"));
	assert(/undefined (?:symbols|reference)/i.test(f.text(link)));
});

test("real Rust Cargo checks/tests, Clippy, rustfmt, JSON compiler diagnostics, and panic output", async (t) => {
	const f = await fixture(t);
	fs.mkdirSync(path.join(f.cwd, "src"));
	fs.writeFileSync(path.join(f.cwd, "Cargo.toml"), '[package]\nname = "quiet_check"\nversion = "0.1.0"\nedition = "2024"\n');
	const source = path.join(f.cwd, "src/lib.rs");
	fs.writeFileSync(source, "pub fn answer()->u32{17}\n#[test]\nfn answer_test(){assert_eq!(answer(),17);}\n");
	const cargo = `CARGO_HOME=${quote(path.join(f.base, "cargo-home"))} CARGO_TARGET_DIR=${quote(path.join(f.cwd, "target"))} cargo`;
	const format = await f.run(`${cargo} fmt -- --check`);
	assert.equal(format.isError, true);
	assert(f.text(format).includes("Diff in"));
	const passed = await f.run(`${cargo} fmt && ${cargo} check --offline && ${cargo} clippy --offline -- -D warnings && ${cargo} test --offline`);
	assert.equal(passed.isError, false, f.text(passed));
	assert(!f.text(passed).includes("test result:"));
	assert(fs.readFileSync(passed.details.fullOutputPath, "utf8").includes("test result: ok"));
	fs.writeFileSync(source, 'pub fn answer() -> u32 { "wrong_type" }\n');
	const compile = await f.run(`${cargo} check --offline --message-format=json`);
	assert.equal(compile.isError, true);
	assert(f.text(compile).includes("error[E0308]"));
	assert(f.text(compile).includes("expected `u32`"));
	assert(!f.text(compile).includes('"reason":"compiler-artifact"'));
	fs.writeFileSync(source, "pub fn answer() -> u32 { return 17; }\n");
	const clippy = await f.run(`${cargo} clippy --offline -- -D warnings`);
	assert.equal(clippy.isError, true);
	assert(f.text(clippy).includes("unneeded `return`"));
	fs.writeFileSync(source, "pub fn answer() -> u32 { 17 }\n#[test]\nfn answer_test() { assert_eq!(answer(), 18); }\n");
	const panic = await f.run(`${cargo} test --offline`);
	assert.equal(panic.isError, true);
	assert(f.text(panic).includes("panicked at"));
	assert(f.text(panic).includes("assertion"));
});

test("timeouts and cancellation preserve partial diagnostics and stop shell descendants", async (t) => {
	const f = await fixture(t);
	const timeout = await f.run("printf 'before timeout\\n'; sleep 30", { timeout: 0.1 });
	assert.equal(timeout.isError, true);
	assert.equal(timeout.structuredContent.exit_code, 124);
	assert(f.text(timeout).includes("before timeout"));
	assert.equal(f.metadata(timeout).status, "timed-out");
	const controller = new AbortController();
	t.after(() => controller.abort());
	const pending = f.run("printf 'before cancellation\\n'; sleep 30 & echo $! > descendant.pid; wait", {}, controller.signal);
	const deadline = Date.now() + 5000;
	while (!fs.existsSync(path.join(f.cwd, "descendant.pid"))) {
		assert(Date.now() < deadline, "The fixture shell did not start its descendant.");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const descendant = Number(fs.readFileSync(path.join(f.cwd, "descendant.pid"), "utf8").trim());
	controller.abort();
	const cancelled = await pending;
	assert.equal(cancelled.isError, true);
	assert.equal(cancelled.structuredContent.exit_code, 130);
	assert(f.text(cancelled).includes("before cancellation"));
	assert.equal(f.metadata(cancelled).status, "aborted");
	let alive = true;
	for (let attempt = 0; attempt < 100 && alive; attempt++) {
		try { process.kill(descendant, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
		catch { alive = false; }
	}
	assert.equal(alive, false, "The cancelled shell must not leave its sleep subprocess alive.");
});

test("large Unicode and unfamiliar failure logs stay bounded without hiding the final status", async (t) => {
	const base = fs.mkdtempSync(path.join(tmpdir(), "pi-check-excerpt-"));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const file = path.join(base, "output.log");
	fs.writeFileSync(file, `error: ${"界".repeat(100_000)}\n${"progress\n".repeat(5000)}FINAL FAILURE DETAILS\n`);
	const excerpt = await failureExcerpt(file);
	assert(Buffer.byteLength(excerpt) <= MAX_DIAGNOSTIC_BYTES);
	assert(excerpt.includes("error:"));
	assert(excerpt.includes("FINAL FAILURE DETAILS"));
	assert(!excerpt.includes("\uFFFD"));
	// The whole log can fit within 40 lines while one giant line still exceeds the byte cap.
	fs.writeFileSync(file, `error: early detail\n${"界".repeat(100_000)}\nFINAL FAILURE DETAILS\n`);
	const short = await failureExcerpt(file);
	assert(Buffer.byteLength(short) <= MAX_DIAGNOSTIC_BYTES);
	assert(short.includes("error: early detail")); assert(short.includes("FINAL FAILURE DETAILS"));
	assert(!short.includes("\uFFFD"));
	fs.writeFileSync(file, '{"reason":"compiler-message","message":{"rendered":123}}\nlast useful detail\n');
	assert((await failureExcerpt(file)).includes("last useful detail"));
	fs.writeFileSync(file, "unknown tool: setup problem\n" + "noise\n".repeat(5000) + "last useful detail\n");
	const unknown = await failureExcerpt(file);
	assert(unknown.includes("unknown tool: setup problem")); assert(unknown.includes("last useful detail"));
});
