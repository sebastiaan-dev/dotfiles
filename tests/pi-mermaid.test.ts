import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { sdk, tui } from "./helpers/pi-sdk.ts";
import { createMermaidTransformer, MAX_SOURCE_BYTES, MAX_PREVIEW_BYTES } from "../private_dot_pi/private_agent/extensions/mermaid/markdown.ts";

const extension = fileURLToPath(new URL("../private_dot_pi/private_agent/extensions/mermaid", import.meta.url));
const palette = fileURLToPath(new URL("../private_dot_pi/private_agent/themes/kanso-mist.json", import.meta.url));
const vendor = process.env.PI_MERMAID_VENDOR ?? path.join(homedir(), ".pi/agent/extensions/mermaid/vendor");
const context = { messageType: "assistant", isStreaming: false, availableWidth: 118 };
const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;

async function fixture(t: any) {
	assert(fs.existsSync(path.join(vendor, "dist/index.js")), "Apply the managed Mermaid extension or set PI_MERMAID_VENDOR to the pinned package directory.");
	assert.equal(JSON.parse(fs.readFileSync(path.join(vendor, "package.json"), "utf8")).version, "1.1.3");
	const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "pi-mermaid-")));
	const agentDir = path.join(base, "agent");
	const target = path.join(agentDir, "extensions/mermaid");
	fs.cpSync(extension, target, { recursive: true });
	fs.symlinkSync(vendor, path.join(target, "vendor"), "dir");
	fs.mkdirSync(path.join(agentDir, "themes"));
	fs.copyFileSync(palette, path.join(agentDir, "themes/kanso-mist.json"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(base, { recursive: true, force: true });
	});
	const loader = new sdk.DefaultResourceLoader({
		cwd: base, agentDir, settingsManager: sdk.SettingsManager.inMemory({ defaultProjectTrust: "never" }),
		noSkills: true, noThemes: true,
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	const mermaid = loaded.extensions.find((item: any) => item.markdownTransformer);
	assert(mermaid);
	assert.equal(mermaid.tools.size, 0);
	assert.equal(mermaid.handlers.size, 0, "Rendering must not mutate transcript or provider events.");
	sdk.initTheme("kanso-mist", false);
	return { transform: mermaid.markdownTransformer };
}

test("native Pi loads beautiful-mermaid and renders all six supported diagram families", async (t) => {
	const { transform } = await fixture(t);
	const examples = [
		["graph TD\n A[Parse] --> B[Plan]\n B --> C[Execute]", ["Parse", "Plan", "Execute"]],
		["stateDiagram-v2\n [*] --> Idle\n Idle --> Active\n Active --> Idle", ["Idle", "Active"]],
		["%% explanatory comment\nsequenceDiagram\n User->>Pi: Request\n Pi-->>User: Result", ["User", "Pi", "Request", "Result"]],
		["classDiagram\n class Worker {\n +run()\n }\n Parent --> Worker", ["Parent", "Worker", "+run"]],
		["erDiagram\n ACCOUNT ||--o{ ROLE : owns", ["ACCOUNT", "ROLE", "owns"]],
		["xychart-beta\n x-axis [A, B]\n y-axis 0 --> 10\n bar [3, 7]", ["█", "A", "B"]],
	] as const;
	for (const [source, labels] of examples) {
		const rendered = transform(fence(source), context);
		assert(rendered.startsWith("```text\n"), rendered);
		assert(!rendered.includes("source shown"), rendered);
		assert(/[┌╭─│┼█]/.test(rendered));
		assert(!rendered.includes("\x1b"), "Pi supplies the theme colors.");
		for (const label of labels) assert(rendered.includes(label), rendered);
	}
});

test("native Kanso chat display shows diagrams and preserves the original user/assistant source", async (t) => {
	const { transform } = await fixture(t);
	const source = `Before the diagram.\n\n${fence("flowchart TD\n A[Parse] --> B[Execute]")}\n\nAfter the diagram.`;
	const message = { role: "assistant", content: [{ type: "text", text: source }], timestamp: Date.now() };
	const original = JSON.stringify(message);
	const assistant = new sdk.AssistantMessageComponent(message, false, sdk.getMarkdownTheme(), "Thinking...", 1, [transform]);
	const assistantLines = assistant.render(80);
	const output = assistantLines.map(stripVTControlCharacters).join("\n");
	assert(output.includes("┌")); assert(output.includes("Parse")); assert(output.includes("Execute"));
	assert(output.includes("Before the diagram.")); assert(output.includes("After the diagram."));
	assert(!output.includes("A[Parse] --> B[Execute]"));
	assert(assistantLines.every((line: string) => tui.visibleWidth(line) <= 80));
	assert(assistantLines.some((line: string) => line.includes("\x1b[")), "The native theme should color the diagram.");
	assert.equal(JSON.stringify(message), original);
	const user = new sdk.UserMessageComponent(source, sdk.getMarkdownTheme(), 1, [transform]);
	assert(user.render(80).map(stripVTControlCharacters).join("\n").includes("┌"));
	assert(source.includes("A[Parse] --> B[Execute]"), "Copy/export/provider input retains Mermaid source.");
});

test("completed fences render while streaming; incomplete, nested, and unrelated code stays intact", async (t) => {
	const { transform } = await fixture(t);
	const source = "graph LR; A[Input] --> B[Result]";
	const pending = `Intro\n\`\`\`mermaid\n${source}\n`;
	assert.equal(transform(pending, { ...context, isStreaming: true }), pending);
	assert(transform(pending + "```", { ...context, isStreaming: true }).includes("┌"));
	const nested = `\`\`\`\`markdown\n${fence(source)}\n\`\`\`\``;
	assert.equal(transform(nested, context), nested);
	const unrelated = `\`\`\`rust\nlet mermaid = "unchanged";\n\`\`\``;
	assert.equal(transform(unrelated, context), unrelated);
	const mixed = `ordinary prose\n\n~~~MERMAID title\n${source}\n~~~~\n\n\`\`\`cpp\nint main() {}\n\`\`\``;
	const rendered = transform(mixed, context);
	assert(rendered.includes("┌")); assert(rendered.includes("int main() {}"));
	const crlf = `\`\`\`mermaid\r\ngraph TD\r\n A --> B\r\n\`\`\`\r\n`;
	assert(transform(crlf, context).includes("```text\r\n"));
	const indented = `  \`\`\`mermaid\n  graph TD\n  A --> B\n  \`\`\``;
	assert(transform(indented, context).startsWith("  ```text\n"));
});

test("semicolon syntax preserves quoted labels, and preview fences cannot be closed by labels", async (t) => {
	const { transform } = await fixture(t);
	const source = 'graph LR; A["Parse; plan"] --> B["done"]; B --> C["literal ``` label"]';
	const rendered = transform(fence(source), context);
	assert(rendered.startsWith("````text\n"), rendered);
	assert(rendered.includes("Parse; plan")); assert(rendered.includes("literal ``` label"));
	assert(rendered.endsWith("\n````"));
	assert(!rendered.includes("source shown"));
});

test("terminal resize previews wide diagrams without wrapping their connectors", async (t) => {
	const { transform } = await fixture(t);
	const source = fence("graph LR\n A[Long input label] --> B[Long output label] --> C[Another long label]");
	const message = { role: "assistant", content: [{ type: "text", text: source }], timestamp: Date.now() };
	const component = new sdk.AssistantMessageComponent(message, false, sdk.getMarkdownTheme(), "Thinking...", 1, [transform]);
	const narrow = component.render(40).map(stripVTControlCharacters).join("\n");
	assert(/wider\s+terminal/.test(narrow)); assert(narrow.includes("graph LR"));
	const wide = component.render(120).map(stripVTControlCharacters).join("\n");
	assert(wide.includes("┌")); assert(!wide.includes("wider terminal"));
	assert(!wide.includes("graph LR"));
});

test("diagrams inside list items reserve the list indentation before previewing", async (t) => {
	const { transform } = await fixture(t);
	const source = "- Diagram:\n\n  ```mermaid\n  graph LR\n  A[ABCDEFGHIJKL] --> B[MNOPQRSTUVWX]\n  ```";
	const message = { role: "assistant", content: [{ type: "text", text: source }], timestamp: Date.now() };
	const component = new sdk.AssistantMessageComponent(message, false, sdk.getMarkdownTheme(), "Thinking...", 1, [transform]);
	assert(/wider\s+terminal/.test(component.render(40).map(stripVTControlCharacters).join("\n")));
	assert(component.render(80).map(stripVTControlCharacters).join("\n").includes("┌"));
});

test("unsupported, misleading, and excessive diagrams retain readable original source", async (t) => {
	const { transform } = await fixture(t);
	for (const source of [
		"pie\n \"Completed\" : 7",
		"graph RL\n A --> B",
		"graph TD\n subgraph group\n direction RL\n A --> B\n end",
		"graph TD\n A[初期化] --> B[完了]",
		"graph TD\n A[&#x4e00;] --> B[End]",
		"graph WRONG\n A --> B",
		"graph TD\n" + Array.from({ length: 45 }, (_, i) => `N${i} --> N${i + 1}`).join("\n"),
	]) {
		const markdown = fence(source);
		const rendered = transform(markdown, context);
		assert(rendered.includes("source shown"), rendered);
		assert(rendered.endsWith(markdown), "Fallback must preserve the complete original fence.");
	}
	let calls = 0;
	const bounded = createMermaidTransformer(() => { calls++; return "x"; }, tui.visibleWidth);
	const tooLarge = fence("graph TD\n" + "x".repeat(MAX_SOURCE_BYTES));
	assert(bounded(tooLarge, context).endsWith(tooLarge)); assert.equal(calls, 0);
	const excessiveOutput = createMermaidTransformer(() => "x".repeat(MAX_PREVIEW_BYTES + 1), tui.visibleWidth);
	assert(excessiveOutput(fence("graph TD\n A --> B"), context).includes("source shown"));
});

test("streaming redraws and terminal resizes reuse bounded cached diagrams, including failures", () => {
	let calls = 0;
	const transform = createMermaidTransformer(() => { calls++; return "┌───┐\n│ A │\n└───┘"; }, tui.visibleWidth);
	const source = fence("graph TD\n A --> B");
	for (let i = 0; i < 50; i++) {
		transform(`Message ${i}\n${source}`, { ...context, isStreaming: true, availableWidth: 40 + i });
	}
	assert.equal(calls, 1);
	for (let i = 0; i < 40; i++) transform(fence(`graph TD\n A${i} --> B`), context);
	transform(source, context);
	assert.equal(calls, 42, "The cache must evict old diagrams rather than grow with session history.");
	let failures = 0;
	const broken = createMermaidTransformer(() => { failures++; throw new Error("Invalid source"); }, tui.visibleWidth);
	for (let i = 0; i < 5; i++) assert(broken(source, context).includes("source shown"));
	assert.equal(failures, 1);
});
