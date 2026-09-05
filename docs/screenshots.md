# Regenerating the README screenshots

`docs/assets/screens/*.png` are real captures of the SPA, composed into macOS window frames by
`docs/assets/screens/frame.html`. Nothing in this pipeline is generated, mocked, or retouched: the
document, the annotations, the revision, the version history, and the approval verdict all come from
one recorded session against a throwaway workspace.

Each image ships as a `-light.png` / `-dark.png` pair, wired up in the README with `<picture>` and
`prefers-color-scheme` so GitHub serves the variant that matches the reader's theme. **Capture both
themes from the same workspace state in one take** — glosa's own state (annotations, checkpoints,
approval) is shared, and only the browser context's `colorScheme` differs. Recording the dark set in
a separate session would let the agent rephrase its revision, and the two variants would then show
different text to anyone toggling themes.

Re-capture whenever the workspace chrome, the margin, the history pane, or the approval strip
changes shape.

## 1. Build a throwaway workspace outside the repo

Anywhere but inside this repository — glosa resolves a workspace by walking up to the enclosing Git
root, so a fixture inside the repo registers the repo itself as a second workspace.

```sh
DEMO=/tmp/glosa-readme-demo
export GLOSA_HOME="$DEMO/glosa-home"   # isolate from your real daemon state
export GLOSA_PORT=4747                 # isolate from your real daemon
mkdir -p "$DEMO/impact-plan/plans/check-ins" "$DEMO/impact-plan/research" "$DEMO/impact-plan/reviews" "$DEMO/team-charter"
```

The fixture in the current screenshots is a fictional "First 90 days — Staff Engineer impact plan"
(`plans/first-90-days.md`) with two check-ins, one research note, and one HTML review, plus a second
workspace (`team-charter`) so the sidebar's workspace switcher is populated. What matters is the
shape, not the prose:

- one Markdown artifact long enough to scroll, with a heading, bullets, a table, and a blockquote;
- at least one weak sentence worth commenting on (the current fixture uses
  `Improve checkout reliability.`, a phase goal with no measurable outcome);
- nested directories and a mix of `.md` and `.html`, so the sidebar shows real nesting.

Then register and wire it:

```sh
bun run packages/cli/src/main.ts open --port 4747 --url --workspace "$DEMO/impact-plan" plans/first-90-days.md
bun run packages/cli/src/main.ts init "$DEMO/impact-plan" --agent claude-code --port 4747
bun run packages/cli/src/main.ts open --port 4747 --url --workspace "$DEMO/team-charter" team-charter.md
bun run packages/cli/src/main.ts doctor "$DEMO/impact-plan" --port 4747   # expect all PASS
```

`open --url` prints the paired URL. Every capture below drives that URL in a headless Chromium at
`deviceScaleFactor: 2`, viewport `1440x860`, once with `colorScheme: light` and once with
`colorScheme: dark`. glosa's appearance setting stays on **System**, so the browser's scheme decides
the theme.

## 2. Record one real session

Start a Claude Code session in the workspace that will still be running while you annotate, so the
wiring badge reads `Live → session` and the comments are delivered at a real turn boundary:

```sh
cd "$DEMO/impact-plan"
claude -p --output-format stream-json --verbose --strict-mcp-config --mcp-config .mcp.json \
  --setting-sources project \
  "Read every artifact in this workspace and tell me which part of the plan is weakest. I am \
reviewing plans/first-90-days.md in glosa right now — when my review comments arrive, apply exactly \
what they ask for, nothing else." > session.jsonl
```

While it runs, in the browser: switch to **Review**, select the weak sentence, pick an intent, write
the comment, send it, and repeat for a second passage. Capture two frames here — the composer
mid-write (this becomes the hero's right pane) and the margin with both cards saved.

Run that pass twice, once per colour scheme, and **withdraw both entries with the card's Remove
button at the end of the first pass** (`button.glosa-annotation-remove`). Otherwise the second pass
starts with a non-empty queue and its wiring badge reads `Live → session · 2 queued` where the first
read `Live → session`, which is a visible difference between the two variants. Keep the second pass's
comments: those are the ones the agent applies.

The comments then reach the session on their own — either injected at the turn boundary as
`Stop hook feedback`, or fetched by the agent through `glosa_inbox_pull` when it decides to look.
Whichever path the recorded run took is the one the hero's terminal pane should show. Keep a glosa tab
open while the agent edits, because the artifact watcher only runs while the workspace is being
watched.

The terminal pane is typeset from `session.jsonl`: the prompt, the tool lines, the delivered
annotation payload, the edit, and the closing summary — hard-wrapped to the pane width and trimmed
with `[…]` where a paragraph ran long. Keep the wording verbatim; that pane is a transcript, not copy.

## 3. Capture the remaining states

| Image | State to reach |
|---|---|
| `annotate-*.png` | Review mode, both margin cards saved, scrolled to the annotated section. |
| `history-*.png` | Make one edit in **Edit → Source** and Save (that is the `human_edit` checkpoint), then open **⋯ → History**, select the oldest version, and press *Compare selected with current*. |
| `approval-*.png` | Run `glosa request-review plans/first-90-days.md --wait 6m --require-approval --message "…"` from the workspace; the strip appears in the browser. Shoot both themes first, then approve in the second one so the verdict returns to the waiting command. |

The Edit-mode source pane needs a beat: the face toggle (`button.glosa-face-source`) only becomes
clickable once the rich editor has mounted, so wait for it to be visible rather than sleeping a fixed
interval.

## 4. Compose the frames

`docs/assets/screens/frame.html` renders the window chrome. It takes one URL-encoded JSON spec and
needs no build step, no network, and no dependencies:

```
file://…/frame.html?spec=<encodeURIComponent(JSON.stringify(spec))>
```

The hero is deliberately small and sparse: one comment in the margin, the same comment arriving in
the terminal, one diff. The browser pane crops the raw capture to the document and the composer —
no sidebar, no app header — and the terminal pane carries only the prompt tail, the delivered
annotation, and the applied edit, trimmed with `[…]`. This is the current hero spec:

```js
{
  w: 1320, h: 668,                       // stage size in CSS px
  theme: "dark",                         // omit for the light stage
  windows: [
    { kind: "browser", url: "127.0.0.1:4747 — impact-plan", x: 292, y: 40, w: 1000,
      img: "file://…/raw-hero-glosa.png", imgW: 1440, imgH: 860, scale: 1000 / 1178,
      crop: { x: 262, y: 350, w: 1178, h: 500 } },   // sidebar and app header cropped out
    { kind: "terminal", title: "impact-plan — claude", x: 28, y: 162, w: 640,
      fontSize: 14, lines: [...] }                   // ~19 hard-wrapped lines, nothing more
  ]
}
```

`lines` entries are HTML strings; an empty string is a vertical gap. The classes are `dim`, `user`,
`dot`, `tool`, `del`, `add`, and `glosa` (used for the delivered annotation block). `fontSize` sets
the terminal's type size in CSS px (default 13).

Screenshot the `#stage` element at `deviceScaleFactor: 2` (or set `document.documentElement.style.zoom = "2"`
before shooting if the driver cannot change the scale factor — both scale the window chrome and type
uniformly), then downsample to the widths committed here — 1660px for the hero, 1600px for the
capability cards. That is roughly twice the width GitHub renders them at:

```sh
sips -s format png --resampleWidth 1660 stage-hero-dark.png --out docs/assets/screens/hero-dark.png
```

## Cleanup

```sh
rm -rf /tmp/glosa-readme-demo
```

If a capture session ever registers an unwanted workspace with your real daemon (for example a
fixture created inside a repository), remove its entry from `~/.glosa/workspaces.json`.
