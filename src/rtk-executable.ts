import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'

import { scrubbedEnv } from './child-env.js'

/** One settled `rtk` invocation. */
export interface RtkRunResult {
  code: number
  stdout: string
  stderr: string
}

/** How an rtk executable path was discovered. */
export type RtkResolverName = 'where' | 'which' | 'configured' | 'candidate'

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
  /** Environment the known-install-location candidates are derived from. */
  env?: NodeJS.ProcessEnv
  /** Test seam: whether a candidate file exists. */
  exists?: (path: string) => Promise<boolean>
  /** Test seam: whether a candidate actually runs rtk. */
  verify?: (path: string) => Promise<boolean>
}

/** Resolver executable name for a platform. */
export function resolverNameFor(platform: NodeJS.Platform): 'where' | 'which' {
  return platform === 'win32' ? 'where' : 'which'
}

/** Whether a configured value names a path rather than a bare command name. */
export function looksLikeRtkPath(value: string): boolean {
  return value.includes('/') || value.includes('\\')
}

/** Whether a path names a reachable file. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Where a Windows rtk installation may sit when PATH does not carry it.
 *
 * The PATH lookup is the fast path, but a harness launched from a desktop
 * shortcut can inherit a stale environment: WinGet, cargo and Scoop each add
 * their shim directory to the *user* PATH, and a process started before that
 * entry existed never sees it. These are the directories those installers use,
 * so the common local installs resolve without the user hand-typing a path.
 */
export function windowsRtkCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = []
  const localAppData = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : ''
  if (localAppData) candidates.push(`${localAppData}\\Microsoft\\WinGet\\Links\\rtk.exe`)
  const userProfile = typeof env.USERPROFILE === 'string' ? env.USERPROFILE.trim() : ''
  if (userProfile) {
    candidates.push(`${userProfile}\\.cargo\\bin\\rtk.exe`)
    candidates.push(`${userProfile}\\scoop\\shims\\rtk.exe`)
  }
  return candidates
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
  options: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<RtkRunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs ?? 3000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: options.env ?? scrubbedEnv(),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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

/** Whether a candidate path answers `--version` successfully. */
async function runsRtk(path: string): Promise<boolean> {
  const result = await runExecutable(path, ['--version'], { timeoutMs: 5000 })
  return result.code === 0
}

/**
 * Resolve the rtk executable, preferring the configured value.
 *
 * A configured value that is not a bare name is taken as an absolute path and
 * used verbatim when it exists — the deployment said where rtk lives, so a PATH
 * probe would only second-guess it. A configured path that no longer exists is
 * treated as stale and falls through to a normal lookup, so an upgrade or
 * uninstall heals the setting instead of leaving rewriting switched off.
 *
 * Bare names are looked up on PATH so `/rtk verify` can report a real path.
 * On Windows a failed lookup continues into the directories the common
 * installers use (see {@link windowsRtkCandidates}); each candidate is run with
 * `--version` before it is trusted. A failed lookup is not fatal, because the
 * name may still resolve when the command actually runs.
 */
export async function resolveRtkExecutable(options: ResolveRtkExecutableOptions): Promise<RtkExecutableResolution> {
  const platform = options.platform ?? process.platform
  const configured = options.configured.trim()
  const exists = options.exists ?? fileExists

  if (looksLikeRtkPath(configured) && (await exists(configured))) {
    return { command: configured, resolvedPath: configured, resolver: 'configured' }
  }

  // A missing configured path is a stale value (an upgrade or uninstall moved
  // rtk), so the lookup falls back to the bare name the setting means.
  const name = configured === '' || looksLikeRtkPath(configured) ? 'rtk' : configured
  const resolver = resolverNameFor(platform)
  const lookupCommand = options.resolverCommand ?? resolver
  const result = await runExecutable(lookupCommand, [name], { timeoutMs: options.timeoutMs ?? 1000 })
  const resolvedPath = parseExecutablePath(result.stdout)

  if (result.code === 0 && resolvedPath !== undefined) {
    return { command: resolvedPath, resolvedPath, resolver }
  }

  // The install-directory fallbacks are only for the auto-detected name: a
  // hand-typed name is an explicit choice, and answering it with some other
  // rtk found on the disk would be worse than reporting it missing.
  if (platform === 'win32' && name === 'rtk') {
    const verify = options.verify ?? runsRtk
    for (const candidate of windowsRtkCandidates(options.env ?? process.env)) {
      if (!(await exists(candidate))) continue
      if (!(await verify(candidate))) continue
      return { command: candidate, resolvedPath: candidate, resolver: 'candidate' }
    }
  }

  const detail = (result.stderr || result.stdout).replace(/\s+/g, ' ').trim()
  return {
    command: name,
    resolver,
    warning: `could not resolve ${name} via ${resolver}${detail ? `: ${detail}` : ''}`,
  }
}

/** What the rtkExecutable setting should become after one detection pass. */
export interface ExecutableSettingInput {
  /** The setting's current value. */
  current: string
  /** The path detection found, if any. */
  detected?: string
  /** A value this plugin wrote on an earlier pass; such values stay managed. */
  autoWritten?: string
}

/**
 * Decide the next rtkExecutable value, or `undefined` to leave it alone.
 *
 * Only values this plugin owns are rewritten: empty (the "auto-detect" state)
 * and the shipped default `rtk`. A hand-typed value — including a path that no
 * longer exists — is never overwritten, because it is an explicit choice the
 * user may be about to fix.
 *
 * Detection never writes an empty value: an empty string in the user layer
 * would pin "not found" as an explicit override, shadowing any later default or
 * composition value. When detection finds nothing the setting is left alone and
 * `/rtk verify` is where the user learns it.
 */
export function decideExecutableSetting(input: ExecutableSettingInput): string | undefined {
  const managed = input.current === '' || input.current === 'rtk' || input.current === input.autoWritten
  if (!managed) return undefined
  if (input.detected === undefined) return undefined
  return input.detected === input.current ? undefined : input.detected
}