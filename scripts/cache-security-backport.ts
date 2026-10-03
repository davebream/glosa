// SPDX-License-Identifier: Apache-2.0
// OSV matches the published version, not Bun's installed patch. Generate the fixed-advisory
// record only after checking both lockfiles, the patch and every installed copy, plus reuse behavior.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, relative } from "node:path";

const PACKAGE = "http-cache-semantics";
const VERSION = "4.2.0";
const PATCH = "patches/http-cache-semantics-4.2.0.patch";
const PATCH_SHA256 = "f5ab5dfb154eb1f848aa82444d555eefc592115562da3929f4fb45b73c98bdac";
const SOURCE_SHA256 = "ae6ad24f801fd17c16cc39d8ebf6547c3c529184b9beabafb3a76d20669a050e";
const CONFIG = ".context/security/osv-scanner.toml";

interface Request {
  url: string;
  method: string;
  headers: Record<string, string>;
}
interface Policy {
  satisfiesWithoutRevalidation(request: Request): boolean;
  evaluateRequest(request: Request): { response: unknown };
  useStaleWhileRevalidate(): boolean;
  revalidatedPolicy(
    request: Request,
    response: { status: number; headers: Record<string, string> },
  ): { modified: boolean };
  timeToLive(): number;
  toObject(): unknown;
}
export interface PolicyConstructor {
  new (
    request: Request,
    response: { status: number; headers: Record<string, string> },
    options: { shared?: boolean },
  ): Policy;
  fromObject(value: unknown): Policy;
}

/** Real library decisions, no network or clock waits. Age: 1 makes max-age: 0 deterministically stale. */
export function cacheReuseProblems(CachePolicy: PolicyConstructor): string[] {
  const problems: string[] = [];
  const request: Request = { url: "https://cache.invalid/document", method: "GET", headers: { host: "cache.invalid" } };
  const cases: Array<{
    name: string;
    directive?: string;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    options?: { shared: boolean };
    reusable?: boolean;
  }> = [
    { name: "shared cookie", responseHeaders: { "set-cookie": "session=secret" } },
    { name: "no-cache", directive: "no-cache" },
    { name: "no-store", directive: "no-store" },
    { name: "shared private", directive: "private" },
    { name: "proxy-revalidate", directive: "proxy-revalidate" },
    { name: "must-revalidate", directive: "must-revalidate" },
    { name: "authenticated shared response", requestHeaders: { authorization: "Bearer secret" } },
    { name: "vary wildcard", responseHeaders: { vary: "*" } },
    { name: "ordinary stale", reusable: true },
    {
      name: "cookie public opt-in",
      directive: "public",
      responseHeaders: { "set-cookie": "session=secret" },
      reusable: true,
    },
    {
      name: "cookie immutable opt-in",
      directive: "immutable",
      responseHeaders: { "set-cookie": "session=secret" },
      reusable: true,
    },
    {
      name: "private cache",
      directive: "private",
      responseHeaders: { "set-cookie": "session=secret" },
      options: { shared: false },
      reusable: true,
    },
  ];
  for (const fixture of cases) {
    const req = { ...request, headers: { ...request.headers, ...fixture.requestHeaders } };
    const original = new CachePolicy(
      req,
      {
        status: 200,
        headers: {
          "cache-control": `max-age=0, stale-if-error=600, stale-while-revalidate=600${fixture.directive ? `, ${fixture.directive}` : ""}`,
          age: "1",
          ...fixture.responseHeaders,
        },
      },
      fixture.options ?? {},
    );
    for (const [form, policy] of [
      ["constructed", original],
      ["restored", CachePolicy.fromObject(original.toObject())],
    ] as const) {
      const decisions = {
        "max-stale": policy.satisfiesWithoutRevalidation({
          ...req,
          headers: { ...req.headers, "cache-control": "max-stale" },
        }),
        "max-stale=600": !!policy.evaluateRequest({
          ...req,
          headers: { ...req.headers, "cache-control": "max-stale=600" },
        }).response,
        "stale-while-revalidate": policy.useStaleWhileRevalidate(),
        "stale-if-error": !policy.revalidatedPolicy(req, { status: 503, headers: {} }).modified,
        "cache lifetime": policy.timeToLive() > 0,
      };
      for (const [path, reused] of Object.entries(decisions)) {
        if (reused !== !!fixture.reusable)
          problems.push(`${fixture.name}: ${form} ${path} must ${fixture.reusable ? "allow" : "refuse"} reuse`);
      }
    }
  }
  return problems;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Enumerate hoisted and nested installs, including package symlinks, without traversing workspaces. */
function installedCopies(modules: string): string[] {
  const copies: string[] = [];
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(modules, entry.name);
    if (entry.name.startsWith("@")) {
      copies.push(...installedCopies(path));
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name !== PACKAGE && !existsSync(path)) continue;
    const actual = realpathSync(path);
    const manifest = join(actual, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === PACKAGE) {
      copies.push(join(actual, "index.js"));
    }
    // Workspace symlinks are outside this installation; their dependencies are hoisted here.
    if (relative(modules, actual).startsWith("..")) continue;
    const nested = join(actual, "node_modules");
    if (existsSync(nested)) copies.push(...installedCopies(nested));
  }
  return copies;
}

export function verifyCacheBackport(root: string): void {
  requireCondition(sha256(join(root, PATCH)) === PATCH_SHA256, "Cache backport patch digest changed");
  for (const [directory, patchPath] of [
    [".", PATCH],
    ["packages/shell", `../../${PATCH}`],
  ] as const) {
    const project = resolve(root, directory);
    const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    const lock = Bun.JSON5.parse(readFileSync(join(project, "bun.lock"), "utf8")) as {
      patchedDependencies?: Record<string, string>;
      packages: Record<string, unknown>;
    };
    for (const metadata of [manifest, lock]) {
      requireCondition(
        metadata.patchedDependencies?.[`${PACKAGE}@${VERSION}`] === patchPath,
        `${directory}: cache backport declaration missing`,
      );
    }
    const versions = Object.values(lock.packages as Record<string, unknown>)
      .filter(
        (value): value is string[] =>
          Array.isArray(value) && typeof value[0] === "string" && value[0].startsWith(`${PACKAGE}@`),
      )
      .map((value) => value[0]);
    requireCondition(
      versions.length > 0 && versions.every((value) => value === `${PACKAGE}@${VERSION}`),
      `${directory}: cache dependency version changed`,
    );
    const modules = realpathSync(join(project, "node_modules"));
    const entry = createRequire(join(project, "package.json")).resolve(PACKAGE);
    requireCondition(
      !relative(modules, realpathSync(entry)).startsWith(".."),
      `${directory}: own cache dependency installation missing`,
    );
    const copies = [...new Set(installedCopies(modules))];
    requireCondition(copies.length > 0, `${directory}: no cache dependency installed`);
    for (const file of copies) {
      const packageJson = JSON.parse(readFileSync(join(file, "..", "package.json"), "utf8"));
      requireCondition(
        packageJson.name === PACKAGE && packageJson.version === VERSION,
        `${file}: cache package identity changed`,
      );
      requireCondition(sha256(file) === SOURCE_SHA256, `${file}: installed cache backport digest mismatch`);
      const CachePolicy = createRequire(file)(file) as PolicyConstructor;
      const problems = cacheReuseProblems(CachePolicy);
      requireCondition(problems.length === 0, `${file}: ${problems.join("; ")}`);
    }
  }
}

export function writeVerifiedCacheConfig(root: string): void {
  const output = join(root, CONFIG);
  // A failed verification must never leave a record from an earlier successful run.
  rmSync(output, { force: true });
  verifyCacheBackport(root);
  mkdirSync(join(output, ".."), { recursive: true });
  writeFileSync(
    output,
    `# Generated only after installed-byte and cache-reuse verification in both dependency trees.
[[IgnoredVulns]]
id = "GHSA-ch52-4w7c-c8xp"
ignoreUntil = 2026-11-03
reason = "Fixed locally in http-cache-semantics@4.2.0 by the verified Bun backport. All other advisories remain blocking. Replace with an upstream patched release before expiry."
`,
  );
}

if (import.meta.main) {
  writeVerifiedCacheConfig(resolve(import.meta.dir, ".."));
  console.log("Verified cache backport in both dependency trees; generated fixed-advisory record (expires 2026-11-03)");
}
