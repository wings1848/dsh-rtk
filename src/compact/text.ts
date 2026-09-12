/** Text primitives shared by every compaction technique. */

const ANSI_CSI = /\u001b\[[0-9;]*[a-zA-Z]/g
const ANSI_OSC_BEL = /\u001b\][0-9;]*(?:\u0007|\u001b\\)/g
const ANSI_OSC_ST = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/**
 * Remove terminal color and formatting sequences.
 *
 * Covered: CSI (`ESC [ … letter`) and OSC (`ESC ] … BEL|ST`). The cheap guard
 * matters because this runs on every text result and most have no escape byte
 * at all.
 */
export function stripAnsi(text: string): string {
  if (!text.includes('\u001b')) return text
  return text.replace(ANSI_CSI, '').replace(ANSI_OSC_BEL, '').replace(ANSI_OSC_ST, '')
}

/** Keep at most `maxLength` characters, marking elision with a trailing ellipsis. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  if (maxLength < 3) return '...'
  return `${text.slice(0, maxLength - 3)}...`
}

/** Number of lines, counting a trailing newline as a terminator rather than a new line. */
export function countLines(text: string): number {
  if (!text) return 0
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  if (!normalized) return 1
  return normalized.split('\n').length
}

function detectPathSeparator(path: string): '/' | '\\' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function detectPathPrefix(path: string, separator: '/' | '\\'): string {
  if (/^[A-Za-z]:[\\/]/.test(path)) return `${path.slice(0, 2)}${separator}`
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
    if (parts.length >= 2) return `${separator}${separator}${parts[0]}${separator}${parts[1]}${separator}`
    return `${separator}${separator}`
  }
  if (path.startsWith('/') || path.startsWith('\\')) return separator
  return ''
}

/**
 * Shorten a path to `maxLength` by eliding its middle segments.
 *
 * The last segment survives because it is the part a reader needs; earlier
 * candidates keep one parent directory when the budget allows, which is what
 * disambiguates two files with the same basename.
 */
export function compactPath(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path
  if (maxLength < 2) return path.slice(0, maxLength)

  const separator = detectPathSeparator(path)
  const prefix = detectPathPrefix(path, separator)
  const segments = path
    .slice(prefix.length)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)

  const lastSegment = segments[segments.length - 1] ?? path.slice(-(maxLength - 1))
  const previousSegment = segments[segments.length - 2]
  const tail = [previousSegment, lastSegment].filter((segment): segment is string => segment !== undefined)
  const join = (head: string, parts: string[]): string => {
    const body = parts.join(separator)
    return head ? `${head}${body}` : body
  }

  const candidates = [
    join(prefix, ['…', ...tail]),
    join('', ['…', ...tail]),
    join('', ['…', lastSegment]),
    `…${path.slice(-(maxLength - 1))}`,
  ]

  for (const candidate of candidates) {
    if (candidate.length <= maxLength) return candidate
  }
  return `…${lastSegment.slice(-(maxLength - 1))}`
}
