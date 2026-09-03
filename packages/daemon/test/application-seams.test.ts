// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");
const transpiler = new Bun.Transpiler({ loader: "ts" });

function parsed(path: string) {
  const source = readFileSync(path, "utf8");
  return {
    imports: transpiler.scan(source).imports.map((item) => item.path),
    executable: transpiler.transformSync(source),
  };
}

describe("daemon application seams", () => {
  test("application services stay transport-free", () => {
    for (const name of ["artifact", "attention", "composer"]) {
      const service = parsed(join(SRC, `services/${name}.ts`));
      expect(
        service.imports.some((specifier) => /(?:^|\/)(?:http|routes|auth|problem)(?:\.ts)?$/.test(specifier)),
      ).toBe(false);
      for (const transportType of ["Request", "Response", "RouteClass", "ApiContext"]) {
        expect(new RegExp(`\\b${transportType}\\b`).test(service.executable), `${name} uses ${transportType}`).toBe(
          false,
        );
      }
    }
  });

  test("http delegates coherent route families instead of owning their application handlers", () => {
    const http = parsed(join(SRC, "transport/http.ts"));
    for (const family of ["artifactRoutes", "attentionRoutes", "composerRoutes"]) {
      expect(http.imports).toContain(`../routes/${family.replace("Routes", "")}.ts`);
      expect(
        new RegExp(`\\b${family}\\s*\\(\\s*\\{`).test(http.executable),
        `${family} must receive a composed dependency object rather than ApiContext`,
      ).toBe(true);
    }

    for (const legacyHandler of [
      "handleListArtifacts",
      "handleGetArtifact",
      "handlePutArtifact",
      "handleCreateAnnotation",
      "handleWithdrawAnnotation",
      "handleDiff",
      "handleCheckpoints",
      "handleRestore",
      "handleInboxPresentation",
      "handleMintCapability",
      "handleInbox",
      "handleAttentionSeen",
      "handleAttentionResponse",
      "handleWorkspaceAttentionRequest",
      "handleWorkspaceEntryStatus",
      "handleComposerSend",
      "handleComposerStatus",
    ]) {
      expect(
        new RegExp(`\\bfunction\\s+${legacyHandler}\\s*\\(`).test(http.executable),
        `${legacyHandler} remains in transport/http.ts`,
      ).toBe(false);
    }
  });
});
