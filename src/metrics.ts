/** Per-tool savings accumulators for the current session. */
export interface ToolSavings {
  calls: number
  originalChars: number
  compactedChars: number
}

/** One session's compaction savings. */
export interface MetricsSummary {
  calls: number
  originalChars: number
  compactedChars: number
  savedChars: number
  savedPercent: number
  byTool: Record<string, ToolSavings>
  /** How often each technique fired, across all calls. */
  byTechnique: Record<string, number>
}

/** Accumulates compaction savings; one instance per plugin application. */
export interface MetricsTracker {
  /** Record one compacted result. A no-op result must not be passed here. */
  track(originalText: string, compactedText: string, tool: string, techniques: readonly string[]): void
  /** Current totals, recomputed on each call so callers cannot mutate them. */
  summary(): MetricsSummary
  /** Drop all recorded savings. */
  clear(): void
}

function emptyTotals(): ToolSavings {
  return { calls: 0, originalChars: 0, compactedChars: 0 }
}

/**
 * Build the session metrics accumulator.
 *
 * Savings are approximate by construction — character counts stand in for
 * tokens — but they are measured on exactly the strings that were swapped, so
 * the ratio is honest even when the absolute number is not.
 */
export function createMetricsTracker(): MetricsTracker {
  let calls = 0
  let originalChars = 0
  let compactedChars = 0
  const byTool = new Map<string, ToolSavings>()
  const byTechnique = new Map<string, number>()

  return {
    track(originalText, compactedText, tool, techniques) {
      calls += 1
      originalChars += originalText.length
      compactedChars += compactedText.length

      const totals = byTool.get(tool) ?? emptyTotals()
      totals.calls += 1
      totals.originalChars += originalText.length
      totals.compactedChars += compactedText.length
      byTool.set(tool, totals)

      for (const technique of techniques) byTechnique.set(technique, (byTechnique.get(technique) ?? 0) + 1)
    },

    summary() {
      const savedChars = Math.max(0, originalChars - compactedChars)
      return {
        calls,
        originalChars,
        compactedChars,
        savedChars,
        savedPercent: originalChars === 0 ? 0 : Math.round((savedChars / originalChars) * 1000) / 10,
        byTool: Object.fromEntries(byTool),
        byTechnique: Object.fromEntries(byTechnique),
      }
    },

    clear() {
      calls = 0
      originalChars = 0
      compactedChars = 0
      byTool.clear()
      byTechnique.clear()
    },
  }
}
