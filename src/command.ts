import type { RtkConfig } from './config.js'
import type { HistoryDbResolution } from './history-db.js'
import type { MetricsSummary } from './metrics.js'
import type { RtkRuntimeStatus } from './runtime-guard.js'

/** What `/rtk show` needs to explain where the usage ledger ends up. */
export interface HistoryDbReport {
  /** Where the configured value points, after platform and directory checks. */
  resolution: HistoryDbResolution
  /** An `RTK_DB_PATH` already in the environment; it wins over the setting. */
  ambient?: string | undefined
}

/** Everything the `/rtk` command needs from the plugin. */
export interface RtkCommandController {
  getConfig(): RtkConfig
  /**
   * Reset the row's settings to the values inherited from the composition.
   *
   * @returns the command result, so a refused reset is reported as an error
   * instead of a success the user will trust.
   */
  resetConfig(): Promise<RtkCommandResult>
  getRuntimeStatus(): RtkRuntimeStatus
  refreshRuntimeStatus(): Promise<RtkRuntimeStatus>
  getMetrics(): MetricsSummary
  clearMetrics(): void
  /**
   * Run `rtk gain` against the plugin's own history database and return its
   * output.
   *
   * Rewritten commands are recorded in an isolated database, so a plain
   * `rtk gain` in a terminal reports the user's global database and misses
   * everything this plugin saved. The implementation must therefore pass the
   * plugin's database through `RTK_DB_PATH`.
   *
   * @param args - everything typed after `gain`, already tokenized by the caller.
   */
  runGain(args: string): Promise<RtkCommandResult>
  /** Where the user layer of the configuration lives, when it is persisted. */
  configLocation(): string
  /**
   * Where rewritten commands send rtk's usage ledger.
   *
   * Optional so a controller in a test (or an older row) need not implement it:
   * the report then simply names rtk's own default.
   */
  getHistoryDbResolution?(): HistoryDbReport
}

/** The command result shape the harness normalizes. */
export type RtkCommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/**
 * Official install routes, taken from the project's own README.
 *
 * `cargo install rtk` is called out because crates.io carries an unrelated
 * crate of the same name; only the `--git` form installs this tool.
 */
const INSTALL_HINT = [
  'Install rtk with one of:',
  '  brew install rtk                        # macOS / Linux (Homebrew, recommended)',
  '  winget install rtk-ai.rtk               # Windows',
  '  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh',
  '  cargo install --git https://github.com/rtk-ai/rtk',
  '',
  'Note: plain `cargo install rtk` installs an unrelated crate of the same name.',
  'Releases: https://github.com/rtk-ai/rtk/releases',
].join('\n')

const HELP_TEXT = [
  'dsh-rtk — rewrite bash commands to rtk and compact tool output.',
  '',
  '  /rtk              show configuration and runtime status',
  '  /rtk show         same as /rtk',
  '  /rtk path         where the configuration is stored',
  '  /rtk verify       check whether the rtk executable is usable (prints install options when it is not)',
  '  /rtk stats        compaction savings for this session',
  '  /rtk gain [flags] rtk\'s own savings ledger for the commands this plugin rewrote',
  '                     (passes rtk gain flags through, e.g. -H history, -g graph, -f json)',
  '  /rtk clear-stats  reset the savings counters',
  '  /rtk reset        restore configuration defaults',
  '  /rtk help         this text',
].join('\n')

function yesNo(value: boolean): string {
  return value ? 'on' : 'off'
}

function configReport(
  config: RtkConfig,
  status: RtkRuntimeStatus,
  location: string,
  historyDb: HistoryDbReport | undefined,
): string {
  const lines = [
    `dsh-rtk: ${config.mode}   compact: ${yesNo(config.compact)}   maxChars: ${config.maxChars}`,
    `readCompaction: ${config.readCompaction}`,
    `rtk executable: ${config.rtkExecutable}`,
    `rtk binary: ${status.rtkAvailable ? 'available' : 'unavailable'}${status.rtkExecutablePath ? ` (${status.rtkExecutablePath})` : ''}`,
    `history database: ${describeHistoryDb(historyDb)}`,
    `config: ${location}`,
  ]
  if (status.lastError) lines.push('', `last rtk error: ${status.lastError}`)
  return lines.join('\n')
}

/**
 * One line describing where the usage ledger actually goes.
 *
 * This line exists to answer "why does my terminal `rtk gain` not match what the
 * agent did?", so it must report the *effective* location, not the configured
 * one. Those differ whenever the ambient `RTK_DB_PATH` wins: the plugin then
 * injects nothing at all, and printing the configured path would send the reader
 * looking in the wrong database — the exact confusion the line was added to
 * prevent.
 */
function describeHistoryDb(historyDb: HistoryDbReport | undefined): string {
  if (historyDb === undefined) return 'rtk default'
  const { resolution, ambient } = historyDb
  if (ambient !== undefined && ambient.trim() !== '') {
    return `${ambient} (from the ambient RTK_DB_PATH; historyDbPath is ignored)`
  }
  if (resolution.warning !== undefined) return `rtk default (configured value refused: ${resolution.warning})`
  if (resolution.path === undefined) return 'rtk default (shared with `rtk gain`)'
  return resolution.path
}

function statsReport(summary: MetricsSummary): string {
  if (summary.calls === 0) return 'dsh-rtk: no compaction recorded in this session yet.'

  const lines = [
    `compacted calls: ${summary.calls}`,
    `characters: ${summary.originalChars} -> ${summary.compactedChars} (saved ${summary.savedChars}, ${summary.savedPercent}%)`,
  ]

  const tools = Object.entries(summary.byTool)
  if (tools.length > 0) {
    lines.push('', 'by tool:')
    for (const [tool, totals] of tools.sort((left, right) => right[1].originalChars - left[1].originalChars)) {
      const saved = Math.max(0, totals.originalChars - totals.compactedChars)
      lines.push(`  ${tool}: ${totals.calls} call(s), saved ${saved} chars`)
    }
  }

  const techniques = Object.entries(summary.byTechnique)
  if (techniques.length > 0) {
    lines.push('', 'techniques:')
    for (const [technique, count] of techniques.sort((left, right) => right[1] - left[1])) {
      lines.push(`  ${technique}: ${count}`)
    }
  }

  return lines.join('\n')
}

/**
 * Build the `/rtk` command definition.
 *
 * The harness has no interactive settings modal, so every subcommand returns
 * text; the configuration itself is editable through the harness settings
 * document, which this namespace is registered in.
 *
 * @param controller - accessors into the live plugin state.
 * @returns the command definition to register.
 */
export function createRtkCommand(controller: RtkCommandController): {
  name: string
  description: string
  /**
   * Declaring an `input` makes the harness treat `/rtk <subcommand>` as one
   * command with arguments instead of a chat line. Without it the client only
   * routes the bare token; anything after the space falls back to the model.
   */
  input: { hint: string }
  handler: (invocation: { rawInput: string }) => Promise<RtkCommandResult>
} {
  return {
    name: 'rtk',
    description: 'RTK command rewriting and output compaction: status, verification, and savings.',
    input: { hint: 'show | path | verify | stats | gain [flags] | clear-stats | reset | help' },
    async handler(invocation) {
      const stripped = invocation.rawInput.trim()
      const subcommand = stripped.split(/\s+/)[0]?.toLowerCase() ?? ''
      const rest = stripped.slice(subcommand.length).trim()

      switch (subcommand) {
        case '':
        case 'show':
          return {
            kind: 'success',
            text: configReport(
              controller.getConfig(),
              controller.getRuntimeStatus(),
              controller.configLocation(),
              controller.getHistoryDbResolution?.(),
            ),
          }

        case 'path':
          return { kind: 'success', text: controller.configLocation() }

        case 'verify': {
          const status = await controller.refreshRuntimeStatus()
          if (status.rtkAvailable) {
            const parts = [`rtk is available at ${status.rtkExecutablePath ?? status.rtkExecutableCommand ?? 'rtk'}`]
            if (status.rtkExecutableResolutionWarning) parts.push(`note: ${status.rtkExecutableResolutionWarning}`)
            return { kind: 'success', text: parts.join('\n') }
          }
          return {
            kind: 'error',
            text: `rtk is not usable: ${status.lastError ?? 'unknown error'}\n\n${INSTALL_HINT}`,
          }
        }

        case 'stats':
          return { kind: 'success', text: statsReport(controller.getMetrics()) }

        case 'gain':
          return controller.runGain(rest)

        case 'clear-stats':
          controller.clearMetrics()
          return { kind: 'success', text: 'dsh-rtk: savings counters cleared.' }

        case 'reset':
          return controller.resetConfig()

        case 'help':
          return { kind: 'success', text: HELP_TEXT }

        default:
          return { kind: 'error', text: `unknown subcommand "${subcommand}".\n\n${HELP_TEXT}` }
      }
    },
  }
}
