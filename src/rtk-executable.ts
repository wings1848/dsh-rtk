import { execFile } from 'node:child_process'

/** One settled `rtk` invocation. */
export interface RtkRunResult {
  code: number
  stdout: string
  stderr: string
}

/** How an rtk executable path was discovered. */
export type RtkResolverName = 'where' | 'which' | 'configured'

/** The executable this plugin will use, and how sure it is. */
export interface RtkExecutableResolution {
  command: string
  resolvedPath?: string
  resolver: RtkResolverName
  warning?: string
}

/** Everything the resolver needs; all fields have production defaults. */
export interface ResolveRtkExecutableOptions {
  /** Configured executable name or path. */
  configured: string
  /** Command used to look the name up on PATH. */
  resolverCommand?: string
  timeoutMs?: number
  platform?: NodeJS.Platform
}

/** Resolver executable name for a platform. */
export function resolverNameFor(platform: NodeJS.Platform): 'where' | 'which' {
  return platform === 'win32' ? 'where' : 'which'
}

/**
 * Invoke one executable and settle with its output.
 *
 * A missing binary or a non-zero exit resolves rather than rejects: every
 * caller here treats "rtk said no" as an ordinary outcome, and rejecting would
 * make each call site wrap the same try/catch. Arguments are passed as an
 * array, so no command string is ever handed to a shell.
 */
export function runExecutable(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RtkRunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs ?? 3000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}

/** First non-empty line of resolver output, with surrounding quotes removed. */
export function parseExecutablePath(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    let candidate = line.trim()
    if (candidate.length >= 2) {
      const first = candidate[0]
      const last = candidate[candidate.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) candidate = candidate.slice(1, -1)
    }
    if (candidate) return candidate
  }
  return undefined
}

/**
 * Resolve the rtk executable, preferring the configured value.
 *
 * A configured value that is not a bare name is taken as an absolute path and
 * used verbatim — the deployment said where rtk lives, so a PATH probe would
 * only second-guess it. Bare names are looked up so `/rtk verify` can report a
 * real path; a failed lookup is not fatal, because the name may still resolve
 * when the command actually runs.
 */
export async function resolveRtkExecutable(options: ResolveRtkExecutableOptions): Promise<RtkExecutableResolution> {
  const platform = options.platform ?? process.platform
  const configured = options.configured.trim() || 'rtk'
  const looksLikePath = configured.includes('/') || configured.includes('\\')

  if (looksLikePath) {
    return { command: configured, resolvedPath: configured, resolver: 'configured' }
  }

  const resolver = options.resolverCommand ?? resolverNameFor(platform)
  const result = await runExecutable(resolver, [configured], { timeoutMs: options.timeoutMs ?? 1000 })
  const resolvedPath = parseExecutablePath(result.stdout)

  if (result.code === 0 && resolvedPath !== undefined) {
    return { command: resolvedPath, resolvedPath, resolver: resolver as RtkResolverName }
  }

  const detail = (result.stderr || result.stdout).replace(/\s+/g, ' ').trim()
  return {
    command: configured,
    resolver: resolver as RtkResolverName,
    warning: `could not resolve ${configured} via ${resolver}${detail ? `: ${detail}` : ''}`,
  }
}
