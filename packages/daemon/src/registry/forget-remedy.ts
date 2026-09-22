// SPDX-License-Identifier: Apache-2.0
// The one sentence that tells someone how to finish an interrupted `glosa forget` (issues #156,
// #312).
//
// It used to exist twice, written out by hand in `glosa status`'s human output and again in
// `doctor`'s workspace check. #312 needs it in two more places — the daemon's 409 body, so an
// agent that only ever sees an error string learns the remedy, and `/api/status`'s JSON, so the
// `glosa-connect` skill can quote the daemon instead of composing a fifth copy in untested prose.
// Four hand-written copies of one sentence is where drift lives, so there is one here instead.
//
// Deliberately never runs anything: `glosa forget` deletes data, so this only ever says what to
// type.

/** When the row still exists, name it — the user can act without a second lookup. */
export function forgetRemedy(slug: string): string {
  return `deletion interrupted (\`glosa forget\`) — run \`glosa forget ${slug} --yes\` to resume`;
}

/** The slugless variant. `getOrRegisterWorkspace` refuses with `workspace-forgetting` precisely
 * when the registration is ALREADY GONE, so there is no slug to print; `glosa doctor` resolves it
 * from the durable forget record. Interpolating `undefined` into the command above would be
 * worse than saying less. */
export function forgetRemedyWithoutSlug(): string {
  return "deletion interrupted (`glosa forget`) — run `glosa doctor` for the exact resume command";
}
