# Agent Note: command rewriting rides `tools/execute`

Status: accepted, knowingly outside the documented contract.

## Problem

The plugin's whole point is that a command the model wrote can run as its rtk
equivalent. The harness offers three interception points, and none of them is
documented as an input-rewrite hook:

- `tools/pre-execute` decides allow/deny/ask, and the call is logged and
  presented from its arguments — rewriting there would make the log a lie.
- `tools/post-execute` runs after the body, too late.
- `tools/execute` is documented for "timeout, retry, or metrics", with the
  explicit constraint that wrappers "may change only `exec.signal`".

## Decision

Rewrite `exec.arguments` in a `tools/execute` wrapper, scoped to one dispatch,
and restore the original in `finally` so `tools/post-execute`, content
finalization, and `tools/result` all observe the call the model made. Every
failure path falls back to the original command.

## Alternatives considered

- **Re-register the bash tool with a rewriting executor.** Rejected: the
  registry resolves the visible definition per name, and a second definition in
  the same layer does not shadow the first — the harness silently keeps the
  original tool, so users would see no effect and no error.
- **Register a `ctx.tools.guard()` that denies non-rtk commands.** Rejected:
  guards are monotonic denials; turning ordinary commands into denials breaks
  the user's work.
- **Ship a `ctx.shell` backend that rewrites argv.** Rejected as a bigger
  contract break: it would replace the harness's own shell execution for every
  tool, not just the ones this plugin rewrites.
- **Wait for the proposed pre-tool input-rewrite extension point.** Correct in
  principle; tracked in the README caveat. Not usable today.

## Consequences

If the harness ever freezes the execution object before dispatch, rewriting goes
quiet: commands run unrewritten, compaction is unaffected, and nothing throws.
The plugin's own integration test can only prove the behaviour against the
harness version it runs on, so the README caveat — not the test suite — is the
disclosure that this seam is unsanctioned.
