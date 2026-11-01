// SPDX-License-Identifier: Apache-2.0
import { noticeDialog } from "./dialog.js";
import { createElement as el } from "./viewer-shell.js";

const failureText = {
  cancelled: "Sign-in was cancelled. Your drafts are unchanged.",
  expired: "Sign-in expired. Continue with ChatGPT to start again.",
  "access-denied": "ChatGPT sign-in was declined. Your drafts are unchanged.",
  "identity-mismatch":
    "This is a different ChatGPT account. Sign in to the original account or add a separate account.",
  "secure-storage": "Unlock your system credential storage, then try again.",
  "invalid-client": "ChatGPT rejected this registration. Start a new sign-in.",
  "reauth-required": "Sign in to ChatGPT again before continuing.",
};

/** OAuth has no composer access and can never send or retry a prompt. */
export async function mountAgentOAuth(
  host,
  { dataAccess, provider, accountId, requestPlanConsent = !accountId, openOutside, onFinished },
) {
  let destroyed = false;
  let timer;
  let attempt;
  let adopting = false;
  const requestId = crypto.randomUUID();
  const status = el("p", { role: "status", textContent: "Opening ChatGPT sign-in…" });
  const link = el("a", {
    target: "_blank",
    rel: "noopener noreferrer",
    textContent: "Open ChatGPT sign-in",
    hidden: true,
  });
  const cancel = el("button", { type: "button", textContent: "Cancel sign-in" });
  const retry = el("button", { type: "button", textContent: "Check sign-in", hidden: true });
  const panel = el("section", { className: "glosa-agent-oauth", "aria-label": "ChatGPT sign-in" }, [
    el("h3", { textContent: "Continue with ChatGPT" }),
    status,
    link,
    retry,
    cancel,
  ]);
  host.replaceChildren(panel);
  const fail = (message) => {
    status.textContent = message;
    status.setAttribute("role", "alert");
  };
  const poll = async () => {
    if (destroyed || !attempt || adopting) return;
    retry.hidden = true;
    try {
      const result = await dataAccess.getAgentOAuth(provider, attempt.attemptId);
      if (destroyed) return;
      if (result.status === "succeeded") {
        adopting = true;
        const profile = await dataAccess.adoptAgentOAuth(provider, { requestId, attemptId: attempt.attemptId });
        if (destroyed) return;
        if (result.account?.planEnabled && !profile.authentication?.planNoticeSeen) {
          await noticeDialog({
            title: "You’re using your ChatGPT plan",
            body: "Eligible usage in glosa uses your ChatGPT plan. Manage usage in your ChatGPT settings. No message has been sent.",
            dismissLabel: "Got it",
          });
          if (!destroyed) await dataAccess.acknowledgeAgentOAuthPlan(profile.id, { requestId: crypto.randomUUID() });
        }
        if (destroyed) return;
        status.textContent = result.account?.planEnabled
          ? "Using ChatGPT plan. No message has been sent."
          : "Signed in. ChatGPT plan usage was not authorized. No message has been sent.";
        link.hidden = true;
        cancel.hidden = true;
        onFinished?.(profile);
        return;
      }
      if (["failed", "cancelled", "expired"].includes(result.status)) {
        fail(
          failureText[result.error ?? result.status] ?? "ChatGPT could not complete sign-in. Start again when ready.",
        );
        link.hidden = true;
        cancel.textContent = "Close";
        return;
      }
      status.textContent =
        result.status === "exchanging"
          ? "Verifying your ChatGPT account…"
          : "Finish sign-in in your browser. Your drafts are safe here.";
      timer = setTimeout(() => void poll(), 1000);
    } catch (error) {
      adopting = false;
      if (!destroyed) {
        fail(error.message || "Could not check sign-in. Try again.");
        retry.hidden = false;
      }
    }
  };
  retry.addEventListener("click", () => void poll());
  cancel.addEventListener("click", async () => {
    clearTimeout(timer);
    cancel.disabled = true;
    try {
      if (attempt) await dataAccess.cancelAgentOAuth(provider, attempt.attemptId);
      if (!destroyed) {
        status.textContent = "Sign-in closed. Your drafts are unchanged.";
        link.hidden = retry.hidden = cancel.hidden = true;
      }
    } catch (error) {
      if (!destroyed) {
        fail(error.message);
        cancel.disabled = false;
      }
    }
  });
  try {
    attempt = await dataAccess.beginAgentOAuth(provider, {
      ...(accountId ? { accountId } : {}),
      requestPlanConsent,
    });
    if (destroyed) await dataAccess.cancelAgentOAuth(provider, attempt.attemptId);
    else {
      const url = new URL(attempt.authorizationUrl);
      if (url.protocol !== "https:" || url.origin !== "https://auth.openai.com")
        throw new Error("The sign-in address could not be verified.");
      link.href = url.href;
      link.hidden = false;
      if (openOutside) await openOutside(url.href);
      else window.open(url.href, "_blank", "noopener,noreferrer");
      void poll();
    }
  } catch (error) {
    fail(error.message || "Could not start ChatGPT sign-in.");
    cancel.textContent = "Close";
  }
  return {
    async destroy() {
      destroyed = true;
      clearTimeout(timer);
      if (attempt && !adopting) await dataAccess.cancelAgentOAuth(provider, attempt.attemptId).catch(() => {});
      panel.remove();
    },
  };
}
