# Changelog

## Unreleased

### Added

- **Display metadata for the Plugin Manager.** The package now ships
  `locale/en.json` and `locale/zh.json` (`meta.title` / `meta.description`)
  and an original `icon.svg`, all exported from `package.json`, so the Plugins
  page shows a real name, description and artwork instead of the bare package id.
  They are read without activating the plugin, which is why they exist as files
  rather than as client code.
- **`prepare` script.** A git-source install now builds `lib/` (TypeScript plus
  the browser bundle) instead of importing a package with no entry file.

- **Browser half with a row configuration page.** The package now exports
  `./client` and declares `dsh.client`, so the Web Plugins page shows a
  **Configure** control on the `rtk` row. The page renders the five everyday fields
  (`historyDbPath` stays a composition setting — see Changed), stages edits
  locally, commits them through the host settings service (the same
  user layer `/rtk reset` clears), and marks overridden fields with a per-field
  reset.
- **Gain panel, wired to the ledger.** Below the form, the Configure page now
  shows what rtk reclaimed: a 20-cell efficiency meter, a ledger of original
  output / after rtk / saved (with the share), command count and average time,
  and a breakdown that switches between **by day** and **by command** (the
  command table is aggregated read-only from the ledger's `commands` table,
  because neither `rtk gain` format carries one; every column header explains
  itself through a tooltip). A value is read
  from `rtk gain -d -f json` on the host, always with `RTK_DB_PATH` following
  the ledger this session actually writes, and can be sliced by **workspace**
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
  from the command line instead of only in the terminal. Extra flags pass through
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

### Testing

- **Keyless snapshots of the text the model and the user see.**
  `test/transcript-snapshot.test.ts` pins a compacted build log (trailing
  `[exit code: N]` marker included) and the whole `/rtk show` report, so a
  wording or marker change fails the suite instead of reaching a request.
- **Contracts that used to be asserted by construction.** Regression cases now
  cover the `suggest`-mode probe, the child-environment scrub, migration through
  the real schema (not a hand-built object), the fail-loud budget bounds, the
  executable write-back rules, the document-relative route and the slot
  registration inject factory.
- **Source rules for the browser half.** The suite rejects literal colours,
  pixel radii, DOM side effects, any `require` beyond `react`, and a `lib/`
  bundle that differs from `src/`.

- **The rebase is green.** `node --test test/*.test.ts` runs 238 cases, 238
  passing, with the browser bundle rebuilt first (`node scripts/build-client.mjs`);
  `tsc -p tsconfig.json --noEmit` is clean. Two suites changed meaning rather than
  wording, both recorded in §19: the `/rtk show` snapshot gained the
  `history database` line, and the report's `label: value` lines replaced the old
  aligned columns.

### Fixed

- **The Configure page and the Host UI rules line up.** The ledger request now
  uses a document-relative route resolved against `document.baseURI` (a
  root-absolute path breaks a deployment mounted under a prefix); colours come
  only from `--dsw-alias-*` tokens and radii from `--dsw-radius-*` instead of
  local pixel values; clearing the executable field to return to auto-detection
  no longer makes Save permanently invalid; the meter's screen-reader label is
  translated; the entry-private reader travels through the slot registration's
  inject factory instead of a wrapper component; the refresh request is consumed
  once instead of bypassing the cache forever; and the page no longer repeats the
  title and description the Plugins chrome already draws.
- **The panel degrades honestly.** A refused reset, an unreachable ledger and a
  failure detail are all bounded: the detail is truncated to 200 characters, the
  report cache has a ceiling, and the breakdown query filters its time window in
  SQL instead of loading the whole table.
- **Configuration written for the retired schema now migrates.** The loader
  validates the composition's `config:` block before the plugin sees it, which
  fills all five new fields with their schema defaults; the migration treated
  "present" as "explicit" and therefore dropped every retired key except
  `enabled`. A defaulted field is no longer mistaken for a user choice.
- **An out-of-range `maxChars` fails at load time.** The schema now enforces
  the published 1000–200000 bounds instead of accepting any integer and
  clamping it later, so a typo is reported where it is written.
- **Detection no longer writes a setting nobody asked for.** It used to write an
  empty string when rtk was not found (pinning "not found" as an explicit
  user-layer override) and to replace a hand-typed path that no longer existed.
  It now only replaces the values it owns (empty, the shipped `rtk` default, or
  its own earlier write) and never writes an empty value.
- **A settings edit re-probes rtk.** The cached availability answer used to
  outlive the executable it described by up to 30 seconds.
- **`/rtk reset` no longer reports a refusal as success.** The bridge returns a
  structured result, so a read-only profile or a rejected write comes back as an
  error, and the success text no longer claims the user layer was cleared.
- **`suggest` mode works again.** It asked rtk for an equivalent only after an
  availability probe, and the probe used to be skipped in every mode but
  `rewrite` — so the mode never produced a suggestion and, worse, reported
  "rtk not found" once per session on machines where rtk was installed. The
  probe now runs whenever the plugin is not `off`.
- **Child processes no longer inherit credentials.** `rtk` was spawned with
  `process.env`, which handed it the harness's API key and every `DSH_*`
  variable. Spawns now use the harness's own scrub rule (credential-shaped
  names and `DSH_*` dropped, `PATH`/locale/proxy kept), with the ledger path
  forwarded explicitly.
- **Peer ranges match the family canonical range.** `peerDependencies` now
  carry the six-clause range the DSH plugin family publishes, which admits the
  `0.2.1` line explicitly instead of relying on prerelease matching, and
  `engines.node` stays `>=22.18.0` — the floor both READMEs advertise and the
  one the CI matrix's floor job actually runs.
- **A missing settings service no longer disables the plugin.** `settings` was
  a hard dependency, so a composition without it kept rewriting and compaction
  from ever activating. It is now an upgrade: the plugin starts on the
  composition's config and switches to the live settings service when that
  service appears.

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

- **The usage ledger is no longer forced into `tmpdir()`** (issue #12). Rewritten
  commands used to run under `RTK_DB_PATH=<tmpdir>/dsh-rtk/history.db`, which had
  two consequences: `/tmp` is tmpfs on most Linux distributions, so the ledger
  reset on every reboot and `/rtk stats` could only describe the current uptime;
  and it is not the database the user's own `rtk gain` reads, so the terminal
  said "No tracking data yet" while the agent had written hundreds of rows
  somewhere else. The new `historyDbPath` setting defaults to `''`, which injects
  nothing and lets rtk use its per-platform database — the same one `rtk gain`
  reads, and one that survives a reboot. It also accepts an absolute path, a
  `~/` path, and `isolated` for the previous tmpdir behavior. A relative path is
  refused rather than resolved against the working directory (that would drop the
  ledger into whichever project is running); a refusal costs the scoping only —
  the command still runs rewritten — and `/rtk show` reports it on its new
  `history database` line. An `RTK_DB_PATH` already in the environment still wins.
- **Three more `historyDbPath` values are refused, because rtk fails on them
  silently.** A directory (`~`, `~/`, `/var/lib/rtk/`) is not a database file:
  rtk exits 0, writes nowhere, and only `rtk gain` later reports "unable to open
  database file" — the whole ledger disappears with no visible failure. Another
  platform's path syntax is accepted by rtk but resolves *relatively*:
  `C:\data\history.db` becomes a file in the working directory on Linux, which is
  the leak the scoping exists to prevent. Both are now refused with a warning
  that names the risk and shows a usable value, and platform detection uses
  `node:path`'s own `win32` / `posix` rules instead of an approximation.
- **`/rtk show` now reports the ledger actually in effect, not the configured
  value.** When an ambient `RTK_DB_PATH` is set the plugin injects nothing, so
  printing the setting pointed readers at a database nobody writes — the exact
  confusion that line was added to remove. It now names the ambient path and
  says the setting is ignored.
- The ledger-scoping integration test no longer depends on the developer's shell:
  a machine with `RTK_DB_PATH` exported used to see one failure locally while CI
  (clean) stayed green.

### Changed

- **Configuration reduced from 26 fields to 6**: `mode` (`off` | `rewrite` |
  `suggest`), `compact`, `maxChars`, `readCompaction` (`none` | `budget` |
  `minimal` | `aggressive`), `rtkExecutable`, and the retained `historyDbPath`. Retired fields are migrated by
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
- `/rtk` now prints the six effective fields instead of the retired switch
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
- **The collapsed model keeps `historyDbPath` as a sixth field.** The refactor
  replaced the plugin's ledger handling with a hard-coded
  `<tmpdir>/dsh-rtk/history.db` — exactly the behavior issue #12 fixed — so the
  merge keeps the setting and drops the hard-coded path. `resolveHistoryDbPath`
  still validates it (a relative path or a directory is refused rather than
  silently losing rows), and the savings panel plus `/rtk gain` now follow the
  ledger actually in effect through `resolveEffectiveHistoryDbPath` (ambient
  `RTK_DB_PATH` > configured value > rtk's per-platform default) instead of
  pointing at a private database. The Configure page deliberately keeps five
  controls: the ledger path is a layout decision, set in the composition or the
  settings document.

### Docs

- **The install section now starts with the rtk binary** (issue #11). Both READMEs
  gained a "Prerequisite" step with the four official install routes, the warning
  that plain `cargo install rtk` installs an unrelated crate, and the
  `rtk --version` check — because a missing binary is the one failure the plugin
  can only degrade through, silently: commands run unchanged, output is not
  compacted, and a single easily-missed line is all the user sees.

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