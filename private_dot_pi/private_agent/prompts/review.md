---
description: Review changes for concrete bugs, regressions, and missing coverage
argument-hint: "[commit, branch, paths, or review focus]"
---
Review this scope or focus:

${@:-All current changes, including staged, unstaged, and relevant untracked files.}

Follow the shared AGENTS.md instructions and any repository review guidance.

1. You MUST establish the requested scope using Git status and diffs. For a branch
   comparison, identify the merge base; for a commit, inspect its patch. Preserve
   source files and Git state because this command is a review, not an implementation
   task.
2. You MUST read the changed code and the surrounding callers, invariants, and tests.
   Prioritize correctness, regressions, error handling, security, concurrency, and
   performance. Distinguish actionable defects from stylistic preferences.
3. You MUST substantiate each finding with a concrete trigger, affected behavior,
   and code location. Run focused checks or an end-to-end reproduction when needed
   to resolve uncertainty; report checks you could not run. Record unrelated bugs
   with Beans from `~/repos`, tagging the repository and the review task.
4. You MUST present actionable findings in severity order with file and line,
   impact, supporting evidence, and a suggested direction. If there are no findings,
   say so and state the checks performed and remaining coverage gaps. Do not invent
   findings to fill the report.
