// SPDX-License-Identifier: Apache-2.0
// Maintainer-only: takes an already installed, isolated vendor workspace. Never runs at startup.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = process.argv[2];
if (!workspace) throw new Error("Usage: bun run scripts/vendor-chat-ui.ts /absolute/isolated/vendor/workspace");
const root = fileURLToPath(new URL("../", import.meta.url));
const vendor = join(root, "packages/spa/src/vendor");
const directory = resolve(workspace);
writeFileSync(join(directory, "entry.js"), readFileSync(join(root, "scripts/vendor-chat-ui-entry.js")));
const buildEnv = { ...process.env };
delete buildEnv.ANTHROPIC_API_KEY;
const built = Bun.spawnSync(
  [
    process.execPath,
    "build",
    "entry.js",
    "--target=browser",
    "--minify",
    "--define",
    'process.env.NODE_ENV="production"',
    "--metafile=metafile.json",
    "--outfile=chat-ui.js",
  ],
  { cwd: directory, env: buildEnv, stdout: "inherit", stderr: "inherit" },
);
if (built.exitCode !== 0) throw new Error("Chat vendor build failed");
const graph = JSON.parse(readFileSync(join(directory, "metafile.json"), "utf8")) as {
  outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
};
const packages = new Set<string>();
for (const output of Object.values(graph.outputs))
  for (const [path, value] of Object.entries(output.inputs)) {
    if (!value.bytesInOutput) continue;
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/u.exec(path);
    if (match?.[1]) packages.add(match[1]);
  }
const notices = [
  "Vendored chat UI third-party notices\n\nThese packages contribute bytes to chat-ui.js. This is a local production bundle; no hosted service is configured.\n",
];
for (const name of [...packages].sort()) {
  const path = join(directory, "node_modules", name);
  const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as {
    version: string;
    license: string;
    repository?: string | { url: string };
  };
  const license = readdirSync(path).find((file) => /^license(?:\.[a-z]+)?$/iu.test(file));
  if (!license) throw new Error(`Missing license: ${name}`);
  const source = typeof manifest.repository === "string" ? manifest.repository : (manifest.repository?.url ?? "");
  notices.push(
    `\n${"=".repeat(72)}\n${name}@${manifest.version} · ${manifest.license}\n${source}\n\n${readFileSync(join(path, license), "utf8")}\n`,
  );
}
const body = readFileSync(join(directory, "chat-ui.js"), "utf8");
if (/\b(?:fetch|WebSocket|EventSource|XMLHttpRequest|sendBeacon)\s*\(/u.test(body))
  throw new Error("Unexpected network transport in chat vendor bundle; audit before vendoring");
writeFileSync(
  join(vendor, "chat-ui.js"),
  "// SPDX-License-Identifier: MIT\n// assistant-ui/react 0.15.32, React/react-dom 19.3.0. See chat-ui-notices.txt and THIRD_PARTY_NOTICES.md.\n" +
    body,
);
writeFileSync(join(vendor, "chat-ui-notices.txt"), notices.join(""));
console.log(`Vendored ${packages.size} packages; ${Buffer.byteLength(body)} JavaScript bytes.`);
