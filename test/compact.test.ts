import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { compactToolResult } from '../lib/compact/index.js'
import { NO_OUTPUT_PLACEHOLDER, parseBashResult, renderBashResult } from '../lib/compact/dsh-result.js'
import { compactStatus, compactDiff } from '../lib/compact/git.js'
import { filterBuildOutput } from '../lib/compact/build.js'
import { aggregateTestOutput } from '../lib/compact/test-output.js'
import { aggregateLinterOutput } from '../lib/compact/linter.js'
import { groupSearchResults } from '../lib/compact/search.js'
import { stripAnsi, truncate, compactPath } from '../lib/compact/text.js'
import { normalizeCommandForDetection } from '../lib/compact/detect.js'

const config = normalizeConfig({})

/** Run one result through the pipeline with default configuration. */
function compact(toolName: string, args: unknown, text: string): { changed: boolean; text: string; techniques: string[] } {
  const outcome = compactToolResult({ toolName, args, content: [{ type: 'text', text }] }, config)
  const blocks = (outcome.content ?? [{ type: 'text', text }]) as Array<{ type: string; text: string }>
  return { changed: outcome.changed, text: blocks[0]?.text ?? '', techniques: outcome.techniques }
}

/** A git-status body large enough that summarizing it is a real saving. */
function bigStatus(count = 30): string {
  return ['## main', ...Array.from({ length: count }, (_, index) => ` M src/file${index}.ts`)].join('\n')
}

/** A grep result set large enough that grouping beats the raw list. */
function bigGrep(count = 40): string {
  return Array.from({ length: count }, (_, index) => `src/module${index % 4}.ts:${index + 1}:const value${index} = ${index}`).join('\n')
}

describe('dsh bash result envelope', () => {
  it('lifts trailing status markers out of the body', () => {
    const parts = parseBashResult('some output\n[output truncated; full output: /tmp/x]\n[exit code: 2]')
    assert.equal(parts.stdout, 'some output')
    assert.deepEqual(parts.markers, ['[output truncated; full output: /tmp/x]', '[exit code: 2]'])
  })

  it('splits the stderr section from stdout', () => {
    const parts = parseBashResult('out line\n[stderr]\nerr line\n[exit code: 1]')
    assert.equal(parts.stdout, 'out line')
    assert.equal(parts.stderr, 'err line')
    assert.deepEqual(parts.markers, ['[exit code: 1]'])
  })

  it('recognizes the empty placeholder', () => {
    const parts = parseBashResult(NO_OUTPUT_PLACEHOLDER)
    assert.equal(parts.empty, true)
    assert.equal(renderBashResult(parts), NO_OUTPUT_PLACEHOLDER)
  })

  it('round-trips a result unchanged', () => {
    const original = 'out\n[stderr]\nerr\n[exit code: 3]'
    assert.equal(renderBashResult(parseBashResult(original)), original)
  })
})

describe('compaction preserves the harness contract', () => {
  it('keeps the exit-code marker through a git rewrite', () => {
    const result = compact('bash', { command: 'git status' }, `${bigStatus()}\n[exit code: 0]`)

    assert.equal(result.changed, true)
    assert.ok(result.techniques.includes('git'))
    assert.match(result.text, /Branch: main/)
    assert.match(result.text, /\[exit code: 0\]$/, 'the exit marker must survive compaction')
  })

  it('keeps a non-zero exit marker', () => {
    const result = compact('bash', { command: 'git status' }, `${bigStatus()}\n[exit code: 128]`)
    assert.match(result.text, /\[exit code: 128\]$/)
  })

  it('keeps a stderr section alongside the marker', () => {
    const compiling = Array.from({ length: 20 }, (_, index) => `   Compiling crate${index} v0.1.0`).join('\n')
    const result = compact('bash', { command: 'cargo build' }, `${compiling}\n[stderr]\nboom\n[exit code: 101]`)
    assert.match(result.text, /\[stderr\]/)
    assert.match(result.text, /boom/)
    assert.match(result.text, /\[exit code: 101\]$/)
  })

  it('never inflates a result', () => {
    // `## main` is a valid status body whose summary (`Branch: main`) is
    // longer than the text it would replace. Only the size guard keeps the
    // original here, so this case fails the moment that guard is dropped.
    const tiny = '## main\n[exit code: 0]'
    const result = compact('bash', { command: 'git status' }, tiny)
    assert.equal(result.changed, false)
    assert.equal(result.text, tiny)
  })

  it('leaves the empty placeholder alone', () => {
    const result = compact('bash', { command: 'ls' }, NO_OUTPUT_PLACEHOLDER)
    assert.equal(result.changed, false)
    assert.equal(result.text, NO_OUTPUT_PLACEHOLDER)
  })

  it('strips ANSI codes but keeps the marker', () => {
    const result = compact('bash', { command: 'echo hi' }, '\u001b[31mred\u001b[0m text\n[exit code: 0]')
    assert.equal(result.text, 'red text\n[exit code: 0]')
    assert.ok(result.techniques.includes('ansi'))
  })

  it('refuses to cut through a marker when truncating', () => {
    const filler = Array.from({ length: 4000 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n')
    const small = normalizeConfig({ outputCompaction: { truncate: { maxChars: 1000 } } })
    const outcome = compactToolResult({ toolName: 'bash', args: { command: 'echo hi' }, content: [{ type: 'text', text: `${filler}\n[exit code: 7]` }] }, small)
    const text = (outcome.content as Array<{ text: string }>)[0]?.text ?? ''
    assert.ok(text.length <= 1000 + 64, `expected a bounded result, got ${text.length} chars`)
    assert.match(text, /\[exit code: 7\]$/)
  })
})

describe('per-tool dispatch', () => {
  it('does not touch results from tools outside the configured list', () => {
    const result = compact('read', { path: 'a.ts' }, 'x'.repeat(50_000))
    assert.equal(result.changed, false)
  })

  it('leaves read output exact by default', () => {
    const source = Array.from({ length: 500 }, (_, index) => `const value${index} = ${index}`).join('\n')
    const result = compact('read', { path: 'big.ts' }, source)
    assert.equal(result.changed, false)
    assert.equal(result.text, source)
  })

  it('groups grep matches by file', () => {
    const result = compact('grep', { pattern: 'const' }, bigGrep())
    assert.equal(result.changed, true)
    assert.ok(result.techniques.includes('search'))
    assert.match(result.text, /40 matches in 4 files/)
    assert.match(result.text, /> src\/module0\.ts \(10 matches\)/)
  })

  it('leaves unrecognized search output untouched', () => {
    const noisy = 'this is not a match list\nnor is this\nnothing parses here'
    const result = compact('grep', { pattern: 'x' }, noisy)
    assert.equal(result.changed, false)
    assert.equal(result.text, noisy)
  })
})

describe('techniques', () => {
  it('summarizes git status counts', () => {
    const summary = compactStatus('## main\n M a.ts\n M b.ts\n?? c.txt\n?? d.txt')
    assert.match(summary, /Branch: main/)
    assert.match(summary, /Modified: 2 files/)
    assert.match(summary, /Untracked: 2 files/)
  })

  it('summarizes a diff with per-file counts', () => {
    const diff = ['diff --git a/x.ts b/x.ts', '@@ -1,3 +1,4 @@', '-old', '+new', '+extra'].join('\n')
    const summary = compactDiff(diff)
    assert.match(summary, /> x\.ts/)
    assert.match(summary, /\+2 -1/)
  })

  it('collapses a clean build to one line', () => {
    assert.equal(filterBuildOutput('   Compiling a\n   Compiling b\n    Finished dev', 'cargo build'), '[OK] Build successful (2 units compiled)')
  })

  it('keeps build errors with their location lines', () => {
    const output = ['error[E0308]: mismatched types', ' --> src/main.rs:3:5', '  |', '3 |   let x: u8 = "s";'].join('\n')
    const summary = filterBuildOutput(output, 'cargo build')
    assert.match(summary ?? '', /1 error\(s\)/)
    assert.match(summary ?? '', /src\/main\.rs:3:5/)
  })

  it('is inert for a command the technique does not own', () => {
    assert.equal(filterBuildOutput('anything', 'ls'), null)
    assert.equal(aggregateTestOutput('anything', 'ls'), null)
    assert.equal(aggregateLinterOutput('anything', 'ls'), null)
  })

  it('aggregates a test run summary and failures', () => {
    const output = ['FAIL src/a.test.ts', '  expected 1 to be 2', '', '', 'Tests: 3 passed, 1 failed'].join('\n')
    const summary = aggregateTestOutput(output, 'vitest run')
    assert.match(summary ?? '', /PASS: 3 passed/)
    assert.match(summary ?? '', /FAIL: 1 failed/)
  })

  it('aggregates linter issues by rule', () => {
    const issues = [
      'src/a.ts:1:1: Unexpected any [no-explicit-any]',
      'src/a.ts:2:1: Unexpected any [no-explicit-any]',
      'src/b.ts:5:1: Missing semicolon [semi]',
    ].join('\n')
    const summary = aggregateLinterOutput(issues, 'eslint .')
    assert.match(summary ?? '', /ESLint: 3 errors, 0 warnings in 2 files/)
    assert.match(summary ?? '', /no-explicit-any \(2x\)/)
  })

  it('reports a clean lint run', () => {
    assert.equal(aggregateLinterOutput('', 'eslint .'), '[OK] ESLint: No issues found')
  })
})

describe('text primitives', () => {
  it('strips CSI and OSC sequences', () => {
    assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red')
    assert.equal(stripAnsi('\u001b]0;title\u0007text'), 'text')
    assert.equal(stripAnsi('plain'), 'plain')
  })

  it('truncates with an ellipsis marker', () => {
    assert.equal(truncate('abcdefghij', 5), 'ab...')
    assert.equal(truncate('abc', 5), 'abc')
  })

  it('elides the middle of a long path but keeps the basename', () => {
    const compacted = compactPath('/very/long/path/that/keeps/going/somewhere/file.ts', 24)
    assert.ok(compacted.length <= 24)
    assert.match(compacted, /file\.ts$/)
  })

  it('normalizes a command to its first simple command', () => {
    assert.equal(normalizeCommandForDetection('FOO=1 git status | head'), 'git status')
    assert.equal(normalizeCommandForDetection('  cargo   test  '), 'cargo   test')
    assert.equal(normalizeCommandForDetection('git status && cargo test'), 'git status')
    assert.equal(normalizeCommandForDetection(''), null)
    assert.equal(normalizeCommandForDetection(undefined), null)
  })
})
