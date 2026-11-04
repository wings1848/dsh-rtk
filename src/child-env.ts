/**
 * The environment an rtk child process is allowed to see.
 *
 * The harness policy is one heuristic for every spawner: credential-shaped
 * names (`KEY`, `PASSWORD`, `SECRET`, `TOKEN`) and every `DSH_*` name are
 * never forwarded implicitly, because harness identity and secrets are not the
 * child's business. `PATH`, `HOME`, locale and proxy variables survive, so a
 * child CLI still runs normally.
 *
 * Kept local rather than imported from `@deepseek-ai/dsh-subprocess` so the
 * plugin stays runnable against the harness generations it declares; the two
 * definitions have to agree, and `test/child-env.test.ts` pins that.
 */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * Build a child environment from the parent's, minus secrets and harness
 * identity, then apply explicitly supplied entries on top.
 *
 * @param overrides - values this call deliberately forwards (they survive the scrub).
 * @returns a fresh environment object, never `process.env` itself.
 */
export function scrubbedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    env[key] = value
  }
  return { ...env, ...overrides }
}
