# Public boundary decisions

This file records current architectural boundaries. Historical product exploration is retained
under `docs/archive/` and is not build input.

## External integrations are declarative

External integrations own their packages, workflow logic, and domain vocabulary. They register a
`WorkspaceMetadataDescriptor` v1 through glosa's CLI or MCP tools. glosa persists one active
descriptor per workspace and exposes it through the existing generic `ContentAdapter` interface.

The descriptor may declare artifact class, ordering, a derived-from edge, and a manifest location.
The core interprets only those generic fields. It does not import an integration package, inspect
an integration's state schema, or infer workflow behavior from filenames.

## Session routing is explicit when cwd is insufficient

Providers register live sessions. An external integration may then bind a live session to a glosa
workspace through `glosa session bind` or `glosa_session_bind`. Bindings are session-scoped and
must be restored by the integration after session registration or daemon restart.

## Runtime trust boundary

glosa remains local-first and makes no telemetry or external runtime calls. Channels are an
optional delivery optimization. Hook, turn-boundary, and MCP delivery remain supported fallbacks.

## Token lifecycle is a local filesystem authority

Rotation and revocation mutate the single mode-0600 token file directly instead of calling an API
route. This keeps recovery available when the daemon is stopped or its in-memory token state is stale,
and avoids a second persisted epoch whose update could not be atomic with the token file. Atomic rename
or unlink is the durable linearization point; the daemon derives an in-memory generation from the
complete current value.

The daemon combines a directory watcher with request-time refresh. A generation change aborts existing
credential-bound streams and clears class-F capabilities; subsequent Bearer checks accept only the new
value. The CLI never returns the replacement token. `glosa open` remains the explicit browser-pairing
boundary and recovery path.

## Ownership rule

A change that needs integration-specific code belongs outside this repository. A change belongs in
glosa only when it strengthens a generic contract that remains useful with zero adapters loaded.
