# Public boundary decisions

This file records current architectural boundaries. `docs/requirements.md` and its normative
appendices remain the authoritative build input.

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

## The URL fragment is the canonical on-screen focus

The SPA reflects the current workspace and open artifact into the address-bar fragment
(`#w=<slug>&a=<artifact>`) via `history.replaceState` as the user navigates, not only on load. This
makes reload/refresh restore the view and makes the URL shareable, so focus lives in one place
instead of duplicated UI state. The deep-link is no longer one-shot: `readRoute` seeds the initial
view and `writeFocus` keeps it current thereafter.

Three constraints hold this inside the security boundary:

- **Fragment, never query string.** Focus stays in the `#` fragment so it is never sent to the
  daemon or written to its request path (A1 §2) — the same reason the pairing token uses the
  fragment.
- **The written fragment carries only `w`/`a`, never `t=`.** `focusHash` is rebuilt from scratch on
  every call and reads only slug/artifact, so live-reflecting focus can never re-expose the pairing
  token that `scrubSecrets` strips on load (A3 §3/F24). This is structural, not a runtime filter.
- **`replaceState`, not `pushState`.** Reflecting focus does not spawn a history entry per artifact;
  it mutates the current one.

Mode (Preview/Annotate/Edit) is deliberately **not** in the URL. It is an act with a stateful save
guard (leaving Edit while dirty is blocked pending a discard prompt), and a shareable link should
land in Preview rather than the source editor — modes are acts, not defaults.

## Ownership rule

A change that needs integration-specific code belongs outside this repository. A change belongs in
glosa only when it strengthens a generic contract that remains useful with zero adapters loaded.
