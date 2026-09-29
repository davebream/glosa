# Third-Party Notices

glosa includes vendored browser code from the projects below. Package-managed
dependencies retain their own license files in their distributions and are
validated by the repository's production dependency license check.

## MIT-licensed components

- diff2html 3.4.56, copyright 2014-2016 Rodrigo Fernandes
- jsdiff, bundled by diff2html
- Hogan.js, bundled by diff2html
- ProseMirror packages, copyright Marijn Haverbeke and others
- markdown-it, copyright 2014 Vitaly Puzrin and Alex Kocharin
- markdown-it dependencies bundled with the editor module
- dockview-core 8.2.0, copyright https://github.com/mathuo
- React and React DOM 19.3.0, Scheduler 0.28.0, copyright Meta Platforms, Inc. and affiliates
- react-zoom-pan-pinch 4.2.0, copyright 2019 prc5
- TypeScript runtime helpers bundled with react-zoom-pan-pinch, copyright Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Zero-Clause BSD component

- idiomorph 0.8.0

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

## SIL Open Font License 1.1 components

- Source Serif 4, copyright 2014 The Source Serif 4 Project Authors
  (https://github.com/adobe-fonts/source-serif). Shipped as a Latin and Latin Extended-A subset.
- Source Sans 3, copyright 2010-2020 Adobe (http://www.adobe.com/), with Reserved Font Name
  "Source". Shipped complete and unmodified apart from WOFF2 compression.

The full license text for both families is in `packages/spa/src/fonts/OFL.txt`.

## Colour palettes

Settings > Appearance offers three palettes made by others, each in a light and a dark theme
(`packages/spa/src/themes/`). glosa uses their colour values and adapts them: a colour below one of
glosa's contrast floors is made darker (light) or lighter (dark) in its own hue until it passes. Each
theme file records its source, the upstream colour every slot takes, and every colour it moved.

- **Catppuccin**, Latte and Mocha, copyright 2021 Catppuccin (the Catppuccin Org), MIT. Source:
  https://github.com/catppuccin/palette, `palette.json` at v1.8.0 (commit `07d02aa`).
- **Rosé Pine**, Dawn and the main variant, copyright mvllow, MIT. Source:
  https://github.com/rose-pine/palette, `palette.json` at commit `92af52b`, and the highlight colours
  from `source/index.ts` at the same commit.
- **Gruvbox**, the light and dark modes at medium contrast, by Pavel Pertsev (morhetz). Source:
  https://github.com/morhetz/gruvbox, `colors/gruvbox.vim` at commit `ef8864b`. The repository has no
  licence file. Its README states the licence as:

  > License
  > -------
  > [MIT/X11][]
  >
  >    [MIT/X11]: https://en.wikipedia.org/wiki/MIT_License

  and its `package.json` names the author "Pavel Pertsev" and the licence "MIT".

The MIT licence text, as Catppuccin's and Rosé Pine's licence files give it under their copyright
lines above, and as Gruvbox's README links to it:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Managed chat rendering and native login

- **xterm.js 6.0.0** (`@xterm/xterm`, MIT): unmodified published browser module and stylesheet in `packages/spa/src/vendor/`; license in `xterm-license.txt`. Used only for explicitly opened native login terminals. Source: https://github.com/xtermjs/xterm.js.
- **markdown-it 14.3.1** (MIT): unmodified published browser distribution in `packages/spa/src/vendor/markdown-it.js`; license in `markdown-it-license.txt`. Chat rendering disables raw HTML and remote images. Source: https://github.com/markdown-it/markdown-it.

## Desktop app runtime

The desktop app (`packages/shell`, built by `packages/shell/scripts/package-app.ts`) redistributes two runtimes as
binaries. Their license texts ship inside the app, in `glosa.app/Contents/Resources/licenses/` on
macOS and `/opt/glosa/resources/licenses/` in the Linux pacman package (#432), which carries Bun's
`bun-linux-x64-baseline` build.

- **Electron 44** (MIT, copyright Electron contributors and GitHub Inc.), which includes Chromium and
  the components listed in Chromium's own license file. Shipped as `electron-LICENSE.txt` and
  `chromium-LICENSES.html`. Source: https://github.com/electron/electron.
- **Bun** at the repository's `packageManager` pin (MIT, copyright Oven and contributors). Bun
  statically links JavaScriptCore and WebKit, which are LGPL-2 licensed, and further components
  under their own licenses. Bun's `LICENSE.md` lists them and says how to relink Bun against a
  modified JavaScriptCore. Shipped as `bun-LICENSE.md`. Source:
  https://github.com/oven-sh/bun, at the tag `bun-v<version>` for the version the app carries.

## Agent identity marks

The locally embedded monochrome marks in `packages/spa/src/agent-ui.js` identify the selected
coding agent. They are third-party trademarks, not Glosa branding or an endorsement.

- Claude and OpenAI (used for Codex, matching the selected UI reference): [Lobe Icons](https://github.com/lobehub/lobe-icons), MIT, commit
  `5c1ecb4fb06b92519a39102482d4e8273f000422`. Static SVG geometry and viewBox are unchanged;
  fill follows the interface foreground. Source assets: `packages/static-svg/icons/claude.svg`
  and `packages/static-svg/icons/openai.svg`. The marks belong to Anthropic and OpenAI respectively.

MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


## Rebuilding the image viewer vendor bundle

This is a maintainer vendoring step, not an installation or runtime build. Use the repository's
pinned Bun. In a disposable directory, install exact `react@19.3.0`, `react-dom@19.3.0`,
`scheduler@0.28.0` and `react-zoom-pan-pinch@4.2.0` with `bun add --exact`.
From the latter package's `dist/index.esm.js`, extract the JSON string assigned to `css_248z`
into `packages/spa/src/vendor/image-viewer.css` and remove the call `styleInject(css_248z);`.
The app stylesheet imports that CSS locally. Use this entry module in the disposable directory:

```js
export * as React from "react";
export { createRoot } from "react-dom/client";
export { TransformWrapper, TransformComponent } from "./node_modules/react-zoom-pan-pinch/dist/index.esm.js";
```

Build it with `bun build entry.js --target=browser --minify --define
'process.env.NODE_ENV="production"' --outfile image-viewer.js`. Prepend the MIT SPDX notice
and version/license-reference comment already in the checked-in bundle, then copy to
`packages/spa/src/vendor/image-viewer.js`. Verify that the output has no bare imports, external
requests or injected stylesheet, and run the image-tab browser acceptance test and import-boundary
suite. The bundle is loaded only by the image pane's dynamic import.


## CodeMirror read-only source viewer (#448)

The locally vendored ES module is 659,382 bytes (229,205 bytes gzip).
It loads only when a text read-only tab opens. Binary/oversized placeholders, documents and images
do not load it. All grammars and styles are local; no workers, evaluation, CDN or runtime build
are required. The following exact package versions are pinned for rebuilding:

```text
@codemirror/autocomplete@6.20.3
@codemirror/commands@6.11.1
@codemirror/lang-css@6.3.1
@codemirror/lang-html@6.4.12
@codemirror/lang-javascript@6.2.5
@codemirror/lang-json@6.0.2
@codemirror/lang-markdown@6.5.2
@codemirror/lang-python@6.2.1
@codemirror/lang-sql@6.10.0
@codemirror/lang-xml@6.1.0
@codemirror/lang-yaml@6.1.3
@codemirror/language@6.12.4
@codemirror/legacy-modes@6.5.4
@codemirror/lint@6.9.7
@codemirror/search@6.7.2
@codemirror/state@6.7.6
@codemirror/view@6.43.13
@lezer/common@1.5.3
@lezer/css@1.3.8
@lezer/highlight@1.2.5
@lezer/html@1.3.13
@lezer/javascript@1.5.5
@lezer/json@1.0.3
@lezer/lr@1.4.10
@lezer/markdown@1.7.2
@lezer/python@1.1.19
@lezer/xml@1.0.6
@lezer/yaml@1.0.4
@marijn/find-cluster-break@1.0.4
crelt@1.0.7
style-mod@4.1.4
w3c-keyname@2.2.8
```

### License: @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/lang-json, @codemirror/lang-markdown, @codemirror/lang-python, @codemirror/lang-sql, @codemirror/lang-xml, @codemirror/language, @codemirror/legacy-modes, @codemirror/lint, @codemirror/search, @codemirror/state, @codemirror/view

```text
MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License: @codemirror/lang-yaml

```text
MIT License

Copyright (C) 2024 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License: @lezer/common, @lezer/css, @lezer/highlight, @lezer/html, @lezer/javascript, @lezer/lr, @lezer/xml

```text
MIT License

Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License: @lezer/json

```text
MIT License

Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin>, Arun Srinivasan <rulfzid@gmail.com>, and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License: @lezer/markdown, @lezer/python

```text
MIT License

Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License: @lezer/yaml

```text
MIT License

Copyright (C) 2024 by Marijn Haverbeke <marijnh@gmail.com> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License: @marijn/find-cluster-break

```text
MIT License

Copyright (C) 2024 by Marijn Haverbeke <marijn@haverbeke.berlin>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License: crelt

```text
Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License: style-mod

```text
Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License: w3c-keyname

```text
Copyright (C) 2016 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### Rebuilding the source viewer

Use the repository's pinned Bun in a disposable directory. Install every exact package above
with `bun add --exact` (including transitive packages to preserve resolution). Save this entry:

```js
export {standardKeymap} from '@codemirror/commands';
export {EditorState, Compartment} from '@codemirror/state';
export {EditorView, keymap, lineNumbers, drawSelection} from '@codemirror/view';
export {search, searchKeymap, openSearchPanel, highlightSelectionMatches} from '@codemirror/search';
export {syntaxHighlighting, HighlightStyle} from '@codemirror/language';
export {tags} from '@lezer/highlight';
import {StreamLanguage} from '@codemirror/language';
import {javascript} from '@codemirror/lang-javascript';
import {json} from '@codemirror/lang-json';
import {yaml} from '@codemirror/lang-yaml';
import {html} from '@codemirror/lang-html';
import {xml} from '@codemirror/lang-xml';
import {css} from '@codemirror/lang-css';
import {markdown} from '@codemirror/lang-markdown';
import {python} from '@codemirror/lang-python';
import {sql} from '@codemirror/lang-sql';
import {ruby} from '@codemirror/legacy-modes/mode/ruby';
import {shell} from '@codemirror/legacy-modes/mode/shell';
import {toml} from '@codemirror/legacy-modes/mode/toml';
export function languageFor(path) {
  const ext = path.split('.').pop().toLowerCase();
  if (['js','mjs','cjs','jsx','ts','mts','cts','tsx'].includes(ext)) return javascript({typescript:['ts','mts','cts','tsx'].includes(ext),jsx:['jsx','tsx'].includes(ext)});
  if (['json','jsonc'].includes(ext)) return json();
  if (['yml','yaml'].includes(ext)) return yaml();
  if (['html','htm'].includes(ext)) return html();
  if (['xml','svg'].includes(ext)) return xml();
  if (ext==='css') return css();
  if (['md','markdown'].includes(ext)) return markdown();
  if (['py','pyw'].includes(ext)) return python();
  if (ext==='sql') return sql();
  if (['rb','rake','gemspec'].includes(ext)) return StreamLanguage.define(ruby);
  if (['sh','bash','zsh'].includes(ext)) return StreamLanguage.define(shell);
  if (ext==='toml') return StreamLanguage.define(toml);
  return [];
}
```

Run `bun build entry.js --target=browser --minify --outfile codemirror.js`. Prepend the two-line
MIT/license-reference header from the checked-in bundle and copy the result to
`packages/spa/src/vendor/codemirror.js`. This is a maintainer vendoring step, never installation
or runtime work. Verify no external imports or resource requests, then run the SPA import-boundary
suite and the read-only source scenario in the real-engine workbench acceptance suite.
