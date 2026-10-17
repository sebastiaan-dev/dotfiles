import * as path from "node:path";
import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Box, SelectList, ScrollView, backgroundAnsi, parseColor, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
	type Component, type TUI,
} from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import {
	BenchmarkStore, duration, relativeChange, type Manifest, type SavedBenchmark, type BenchmarkCase,
} from "./results.ts";
import { benchmarkMarkdown } from "./markdown.ts";

const clean = (value: unknown) => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const recorded = (value: unknown) => value === undefined || value === "" ? "Not recorded" : clean(value);
const percent = (value: number | undefined) => value === undefined ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const memory = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const tabs = ["Summary", "Runs", "Details"];
// Kanso's inkBg0: darker than the Mist page background, from the same palette.
const kansoWindowBg = parseColor("#14171d");

export class BenchmarkView implements Component {
	private history!: SelectList;
	private runs: Manifest[] = [];
	private selected?: SavedBenchmark;
	private error?: string;
	private skipped = 0;
	private tab = 0;
	private baseline?: number; // Zero-based in the view; never changes saved metadata.
	private sampleCase = 0;
	private readonly scroll: ScrollView;
	private readonly panel: Box;
	private copying = false;
	private copyNotice?: { text: string; color: "muted" | "success" | "error" };

	constructor(
		private store: BenchmarkStore, private repositoryKey: string,
		private tui: Pick<TUI, "terminal" | "requestRender">, private theme: Theme,
		private done: () => void, id?: string,
		private writeClipboard: (text: string) => Promise<void> = copyToClipboard,
	) {
		this.scroll = new ScrollView({ render: (width) => this.content(width), invalidate() {} }, { overscroll: "contain" });
		this.panel = new Box(0, 0, (text) => {
			const bg = this.theme.name?.startsWith("kanso") ? kansoWindowBg : this.theme.colors.userMessageBg;
			const ansi = backgroundAnsi(bg, this.theme.getColorMode());
			// Truncation can reset ANSI styles inside a row; keep the panel opaque through its padding.
			return this.theme.style(text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + ansi), { bg });
		});
		this.panel.addChild({ render: (width) => this.renderPanel(width), invalidate() {} });
		this.refresh(id);
	}
	invalidate() { this.history.invalidate(); this.scroll.invalidate(); this.panel.invalidate(); }
	private changed() { this.invalidate(); this.tui.requestRender(); }
	private refresh(id = this.selected?.manifest.id) {
		try {
			const listing = this.store.list(this.repositoryKey);
			this.runs = listing.runs;
			this.skipped = listing.skipped;
			if (id && !this.runs.some((entry) => entry.id === id)) this.runs.unshift(this.store.load(id).manifest);
			this.error = undefined;
		} catch (error) { this.error = String(error); this.runs = []; }
		this.history = new SelectList(this.runs.map((entry) => ({
			value: entry.id, label: clean(entry.options.title || "Hyperfine"),
			description: `${new Date(entry.importedAt).toLocaleString()} · ${entry.id}`,
		})), 3, {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("muted", text),
		});
		this.history.onSelectionChange = (item) => { this.select(item.value); this.changed(); };
		this.history.setSelectedIndex(Math.max(0, this.runs.findIndex((entry) => entry.id === id)));
		const item = this.history.getSelectedItem();
		if (item) this.select(item.value);
		else this.selected = undefined;
	}
	private select(id: string) {
		this.copyNotice = undefined;
		try {
			this.selected = this.store.load(id);
			this.baseline = this.selected.manifest.options.baseline === undefined ? undefined : this.selected.manifest.options.baseline - 1;
			this.error = undefined;
		} catch (error) { this.error = String(error); this.selected = undefined; }
		this.sampleCase = 0;
		this.scroll.scrollToStart();
	}
	private async copyMarkdown() {
		if (this.copying) return;
		const selected = this.selected;
		const baseline = this.baseline;
		if (!selected) {
			this.copyNotice = { text: "Select a benchmark to copy.", color: "error" };
			this.changed();
			return;
		}
		this.copying = true;
		this.copyNotice = { text: "Copying Markdown table…", color: "muted" };
		this.changed();
		try {
			await this.writeClipboard(benchmarkMarkdown(selected, baseline));
			if (this.selected === selected && this.baseline === baseline) {
				this.copyNotice = { text: "Copied Markdown table.", color: "success" };
			}
		} catch (error) {
			if (this.selected === selected && this.baseline === baseline) {
				this.copyNotice = { text: `Copy failed: ${clean(error instanceof Error ? error.message : String(error))}`, color: "error" };
			}
		} finally {
			this.copying = false;
			this.changed();
		}
	}
	handleInput(data: string) {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") { this.done(); return; }
		if (matchesKey(data, "y")) return this.copyMarkdown();
		if (matchesKey(data, "up") || matchesKey(data, "down")) { this.history.handleInput(data); return; }
		if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
			this.tab = (this.tab + (matchesKey(data, "left") ? 2 : 1)) % tabs.length;
			this.scroll.scrollToStart();
		} else if (data === "b" && this.selected) {
			this.baseline = this.baseline === undefined ? 0 : this.baseline + 1 < this.selected.cases.length ? this.baseline + 1 : undefined;
			this.copyNotice = undefined;
		} else if (data === "c" && this.selected) {
			this.sampleCase = (this.sampleCase + 1) % this.selected.cases.length;
			this.scroll.scrollToStart();
		} else if (data === "r") this.refresh();
		else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
		else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
		else if (data === "j") this.scroll.scrollBy(1);
		else if (data === "k") this.scroll.scrollBy(-1);
		else if (matchesKey(data, "home")) this.scroll.scrollToStart();
		else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
		else return;
		this.changed();
	}
	render(width: number): string[] {
		return this.panel.render(Math.max(1, Math.floor(width)));
	}
	private renderPanel(width: number): string[] {
		width = Math.max(1, Math.floor(width));
		const th = this.theme;
		const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.9) - 2);
		const framed = width >= 3 && height >= 3;
		const padding = framed && width >= 5 ? 1 : 0;
		const contentWidth = width - (framed ? 2 + padding * 2 : 0);
		const contentHeight = height - (framed ? 2 : 0);
		const header = [
			th.fg("accent", th.bold(" Benchmarks ")),
			...(!this.runs.length ? [] : this.history.render(contentWidth)),
			tabs.map((name, index) => index === this.tab ? th.fg("accent", th.bold(`[${name}]`)) : th.fg("muted", ` ${name} `)).join(" "),
		].map((line) => truncateToWidth(line, contentWidth));
		const footer = wrapTextWithAnsi(th.fg("dim",
			"↑↓ history · ←→ tabs · b baseline · c case · y copy table · PgUp/PgDn or j/k scroll · r refresh · Esc close"), contentWidth);
		const room = Math.max(1, contentHeight - header.length - footer.length - 1);
		const content = this.scroll.render(contentWidth);
		this.scroll.updateLayout(content.length, room, () => this.tui.requestRender());
		const visible = content.slice(this.scroll.scrollTop, this.scroll.scrollTop + room);
		while (visible.length < room) visible.push("");
		const position = content.length > room ? `${this.scroll.scrollTop + 1}–${Math.min(content.length, this.scroll.scrollTop + room)}/${content.length}` : "";
		const status = [this.copyNotice?.text, position].filter(Boolean).join(" · ");
		const body = [...header, ...visible, th.fg(this.copyNotice?.color ?? "dim", truncateToWidth(status, contentWidth)), ...footer].slice(0, contentHeight);
		if (!framed) return body;
		const side = th.fg("border", "│");
		const edge = (left: string, right: string) => th.fg("border", left + "─".repeat(width - 2) + right);
		const inset = " ".repeat(padding);
		return [
			edge("╭", "╮"),
			...body.map((line) => `${side}${inset}${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))}${inset}${side}`),
			edge("╰", "╯"),
		];
	}
	private content(width: number): string[] {
		const lines: string[] = [];
		const th = this.theme;
		const text = (value: string) => lines.push(...wrapTextWithAnsi(value, width));
		const field = (label: string, value: unknown) => text(th.fg("muted", `${label}: `) + recorded(value));
		if (this.error) text(th.fg("error", clean(this.error)));
		if (this.skipped) text(th.fg("warning", `${this.skipped} unreadable saved manifests skipped.`));
		const run = this.selected;
		if (!run) {
			text("No saved benchmark selected.");
			text("Run /bench <workload>, or /bench import <hyperfine.json>.");
			return lines;
		}
		const baseline = this.baseline === undefined ? undefined : run.cases[this.baseline];
		if (this.tab === 0) {
			field("Baseline", baseline?.label ?? "None selected");
			if (width >= 100) {
				const labelWidth = Math.min(32, width - 76);
				const pad = (value: string, size: number) => {
					const clipped = truncateToWidth(value, size);
					return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
				};
				const row = (values: string[]) => [pad(values[0], labelWidth), ...values.slice(1).map((value, index) => pad(value, [11, 11, 11, 11, 7, 9, 9][index]))].join(" ");
				lines.push(th.fg("muted", row(["Case", "Mean", "Median", "SD", "p95 est.", "n", "CV", "Δ mean"])));
				run.cases.forEach((entry, index) => {
					lines.push(row([
						`${index + 1}. ${clean(entry.label)}`, duration(entry.mean), duration(entry.median), duration(entry.stddev),
						duration(entry.p95), String(entry.n), entry.cv === undefined ? "—" : `${(entry.cv * 100).toFixed(1)}%`,
						index === this.baseline ? "baseline" : percent(relativeChange(entry, baseline)),
					]));
				});
			}
			const longest = Math.max(...run.cases.map((entry) => entry.mean));
			for (const [index, entry] of run.cases.entries()) {
				text(th.fg("accent", `${index + 1}. ${clean(entry.label)}`));
				const barWidth = Math.max(1, Math.min(32, width - 17));
				const bar = "█".repeat(longest ? Math.max(1, Math.round(entry.mean / longest * barWidth)) : 0);
				lines.push(truncateToWidth(th.fg(index === this.baseline ? "muted" : "accent", bar) + ` ${duration(entry.mean)}`, width));
				if (width < 100) {
					text(`Mean ${duration(entry.mean)} · median ${duration(entry.median)} · SD ${duration(entry.stddev)}`);
					text(`n=${entry.n} · CV ${entry.cv === undefined ? "—" : `${(entry.cv * 100).toFixed(1)}%`} · p95 est. ${duration(entry.p95)}`);
					if (baseline) text(`Mean change: ${index === this.baseline ? "baseline" : percent(relativeChange(entry, baseline))}`);
				}
				text(`Range ${duration(entry.min)}–${duration(entry.max)} · IQR ${duration(entry.q1)}–${duration(entry.q3)}`);
				const status = entry.status === "passed" ? "All measured exits succeeded" :
					entry.status === "failed" ? "FAILED: nonzero measured exits; comparisons disabled" : "Exit codes not recorded; comparisons disabled";
				text(th.fg(entry.status === "passed" ? "success" : "warning", status));
				if (entry.user !== undefined || entry.system !== undefined) {
					text(`Mean CPU time: user ${duration(entry.user)} · system ${duration(entry.system)}`);
				}
				if (entry.memory) text(`RSS median ${memory(entry.memory.median)} · peak ${memory(entry.memory.peak)}`);
				if (entry.cv !== undefined && entry.cv > 0.05) text(th.fg("warning", "CV exceeds 5%: inspect variability (heuristic)."));
				if (!entry.mean) text(th.fg("warning", "Zero timing: comparison unavailable; check measurement resolution."));
				if (entry.n < 20) text(th.fg("muted", "Few samples: tail percentile estimates have limited resolution."));
				lines.push("");
			}
			text("SD is sample standard deviation; p95 uses linear interpolation of measured samples.");
			text("Δ mean = (case / baseline − 1) × 100%; negative is faster. These are descriptive statistics, not significance tests.");
		} else if (this.tab === 1) {
			const entry = run.cases[this.sampleCase];
			field("Case", `${this.sampleCase + 1}/${run.cases.length} · ${entry.label} (c to switch)`);
			text(`Measured runs in execution order · ${entry.n} samples`);
			lines.push("");
			this.histogram(entry, Math.max(1, width), text);
			lines.push("");
			for (const [index, time] of entry.times.slice(0, 200).entries()) {
				text(`${String(index + 1).padStart(4)}  ${duration(time)}  exit ${entry.exitCodes?.[index] ?? "not recorded"}`);
			}
			if (entry.n > 200) text(`Showing the first 200 of ${entry.n} samples; every sample is included in statistics.`);
			field("All samples", path.join(run.directory, "hyperfine.json"));
		} else {
			const m = run.manifest;
			field("Title", m.options.title);
			field("ID", m.id);
			field("Imported", m.importedAt);
			field("Measurement environment", m.options.environment);
			field("Conditions / inputs / caches", m.options.conditions);
			field("Warmup runs per case", m.options.warmup);
			field("Hyperfine invocation / version", m.options.invocation);
			for (const [index, entry] of run.cases.entries()) {
				lines.push("");
				text(th.fg("accent", `${index + 1}. ${clean(entry.label)}`));
				field("Exact measured command", entry.info.command);
				field("Exported command/name", entry.exportedCommand);
				field("Measured revision", entry.info.revision);
				field("Build configuration", entry.info.build);
				field("Case notes", entry.info.notes);
			}
			lines.push("");
			text(th.fg("muted", "Recorder context below describes this import, not necessarily the measurement host or revision."));
			field("Recorder host", m.recorder.hostname);
			field("Recorder system", `${m.recorder.os} · ${m.recorder.arch}`);
			field("Recorder hardware", `${m.recorder.cpu} · ${memory(m.recorder.ram)} RAM`);
			field("Recorder working directory", m.repository.cwd);
			field("Recorder repository", m.repository.root);
			field("Recorder HEAD", m.repository.head);
			field("Recorder changes", m.repository.dirty === undefined ? undefined : m.repository.dirty ? "Dirty" : "Clean");
			field("Original import path", m.source);
			field("Saved raw export", path.join(run.directory, "hyperfine.json"));
			field("Saved metadata", path.join(run.directory, "manifest.json"));
			field("Raw export SHA256", m.sha256);
		}
		return lines.map((line) => truncateToWidth(line, width));
	}
	private histogram(entry: BenchmarkCase, width: number, text: (line: string) => void) {
		if (entry.min === entry.max) { text(`All samples: ${duration(entry.min)}`); return; }
		const bins = Array.from({ length: Math.min(10, entry.n) }, () => 0);
		for (const time of entry.times) bins[Math.min(bins.length - 1, Math.floor((time - entry.min) / (entry.max - entry.min) * bins.length))]++;
		const maximum = Math.max(...bins);
		text("Distribution (equal-width bins)");
		for (const [index, count] of bins.entries()) {
			const lower = entry.min + (entry.max - entry.min) * index / bins.length;
			const upper = entry.min + (entry.max - entry.min) * (index + 1) / bins.length;
			const label = `${duration(lower)}–${duration(upper)}`;
			const room = Math.max(1, Math.min(30, width - visibleWidth(label) - 10));
			text(`${label} ${this.theme.fg("accent", "█".repeat(Math.round(count / maximum * room)))} ${count}`);
		}
	}
}
