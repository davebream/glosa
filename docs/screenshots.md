# Regenerating the README screenshots

`docs/assets/screens/*.png` are real captures of the SPA, composed into macOS window frames by
`docs/assets/screens/frame.html`. Nothing in this pipeline is generated, mocked or retouched: the
document, the notes, the agent's change, the version history and the approval request all come from
one recorded session against a throwaway workspace.

Each image ships as a `-light.png` / `-dark.png` pair, wired up in the README with `<picture>` and
`prefers-color-scheme` so GitHub serves the variant that matches the reader's theme. **Capture both
themes from the same workspace state, back to back.** glosa's own state (notes, checkpoints, approval)
is shared, and only the browser context's `colorScheme` differs. If the state moves between the two
captures (a session applies a note, a request is approved), the two variants show different things to
anyone toggling themes.

Re-capture whenever the workspace chrome, the margin, the history pane or the approval strip changes
shape.

## 1. Build a throwaway workspace outside the repo

Put it anywhere but inside this repository: glosa resolves a workspace by walking up to the enclosing
Git root, so a fixture inside the repo registers the repo itself.

A source checkout already isolates itself from an installed glosa, but pin the home and port so every
command, the browser and the recorded agent session talk to the same daemon. The simplest way is a
small wrapper on `PATH`:

```sh
DEMO=/tmp/glosa-readme-demo
mkdir -p "$DEMO/bin" "$DEMO/impact-plan/plans/check-ins" "$DEMO/impact-plan/research" "$DEMO/impact-plan/reviews" "$DEMO/team-charter"
cat > "$DEMO/bin/glosa" <<EOF
#!/bin/sh
export GLOSA_HOME="$DEMO/glosa-home" GLOSA_PORT=4747
exec bun run /path/to/glosa/packages/cli/src/main.ts "\$@"
EOF
chmod +x "$DEMO/bin/glosa"
export PATH="$DEMO/bin:$PATH"
```

The fixture in the current screenshots is a fictional "First 90 days: Staff Engineer impact plan"
(`plans/first-90-days.md`) with two check-ins, one research note and one HTML review, plus a second
workspace (`team-charter`) so the sidebar's workspace list is populated. What matters is the shape:

- one Markdown artifact long enough to scroll, with headings, bullets, a table and a blockquote;
- at least one weak sentence worth a note (the current fixture uses `Improve checkout reliability.`,
  a phase goal with no measurable outcome);
- nested directories and a mix of `.md` and `.html`, so the sidebar shows real nesting.

Commit each fixture directory as its own Git repository, then register both:

```sh
glosa open --url --workspace "$DEMO/impact-plan" plans/first-90-days.md
glosa open --url --workspace "$DEMO/team-charter" team-charter.md
```

`open --url` prints the paired URL. Every capture drives that URL in a headless Chromium at
`deviceScaleFactor: 2` and a `1440x860` viewport, once with `colorScheme: light` and once with
`colorScheme: dark`. glosa's appearance setting stays on **System**, so the browser's scheme decides
the theme.

## 2. Record one real session

There is no `glosa init` and nothing to install into Claude's configuration. Give the session an
explicit MCP config that points at the wrapper, and keep your own plugins and settings out of the
recording:

```sh
cat > "$DEMO/impact-plan/.mcp.json" <<EOF
{ "mcpServers": { "glosa": { "command": "$DEMO/bin/glosa", "args": ["mcp"] } } }
EOF
cd "$DEMO/impact-plan"
claude -p --output-format stream-json --verbose --strict-mcp-config --mcp-config .mcp.json \
  --setting-sources project --permission-mode acceptEdits \
  --allowedTools "mcp__glosa__glosa_session_bind,mcp__glosa__glosa_inbox_pull,mcp__glosa__glosa_inbox_get,mcp__glosa__glosa_delivery_ack,Bash(glosa:*),Bash(sleep:*),Bash(printenv:*),Read,Edit,ToolSearch" \
  < prompt.txt > session.jsonl
```

Pass the prompt on stdin: `--allowedTools` takes a variable number of values and swallows a trailing
prompt argument. The prompt asks the session to read `CLAUDE_CODE_SESSION_ID` with `printenv`, bind
with `glosa_session_bind` to the workspace's absolute path, check `glosa_inbox_pull` every 20 seconds
until notes arrive, and apply exactly what they ask by following the instructions glosa returns with
each note (`glosa apply-begin`, the edit, `glosa resolve`). Allow `printenv` explicitly; without it the
session stops at a permission prompt nobody can answer.

Wait until `glosa status` reports the session, then, in the browser, switch to **Review**, select the
weak sentence and write the note. Capture the draft open under its passage in both themes before
sending anything: that frame becomes the hero's browser pane. Cancel it in one context and send it in
the other, so exactly one copy exists. A second note on another passage gives the session something
it may reasonably decline.

The session's own terminal output is the hero's terminal pane, typeset from `session.jsonl`: the prompt
tail, the `glosa_inbox_pull` result carrying the note, the lease, the edit, the resolve and the closing
summary. Keep the wording verbatim and trim with `[…]` where a line or a paragraph runs long. That pane
is a transcript, not copy.

## 3. Capture the remaining states

| Image | State to reach |
|---|---|
| `annotate-*.png` | Review with two notes waiting beside their passages. Add them after the session has finished so their state cannot change between the two theme captures, and check the cards sit in the right-hand rail, not in the collapsed tray at the pane's foot. |
| `history-*.png` | Make one edit in **Edit → Source** and Save (the human checkpoint), so the list shows all three attributions: you, the agent session's leased change, and the untracked starting version. Open **History** and tick the oldest version; capture the list itself rather than the comparison tab it opens. |
| `approval-*.png` | Run `glosa request-review plans/first-90-days.md --wait 6m --require-approval --message "…"` from the workspace and capture the strip in both themes. Approving takes two clicks: **Final approval**, then **Approve revision** in the confirmation dialog. |
| `question-*.png` | Not captured yet (#308); take it with the next full re-record rather than alone, so it shows the same session as the others. While the recorded session is still bound, have it call the `glosa_ask` MCP tool on one sentence **in the middle of a paragraph** (so the band visibly starts and stops mid-line), with a question and two or three options. Do not answer it between the two theme captures: answering removes the band. Capture at the standard 1440-wide viewport, where the card sits in the rail beside the banded passage. A second pair, `question-narrow-*.png`, at a viewport under 1437px wide (a pane under the 1205px rail floor), shows the notice, **Go to it**, and the card floating at the passage: scroll to the end of the document first, capture the notice, then press **Go to it** and capture again. |

## 4. Compose the frames

`docs/assets/screens/frame.html` renders the window chrome. It takes one URL-encoded JSON spec and
needs no build step, no network and no dependencies:

```
file://…/frame.html?spec=<encodeURIComponent(JSON.stringify(spec))>
```

Crops are in the page's CSS pixels (the 1440×860 viewport), not in the pixels of the 2× capture. The
navigator is 232px wide, so a crop that should start at the pane's left edge uses `x: 232`. The hero
places the terminal on the left and the browser on the right, overlapping only where the browser pane
is empty, so the open draft is never covered:

```js
{
  w: 1320, h: 760,                        // stage size in CSS px
  theme: "dark",                          // omit for the light stage
  windows: [
    { kind: "browser", url: "glosa.localhost:4747 — impact-plan", x: 636, y: 40, w: 660,
      img: "file://…/raw-hero-dark.png", imgW: 1440, imgH: 860, scale: 1,
      crop: { x: 440, y: 430, w: 660, h: 340 } },    // the heading, the sentence and its draft
    { kind: "terminal", title: "impact-plan — claude", x: 24, y: 130, w: 664,
      fontSize: 13, lines: [...] }                   // ~20 hard-wrapped lines, nothing more
  ]
}
```

`lines` entries are HTML strings; an empty string is a vertical gap. The classes are `dim`, `user`,
`dot`, `tool`, `del`, `add` and `glosa` (the delivered note). `fontSize` sets the terminal's type size
in CSS px (default 13). Keep it at 13: the README shows the hero at 830px wide, and anything smaller is
unreadable there.

Screenshot the `#stage` element at `deviceScaleFactor: 2` (or set `document.documentElement.style.zoom = "2"`
before shooting if the driver cannot change the scale factor), then downsample to the widths committed
here, 1660px for the hero and 1600px for the capability cards:

```sh
sips -s format png --resampleWidth 1660 stage-hero-dark.png --out docs/assets/screens/hero-dark.png
```

## The wordmark

`docs/assets/glosa-wordmark.svg` and `-dark.svg` set "glosa" and the margin note in Source Serif 4
converted to outlines, so GitHub renders them without the font. Regenerate the outlines with fontTools
and uharfbuzz from `packages/spa/src/fonts/` (an instance at `wght=620, opsz=60` for the word and
`wght=450, opsz=20` for the note), in the palette from `DESIGN.md`: ink `#1a1511` / `#ebe7e1`, the hand
`#b03f00` / `#e7885d`.

## Cleanup

Stop the demo daemon and delete the workspace:

```sh
lsof -ti tcp:4747 -sTCP:LISTEN | xargs kill   # the demo daemon, found by its port
rm -rf "$DEMO"
```
