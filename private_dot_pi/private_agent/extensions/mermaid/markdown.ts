type Context = { messageType: string; isStreaming: boolean; availableWidth: number };
type Preview = { diagram: string } | { reason: string };
type Measure = (text: string) => number;
export const MAX_SOURCE_BYTES = 8 * 1024;
export const MAX_SOURCE_LINES = 80;
export const MAX_PREVIEW_BYTES = 64 * 1024;
export const MAX_PREVIEW_LINES = 160;
const CACHE_SIZE = 32;

/** The upstream parser expects separate lines; semicolons inside labels must remain literal. */
export function normalizeSource(source: string): string {
	source = source.replace(/\r\n?/g, "\n");
	let result = "";
	let quoted = false;
	let escaped = false;
	let comment = false;
	const brackets: string[] = [];
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === "\n") comment = false;
		if (!comment && !quoted && !brackets.length && source.slice(i, i + 2) === "%%") comment = true;
		if (!comment) {
			if (escaped) escaped = false;
			else if (char === "\\" && quoted) escaped = true;
			else if (char === '"') quoted = !quoted;
			else if (!quoted) {
				if ("[({".includes(char)) brackets.push(char);
				else if ("])}".includes(char)) brackets.pop();
				else if (char === ";" && !brackets.length) { result += "\n"; continue; }
			}
		}
		result += char;
	}
	// Leading Mermaid comments/config directives otherwise confuse diagram-type detection.
	return result.replace(/^(?:[ \t]*(?:%%[^\n]*)?\r?\n)*/, "").trim();
}

/** Only rendered Markdown changes. Original messages, model context, and exported source stay intact. */
export function createMermaidTransformer(render: (source: string) => string, measure: Measure) {
	const cache = new Map<string, Preview>();
	const preview = (source: string): Preview => {
		const existing = cache.get(source);
		if (existing) {
			cache.delete(source); cache.set(source, existing);
			return existing;
		}
		let value: Preview;
		if (Buffer.byteLength(source) > MAX_SOURCE_BYTES || source.split("\n").length > MAX_SOURCE_LINES ||
			source.split("\n").some((line) => line.length > 512)) {
			// Do not cache unbounded source strings.
			return { reason: "Mermaid diagram is too large for an inline preview; source shown." };
		}
		const normalized = normalizeSource(source);
		if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(normalized)) {
			return { reason: "Mermaid preview unavailable; source shown." };
		}
		// This renderer's character grid cannot align double-width or combining labels correctly.
		if (normalized.split("\n").some((line) => measure(line) !== line.length)) {
			value = { reason: "Mermaid preview cannot align these label characters; source shown." };
		} else {
			try {
				const diagram = render(normalized).split("\n").map((line) => line.trimEnd()).join("\n").trimEnd();
				value = !diagram || Buffer.byteLength(diagram) > MAX_PREVIEW_BYTES ||
					diagram.split("\n").length > MAX_PREVIEW_LINES ||
					/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(diagram) ?
					{ reason: "Mermaid diagram is too large for an inline preview; source shown." } : { diagram };
				if ("diagram" in value && diagram.split("\n").some((line) => measure(line) !== line.length)) {
					value = { reason: "Mermaid preview cannot align these label characters; source shown." };
				}
			} catch {
				value = { reason: "Mermaid preview unavailable for this syntax; source shown." };
			}
		}
		cache.set(source, value);
		if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
		return value;
	};
	return (markdown: string, context: Context): string => {
		if (!/mermaid/i.test(markdown)) return markdown;
		const lines = markdown.match(/[^\n]*(?:\n|$)/g)!.filter(Boolean);
		const result: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const opening = lines[i].replace(/\r?\n$/, "").match(/^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/);
			if (!opening || (opening[2][0] === "`" && opening[3].includes("`"))) {
				result.push(lines[i]); continue;
			}
			const closing = new RegExp(`^ {0,3}${opening[2][0]}{${opening[2].length},}[ \\t]*$`);
			let end = i + 1;
			while (end < lines.length && !closing.test(lines[end].replace(/\r?\n$/, ""))) end++;
			// An unfinished streamed fence remains source, including any nested-looking fences.
			if (end === lines.length) { result.push(lines.slice(i).join("")); break; }
			const original = lines.slice(i, end + 1).join("");
			if (!/^mermaid(?:[ \t].*)?$/i.test(opening[3].trim())) {
				result.push(original); i = end; continue;
			}
			const indent = opening[1];
			const body = lines.slice(i + 1, end).map((line) =>
				line.replace(new RegExp(`^ {0,${indent.length}}`), "")).join("");
			const value = preview(body);
			const newline = lines[i].endsWith("\r\n") ? "\r\n" : "\n";
			// Native code blocks add two columns; a containing list also consumes the fence indentation.
			if ("reason" in value || value.diagram.split("\n").some((line) => measure(line) + 2 + indent.length > context.availableWidth)) {
				const reason = "reason" in value ? value.reason : "Mermaid preview needs a wider terminal; source shown.";
				result.push(`${indent}*${reason}*${newline}${newline}${original}`);
			} else {
				// A label containing backticks must not terminate the replacement Markdown fence.
				const fence = "`".repeat(Math.max(3, ...(value.diagram.match(/`+/g) ?? []).map((run) => run.length + 1)));
				const art = value.diagram.split("\n").map((line) => indent + line).join(newline);
				result.push(`${indent}${fence}text${newline}${art}${newline}${indent}${fence}${lines[end].endsWith("\n") ? newline : ""}`);
			}
			i = end;
		}
		return result.join("");
	};
}
