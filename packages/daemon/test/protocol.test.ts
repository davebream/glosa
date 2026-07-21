// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { parseProtocolVersion, protocolCompatible } from "../src/protocol.ts";

describe("protocol.ts", () => {
  test("parseProtocolVersion splits major.minor", () => {
    expect(parseProtocolVersion("1.0")).toEqual({ major: 1, minor: 0 });
    expect(parseProtocolVersion("2.7")).toEqual({ major: 2, minor: 7 });
  });

  test("compatible: same major, client-minor <= daemon-minor", () => {
    expect(protocolCompatible("1.0", "1.0")).toBe(true);
    expect(protocolCompatible("1.0", "1.5")).toBe(true); // daemon ahead on minor — fine
  });

  test("incompatible: client-minor ahead of daemon-minor", () => {
    expect(protocolCompatible("1.5", "1.0")).toBe(false);
  });

  test("incompatible: major mismatch in either direction", () => {
    expect(protocolCompatible("2.0", "1.0")).toBe(false);
    expect(protocolCompatible("1.0", "2.0")).toBe(false);
  });

  test("parseProtocolVersion rejects malformed strings to a never-compatible sentinel", () => {
    for (const malformed of ["", "1", "1.2.3", "x.y"]) {
      expect(parseProtocolVersion(malformed)).toEqual({ major: -1, minor: -1 });
    }
  });

  test("a malformed version is incompatible with a well-formed one in either role", () => {
    expect(protocolCompatible("1.2.3", "1.0")).toBe(false);
    expect(protocolCompatible("1.0", "1.2.3")).toBe(false);
    expect(protocolCompatible("x.y", "x.y")).toBe(false); // even malformed-vs-itself
  });
});
