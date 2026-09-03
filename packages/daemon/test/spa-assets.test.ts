// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type ApiContext, createApiFetch } from "../src/transport/http.ts";

const PORT = 4646;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SPA_ROOT = new URL("../../spa/src/", import.meta.url);

function request(path: string): Request {
  return new Request(`${ORIGIN}${path}`, { headers: { Host: `127.0.0.1:${PORT}` } });
}

async function shellAssetPaths(): Promise<Set<string>> {
  const paths = new Set<string>();
  const shell = readFileSync(new URL("shell.html", SPA_ROOT), "utf8");
  const rewritten = new HTMLRewriter().on("[src], [href]", {
    element(element) {
      for (const attribute of ["src", "href"]) {
        const value = element.getAttribute(attribute);
        if (value?.startsWith("/app/")) paths.add(new URL(value, ORIGIN).pathname);
      }
    },
  });
  await rewritten.transform(new Response(shell)).text();
  return paths;
}

describe("SPA static asset graph", () => {
  test("every shell asset and imported module is served through the fixed allowlist", async () => {
    const fetchFn = createApiFetch({ port: PORT, classFPort: PORT + 1, token: null } as ApiContext);
    const pending = [...(await shellAssetPaths())];
    const visited = new Set<string>();
    const transpiler = new Bun.Transpiler({ loader: "js" });

    while (pending.length > 0) {
      const path = pending.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);

      const response = await fetchFn(request(path));
      expect(response.status, `${path} must be present in the SPA asset allowlist`).toBe(200);

      if (!path.endsWith(".js")) continue;
      expect(response.headers.get("Content-Type"), `${path} must be served as JavaScript`).toBe(
        "text/javascript; charset=utf-8",
      );

      const source = await response.text();
      for (const entry of transpiler.scan(source).imports) {
        expect(entry.path.startsWith("."), `${path} contains unsupported bare import ${entry.path}`).toBe(true);
        const importedPath = new URL(entry.path, `${ORIGIN}${path}`).pathname;
        expect(importedPath.startsWith("/app/"), `${path} imports outside the SPA asset root`).toBe(true);
        pending.push(importedPath);
      }
    }

    expect(visited).toContain("/app/bootstrap.js");
    expect(visited.size).toBeGreaterThan(1);
  });
});
