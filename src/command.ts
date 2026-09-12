import type { RtkConfig } from './config.js'
import type { MetricsSummary } from './metrics.js'
import type { RtkRuntimeStatus } from './runtime-guard.js'

/** Everything the `/rtk` command needs from the plugin. */
export interface RtkCommandController {
  getConfig(): RtkConfig
  /** Replace the user layer wholesale; `{}` restores composition defaults. */
  resetConfig(): Promise<void>
  getRuntimeStatus(): RtkRuntimeStatus
  refreshRuntimeStatus(): Promise<RtkRuntimeStatus>
  getMetrics(): MetricsSummary
  clearMetrics(): void
  /** Where the user layer of the configuration lives, when it is persisted. */
  configLocation(): string
}

/** The command result shape the harness normalizes. */
export type RtkCommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

const HELP_TEXT = [
  'dsh-rtk — rewrite bash commands to rtk and compact tool output.',
  '',
  '  /rtk              show configuration and runtime status',
  '  /rtk show         same as /rtk',
  '  /rtk path         where the configuration is stored',
  '  /rtk verify       check whether the rtk executable is usable',
  '  /rtk stats        compaction savings for this session',
  '  /rtk clear-stats  reset the savings counters',
  '  /rtk reset        restore configuration defaults',
  '  /rtk help         this text',
].join('\n')

function yesNo(value: boolean): string {
  return value ? 'on' : 'off'
}

function configReport(config: RtkConfig, status: RtkRuntimeStatus, location: string): string {
  const compaction = config.outputCompaction
  const lines = [
    `dsh-rtk: ${yesNo(config.enabled)}   mode: ${config.mode}`,
    `rtk binary: ${status.rtkAvailable ? 'available' : 'unavailable'}${status.rtkExecutablePath ? ` (${status.rtkExecutablePath})` : ''}`,
    `config: ${location}`,
    '',
    'command rewriting',
    `  guardWhenRtkMissing      ${yesNo(config.guardWhenRtkMissing)}`,
    `  showRewriteNotifications ${yesNo(config.showRewriteNotifications)}`,
    `  rewriteTimeoutMs         ${config.rewriteTimeoutMs}`,
    '',
    'output compaction',
    `  enabled                  ${yesNo(compaction.enabled)}`,
    `  tools                    ${config.compactedTools.join(', ')}`,
    `  stripAnsi                ${yesNo(compaction.stripAnsi)}`,
    `  readCompaction           ${yesNo(compaction.readCompaction.enabled)}`,
    `  sourceCodeFiltering      ${compaction.sourceCodeFiltering}`,
    `  filterBuildOutput        ${yesNo(compaction.filterBuildOutput)}`,
    `  aggregateTestOutput      ${yesNo(compaction.aggregateTestOutput)}`,
    `  compactGitOutput         ${yesNo(compaction.compactGitOutput)}`,
    `  aggregateLinterOutput    ${yesNo(compaction.aggregateLinterOutput)}`,
    `  groupSearchOutput        ${yesNo(compaction.groupSearchOutput)}`,
    `  smartTruncate            ${yesNo(compaction.smartTruncate.enabled)} (max ${compaction.smartTruncate.maxLines} lines)`,
    `  truncate                 ${yesNo(compaction.truncate.enabled)} (max ${compaction.truncate.maxChars} chars)`,
  ]
  if (status.lastError) lines.push('', `last rtk error: ${status.lastError}`)
  return lines.join('\n')
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
  handler: (invocation: { rawInput: string }) => Promise<RtkCommandResult>
} {
  return {
    name: 'rtk',
    description: 'RTK command rewriting and output compaction: status, verification, and savings.',
    async handler(invocation) {
      const subcommand = invocation.rawInput.trim().split(/\s+/)[0]?.toLowerCase() ?? ''

      switch (subcommand) {
        case '':
        case 'show':
          return { kind: 'success', text: configReport(controller.getConfig(), controller.getRuntimeStatus(), controller.configLocation()) }

        case 'path':
          return { kind: 'success', text: controller.configLocation() }

        case 'verify': {
          const status = await controller.refreshRuntimeStatus()
          if (status.rtkAvailable) {
            const parts = [`rtk is available at ${status.rtkExecutablePath ?? status.rtkExecutableCommand ?? 'rtk'}`]
            if (status.rtkExecutableResolutionWarning) parts.push(`note: ${status.rtkExecutableResolutionWarning}`)
            return { kind: 'success', text: parts.join('\n') }
          }
          return { kind: 'error', text: `rtk is not usable: ${status.lastError ?? 'unknown error'}` }
        }

        case 'stats':
          return { kind: 'success', text: statsReport(controller.getMetrics()) }

        case 'clear-stats':
          controller.clearMetrics()
          return { kind: 'success', text: 'dsh-rtk: savings counters cleared.' }

        case 'reset':
          await controller.resetConfig()
          return { kind: 'success', text: 'dsh-rtk: configuration restored to defaults.' }

        case 'help':
          return { kind: 'success', text: HELP_TEXT }

        default:
          return { kind: 'error', text: `unknown subcommand "${subcommand}".\n\n${HELP_TEXT}` }
      }
    },
  }
}
