// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ApiContext, createApiFetch } from "../src/transport/http.ts";
import { liveSpaAssets, pinnedSpaAssets, stampShell } from "../src/transport/spa-assets.ts";

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

      // A stylesheet's own url() references (the vendored faces) are part of the graph too.
      if (path.endsWith(".css")) {
        const css = await response.text();
        for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
          const ref = match[1]!;
          if (ref.startsWith("data:") || ref.startsWith("#")) continue;
          pending.push(new URL(ref, `${ORIGIN}${path}`).pathname);
        }
        continue;
      }

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

const HASH = "0123456789abcdef";
const copies: string[] = [];
afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A private copy of packages/spa/src, so a test can replace and delete files under a source. */
function spaCopy(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "glosa-spa-copy-")));
  copies.push(dir);
  cpSync(fileURLToPath(SPA_ROOT), dir, { recursive: true });
  return dir;
}

describe("the install lifetime policy's asset rules (#432, R-L1 and R-L6)", () => {
  test("the stamped shell carries its build hash and scopes every /app/ reference to it", () => {
    const html = readFileSync(new URL("shell.html", SPA_ROOT), "utf8");
    const stamped = stampShell(html, HASH);
    expect(stamped).toContain(`<meta name="glosa-build" content="${HASH}" />`);
    expect(stamped).not.toMatch(/="\/app\/(?!@)/);
    expect(stamped).toContain(`src="/app/@${HASH}/bootstrap.js"`);
  });

  test("a pinned source keeps serving its boot bytes after the file is replaced or deleted", () => {
    const dir = spaCopy();
    const source = pinnedSpaAssets({ dir, buildHash: HASH, providerAssets: [] });
    const before = source.asset("/app/bootstrap.js");
    writeFileSync(join(dir, "bootstrap.js"), "// a newer build\n");
    expect(source.asset("/app/bootstrap.js")?.body.equals(before!.body)).toBe(true);
    unlinkSync(join(dir, "bootstrap.js"));
    unlinkSync(join(dir, "shell.html"));
    expect(source.asset("/app/bootstrap.js")?.body.equals(before!.body)).toBe(true);
    expect(source.shell()).toContain(HASH);
  });

  test("control: a live source serves the replaced bytes, which is why an installed daemon pins", () => {
    const dir = spaCopy();
    const source = liveSpaAssets({ dir, buildHash: HASH });
    writeFileSync(join(dir, "bootstrap.js"), "// a newer build\n");
    expect(source.asset("/app/bootstrap.js")?.body.toString()).toBe("// a newer build\n");
  });

  test("a page's whole asset graph stays under its build's scope and answers 200 from a pinned source", async () => {
    const spaAssets = pinnedSpaAssets({ buildHash: HASH, providerAssets: [] });
    const fetchFn = createApiFetch({ port: PORT, classFPort: PORT + 1, token: null, spaAssets } as ApiContext);
    const shell = await (await fetchFn(request("/"))).text();
    const pending: string[] = [];
    await new HTMLRewriter()
      .on("[src], [href]", {
        element(element) {
          for (const attribute of ["src", "href"]) {
            const value = element.getAttribute(attribute);
            if (value?.startsWith("/app/")) pending.push(value);
          }
        },
      })
      .transform(new Response(shell))
      .text();
    const transpiler = new Bun.Transpiler({ loader: "js" });
    const visited = new Set<string>();
    while (pending.length > 0) {
      const path = pending.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);
      expect(path.startsWith(`/app/@${HASH}/`), `${path} escaped the page's build scope`).toBe(true);
      const response = await fetchFn(request(path));
      expect(response.status, path).toBe(200);
      if (!path.endsWith(".js")) continue;
      for (const entry of transpiler.scan(await response.text()).imports) {
        pending.push(new URL(entry.path, `${ORIGIN}${path}`).pathname);
      }
    }
    expect(visited).toContain(`/app/@${HASH}/bootstrap.js`);
  });

  test("no hand-written SPA module names an absolute /app/ path, which would escape the page's build scope", () => {
    const dir = fileURLToPath(SPA_ROOT);
    // Named exceptions, each with why its literal is not a load:
    const exempt = new Map([
      // Compares a provider's canonical `/app/…` route from the daemon, then scopes it (scopedModule)
      // before loading, so what it imports is always under the page's own build.
      ["dictation.js", "route comparison, scoped before import"],
    ]);
    const offenders: string[] = [];
    for (const name of new Bun.Glob("*.js").scanSync({ cwd: dir })) {
      if (exempt.has(name)) continue;
      const source = readFileSync(join(dir, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const match of source.matchAll(/["'`]\/app\//g)) offenders.push(`${name}@${match.index}`);
    }
    expect(offenders).toEqual([]);
  });

  test("another build's scope is 410 build-changed; the unscoped form still answers for older pages", async () => {
    const spaAssets = pinnedSpaAssets({ buildHash: HASH, providerAssets: [] });
    const fetchFn = createApiFetch({ port: PORT, classFPort: PORT + 1, token: null, spaAssets } as ApiContext);
    const other = await fetchFn(request("/app/@fedcba9876543210/bootstrap.js"));
    expect(other.status).toBe(410);
    expect(((await other.json()) as { type: string }).type).toContain("build-changed");
    expect((await fetchFn(request("/app/bootstrap.js"))).status).toBe(200);
    expect((await fetchFn(request(`/app/@${HASH}/not-on-the-allowlist.js`))).status).toBe(404);
  });
});
