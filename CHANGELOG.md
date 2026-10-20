# Changelog

## Unreleased

### Added

- **Browser half with a row configuration page.** The package now exports
  `./client` and declares `dsh.client`, so the Web Plugins page shows a
  **Configure** control on the `rtk` row. The page renders the five fields,
  stages edits locally, commits them through the host settings service (the same
  user layer `/rtk reset` clears), and marks overridden fields with a per-field
  reset.
- **Gain panel, wired to the ledger.** Below the form, the Configure page now
  shows what rtk reclaimed: a 20-cell efficiency meter, a ledger of original
  output / after rtk / saved (with the share), command count and average time,
  and a breakdown that switches between **by day** and **by command** (the
  command table is aggregated read-only from the ledger's `commands` table,
  because neither `rtk gain` format carries one; every column header explains
  itself through a tooltip). A value is read
  from `rtk gain -d -f json` on the host, always with `RTK_DB_PATH` pointed at
  this plugin's isolated history database, and can be sliced by **workspace**
  (`rtk gain -p`; the picker is the host's `workspaceRegistry.list()`, with the
  ledger's `project_path` rows as the fallback) and by
  **time** (today / last 7 days / last 30 days / all time, filtered in UTC to
  match rtk's own day grouping). The browser reads it through the host's exact
  fetch route `/api/dsh-rtk/gain`, which the host registers on the connection's
  authenticated `/api` prefix only when that service exists; a CLI host simply
  reports the ledger as unavailable. Reports are cached for 30 seconds and the
  refresh button bypasses the cache.
- `src/gain.ts` owns that host side: argument shape, UTC window slicing,
  verbatim-path normalization, read-only `node:sqlite` workspace/command
  aggregation, and the 30-second report cache. `runExecutable` gained an optional `cwd` so
  the workspace filter can run `rtk gain` inside the selected project.
- `test/client-bundle.test.ts` pins the client contract: the
  `window.__ModuleLoader__.load` wrapper and its package-name id, the
  `plugins.row.config` registration key `@wingsbutterfly/dsh-rtk#rtk`, the
  five rendered controls, the workspace/range controls, and the ledger
  formatters. `test/gain.test.ts` covers the host reader.

- `/rtk gain [flags]`: runs `rtk gain` against the plugin's own history database
  (`RTK_DB_PATH`), so the savings of commands this plugin rewrote are queryable
  from the command line instead of only by hand-pointing a terminal at
  `%LOCALAPPDATA%\Temp\dsh-rtk\history.db`. Extra flags pass through
  (`-H`, `-g`, `-f json`, …); `--reset` and `--yes` are refused because they
  would erase the ledger.
- `dsh.bundle` metadata (`dsh.bundle.patch` → [`cordis.patch.yml`](cordis.patch.yml)):
  `dsh plugin --profile <name> add @wingsbutterfly/dsh-rtk` now installs **and**
  mounts the plugin. The bundle layer inserts the host-plane `rtk` row, the same
  row the manual `cordis.patch.yml` mount used to require.
- dsh-ops support: `ops_bash` joins `REWRITABLE_TOOLS` and the compaction
  pipeline (`bash`, `read`, `grep`, `ops_bash`, `ops_grep`), so dsh-ops
  sessions get both command rewriting and output compaction. `ops_grep` reuses
  the grep summarizer, with one guard: dsh-ops renders its Rust tools as a
  single `JSON.stringify` line, which the match-list heuristic would mis-read
  as "1 matches in 1 files" — JSON bodies are therefore left byte-exact.
- `test/bundle-manifest.test.ts` pins the manifest contract: the declared patch
  path, the patch's presence in `files`, and the inserted row's `id`/`name`.

### Fixed

- **The rtk executable setting is filled in automatically, including on
  Windows.** Resolution ran on every call while the `rtkExecutable` field kept
  reading the bare name, and a Windows harness whose PATH predated the install
  (WinGet, cargo and Scoop each add their shim directory to the *user* PATH)
  silently failed the single `where` lookup. The resolver now asks the platform
  command first, then checks the Windows install directories (WinGet Links,
  `%USERPROFILE%\.cargo\bin`, `%USERPROFILE%\scoop\shims`), running each
  candidate with `--version` before trusting it. The path it finds is written
  back into the setting through `settings.mutate`, so the configuration page
  shows it; when nothing is found the field is written empty. Only values the
  plugin owns (empty, the shipped `rtk` default, its own earlier write, or a
  path that no longer exists) are rewritten, so a hand-typed value survives, and
  a read-only profile (a home-patch row) refuses the write without disturbing the
  runtime.
- `/rtk <subcommand>` was delivered to the model as a chat message: the command
  definition declared no `input`, and the harness client only routes a
  space-argument line to a command that declares one (bare `/rtk` worked because
  it does not need arguments). The definition now carries
  `input: { hint: 'show | path | verify | stats | clear-stats | reset | help' }`,
  pinned by a `plugin-surface` test.
- **Gain panel failed with `HTTP 405`.** The host tried the connection's
  generic RPC channel (`connection.rpc.handle('/dsh-rtk', …)`), whose route
  registration reads `webServer` from the *connection service's own* Context —
  a Context that injects only `credentials`, so the read throws
  (`cannot get property "webServer" without inject`) and no route is ever
  installed. `POST /dsh-rtk/gain` then fell through to the SPA fallback, which
  answers 405. The panel now uses an **exact Fetch route**
  (`/api/dsh-rtk/gain`) registered through `connection.fetch.register`, the
  same authenticated `/api` transport the shipped file-upload package uses. A
  failed registration is logged instead of taking the rewriting and compaction
  halves down.

### Changed

- **Configuration reduced from 26 fields to 5**: `mode` (`off` | `rewrite` |
  `suggest`), `compact`, `maxChars`, `readCompaction` (`none` | `budget` |
  `minimal` | `aggressive`), and `rtkExecutable`. Retired fields are migrated by
  `normalizeConfig` rather than ignored: `enabled: false` → `mode: off`,
  `outputCompaction.enabled` → `compact`, `truncate.maxChars` → `maxChars`, and
  the three read-compaction fields collapse into the single level. Every other
  removed switch now sits at its previous default: `guardWhenRtkMissing`,
  `notifyWhenRtkMissing`, `trackSavings`, `stripAnsi`, the five output
  summarizers, `preserveExactSkillReads` and `truncate.enabled` stay on;
  `showRewriteNotifications` stays off; `rewriteTimeoutMs` stays 3000;
  `compactedTools` stays the five tools with a compactor. Spill deferral is
  detected from the mounted `spillStore` service instead of configured.
- `readCompaction` gained `budget`: bounds a `read` result by the character
  budget without filtering source text — the behavior the old "enabled but not
  filtering" combination produced.
- `/rtk` now prints the five effective fields instead of the retired switch
  tree.
- **Scope decision revised (supersedes the 2026-10-11 entry).** A bundle patch
  can only append rows to the root entry list, and root rows are instantiated
  once per host process, so the mounted row's `tools/execute` /
  `tools/post-execute` listeners are process-global: every session in the
  profile gets rewriting and compaction, with no per-preset opt-in. The previous
  "declare no `dsh.bundle`, stay agent-plane-first" position bought per-preset
  opt-in at the cost of a manual mount line and an "installed, not active"
  plugin-manager state. The bundle is now the default channel because
  one-command installation is worth more than preset granularity; per-preset
  use remains possible by skipping the bundle channel and adding the row to a
  preset by hand (README, "Per-preset instead of global"). `mode: off`
  and `mode: suggest` stay the switches that tame the global row — including
  from a non-insert profile override (`- id: rtk` + full `config:`).

### Docs

- The install section now describes the bundle channel: install mounts a
  host-plane row that covers every session in the profile, and the manual mount
  line must be deleted when switching (two mounts, one id). Both READMEs also
  keep the per-preset recipe and the "installed, not active" troubleshooting
  line for the no-bundle path.

## 0.1.2

### Harness compatibility

- Runs on dsh 0.2.0 (0.2.0-rc.1 and 0.2.0-rc.2). No plugin code changed: the
  seams it hangs on are untouched in 0.2.0 — `tools/execute` and
  `tools/post-execute` with the same signatures, the `bash`/`pwsh` tool names,
  the trailing `[exit code: N]` marker, and the settings surface
  (`SettingsForms.replace`, `loader/volatile-update`). `diff -rq` over the
  `lib/types` of 0.2.0-rc.1 and 0.2.0-rc.2 reports no difference, and the full
  suite passes against both: 130/130 against the locally installed 0.2.0-rc.1
  and 130/130 against a fresh 0.2.0-rc.2 pulled from npm
  ([`docs/verification.md`](docs/verification.md) §12).
- Peer ranges now include the 0.2.0 train: `^0.1.5-rc.1 || ^0.1.7-rc.2 ||
  ^0.2.0-rc.1` for each `@deepseek-ai/dsh-*` package. That clause matches
  0.2.0-rc.1, 0.2.0-rc.2 and 0.2.0 itself, and deliberately not 0.2.1-alpha.1
  (`semver.satisfies` verified for all five). Installing on a 0.2.0 host no
  longer reports an unsatisfied peer.
- devDependencies moved to 0.2.0-rc.2, so CI typechecks against the newest
  harness instead of the 0.1.7 one.
- New guard test: `test/harness-compat.test.ts` fails whenever a `dsh-*`
  devDependency moves to a new rc train without a matching peer-range clause —
  the exact drift 0.1.1 shipped with.

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