import * as path from "node:path";
import {
	createBashToolDefinition, createLocalBashOperations, getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CheckLog, failureExcerpt } from "./logs.ts";

export default function (pi: ExtensionAPI) {
	const base = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...base,
		description: `${base.description} Set quiet=true for build, test, lint, and formatting checks: success returns only status and a saved log path; failure returns bounded diagnostics. Quiet pipelines use pipefail. Omit quiet when the output itself is needed.`,
		parameters: Type.Object({
			...base.parameters.properties,
			quiet: Type.Optional(Type.Boolean({ description: "Save full logs; return output only on failure. For builds, tests, lint, and formatting checks.", default: false })),
		}),
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			"Use bash with quiet=true for status-only build, test, lint, and format checks, including Ninja/CMake/CTest, Cargo, Clippy, rustfmt, and clang-format.",
			"Quiet checks preserve full logs and show diagnostics only on failure. Use && between dependent checks; pipelines propagate failure. Read or grep the saved log when more detail is needed.",
			"Keep quiet=false when inspecting files, reproducer output, benchmark measurements, warnings, formatter diffs, or test listings.",
		],
		async execute(id, params, signal, onUpdate, ctx) {
			const settings = pi.getSettings();
			const options = { shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix };
			if (!params.quiet) {
				return createBashToolDefinition(ctx.cwd, options).execute(id, params, signal, onUpdate, ctx);
			}
			const log = new CheckLog(path.join(getAgentDir(), "checks"));
			const started = Date.now();
			const controller = new AbortController();
			const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			const backend = createLocalBashOperations(options);
			let exitCode = 1;
			let status = "failed";
			let error: string | undefined;
			try {
				const tool = createBashToolDefinition(ctx.cwd, {
					...options,
					commandPrefix: [settings.shellCommandPrefix, "set -o pipefail"].filter(Boolean).join("\n"),
					operations: {
						exec: (command, cwd, execution) => backend.exec(command, cwd, {
							...execution,
							// CTest normally hides failed-test output unless this is requested.
							env: { ...execution.env, CTEST_OUTPUT_ON_FAILURE: "1" },
							onData: (data) => {
								log.write(data);
								if (log.error) controller.abort();
							},
						}),
					},
				});
				const result = await tool.execute(id, params, combinedSignal, onUpdate, ctx);
				exitCode = (result.structuredContent as { exit_code: number }).exit_code;
				status = exitCode === 0 ? "passed" : "failed";
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
				if (signal?.aborted) { status = "aborted"; exitCode = 130; }
				else if (error.includes("Command timed out")) { status = "timed-out"; exitCode = 124; }
			} finally { log.close(); }
			if (log.error) { status = "failed"; exitCode = 1; error = `Log capture failed: ${log.error.message}`; }
			const seconds = Math.round((Date.now() - started) / 100) / 10;
			log.save({
				command: params.command, cwd: ctx.cwd, status, exitCode,
				seconds, error, log: log.file, completed: new Date().toISOString(),
			});
			const failed = status !== "passed";
			const output = failed ? await failureExcerpt(log.file) : "";
			const text = [
				`${failed ? status : "Passed"} (exit ${exitCode}, ${seconds}s).`,
				error, failed ? output : undefined, `Full log: ${log.file}`,
			].filter(Boolean).join("\n\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { fullOutputPath: log.file },
				structuredContent: {
					output, truncated: true, full_output_path: log.file,
					exit_code: exitCode, wall_time_seconds: seconds,
				},
				isError: failed,
			};
		},
	});
}
