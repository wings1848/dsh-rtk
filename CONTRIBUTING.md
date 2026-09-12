# Contributing

Thanks for looking. This is a small plugin; the bar for a change is "it is
demonstrably better", not "it is more complete".

## Setup

```bash
pnpm install          # installs the harness peers from the registry
pnpm run link-dsh     # re-points them at your running DSH install, if you have one
pnpm run check        # typecheck + build + test
```

`link-dsh` matters: the harness supplies `@deepseek-ai/dsh-*` at plugin load time
from its own install. If a private copy sits in `node_modules`, the plugin builds
tool definitions and reads settings through a *different* instance than the
runtime that owns them. The script symlinks the peers from your DSH install and
falls back to the registry copies when there is no harness — which is what CI
does. `node scripts/link-dsh.mjs --check` fails instead of falling back.

## What CI runs

`ci.yml` runs `pnpm run check` on Node 22.18 / 24 / 26, packs the tarball and
imports it back to prove the published entry exports the plugin contract, audits
dependencies, and reviews what a pull request adds. `codeql.yml` and `secrets.yml`
are separate. All of it must pass before a merge.

## Tests

Every behaviour change needs a test, and **every regression test needs a red run
first**: break the code deliberately, watch the test fail, then fix it. A test
that has never failed is not evidence. `docs/verification.md` shows what that
looks like in practice — sections 3 and 8.

Two properties are load-bearing and any change touching the compaction or
rewriting path has to preserve them:

1. **The harness result contract survives.** A `bash` result ends with
   `[exit code: N]` and friends. The model is told to check that line and the Web
   UI parses it for the exit-status pill, so it must remain the **last** line.
2. **Compaction never inflates a result.** If a technique would not shrink the
   text, the original is kept and the change is reported as "nothing happened".

## Style

- Plain ESM TypeScript, `strict`, no default exports for anything the harness
  loads.
- Comments explain *why*, not *what*. If a line looks odd, the reason it is not
  the obvious alternative belongs next to it.
- A function that cannot do its job should return `null` / `undefined` and leave
  the input alone, rather than returning something confident and wrong. Three
  shipped bugs were exactly that shape — see `docs/verification.md` §8.
- Commit messages are [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), with a body that states the
  problem and the evidence, not a restatement of the diff.

## Pull requests

Say what the change is for and how you know it works — the command you ran and
what it printed. If it changes a default, explain the trade-off; several defaults
here are deliberately the conservative choice and a PR that flips one needs to
argue against the note that put it there.

## Licence

Contributions are accepted under the MIT licence in [LICENSE](LICENSE). By
opening a pull request you confirm you have the right to submit the work under
those terms.

## Releasing

The published package is `@wingsbutterfly/dsh-rtk` (the GitHub owner and the npm
account differ on purpose). Publications run through `.github/workflows/release.yml`
on a `v*` tag, using npm **Trusted Publishing** — the job exchanges its OIDC token
for a short-lived credential, so there is no `NPM_TOKEN` to leak or rotate. Never
add one.

### The first release has to be published by hand

A trusted publisher can only be configured for a package that already exists on
the registry, which is a chicken-and-egg problem the first time. Run this in your
**own interactive terminal** — 2FA is required, and the browser hand-off link is
masked in a non-TTY:

```bash
# 1. Log in to the public registry. The machine's default registry is a mirror,
#    which will not accept a publish.
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/

# 2. Publish the version in package.json.
cd path/to/dsh-rtk
npm publish --registry=https://registry.npmjs.org/

# 3. Register this repository's release workflow as a trusted publisher.
#    `--allow-publish` is the flag people miss: without it the workflow may only
#    stage a publish, and `npm publish` inside it fails even though the setup
#    looked successful. Provider and fields cannot be edited afterwards.
npm trust github @wingsbutterfly/dsh-rtk \
  --file release.yml \
  --repo wings1848/dsh-rtk \
  --allow-publish \
  --registry=https://registry.npmjs.org/
```

`release.yml` is idempotent, so re-running it for a version already on npm is a
notice rather than a red X — which matters, because a failing badge teaches people
to ignore badges.

It reaches that by **attempting the publish and reading the refusal**, not by asking
`npm view` first. The registry's read endpoint is served from a cache that lags a
fresh publish by minutes, so a `npm view` guard answers "not published yet" for a
version that is already there, and the publish that follows is refused with a 403
that reads like an auth problem. That is exactly how the first tagged release went
red with a fully green test run above it.

### Subsequent releases

Bump the version in `package.json` and `CHANGELOG.md`, commit, then tag:

```bash
git tag -a v0.1.1 -m "v0.1.1" && git push origin v0.1.1
```

The tag must match the `package.json` version; the workflow publishes whatever is
in the manifest, not what the tag says.
