# Changelog

## 0.1.0

Initial release — a port of `pi-rtk-optimizer` to the DeepSeek Harness plugin
model.

### Command rewriting

- Rewrites `bash`/`pwsh` commands to their rtk equivalents by delegating to
  `rtk rewrite`; rtk remains the only source of rewrite rules.
- Honors rtk's exit-code contract: `0`/`3` carry a rewrite on stdout, `1` means
  no equivalent, `2` means rtk refused and stderr explains why.
- `rewrite` and `suggest` modes, plus a runtime guard that runs the original
  command whenever rtk cannot be proven available.
- Scopes an isolated `RTK_DB_PATH` onto rewritten commands so rtk's usage
  history does not reach the working tree.
- Restores the original arguments as soon as dispatch returns, so the session
  log and later pipeline stages keep seeing the call the model made.

### Output compaction

- Multi-stage pipeline over `bash`, `read`, and `grep` results: ANSI stripping,
  build filtering, test aggregation, git compaction, linter aggregation, search
  grouping, source filtering, smart truncation, and hard truncation.
- Preserves the harness result contract: `[exit code: N]`, `[stderr]`,
  `[timed out after …]`, `[sandbox: …]`, and truncation markers are lifted out
  before the body is rewritten and restored verbatim afterwards.
- Never inflates a result — a technique that would not shrink the text is
  discarded and reported as no change.
- Lossy `read` compaction and source filtering are off by default, and every
  numeric bound is clamped on load.

### Configuration and commands

- Full configuration surface mirroring `pi-rtk-optimizer`'s documented
  defaults, registered as the `dsh-rtk` settings namespace with the
  composition's `config:` block as its base layer.
- `/rtk`, `/rtk show`, `/rtk path`, `/rtk verify`, `/rtk stats`,
  `/rtk clear-stats`, `/rtk reset`, and `/rtk help`.
- Session savings metrics by tool and by technique.

### Notes on the port

- Streamed bash output is not sanitized: the harness has no equivalent of Pi's
  `tool_execution_*` hooks.
- The Windows-specific shell fixups and the hashline/anchor-safe read handling
  are not ported; the target deployment is POSIX with the harness's own `read`
  format.
- A host-plane row and a preset row both want the same process-global settings
  namespace. The second instance to mount now follows the first through the
  settings event instead of failing the mount.
