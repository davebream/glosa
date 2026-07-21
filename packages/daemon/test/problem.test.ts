// SPDX-License-Identifier: Apache-2.0
// P1.3 review item 2 — unit coverage for internalErrorResponse, the last-resort 500 an unhandled
// throw in the HTTP pipeline falls back to. The point of this response is what it does NOT say —
// no error message, no stack, nothing an exception could have been carrying.
import { describe, expect, test } from "bun:test";
import { internalErrorResponse, problem } from "../src/problem.ts";

describe("problem", () => {
  test("builds the RFC 9457 envelope with problem+json content type", async () => {
    const res = problem(404, "not-found", "unknown workspace", "detail here", "/w/x/y");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    const body = await res.json();
    expect(body).toEqual({
      type: "https://glosa.local/errors/not-found",
      title: "unknown workspace",
      status: 404,
      detail: "detail here",
      instance: "/w/x/y",
    });
  });

  test("omits detail/instance when not provided", async () => {
    const res = problem(401, "unauthorized", "missing token");
    const body = await res.json();
    expect(body).toEqual({
      type: "https://glosa.local/errors/unauthorized",
      title: "missing token",
      status: 401,
    });
  });
});

describe("internalErrorResponse", () => {
  test("status 500, problem+json, slug internal", async () => {
    const res = internalErrorResponse();
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    const body = await res.json();
    expect(body.type).toBe("https://glosa.local/errors/internal");
    expect(body.status).toBe(500);
  });

  test("attaches the given CSP headers", async () => {
    const res = internalErrorResponse({ "Content-Security-Policy": "default-src 'none';", "X-Test": "y" });
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none';");
    expect(res.headers.get("X-Test")).toBe("y");
  });

  test("works with no CSP headers at all", async () => {
    const res = internalErrorResponse();
    expect(res.status).toBe(500);
  });

  test("never contains a stack trace, file path, or error message — only the fixed generic body", async () => {
    const res = internalErrorResponse();
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ type: "https://glosa.local/errors/internal", title: "internal error", status: 500 }));
    expect(text).not.toContain(".ts:"); // no source location
    expect(text).not.toContain("at "); // no stack-frame-shaped text
    expect(text.toLowerCase()).not.toContain("error:"); // no re-thrown message prefix
  });
});
