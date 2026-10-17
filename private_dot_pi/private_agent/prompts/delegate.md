---
description: Coordinate durable Pi subagent jobs with assigned worktrees and verified results
argument-hint: "<task, roles, or parallel investigations>"
---
Delegate this request:

$ARGUMENTS

Follow the shared AGENTS.md instructions and any repository guidance.

1. You MUST establish the task, working directory, baseline, and expected result.
   Use the subagent tool with agentScope "user" and the installed roles: scout
   for code discovery, planner for a grounded plan, reviewer for an independent
   review, and worker for implementation. Pass a self-contained task with
   relevant absolute paths, constraints, and expected output because children
   have their own conversations. They inherit this session's model and thinking
   level and load the shared AGENTS.md.
2. You MUST choose single, parallel tasks, or a sequential chain to match the
   dependencies. Parallelize independent investigations; use "{previous}" in
   chain tasks when a later step needs the prior result. Children have explicit
   tool lists and do not delegate further. Perform Builder MCP lookups in the
   parent and pass the relevant evidence when a child needs it.
3. You MUST give each worker explicit files ownership: repository-relative files,
   or directory prefixes ending in "/", such as ["src/", "tests/"]. Omit cwd to
   let the coordinator create a distinct wt worktree carrying the source's
   current tracked and untracked working contents. Ignored files, build outputs,
   and submodule working contents are not carried. If choosing an existing
   worktree, use wt and pass its absolute path as cwd. The coordinator rejects
   the parent's worktree, unrelated repositories, and concurrent writers sharing
   a directory. Use worktreeFrom with an earlier chain step number to have a
   reviewer or later worker continue in that step's worktree.
4. You MUST wait for results and inspect status, findings, and validation evidence
   before proceeding. Jobs save their manifest, native sessions, logs, summaries,
   and worktree paths automatically. In chains, "{previous}" points to a file
   containing prior findings. If interrupted, use the subagent tool's resume
   field with the saved job ID; completed tasks are retained and unfinished tasks
   continue with their original sessions and directories. Inspect an uncertain
   outcome with the status field before starting another job.
5. You MUST resolve contradictory findings and verify the final change. Treat
   file-ownership and HEAD violations as failures: inspect the retained worktree
   and report them instead of discarding changes. Integrate only when appropriate
   for the user's request; the coordinator preserves worktrees for review.
6. You MUST return the outcome, job ID, evidence, checks, worktree paths, and
   unresolved issues. Record unrelated bugs identified by agents that lack Beans
   access, using Beans from `~/repos` with repository and task tags.
