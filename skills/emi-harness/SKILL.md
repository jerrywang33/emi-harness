---
name: emi-harness
description: Start or resume the EMI Harness v0.1 new-module design-to-delivery workflow with Coordinator, Executor, independent Verifier, evidence capture, bounded failure feedback, and user approval gates. Use when creating the approved emi-pilot calibration project, continuing an existing EMI Harness run-id, or asking an Agent to execute an Approved EMI Harness SDD.
---

# EMI Harness

## Resolve The Harness

1. Use `EMI_HARNESS_HOME` when it is set.
2. Otherwise read the single absolute path from `~/.emi-harness/path`.
3. Stop and ask the user to run `bash install.sh` from the Harness repository if the resolved path is invalid.
4. Record the resolved path and Git commit in the target run manifest; never infer a different checkout silently.

## Load The Entry Point

Read `$EMI_HARNESS_HOME/AGENTS.md`. Follow its role-specific loading map and source-priority rules. Do not load the entire repository.

Confirm `$EMI_HARNESS_HOME/specs/pilot/system-design.md` is `Approved` before creating or changing target code.

## Select The Run

- Treat requests to create the approved `emi-pilot` project as `new-module`.
- Resume the exact run when the user supplies a run-id or the target manifest identifies one active run.
- Stop for user clarification if multiple unfinished runs exist.
- Reject unsupported `new-feature`, `refactor`, regulatory knowledge, or evolution tasks in v0.1 instead of improvising a workflow.

## Execute The Workflow

Read and execute `$EMI_HARNESS_HOME/harness/workflow/new-module.md` in order.

- Preserve Coordinator, Executor, and Verifier context boundaries.
- Persist state and evidence before every role handoff.
- Stop at every required user approval gate.
- Use a new attempt for each failure return and stop after the third FAIL.
- Never mark the run complete before explicit user acceptance.

## Resume Safely

When resuming, treat the target manifest and referenced Git commits as the source of truth. Compare them with the actual repositories before acting. If state, path, evidence, or commit differs, record `BLOCKED` and surface the mismatch instead of reconstructing it from conversation history.

Do not use conversation claims as replacement evidence and do not modify completed attempt artifacts.
