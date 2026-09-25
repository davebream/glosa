// SPDX-License-Identifier: Apache-2.0
// The pure half of scripts/brand-electron.ts: rewriting one plist string, or adding it when absent.
import { describe, expect, test } from "bun:test";
import { withPlistString } from "../scripts/brand-electron.ts";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleName</key>
\t<string>Electron</string>
\t<key>CFBundleIconFile</key>
\t<string>electron.icns</string>
</dict>
</plist>`;

describe("brand-electron: withPlistString", () => {
  test("rewrites an existing key and leaves the rest untouched", () => {
    const out = withPlistString(PLIST, "CFBundleName", "glosa");
    expect(out).toContain("<key>CFBundleName</key>\n\t<string>glosa</string>");
    expect(out).toContain("<string>electron.icns</string>");
    expect(out).not.toContain("<string>Electron</string>");
  });
  test("adds a key the plist lacks, before the closing dict", () => {
    const out = withPlistString(PLIST, "CFBundleDisplayName", "glosa");
    expect(out).toContain("<key>CFBundleDisplayName</key>\n\t<string>glosa</string>\n</dict>\n</plist>");
  });
  test("is idempotent", () => {
    const once = withPlistString(PLIST, "CFBundleName", "glosa");
    expect(withPlistString(once, "CFBundleName", "glosa")).toBe(once);
  });
});
