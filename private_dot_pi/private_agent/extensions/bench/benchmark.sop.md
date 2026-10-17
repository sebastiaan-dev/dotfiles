# Reproducible Hyperfine benchmark

## Overview

Measure a workload, preserve its Hyperfine samples and provenance, and make
timing statistics available in Pi's `/bench` dashboard across sessions.
Follow shared AGENTS.md instructions and repository benchmarking guidance.

## Parameters

- **workload** (required): Runnable commands or a description of the operation,
  inputs and performance question to measure.
- **comparison** (optional): Requested baseline and candidate commands or source
  revisions. A single workload has no implied before/after comparison.

**Constraints for parameter acquisition:**

- You MUST infer provided parameters from the request and conversation first.
- If all required parameters are already provided, You MUST proceed to the Steps.
- If any required parameters are missing, You MUST ask for them before proceeding.
- When asking for parameters, You MUST request all parameters in a single prompt.
- When asking for parameters, You MUST use the exact parameter names as defined.

## Steps

### 1. Prepare valid measurements

Prepare runnable cases with known inputs and build settings.

**Constraints:**

- You MUST identify what the workload measures and the requested comparison.
- You MUST verify each command completes the intended work and produces expected
  results before timing. If validation fails, You MUST fix or report it before
  proceeding.
- You MUST preserve existing changes and use `wt` for isolated revisions.
- You MUST compile C++ with Ninja and use reldebug by default. You MUST record
  Rust build profiles, compiler options and other relevant toolchain settings.
- You MUST keep input data, thread counts, cache conditions and build settings
  consistent across cases, or explicitly document intentional differences.

### 2. Capture Hyperfine samples

Run timings and export machine-readable data to a temporary or designated file.

**Constraints:**

- You MUST use `hyperfine` with `--export-json` and record its exact invocation
  and version. You MUST choose appropriate warmups and repetition counts and
  record the actual values.
- You MUST reset mutable state consistently, distinguish cold and warm caches,
  and verify the benchmark measures execution rather than cached output.
- You MUST retain exact measured commands, including working directory setup,
  even when `--command-name` replaces commands with labels in the JSON export.
- You MUST keep raw samples in the export file and pass its path to
  `benchmark_results`, because deterministic processing avoids filling context
  with sample arrays.
- If a timing command fails, You MUST diagnose or report the failure before
  making performance claims. You MAY retain failed samples for inspection.

### 3. Save validated results and provenance

Make the export available in the dashboard without opening a modal mid-task.

**Constraints:**

- You MUST call `benchmark_results` with the completed export's `file` path,
  a useful `title`, `warmup`, `conditions`, `environment`, `invocation`, and
  `cases` in export order.
- You MUST include each case's exact command, measured source revision and dirty
  state, build settings, and any intentional differences or correctness checks.
- You MUST set a one-based `baseline` only when a comparison was requested.
- You MUST record the actual measurement environment. You MUST leave unknown
  metadata omitted and explain the limitation, because the importing machine
  and current HEAD may differ from where or what was measured.
- If the importer rejects the export or metadata, You MUST correct the reported
  problem and retry, or report the blocker. You MUST verify a saved benchmark ID
  was returned before claiming the results are saved.
- You MUST use `benchmark_results` in the parent session when subagents perform
  measurements, because subagents do not have this custom tool.

### 4. Explain the observed result

Report useful conclusions and the saved view command.

**Constraints:**

- You MUST report run counts, mean, median, sample standard deviation and any
  requested relative mean change from the tool's computed summary.
- You MUST explain failed or unverified exits, noisy samples, inconsistent
  conditions and other material limits before drawing conclusions.
- You MUST treat timing differences as descriptive observations rather than
  statistical significance claims. Sample p95 estimates have limited resolution
  at small run counts.
- You MUST provide `/bench view <saved-id>` so the user can inspect statistics,
  distributions, commands, revisions and raw artifacts.
- You SHOULD keep the final report concise rather than repeat all samples.
- You MAY profile when requested or when investigating an observed result;
  available tools include samply, pprof, gperftools and Valgrind.
- You MUST record unrelated bugs or inefficient code with Beans from `~/repos`,
  tagging the repository and benchmark task.

## Examples

### Single workload

Input: `workload` is "measure this Rust parser on fixtures/input.json".
Expected behavior: verify the output, use Hyperfine on the selected build,
save its JSON with the actual profile and input/cache settings, omit `baseline`,
and return the saved `/bench view` command.

### Baseline and candidate

Input: `workload` is "parse the same input"; `comparison` identifies two builds.
Expected behavior: use identical inputs and conditions, retain exact commands
even if labels are used, save both cases in export order with their revisions,
and choose the explicitly requested baseline.

## Troubleshooting

- No runnable workload: acquire the missing `workload` parameter.
- No Hyperfine: report the missing executable; the dotfiles Brewfile provides it.
- Rejected export: check the completed `--export-json` file, aligned case metadata,
  sample arrays, summary consistency and measured exit codes.
- Failed or noisy runs: inspect correctness and measurement conditions; rerun
  only when that resolves a concrete limitation.
- No saved view: call `benchmark_results` and verify its ID, then run `/bench`
  from the same repository or `/bench view <saved-id>` from any directory.
