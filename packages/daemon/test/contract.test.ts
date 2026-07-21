// P1.3 review item 3 — full matrix for checkContractVersion's leniency decision (D4 in
// docs/OVERNIGHT-LOG.md): missing AND unparseable/partial headers are both "ok" (lenient, same
// major assumed); only a well-formed value with a differing major is a proven mismatch.
import { describe, expect, test } from "bun:test";
import { checkContractVersion } from "../src/contract.ts";

describe("checkContractVersion", () => {
  test("null (missing header) → ok", () => {
    expect(checkContractVersion(null)).toEqual({ status: "ok" });
  });

  test("exact match (1.0) → ok", () => {
    expect(checkContractVersion("1.0")).toEqual({ status: "ok" });
  });

  test("minor mismatch, same major (1.9) → stale-minor", () => {
    expect(checkContractVersion("1.9")).toEqual({ status: "stale-minor" });
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
