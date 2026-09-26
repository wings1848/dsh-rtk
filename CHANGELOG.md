# Changelog

## 0.1.1

### Harness compatibility

- Runs on both dsh 0.1.5 and dsh 0.1.7. The 0.1.7 release replaced the settings
  provider (`SettingsProvider` / `register` / `settings/updated`) with
  `SettingsForms` plus live config references updated in place; the settings
  integration now sits behind one bridge that detects which generation it is
  talking to ([`src/settings-compat.ts`](src/settings-compat.ts)), and imports
  no runtime type from `@deepseek-ai/dsh-settings` — that package is exactly
  the one that changed, so structural typing is what keeps the next change
  cheap.
- Fixed a hard failure on 0.1.7: the old fallback path called `settings.get()`,
  which the new service does not have, so `apply()` threw
  `TypeError: settings.get is not a function` and took the whole plugin down —
  rewriting, compaction, and `/rtk` together. An unrecognized settings surface
  now costs the live-editing integration only: the plugin degrades to
  composition-only configuration.
- Configuration fields are marked live-editable where the host's schemastery
  supports it, so on 0.1.7 the settings page is generated from the plugin's own
  schema. Note the namespace there is the composition row's id (`rtk` in the
  README's example), not the plugin's old hardcoded `dsh-rtk`.
- `/rtk reset` now reports what it actually did; with no writable settings
  layer it says so instead of claiming a reset that never happened.
- Peer ranges cover both generations (`^0.1.5-rc.1 || ^0.1.7-rc.2`). A
  prerelease range only matches its own `[major,minor,patch]` tuple, so each
  new harness rc train needs a one-line range bump here.
- Verified end-to-end in an isolated harness home against a real 0.1.7 host
  (six headless runs, evidence in
  [`docs/verification.md`](docs/verification.md) §11.6): rewriting, the quiet
  default, compaction's spill coordination, the `/rtk` command, and the modern
  settings entry all behave. One deployment caveat that surfaced there: a row
  in the home patch (`~/.dsh/cordis.patch.yml`) is settings-**read-only** on
  0.1.7 — the service refuses writes a lower layer would override, and
  `/rtk reset` reports the refusal. Profile-layer rows stay live-editable.

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
