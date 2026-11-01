// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mountAgentOAuth } from "../src/agent-oauth.js";
import { installDom, installModalDialogs, type DomEnv } from "./dom-env.ts";
let dom: DomEnv;
let restoreDialogs: () => void;
const mounted: Array<{ destroy(): Promise<void> }> = [];
beforeEach(() => {
  dom = installDom();
  restoreDialogs = installModalDialogs(dom);
});
afterEach(async () => {
  for (const pane of mounted.splice(0)) await pane.destroy();
  restoreDialogs();
  dom.teardown();
});
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("OAuth UI state was not reached");
}
function fixture(status = "succeeded", noticeSeen = true) {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const calls: string[] = [];
  const beginInputs: unknown[] = [];
  const account = { planEnabled: true };
  const dataAccess = {
    async beginAgentOAuth(_provider: string, input: unknown) {
      calls.push("begin");
      beginInputs.push(input);
      return { attemptId: "attempt", authorizationUrl: "https://auth.openai.com/authorize?state=opaque", input };
    },
    async getAgentOAuth() {
      calls.push("status");
      return { status, error: status === "failed" ? "access-denied" : undefined, account };
    },
    async adoptAgentOAuth() {
      calls.push("adopt");
      return { id: "profile", authentication: { planNoticeSeen: noticeSeen } };
    },
    async acknowledgeAgentOAuthPlan() {
      calls.push("notice");
    },
    async cancelAgentOAuth() {
      calls.push("cancel");
    },
    async sendChatTurn() {
      throw new Error("Sign-in must never submit a prompt");
    },
  };
  return { host, calls, beginInputs, dataAccess, account };
}
test("OAuth completion names plan use, opens only the provider URL and never sends a draft", async () => {
  const f = fixture();
  let completed = false;
  const links: string[] = [];
  const pane = await mountAgentOAuth(f.host, {
    dataAccess: f.dataAccess,
    provider: "codex",
    accountId: undefined,
    openOutside: async (url: string) => {
      links.push(url);
    },
    onFinished: () => {
      completed = true;
    },
  });
  mounted.push(pane);
  await until(() => completed);
  expect(links).toEqual(["https://auth.openai.com/authorize?state=opaque"]);
  expect(f.calls).toEqual(["begin", "status", "adopt"]);
  expect(f.host.textContent).toContain("Using ChatGPT plan. No message has been sent.");
});
test("first plan use is acknowledged once after successful sign-in, before completion", async () => {
  const f = fixture("succeeded", false);
  let completed = false;
  mounted.push(
    await mountAgentOAuth(f.host, {
      dataAccess: f.dataAccess,
      provider: "codex",
      accountId: undefined,
      openOutside: async () => {},
      onFinished: () => {
        completed = true;
      },
    }),
  );
  await until(() => !!dom.document.querySelector("dialog"));
  expect(completed).toBe(false);
  expect(f.calls).not.toContain("notice");
  expect(dom.document.querySelector("dialog")?.textContent).toContain("You’re using your ChatGPT plan");
  dom.document.querySelector("dialog button")!.dispatchEvent(new dom.window.Event("click"));
  await until(() => completed);
  expect(f.calls.filter((x) => x === "notice")).toHaveLength(1);
});
test("denied and missing-scope sign-ins explain what happened without dispatching work", async () => {
  const denied = fixture("failed");
  mounted.push(
    await mountAgentOAuth(denied.host, {
      dataAccess: denied.dataAccess,
      provider: "codex",
      accountId: undefined,
      openOutside: async () => {},
      onFinished: () => {
        throw new Error("Denied login cannot complete");
      },
    }),
  );
  await until(() => denied.host.textContent!.includes("declined"));
  expect(denied.calls).not.toContain("adopt");
  const disabled = fixture();
  disabled.account.planEnabled = false;
  let finished = false;
  mounted.push(
    await mountAgentOAuth(disabled.host, {
      dataAccess: disabled.dataAccess,
      provider: "codex",
      accountId: undefined,
      openOutside: async () => {},
      onFinished: () => {
        finished = true;
      },
    }),
  );
  await until(() => finished);
  expect(disabled.host.textContent).toContain("plan usage was not authorized");
  expect(disabled.calls).not.toContain("notice");
});
test("closing a pending sign-in cancels the attempt and leaves the composer outside its authority", async () => {
  const f = fixture("pending");
  const pane = await mountAgentOAuth(f.host, {
    dataAccess: f.dataAccess,
    provider: "codex",
    accountId: "original-account",
    openOutside: async () => {},
    onFinished: () => {
      throw new Error("Pending login cannot complete");
    },
  });
  mounted.push(pane);
  await until(() => f.calls.includes("status"));
  await pane.destroy();
  mounted.splice(mounted.indexOf(pane), 1);
  expect(f.calls.at(-1)).toBe("cancel");
  expect(f.calls).not.toContain("adopt");
  expect(f.beginInputs).toEqual([{ accountId: "original-account", requestPlanConsent: false }]);
});

test("enabling plan use for an existing account explicitly requests reconsent on its saved registration", async () => {
  const { mountAgentSettings } = await import("../src/agent-settings.js");
  const f = fixture("pending");
  const profile = {
    id: "saved-profile",
    provider: "codex",
    label: "Writer",
    enabled: true,
    isDefault: false,
    revision: 1,
    authentication: { mode: "oauth", credentialRef: "saved-registration" },
    auth: { state: "authenticated", identity: "oauth:saved-registration", label: "writer@example.test" },
  };
  const pane = mountAgentSettings(f.host, {
    appearance: undefined,
    onChange: undefined,
    openOutside: () => undefined,
    dataAccess: {
      ...f.dataAccess,
      getAgentStatus: async () => ({
        available: true,
        providers: [{ id: "codex", name: "Codex", installed: true, qualified: true, oauth: true }],
        profiles: [profile],
        oauthAccounts: { codex: [{ accountId: "saved-registration", status: "signed-in", planEnabled: false }] },
      }),
    },
  });
  mounted.push({
    async destroy() {
      pane.destroy();
    },
  });
  await pane.ready;
  const enable = [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Enable ChatGPT plan");
  expect(enable).toBeDefined();
  enable!.click();
  await until(() => f.beginInputs.length === 1);
  expect(f.beginInputs).toEqual([{ accountId: "saved-registration", requestPlanConsent: true }]);
  expect(f.calls).not.toContain("adopt");
});

test.each([true, false])(
  "unconfirmed sign-out with incomplete cleanup=%s reports whether local tokens were actually removed",
  async (incomplete) => {
    const { mountAgentSettings } = await import("../src/agent-settings.js");
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = mountAgentSettings(host, {
      appearance: undefined,
      onChange: undefined,
      dataAccess: {
        getAgentStatus: async () => ({
          available: true,
          providers: [{ id: "codex", name: "Codex", installed: true, qualified: true, oauth: true }],
          profiles: [
            {
              id: "saved-profile",
              provider: "codex",
              label: "Writer",
              enabled: false,
              isDefault: false,
              revision: 2,
              ...(incomplete ? { cleanup: "signout" } : {}),
              authentication: { mode: "oauth", credentialRef: "saved-registration" },
              auth: { state: "needs_login", revocation: "unconfirmed" },
            },
          ],
          oauthAccounts: { codex: [{ accountId: "saved-registration", status: "signed-out", planEnabled: false }] },
        }),
      },
    });
    mounted.push({
      async destroy() {
        pane.destroy();
      },
    });
    await pane.ready;
    if (incomplete) {
      expect(host.textContent).toContain("Secure credential cleanup is incomplete");
      expect(host.textContent).not.toContain("Local credentials were cleared");
    } else expect(host.textContent).toContain("Local credentials were cleared");
    expect(host.textContent).not.toContain("Signed in. ChatGPT plan usage is not authorized.");
  },
);

test("browser sign-in is disabled until the provider is available", async () => {
  const { mountAgentSettings } = await import("../src/agent-settings.js");
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const pane = mountAgentSettings(host, {
    appearance: undefined,
    onChange: undefined,
    dataAccess: {
      getAgentStatus: async () => ({
        available: true,
        profiles: [],
        providers: [{ id: "codex", name: "Codex", installed: true, qualified: false, available: false, oauth: true }],
      }),
    },
  });
  mounted.push({
    async destroy() {
      pane.destroy();
    },
  });
  await pane.ready;
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "Continue with ChatGPT");
  expect(button?.disabled).toBe(true);
});
