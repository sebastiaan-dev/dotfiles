// A real child process exercising the coordinator protocol without paid model calls.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const session = args[args.indexOf("--session") + 1];
const prompt = args.at(-1);
const directive = JSON.parse(prompt.slice(prompt.lastIndexOf("Task:") + 5).trim());
const history = fs.readFileSync(session, "utf8");
const attempt = history.trim() ? history.trim().split("\n").length + 1 : 1;
fs.appendFileSync(session, `${JSON.stringify({attempt, prompt, cwd: process.cwd()})}\n`);
const read = directive.read ? fs.readFileSync(directive.read, "utf8") : undefined;
const extra = directive.extra ? fs.readFileSync(directive.extra, "utf8") : undefined;
if (directive.file) {
	fs.mkdirSync(path.dirname(directive.file), {recursive: true});
	fs.writeFileSync(directive.file, directive.content ?? "done\n");
}
if (directive.commit) {
	execFileSync("git", ["add", directive.file]);
	execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", "Unexpected child commit"]);
}
if (attempt === 1 && directive.pauseFirst) await new Promise((resolve) => setTimeout(resolve, directive.pauseFirst));
const error = attempt === 1 && directive.failFirst ? "Synthetic first-attempt failure" : undefined;
const text = JSON.stringify({
	cwd: process.cwd(), args, read, extra, attempt,
	resumed: prompt.startsWith("Continue"), previous: directive.previous,
});
const encoded = JSON.stringify({type: "message_end", message: {
	role: "assistant", content: [{type: "text", text}],
	model: "global.openai.gpt-6-astra", stopReason: error ? "error" : "stop", errorMessage: error,
	usage: {input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: {total: 0}},
}});
if (directive.splitUtf8) {
	const bytes = Buffer.from(`${encoded}\n`);
	const split = bytes.indexOf(Buffer.from("✅")) + 1;
	process.stdout.write(bytes.subarray(0, split));
	await new Promise((resolve) => setTimeout(resolve, 10));
	process.stdout.write(bytes.subarray(split));
} else console.log(encoded);
