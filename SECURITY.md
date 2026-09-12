# Security policy

## Reporting a vulnerability

Report privately through GitHub's
[security advisories](https://github.com/wings1848/dsh-rtk/security/advisories/new)
rather than in a public issue.

Please include the version (`package.json`), your DSH and Node versions, and the
smallest reproduction you can manage. If the report involves a command being
executed, say so explicitly in the title — this plugin sits in the path of every
`bash` call, so that class of report is triaged first.

**Response times.** Acknowledgement within 7 days; an assessment (affected
versions, whether a fix is warranted) within 30 days. These are targets for a
volunteer-maintained project, not a contract.

## Scope

In scope:

- A command that runs something other than what the model asked for, beyond the
  documented rewrite.
- Argument injection through a rewritten command.
- Escaping the harness's sandbox or approval stack by any means other than the
  documented fallback to the original command.
- Reading or writing files outside what the harness permits.

Out of scope:

- The behaviour of `rtk` itself. Report those to
  <https://github.com/rtk-ai/rtk>.
- The behaviour of the harness. Report those to the DSH maintainers.
- Anything that requires an already-compromised host, or a malicious
  `rtkExecutable` the user configured themselves.
- Compaction altering text. That is the feature, it is bounded by the documented
  settings, and `readCompaction` is off by default so file reads stay exact.

## Known design constraints

`dsh-rtk` replaces `exec.arguments` for the duration of one dispatch. The harness
documents `tools/execute` wrappers as permitted to change only `exec.signal`, so
this is an unsupported seam taken knowingly — see "Caveat: the rewriting seam" in
[README.md](README.md). It is disclosed rather than fixed because no supported
alternative exists. If a future harness closes it, rewriting stops working and
every command runs unrewritten; there is no path by which it silently runs the
wrong thing.
