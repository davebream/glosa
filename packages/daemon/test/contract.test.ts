// SPDX-License-Identifier: Apache-2.0
// A1 §3 contract-version matrix: missing AND unparseable/partial headers are both "ok" (lenient, same
// major assumed); only a well-formed value with a differing major is a proven mismatch.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_VERSION, checkContractVersion } from "../src/transport/contract.ts";

describe("checkContractVersion", () => {
  test("null (missing header) → ok", () => {
    expect(checkContractVersion(null)).toEqual({ status: "ok" });
  });

  test("exact match (1.18) → ok", () => {
    expect(checkContractVersion(CONTRACT_VERSION)).toEqual({ status: "ok" });
  });

  test("N-1 minor (1.12) → stale-minor", () => {
    expect(checkContractVersion("1.12")).toEqual({ status: "stale-minor" });
  });

  test("previous minor (1.0) → stale-minor", () => {
    expect(checkContractVersion("1.0")).toEqual({ status: "stale-minor" });
  });

  test("minor mismatch, same major (1.19) → stale-minor", () => {
    expect(checkContractVersion("1.19")).toEqual({ status: "stale-minor" });
  });

  test("major mismatch (2.0) → mismatch", () => {
    expect(checkContractVersion("2.0")).toEqual({ status: "mismatch" });
  });

  test("major mismatch the other direction (0.5) → mismatch", () => {
    expect(checkContractVersion("0.5")).toEqual({ status: "mismatch" });
  });

  describe("unparseable/partial → lenient (ok), same treatment as missing", () => {
    for (const malformed of ["", "1", "1.0.0", "abc", "2abc", "x.y"]) {
      test(`"${malformed}" → ok`, () => {
        expect(checkContractVersion(malformed)).toEqual({ status: "ok" });
      });
    }
  });
});

/** The authoritative prose copies of the contract version. A bump that edits `CONTRACT_VERSION` and
 * forgets these leaves R5's route catalogue and A1's handshake example advertising an older contract
 * than the daemon serves, which is how 1.9 shipped with two documents still saying 1.8. */
describe("the documented contract version follows CONTRACT_VERSION", () => {
  const repo = join(import.meta.dir, "..", "..", "..");
  const cases = [
    {
      file: "docs/requirements.md",
      quote: (version: string) => `- Versioned route catalog (contract v${version}:`,
    },
    {
      file: "docs/appendices/A1-api-transport.md",
      quote: (version: string) => `{ "contract_version": "${version}", "daemon_version"`,
    },
  ];
  for (const { file, quote } of cases) {
    test(`${file} states ${CONTRACT_VERSION}`, () => {
      const text = readFileSync(join(repo, file), "utf8");
      expect({ file, found: text.includes(quote(CONTRACT_VERSION)) }).toEqual({ file, found: true });
    });
  }
});
