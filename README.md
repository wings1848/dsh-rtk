# dsh-rtk

RTK command rewriting and tool-output compaction for the [DeepSeek Harness](https://github.com/deepseek-ai/dsh).

`dsh-rtk` rewrites `bash` commands to their [rtk](https://github.com/rtk-ai/rtk) equivalents before they run, and compacts noisy tool output before it reaches the model. It is a port of [`pi-rtk-optimizer`](https://github.com/MasuRii/pi-rtk-optimizer) to the harness's plugin model.

```
model asks:  git status
runs:        rtk git status
model sees:  Branch: main
             Modified: 2 files
               src/a.ts
```

## Features

### Command rewriting

- Every command with an rtk equivalent is rewritten before dispatch; commands rtk does not support run untouched.
- **rtk stays the source of truth.** The plugin carries no rewrite table of its own — it asks the installed binary via `rtk rewrite`, so support tracks whatever rtk version is installed.
- **`rewrite` and `suggest` modes.** `rewrite` replaces the command; `suggest` runs it unchanged and reports the equivalent it would have used.
- **Runtime guard.** With `guardWhenRtkMissing` on (the default), a call that cannot prove rtk is available runs the original command. A missing optimizer never blocks work.
- Rewritten commands get an isolated `RTK_DB_PATH`, so rtk's usage history does not land in the working tree.

### Output compaction

A multi-stage pipeline over `bash`, `read`, and `grep` results:

| Stage | What it does |
|---|---|
| ANSI stripping | Removes terminal color and formatting sequences |
| Build filtering | Extracts compiler errors and warnings, drops progress chatter |
| Test aggregation | Collapses runner output to pass/fail/skip plus failure excerpts |
| Git compaction | Summarizes `git status`, `git diff`, and `git log` |
| Linter aggregation | Counts issues and ranks them by rule and file |
| Search grouping | Groups `grep`-style matches by file |
| Source filtering | `none`, `minimal`, or `aggressive` comment/whitespace removal (off by default) |
| Smart truncation | Keeps signatures and imports when dropping lines (off by default) |
| Hard truncation | Final character budget |

Two properties are load-bearing:

- **The harness contract survives.** A `bash` result ends with status markers — `[exit code: N]`, `[stderr]`, `[timed out after …]`, `[sandbox: …]`. Compaction lifts those out before rewriting the body and puts them back afterwards; the model is told to check `[exit code: N]` on every call, and the Web UI parses that same line for its exit-status pill.
- **Compaction never inflates a result.** If a technique would not actually shrink the text, the original is kept and nothing is reported.

### Session metrics

`/rtk stats` reports how many characters compaction saved, per tool and per technique.

## Install

### 1. Make the package resolvable

Either install it into the profile:

```bash
dsh plugin --profile web add /path/to/dsh-rtk
```

or link it where the composition resolves bare specifiers:

```bash
ln -s /path/to/dsh-rtk ~/.dsh/node_modules/dsh-rtk
```

### 2. Add one row to an agent preset

`dsh-rtk` is an **agent-plane** row: it registers listeners into the tool pipeline and contributes no service, so it needs no `isolate` realm. Add it to the preset whose sessions should be optimized:

```yaml
- id: rtk
  name: 'dsh-rtk'
  config:
    enabled: true
    mode: rewrite
```

To try it without touching an existing preset, copy one and add the row:

```
# ask a cordis-preset agent to run this
agentPresets.copy('standard', 'rtk', 'RTK 优化')
```

The row works at the host plane too (add it to `~/.dsh/cordis.patch.yml` instead), which covers every session in the deployment — but that needs a host restart, and a host row plus a preset row would both want the same process-global settings namespace. Pick one plane.

## Configuration

Every field is optional; defaults are shown.

```yaml
- id: rtk
  name: 'dsh-rtk'
  config:
    enabled: true                    # master switch
    mode: rewrite                    # rewrite | suggest
    guardWhenRtkMissing: true        # run the original when rtk is unavailable
    showRewriteNotifications: false  # append a one-line rewrite note to the result
    rtkExecutable: rtk               # name or absolute path
    rewriteTimeoutMs: 3000           # deadline for one `rtk rewrite` call
    compactedTools: [bash, read, grep]
    outputCompaction:
      enabled: true
      stripAnsi: true
      readCompaction:
        enabled: false               # lossy read compaction; off so code reads stay exact
      sourceCodeFilteringEnabled: false
      preserveExactSkillReads: false
      sourceCodeFiltering: none      # none | minimal | aggressive
      aggregateTestOutput: true
      filterBuildOutput: true
      compactGitOutput: true
      aggregateLinterOutput: true
      groupSearchOutput: true
      trackSavings: true
      smartTruncate:
        enabled: false
        maxLines: 220                # 40–4000
      truncate:
        enabled: true
        maxChars: 12000              # 1000–200000
```

The configuration is also registered as the `dsh-rtk` namespace in the harness settings document, so it can be edited there and takes effect without a restart. A composition `config:` block supplies the `base` layer; the settings document supplies the user layer on top.

> **Why `readCompaction` is off by default.** Filtering or truncating a `read` result can leave the model editing against text that no longer matches the file. Everything on by default is lossless for the body text it summarizes, or only fires on outputs whose whole shape is being replaced.

## Commands

| Command | Description |
|---|---|
| `/rtk` | Show configuration and runtime status |
| `/rtk show` | Same as `/rtk` |
| `/rtk path` | Where the configuration is stored |
| `/rtk verify` | Check whether the rtk executable is usable |
| `/rtk stats` | Compaction savings for this session |
| `/rtk clear-stats` | Reset the savings counters |
| `/rtk reset` | Restore configuration defaults |
| `/rtk help` | Usage text |

## How it works

Both halves ride the tool pipeline rather than wrapping a tool, because the harness offers exactly two seams that fit:

- **Rewriting rides `tools/execute`.** `tools/pre-execute` deliberately may not mutate arguments — they are logged and presented before dispatch, so a rewrite there would desync the recorded call from the one that ran. The around-dispatch stage is the only place the executing command may differ, and `dsh-rtk` scopes the change to a single call: the original arguments are restored as soon as dispatch returns, so later pipeline stages and the session log still see what the model asked for.

- **Compaction rides `tools/post-execute`**, the stage that may replace result content.

Both listeners register in the scope the row was mounted into. A preset row therefore covers exactly its own agent (the preset's standing scope is an ancestor of every session that joins it), and a host row covers every agent in the process.

Only the `tools` service is a hard dependency. `settings`, `commands`, and `systemPrompt` are resolved with `ctx.get`, so a composition that omits any of them still gets the optimization.

### Caveat: the rewriting seam is not a sanctioned extension point

The harness documents `tools/execute` wrappers as wrappers that "may change only `exec.signal`". Replacing `arguments` is **not a supported extension point** — it works because the execution object is not frozen until its result is notified, and the failed alternative is worse: `tools/pre-execute` deliberately may not rewrite input (arguments are logged and presented before dispatch), and a tool cannot be re-registered over one in the same layer.

`dsh-rtk` takes that seam knowingly, and pays for it where it can: the replacement is scoped to a single call and restored in `finally`, and every failure path falls back to the command the model sent. If a future harness version freezes the execution object earlier, rewriting goes quiet rather than breaking — commands run unrewritten and compaction is unaffected, because `tools/post-execute` *is* a documented content-replacement stage.

## Differences from pi-rtk-optimizer

| pi-rtk-optimizer | dsh-rtk |
|---|---|
| Rewrites `event.input.command` in the `tool_call` hook | Replaces `exec.arguments` for the duration of one dispatch, then restores it |
| Compacts in the `tool_result` hook | Compacts in the `tools/post-execute` waterfall |
| `/rtk` opens a TUI settings modal | `/rtk` prints status text; configuration lives in the harness settings document |
| Config is a JSON file it owns | Config is a harness settings namespace layered over the composition's `config:` block |
| Streams are sanitized through `tool_execution_*` hooks | No equivalent hook exists, so streamed output is not sanitized |
| Windows-specific shell fixups | Not ported; the target deployment is POSIX |

Everything else — the rewrite delegation to `rtk rewrite`, the exit-code contract, the guard when rtk is missing, the documented default for every compaction switch, and each technique's algorithm — is ported as-is.

## Development

```bash
pnpm install          # or link the peer packages manually
pnpm run typecheck    # tsc --noEmit against the real harness types
pnpm test             # node --test test/
pnpm run build        # emit lib/
pnpm run check        # all three
```

`test/integration.test.ts` drives the real `apply()` through a stand-in context and calls the real `rtk` binary, so it fails on a machine without rtk installed — that is intentional: the rewrite path is the feature.

## License

MIT
