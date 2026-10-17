---
description: Reproduce a bug end to end and leave a minimal regression case
argument-hint: "<bug description, issue, or failing command>"
---
Create a minimal, repeatable end-to-end reproduction for:

$ARGUMENTS

Follow the shared AGENTS.md instructions and any repository instructions.

1. You MUST identify the expected behavior, actual behavior, and relevant version
   or revision. If the request has no bug description, use the current conversation
   or ask for the missing input.
2. You MUST reproduce the failure through the real application or public entry
   point before changing implementation code. For DuckDB and its extensions,
   try sqllogictest first; use a C++ test only when SQL cannot express the failure.
   If the failure does not reproduce, report the command, environment, and result
   without claiming a root cause.
3. You MUST reduce the failing input and required setup while checking that each
   reduction still exhibits the same failure. Preserve existing work; use `wt`
   when an isolated checkout is needed. Compile C++ with Ninja and use the
   reldebug target unless the task requires a different configuration.
4. You MUST leave the smallest appropriate reproduction or regression test and
   rerun it. Keep production code unchanged because this command establishes the
   failing case before a fix. Record unrelated bugs with Beans from `~/repos`,
   tagging the repository and the reproduction task.
5. You MUST report the exact reproduction command, test or input path, expected
   and actual results, relevant environment details, and any remaining uncertainty.
