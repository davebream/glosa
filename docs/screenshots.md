# Regenerating the README screenshots

`docs/assets/screens/*.png` are real captures of the SPA, composed into macOS window frames by
`docs/assets/screens/frame.html`. Nothing in this pipeline is generated, mocked, or retouched: the
document, the annotations, the revision, the version history, and the approval verdict all come from
one recorded session against a throwaway workspace.

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
`deviceScaleFactor: 2`, viewport `1440x860`, `colorScheme: light`.

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

While it runs, in the browser: switch to **Annotate**, select the weak sentence, pick an intent, write
the comment, send it, and repeat for a second passage. Capture two frames here — the composer
mid-write (this becomes the hero's right pane) and the margin with both cards saved.

glosa delivers the queued comments through the session's Stop hook; the agent then edits the file.
Keep a glosa tab open while that happens — the artifact watcher only runs while the workspace is
being watched. The terminal pane of the hero is typeset from `session.jsonl`: the prompt, the tool
lines, the `Stop hook feedback` block glosa injected, the edit, and the closing summary, wrapped to
the pane width and trimmed with `[…]` where a paragraph was long.

## 3. Capture the remaining states

| Image | State to reach |
|---|---|
| `annotate.png` | Annotate mode, both margin cards saved, scrolled to the annotated section. |
| `history.png` | Make one edit in **Edit → Source** and Save (that is the `human_edit` checkpoint), then open **⋯ → History**, select the oldest version, and press *Compare selected with current*. |
| `approval.png` | Run `glosa request-review plans/first-90-days.md --wait 6m --require-approval --message "…"` from the workspace; the strip appears in the browser. Approving it returns the verdict to the waiting command. |

## 4. Compose the frames

`docs/assets/screens/frame.html` renders the window chrome. It takes one URL-encoded JSON spec and
needs no build step, no network, and no dependencies:

```
file://…/frame.html?spec=<encodeURIComponent(JSON.stringify(spec))>
```

```js
{
  w: 1980, h: 960,                       // stage size in CSS px
  bg: "plain",                           // omit for the gradient backdrop
  windows: [
    { kind: "terminal", title: "impact-plan — claude", x: 34, y: 108, w: 800, lines: [...] },
    { kind: "browser", url: "127.0.0.1:4747 — impact-plan", x: 716, y: 58, w: 1210,
      img: "file://…/raw-hero-glosa.png", imgW: 1440, imgH: 860, scale: 1210 / 1440,
      crop: { x: 0, y: 0, w: 1440, h: 545 } }
  ]
}
```

`lines` entries are HTML strings; an empty string is a vertical gap. The classes are `dim`, `user`,
`dot`, `tool`, `del`, `add`, and `glosa` (used for the delivered annotation block).

Screenshot the `#stage` element at `deviceScaleFactor: 2`, then downsample to the widths committed
here — 2000px for `hero.png`, 1600px for the capability cards:

```sh
sips -s format png --resampleWidth 2000 stage-hero.png --out docs/assets/screens/hero.png
```

## Cleanup

```sh
rm -rf /tmp/glosa-readme-demo
```

If a capture session ever registers an unwanted workspace with your real daemon (for example a
fixture created inside a repository), remove its entry from `~/.glosa/workspaces.json`.
