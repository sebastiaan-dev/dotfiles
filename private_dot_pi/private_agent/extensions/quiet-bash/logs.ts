import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

export const MAX_DIAGNOSTIC_BYTES = 12 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const FOCUS_LINES = 100;
const TAIL_LINES = 40;
const diagnostic = /(?:\bfatal error\b|\berror(?:\[[^\]]+\])?:|\bCMake Error\b|\bFAILED\b|\bFAIL(?:ED|URE)?\b|\*\*\*(?:Failed|Exception|Timeout)|undefined (?:reference|symbols?)|ld: |linker .*failed|panicked at|runtime error:|(?:Address|Thread|Memory|UndefinedBehavior)Sanitizer|^Diff in |^diff --git |^@@)/i;

type Line = { index: number; number: number; text: string };

/** Keep reading large logs with bounded memory, including tools that print one enormous line. */
async function* lines(file: string): AsyncGenerator<{ number: number; text: string }> {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	let clipped = false;
	let number = 0;
	const consume = function* (text: string) {
		for (const part of text.split(/(?<=\n)/)) {
			const end = part.endsWith("\n");
			if (!clipped) {
				pending += part;
				if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
					pending = Buffer.from(pending).subarray(0, MAX_LINE_BYTES).toString("utf8").replace(/\uFFFD$/, "");
					clipped = true;
				}
			}
			if (end) {
				yield { number: ++number, text: pending.trimEnd() + (clipped ? " [line shortened; see full log]" : "") };
				pending = "";
				clipped = false;
			}
		}
	};
	for await (const chunk of fs.createReadStream(file)) yield* consume(decoder.write(chunk));
	yield* consume(decoder.end());
	if (pending || clipped) yield { number: ++number, text: pending + (clipped ? " [line shortened; see full log]" : "") };
}

function rendered(text: string): string | undefined {
	const clean = stripVTControlCharacters(text).replace(/\r/g, "");
	if (!clean.startsWith("{")) return clean;
	try {
		const value = JSON.parse(clean);
		// Cargo's JSON includes compiler artifacts that do not help diagnose a failed check.
		if (value.reason === "compiler-message") {
			if (typeof value.message?.rendered === "string") return value.message.rendered;
			if (typeof value.message?.message === "string") return value.message.message;
			return clean;
		}
		if (["compiler-artifact", "build-script-executed"].includes(value.reason)) return undefined;
		if (value.reason === "build-finished") return `cargo build finished: success=${value.success}`;
		if (value.type === "test" && value.event === "failed") {
			return `FAILED: ${value.name}\n${value.stdout ?? ""}`;
		}
	} catch { /* Ordinary output and clipped JSON remain inspectable. */ }
	return clean;
}

function fit(text: string, bytes: number, keepEnd = false): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	const buffer = Buffer.from(text);
	const available = Math.max(0, bytes - 40);
	return keepEnd ?
		"[Excerpt shortened; see full log]\n" + buffer.subarray(-available).toString("utf8").replace(/^\uFFFD+/, "") :
		buffer.subarray(0, available).toString("utf8").replace(/\uFFFD$/, "") + "\n[Excerpt shortened; see full log]";
}

/** Find early root diagnostics even when later build progress pushes them out of the tail. */
export async function failureExcerpt(file: string): Promise<string> {
	const head: Line[] = [];
	const tail: Line[] = [];
	const previous: Line[] = [];
	const focus = new Map<number, Line>();
	let index = 0;
	let after = 0;
	for await (const raw of lines(file)) {
		const text = rendered(raw.text);
		if (text === undefined) continue;
		for (const part of text.split("\n")) {
			const line = { index: ++index, number: raw.number, text: part };
			if (head.length < 16) head.push(line);
			tail.push(line);
			if (tail.length > TAIL_LINES) tail.shift();
			if (diagnostic.test(part) && focus.size < FOCUS_LINES) {
				for (const before of previous) if (focus.size < FOCUS_LINES) focus.set(before.index, before);
				after = 17;
			}
			if (after > 0 && focus.size < FOCUS_LINES) focus.set(line.index, line);
			after--;
			previous.push(line);
			if (previous.length > 3) previous.shift();
		}
	}
	const selected = [...new Map([...(focus.size ? focus.values() : head), ...tail]
		.map((line) => [line.index, line])).values()].sort((a, b) => a.index - b.index);
	if (!selected.length) return "(no output)";
	// Reserve room for the tail; one huge diagnostic must not hide the final test/build status.
	const early = selected.filter((line) => line.index < (tail[0]?.index ?? Infinity));
	const format = (items: Line[]) => items.map((line, i) =>
		`${i && line.index > items[i - 1].index + 1 ? "...\n" : ""}${line.number}: ${line.text}`).join("\n");
	const combined = format(selected);
	if (Buffer.byteLength(combined) <= MAX_DIAGNOSTIC_BYTES) return combined;
	const firstBudget = Math.floor((MAX_DIAGNOSTIC_BYTES - 5) * 2 / 3);
	const first = fit(format(early.length ? early : selected), firstBudget);
	const last = fit(format(tail), MAX_DIAGNOSTIC_BYTES - 5 - firstBudget, true);
	return `${first}\n...\n${last}`;
}

/** Every quiet check retains its exact combined stdout/stderr and command metadata privately. */
export class CheckLog {
	readonly directory: string;
	readonly file: string;
	error?: Error;
	private fd: number;
	constructor(root: string) {
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		fs.chmodSync(root, 0o700);
		this.directory = fs.mkdtempSync(path.join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
		fs.chmodSync(this.directory, 0o700);
		this.file = path.join(this.directory, "output.log");
		this.fd = fs.openSync(this.file, "wx", 0o600);
	}
	write(data: Buffer): void {
		if (this.error) return;
		try {
			let offset = 0;
			while (offset < data.length) {
				const written = fs.writeSync(this.fd, data, offset, data.length - offset);
				if (!written) throw new Error("Could not write the check log.");
				offset += written;
			}
		} catch (error) { this.error = error instanceof Error ? error : new Error(String(error)); }
	}
	close(): void {
		try { fs.closeSync(this.fd); }
		catch (error) { this.error ??= error instanceof Error ? error : new Error(String(error)); }
	}
	save(metadata: object): void {
		fs.writeFileSync(path.join(this.directory, "result.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
	}
}
