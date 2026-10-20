# Agent Note: `settings` is an upgrade, not an injected dependency

Status: accepted.

## Problem

The live-settings integration needs the `settings` service, which registers
asynchronously: it reads the settings document before it is available. Declaring
`settings` in the plugin's `inject` array parked the whole row until the service
appeared — including command rewriting and output compaction, which need no
settings at all. A composition without that service would never activate the
plugin.

## Decision

`inject` lists only `tools`. `apply` starts on a composition bridge built from
the row's own `config:` block, then registers `ctx.inject(['settings'], …)`;
when the service appears the bridge is rebuilt, the change watch is re-armed,
and the configuration is re-read. Every code path that only needs configuration
works from the first millisecond.

## Alternatives considered

- **Keep the hard dependency and document it.** Rejected: the documented
  behaviour of a missing injected service is "never activates", which turns a
  convenience feature into a single point of failure for the entire plugin.
- **Poll `ctx.get('settings')` on first use.** Rejected: it would attach the live
  integration only after a tool call, and a polling loop is exactly what the
  harness's event model is there to avoid.
- **Two plugin rows (one for compaction, one for settings).** Rejected: it
  duplicates the listeners and makes the configuration page's namespace
  ambiguous for no benefit.

## Consequences

The bridge can be replaced after `apply`, so everything that captured it must
read through the current reference. `test/integration.test.ts` pins the upgrade
by providing the service after activation and re-reading `/rtk path`.
