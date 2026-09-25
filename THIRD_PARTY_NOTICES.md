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

## Managed chat rendering and native login

- **xterm.js 6.0.0** (`@xterm/xterm`, MIT): unmodified published browser module and stylesheet in `packages/spa/src/vendor/`; license in `xterm-license.txt`. Used only for explicitly opened native login terminals. Source: https://github.com/xtermjs/xterm.js.
- **markdown-it 14.3.1** (MIT): unmodified published browser distribution in `packages/spa/src/vendor/markdown-it.js`; license in `markdown-it-license.txt`. Chat rendering disables raw HTML and remote images. Source: https://github.com/markdown-it/markdown-it.

## Desktop app runtime

The desktop app (`packages/shell`, built by `scripts/package-app.ts`) redistributes two runtimes as
binaries. Their license texts ship inside the app, in `glosa.app/Contents/Resources/licenses/`.

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
