import { stripVTControlCharacters } from "node:util";
import { duration, relativeChange, type BenchmarkCase, type SavedBenchmark } from "./results.ts";

const text = (value: string) => stripVTControlCharacters(value)
	.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "").replace(/\r\n?/g, "\n");
const markdown = (value: unknown) => value === undefined || value === "" ? "Not recorded" : text(String(value))
	.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
	.replace(/[\\`*_{}\[\]()#+!|]/g, "\\$&").replace(/\n/g, "<br>");
const memory = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const percent = (value: number | undefined) => value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;

// baselineIndex is the view's zero-based selection, including an explicit "none".
export function benchmarkMarkdown(run: SavedBenchmark, baselineIndex: number | undefined): string {
	const baseline = baselineIndex === undefined ? undefined : run.cases[baselineIndex];
	const columns = [
		...(baseline ? [{ entry: baseline, label: `Baseline: ${markdown(baseline.label)}` }] : []),
		...run.cases.filter((_, index) => !baseline || index !== baselineIndex)
			.map((entry) => ({ entry, label: `Current: ${markdown(entry.label)}` })),
	];
	const lines = [
		`| Metric | ${columns.map((column) => column.label).join(" | ")} |`,
		`| --- | ${columns.map(() => "---:").join(" | ")} |`,
	];
	const metrics: [string, (entry: BenchmarkCase) => string][] = [
		["Status", (entry) => entry.status],
		["Runs", (entry) => String(entry.n)],
		["Mean", (entry) => duration(entry.mean)],
		["Median", (entry) => duration(entry.median)],
		["SD", (entry) => duration(entry.stddev)],
		["p95 estimate", (entry) => duration(entry.p95)],
		["Minimum", (entry) => duration(entry.min)],
		["Maximum", (entry) => duration(entry.max)],
		["Q1", (entry) => duration(entry.q1)],
		["Q3", (entry) => duration(entry.q3)],
		["CV", (entry) => percent(entry.cv)],
	];
	if (run.cases.some((entry) => entry.user !== undefined)) metrics.push(["Mean CPU user", (entry) => duration(entry.user)]);
	if (run.cases.some((entry) => entry.system !== undefined)) metrics.push(["Mean CPU system", (entry) => duration(entry.system)]);
	if (run.cases.some((entry) => entry.memory)) {
		metrics.push(["RSS median", (entry) => entry.memory ? memory(entry.memory.median) : "—"]);
		metrics.push(["RSS peak", (entry) => entry.memory ? memory(entry.memory.peak) : "—"]);
	}
	metrics.push(["Mean change vs baseline", (entry) => {
		const change = entry === baseline ? undefined : relativeChange(entry, baseline);
		return change === undefined ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
	}]);
	for (const [label, value] of metrics) {
		lines.push(`| ${label} | ${columns.map((column) => value(column.entry)).join(" | ")} |`);
	}
	return lines.join("\n") + "\n";
}
