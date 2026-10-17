import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Box, Image, SelectList, ScrollView, Text, backgroundAnsi, parseColor, getCapabilities,
	matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI,
} from "@earendil-works/pi-tui";
import { PlotStore, readFile, type SavedPlot } from "./store.ts";

const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const palette = ["dim", "error", "success", "warning", "accent", "thinkingHigh", "mdQuote", "text"] as const;

function colors(text: string, theme: Theme) {
	let color: (typeof palette)[number] = "text";
	return text.split(/(\x1b\[[\d;]*m)/).map((part) => {
		if (/^\x1b\[/.test(part)) {
			const codes = part.slice(2, -1).split(";").map(Number);
			for (const code of codes) {
				if (code === 0 || code === 39) color = "text";
				else if (code >= 30 && code <= 37) color = palette[code - 30];
				else if (code >= 90 && code <= 97) color = palette[code - 90];
			}
			return "";
		}
		return theme.fg(color, stripVTControlCharacters(part).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""));
	}).join("");
}

export class TerminalPlot implements Component {
	private cache = new Map<string, string>();
	private pending?: Promise<void>;
	private wanted = "";
	private current = "";
	private error?: string;
	constructor(
		private store: PlotStore, private run: SavedPlot, private index: number,
		private theme: Theme, private redraw: () => void, private height = 14,
	) {
		const file = path.join(run.directory, run.manifest.charts[index].stem + ".txt");
		if (fs.existsSync(file)) this.current = readFile(file).toString();
	}
	invalidate() {}
	async ready() { await this.pending; }
	render(width: number): string[] {
		this.wanted = `${width}:${this.height}`;
		const cached = this.cache.get(this.wanted);
		if (cached !== undefined) this.current = cached;
		else if (!this.pending && width >= 20) {
			const key = this.wanted;
			this.pending = this.store.preview(this.run, this.index, width, this.height).then((text) => {
				this.cache.set(key, text);
				while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
				if (key === this.wanted) this.current = text;
				this.error = undefined;
			}).catch((error) => {
				this.error = clean(String(error));
				this.cache.set(key, this.error);
			}).finally(() => {
				this.pending = undefined; this.redraw();
			});
		}
		const source = this.error ? this.theme.fg("error", this.error) : this.current ? colors(this.current, this.theme) : "Rendering preview…";
		return source.trimEnd().split("\n").map((line) => truncateToWidth(line, Math.max(1, width)));
	}
}

export class PlotView implements Component {
	private runs: ReturnType<PlotStore["list"]>;
	private selected?: SavedPlot;
	private history: SelectList;
	private index = 0;
	private preview?: TerminalPlot;
	private error?: string;
	private panel: Box;
	private scroll: ScrollView;
	constructor(
		private store: PlotStore, key: string, private tui: Pick<TUI, "terminal" | "requestRender">,
		private theme: Theme, private done: () => void, id?: string,
	) {
		this.runs = store.list(key);
		if (id && !this.runs.some((run) => run.id === id)) this.runs.unshift(store.load(id).manifest);
		this.history = new SelectList(this.runs.map((run) => ({
			value: run.id, label: clean(run.charts[0].title || "Plot"), description: `${run.charts.length} chart(s) · ${run.id}`,
		})), 3, {
			selectedPrefix: (s) => theme.fg("accent", s), selectedText: (s) => theme.fg("accent", s),
			description: (s) => theme.fg("muted", s), scrollInfo: (s) => theme.fg("dim", s), noMatch: (s) => s,
		});
		this.scroll = new ScrollView({ render: (width) => this.content(width), invalidate() {} }, { overscroll: "contain" });
		this.history.onSelectionChange = (item) => { this.select(item.value); this.changed(); };
		this.history.setSelectedIndex(Math.max(0, this.runs.findIndex((run) => run.id === id)));
		const item = this.history.getSelectedItem();
		if (item) this.select(item.value);
		this.panel = new Box(0, 0, (text) => {
			const bg = theme.name?.startsWith("kanso") ? parseColor("#14171d") : theme.colors.userMessageBg;
			const ansi = backgroundAnsi(bg, theme.getColorMode());
			return theme.style(text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + ansi), { bg });
		});
		this.panel.addChild({ render: (width) => this.frame(width), invalidate() {} });
	}
	invalidate() { this.scroll.invalidate(); this.panel.invalidate(); }
	private changed() { this.invalidate(); this.tui.requestRender(); }
	private select(id: string) {
		try { this.selected = this.store.load(id); this.error = undefined; }
		catch (error) { this.error = clean(String(error)); this.selected = undefined; }
		this.index = 0; this.resetPreview();
	}
	private resetPreview() {
		this.scroll.scrollToStart();
		this.preview = this.selected ? new TerminalPlot(this.store, this.selected, this.index, this.theme, () => this.changed(), 14) : undefined;
	}
	handleInput(data: string) {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") { this.done(); return; }
		if (matchesKey(data, "up") || matchesKey(data, "down")) { this.history.handleInput(data); return; }
		if ((matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) && this.selected) {
			this.index = (this.index + (matchesKey(data, "left") ? this.selected.manifest.charts.length - 1 : 1)) % this.selected.manifest.charts.length;
			this.resetPreview();
		} else if (data === "o" && this.selected) {
			const file = path.join(this.selected.directory, this.selected.manifest.charts[this.index].stem + ".png");
			execFile(process.platform === "darwin" ? "open" : "xdg-open", [file], (error) => {
				if (error) { this.error = clean(error.message); this.changed(); }
			});
			return;
		} else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
		else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
		else if (data === "j") this.scroll.scrollBy(1);
		else if (data === "k") this.scroll.scrollBy(-1);
		else return;
		this.changed();
	}
	render(width: number) { return this.panel.render(Math.max(1, Math.floor(width))); }
	private content(width: number) {
		const lines = this.preview?.render(width) ?? ["No saved plots. Use /plot import <chart.json>, or /bench plot."];
		if (this.error) lines.unshift(this.theme.fg("error", this.error));
		if (this.selected) {
			const chart = this.selected.manifest.charts[this.index];
			for (const note of chart.notes) lines.push(...wrapTextWithAnsi(this.theme.fg("muted", clean(note)), width));
			lines.push("");
			for (const extension of ["png", "svg"]) lines.push(...wrapTextWithAnsi(path.join(this.selected.directory, chart.stem + "." + extension), width));
		}
		return lines;
	}
	private frame(width: number) {
		const height = Math.max(1, Math.floor(this.tui.terminal.rows * .9) - 2);
		const bordered = width >= 4 && height >= 4;
		const inner = Math.max(1, width - (bordered ? 4 : 0));
		const header = [this.theme.fg("accent", this.theme.bold(" Plots ")), ...this.history.render(inner)];
		if (this.selected) header.push(this.theme.fg("accent", `${this.index + 1}/${this.selected.manifest.charts.length} · ${clean(this.selected.manifest.charts[this.index].title)}`));
		const footer = wrapTextWithAnsi(this.theme.fg("dim", "↑↓ history · ←→/Tab chart · PgUp/PgDn or j/k scroll · o open PNG · Esc close"), inner);
		const room = Math.max(1, height - (bordered ? 2 : 0) - header.length - footer.length);
		const content = this.scroll.render(inner);
		this.scroll.updateLayout(content.length, room, () => this.tui.requestRender());
		const body = content.slice(this.scroll.scrollTop, this.scroll.scrollTop + room);
		while (body.length < room) body.push("");
		const lines = [...header, ...body, ...footer].slice(0, height - (bordered ? 2 : 0)).map((s) => truncateToWidth(s, inner));
		if (!bordered) return lines;
		const side = this.theme.fg("border", "│");
		return [
			this.theme.fg("border", "╭" + "─".repeat(width - 2) + "╮"),
			...lines.map((s) => `${side} ${s}${" ".repeat(Math.max(0, inner - visibleWidth(s)))} ${side}`),
			this.theme.fg("border", "╰" + "─".repeat(width - 2) + "╯"),
		];
	}
}

export function toolPreview(store: PlotStore, run: SavedPlot, theme: Theme, redraw: () => void, showImages: boolean): Component {
	if (showImages && getCapabilities().images) {
		const file = path.join(run.directory, run.manifest.charts[0].stem + ".png");
		const image = new Image(readFile(file).toString("base64"), "image/png",
			{ fallbackColor: (s) => theme.fg("muted", s) }, { filename: file, maxHeightCells: 25 });
		const title = new Text(theme.fg("accent", run.manifest.charts[0].title), 0, 0);
		return { render: (width) => [...title.render(width), ...image.render(width)], invalidate: () => image.invalidate() };
	}
	return new TerminalPlot(store, run, 0, theme, redraw);
}
