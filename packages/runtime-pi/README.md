# `@emi-harness/runtime-pi`

`runtime-pi` is the only package allowed to depend on Pi. It implements the neutral `PiRuntimePort` used by the future EMI Control Plane and isolates the rest of EMI Harness from Pi types and defaults.

## Pinned upstream contract

- `@earendil-works/pi-ai`: `0.84.2`
- `@earendil-works/pi-agent-core`: `0.84.2`
- `@earendil-works/pi-coding-agent`: `0.84.2`
- Reviewed Pi source commit: `59a71b235dadb4ad0d67557a8abb0aaa093e68b4`

Upgrading any Pi package requires updating all three versions together and rerunning the contract tests.

## Enforced boundary

- The adapter always injects `ControlledResourceLoader`; Pi does not discover project or user resources.
- Pi's ambient `models.json`, `auth.json`, environment credential fallback, and model-catalog network refresh are not used. The caller must provide an explicit API-key resolver, while the model catalog comes from the pinned Pi packages.
- Pi settings and Pi sessions are in memory for this step and do not become EMI workflow state.
- The tool list is always explicit, including the empty list.
- Pi built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools are rejected.
- Only custom tools supplied by the caller can enter a session, and their names are checked after Pi creates the session.
- Pi events are converted into EMI-owned event types without exposing Pi message or result objects. Every event carries Run ID, Role Run ID, role, and Pi Session ID for explicit correlation.
- Agent termination is classified as `completed`, `aborted`, `error`, `incomplete`, or `unknown`; an abort is not reported as successful completion.
- `run()` returns that EMI-owned terminal result directly. Runtime transport failures remain exceptions, so the Control Plane does not have to infer success from Pi messages.
- Runtime event listeners are delivered in order and may be asynchronous. Listener failures cannot interrupt Pi, but `run()` rejects after Pi settles so evidence delivery failures are not hidden.

## Current limits

This package does not yet implement persistent EMI task state, a Tool Gateway, an isolated executor, governed Skills, an Evidence Store, or production credential management. Those belong to later Roadmap steps and must not be added to the Agent loop.

## Verification

```bash
pnpm --filter @emi-harness/runtime-pi check
```

The contract suite uses Pi's public faux provider, so it executes a complete prompt, tool call, tool result, final response, and active-request abort without network access or a real model credential. It also builds the package and checks that the public declaration graph exposes no Pi types.
