// SPDX-License-Identifier: Apache-2.0
// Presentation only. Brand artwork attribution is in THIRD_PARTY_NOTICES.md.
import { createElement as el } from "./viewer-shell.js";

// Lobe Icons static SVG geometry, pinned and licensed in THIRD_PARTY_NOTICES.md.
const brands = {
  "claude-code": {
    viewBox: "0 0 24 24",
    paths: [
      "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z",
    ],
  },
  codex: {
    viewBox: "0 0 24 24",
    paths: [
      "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z",
    ],
  },
};
export const agentName = (provider) => ({ "claude-code": "Claude Code", codex: "Codex" })[provider] ?? provider;

/** Version labels come from discovery metadata, never a hardcoded family-to-latest map. */
export function modelPresentation(model) {
  const wire = model.resolvedModel || model.id;
  const name = model.name || model.id;
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:[-.]\d{1,2})?)(?:-\d{8})?(?:\[.*\])?$/i.exec(wire);
  let label;
  if (claude) {
    label = `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2].replaceAll("-", ".")}`;
  } else if (/^(?:gpt-\d|o\d)/i.test(wire)) {
    label = wire
      .replace(/^gpt/i, "GPT")
      .replace(
        /-(astra|sol|terra|codex|mini|max|nano|pro)\b/gi,
        (_match, word) => ` ${word[0].toUpperCase()}${word.slice(1)}`,
      );
  } else if (/\b(?:opus|sonnet|haiku|fable|gpt|o)[ -]?\d+(?:\.\d+)?\b/i.test(name)) {
    label = name;
  } else if (/^claude-\d+(?:[-.]\d+)?-(?:opus|sonnet|haiku|fable)(?:-\d{8})?$/i.test(wire)) {
    label = wire;
  } else {
    return {
      label: `${name} · version not reported`,
      description: "The agent has not reported a model version. Refresh its models in Settings.",
      versionKnown: false,
    };
  }
  return {
    label,
    description:
      (model.resolvedModel && model.resolvedModel !== model.id
        ? `At last model discovery, alias ${model.id} resolved to ${model.resolvedModel}.`
        : `Model ID: ${wire}.`) + (/\[1m\]$/i.test(wire) ? " 1M context." : ""),
    versionKnown: true,
  };
}

/** Aliases are references, not extra model variants. Preserve the current wire selection. */
export function modelChoices(models, selected) {
  const groups = new Map();
  for (const model of models) {
    const identity = model.resolvedModel || model.id;
    const group = groups.get(identity) ?? [];
    group.push(model);
    groups.set(identity, group);
  }
  return [...groups].map(([identity, aliases]) => {
    const model =
      aliases.find((entry) => entry.id === selected) ??
      aliases.find((entry) => entry.id === identity) ??
      aliases.find((entry) => entry.id !== "default") ??
      aliases[0];
    const display = modelPresentation(model);
    const hasContextVariant = /\[1m\]$/i.test(identity) && groups.has(identity.replace(/\[1m\]$/i, ""));
    const isDefault = aliases.some((entry) => entry.id === "default");
    return {
      id: model.id,
      name: display.label + (hasContextVariant ? " · 1M" : ""),
      description: display.description + (isDefault ? " Agent default at last model discovery." : ""),
    };
  });
}

/** One effort vocabulary for both providers; these are relative settings, never latency promises. */
export function effortPresentation(value) {
  const levels = {
    none: ["None", 0, "Reasoning effort is turned off."],
    minimal: ["Minimal", 1, "The smallest reasoning budget, for straightforward requests."],
    low: ["Low", 1, "Less reasoning, for quicker responses to straightforward requests."],
    medium: ["Medium", 2, "A balance of reasoning depth and response time."],
    high: ["High", 3, "More reasoning for difficult requests; responses may take longer."],
    xhigh: ["Extra high", 4, "An extended reasoning budget for demanding requests."],
    max: ["Maximum", 4, "The highest available reasoning budget; responses may take longer."],
    auto: ["Auto", 0, "The agent chooses how much reasoning to use."],
  };
  const [label, bars, description] = levels[value] ?? [
    value || "Default",
    0,
    "Uses the agent’s configured reasoning effort.",
  ];
  return { label, bars, description };
}

export function effortIcon(value) {
  const { bars } = effortPresentation(value);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 16");
  svg.setAttribute("class", "glosa-effort-mark");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (let index = 0; index < 4; index++) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const height = 4 + index * 3;
    for (const [name, content] of Object.entries({
      x: 1 + index * 5,
      y: 15 - height,
      width: 3,
      height,
      rx: 1,
      fill: "currentColor",
      opacity: index < bars ? 1 : 0.2,
    }))
      rect.setAttribute(name, String(content));
    svg.append(rect);
  }
  return svg;
}

export function agentIcon(provider) {
  const brand = brands[provider];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", brand?.viewBox ?? "0 0 24 24");
  svg.setAttribute("class", "glosa-agent-mark");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of brand?.paths ?? ["M4 4h16v16H4z"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("clip-rule", "evenodd");
    svg.append(path);
  }
  return svg;
}

/** Native top-layer popovers avoid clipping inside split panes. Ordinary tab order, Escape,
 * and outside-click dismissal are supplied by the browser; no document listeners are retained. */
export function actionMenu(label) {
  const popup = el("div", {
    id: `agent-menu-${crypto.randomUUID()}`,
    className: "glosa-agent-menu",
    popover: "auto",
    "aria-label": label,
  });
  const trigger = el("button", {
    type: "button",
    className: "glosa-agent-menu-trigger",
    "aria-label": label,
    title: label,
    "aria-expanded": "false",
    "aria-controls": popup.id,
    onClick: () => {
      const box = trigger.getBoundingClientRect();
      popup.style.maxHeight = `${Math.max(80, window.innerHeight - 16)}px`;
      popup.style.left = `${Math.max(8, Math.min(box.right - 224, window.innerWidth - 232))}px`;
      popup.togglePopover?.();
      if (!popup.matches(":popover-open")) return;
      const height = popup.getBoundingClientRect().height;
      const below = box.bottom + 6;
      const top = below + height <= window.innerHeight - 8 ? below : box.top - height - 6;
      popup.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
      popup.querySelector("button:not(:disabled), input:not(:disabled)")?.focus({ preventScroll: true });
    },
  });
  // Three drawn dots, not typed ones: the same 15px stroke family as every other tool.
  trigger.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="16" cy="10" r="1.6"/></svg>';
  popup.addEventListener("toggle", (event) => trigger.setAttribute("aria-expanded", String(event.newState === "open")));
  popup.addEventListener("click", (event) => {
    if (event.target.closest("button")) {
      popup.hidePopover?.();
      if (popup.contains(document.activeElement) || document.activeElement === document.body)
        trigger.focus({ preventScroll: true });
    }
  });
  popup.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    popup.hidePopover?.();
    trigger.focus({ preventScroll: true });
  });
  const element = el("div", { className: "glosa-agent-menu-anchor" }, [trigger, popup]);
  return { element, popup, trigger };
}

/** One compact entry point for model and per-chat subscription choices. */
export function modelPicker({ onModel, onProfile, onSettings }) {
  const lifetime = new AbortController();
  const popup = el("div", {
    id: `model-picker-${crypto.randomUUID()}`,
    className: "glosa-model-picker",
    popover: "auto",
    role: "dialog",
    "aria-label": "Model and subscription",
  });
  const trigger = el("button", {
    type: "button",
    className: "glosa-model-picker-trigger",
    "aria-label": "Model and subscription",
    "aria-haspopup": "dialog",
    "aria-controls": popup.id,
    "aria-expanded": "false",
  });
  const heading = el("div", { className: "glosa-model-picker-heading" });
  const models = el("div", { className: "glosa-model-picker-models", role: "group", "aria-label": "Models" });
  const accountLabel = el("span", { textContent: "Subscription" });
  const account = el("button", { type: "button", className: "glosa-model-picker-account", "aria-expanded": "false" });
  const accounts = el("div", {
    className: "glosa-model-picker-accounts",
    hidden: true,
    role: "group",
    "aria-label": "Subscriptions",
  });
  const note = el("p", { className: "glosa-model-picker-note" });
  const back = el("button", {
    type: "button",
    className: "glosa-model-picker-back",
    textContent: "‹ Subscriptions",
    "aria-label": "Back to models",
    onClick: () => view(false, true),
  });
  const headingLabel = el("span");
  const savingLabel = el("span");
  heading.append(back, headingLabel, savingLabel);
  const error = el("p", { className: "glosa-model-picker-error", role: "status", hidden: true });
  const manage = el("button", {
    type: "button",
    className: "glosa-model-picker-manage",
    textContent: "Manage accounts…",
    onClick: () => {
      close();
      onSettings();
    },
  });
  popup.append(
    heading,
    models,
    el("div", { className: "glosa-model-picker-footer" }, [accountLabel, account, accounts, note, manage]),
    error,
  );
  const element = el("div", { className: "glosa-model-picker-anchor" }, [trigger, popup]);
  let signature = "",
    open = false,
    subscriptionView = false,
    blocked = false,
    started = false;
  function view(subscriptions, focus = false) {
    subscriptionView = subscriptions;
    models.hidden = subscriptions;
    accounts.hidden = !subscriptions;
    account.hidden = subscriptions;
    accountLabel.hidden = subscriptions;
    headingLabel.hidden = subscriptions;
    back.hidden = !subscriptions;
    manage.hidden = !subscriptions;
    account.setAttribute("aria-expanded", String(subscriptions));
    note.hidden = !subscriptions && !blocked;
    note.textContent = blocked
      ? "Finish or stop pending work to switch subscriptions."
      : started
        ? "Same agent: message text carries over. Another agent opens a new chat."
        : "For this chat only. Your default stays unchanged.";
    if (open) position();
    if (focus)
      (subscriptions
        ? (accounts.querySelector('[aria-pressed="true"]:not(:disabled)') ??
          accounts.querySelector("button:not(:disabled)") ??
          back)
        : account
      )?.focus({ preventScroll: true });
  }
  function position() {
    const box = trigger.getBoundingClientRect();
    popup.style.maxHeight = `${Math.max(100, window.innerHeight - 16)}px`;
    const width = popup.getBoundingClientRect().width;
    popup.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
    const height = popup.getBoundingClientRect().height;
    popup.style.top = `${Math.max(8, Math.min(box.top - height - 8, window.innerHeight - height - 8))}px`;
  }
  function close() {
    popup.hidePopover?.();
    trigger.focus({ preventScroll: true });
  }
  trigger.addEventListener("click", () => {
    if (open) {
      close();
      return;
    }
    error.hidden = true;
    popup.showPopover?.();
    position();
    (
      models.querySelector('[aria-pressed="true"]:not(:disabled)') ??
      models.querySelector("button:not(:disabled)") ??
      account
    ).focus({ preventScroll: true });
  });
  popup.addEventListener("toggle", (event) => {
    open = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (!open) view(false);
  });
  account.addEventListener("click", () => view(true, true));
  popup.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key === "ArrowLeft" && subscriptionView) {
      event.preventDefault();
      view(false, true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const group = event.target.closest('[role="group"]');
    if (!group) return;
    const buttons = [...group.querySelectorAll("button:not(:disabled)")];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
  });
  window.addEventListener(
    "resize",
    () => {
      if (open) position();
    },
    { signal: lifetime.signal },
  );
  return {
    element,
    trigger,
    popup,
    error(message) {
      error.textContent = message;
      error.hidden = false;
      if (open) position();
    },
    destroy() {
      lifetime.abort();
      popup.hidePopover?.();
      element.remove();
    },
    render({ state, catalog, disabled, subscriptionBlocked, busy }) {
      const profiles = (catalog?.profiles ?? [])
        .filter((profile) => profile.enabled && !profile.removed)
        .sort((a, b) => Number(b.provider === state.provider) - Number(a.provider === state.provider));
      const profile = catalog?.profiles?.find((profile) => profile.id === state.profileId);
      const choices = modelChoices(catalog?.capabilities?.[state.profileId]?.models ?? [], state.settings.model);
      const selected = choices.find((choice) => choice.id === state.settings.model);
      const name =
        selected?.name ??
        (state.settings.model
          ? modelPresentation({ id: state.settings.model, name: state.settings.model }).label
          : "Choose model");
      const nextSignature = JSON.stringify([
        state.provider,
        state.profileId,
        state.settings.model,
        !!state.turns.length,
        choices,
        profiles,
        disabled,
        subscriptionBlocked,
        busy,
      ]);
      if (signature === nextSignature) return;
      signature = nextSignature;
      const focusedChoice = popup.contains(document.activeElement) ? document.activeElement?.dataset.choice : undefined;
      trigger.replaceChildren(
        agentIcon(state.provider),
        el("span", { textContent: name }),
        el("span", { className: "glosa-picker-chevron", "aria-hidden": "true" }),
      );
      trigger.title = `${name} · ${profile?.label ?? "Choose subscription"}`;
      trigger.disabled = disabled && !busy;
      trigger.setAttribute("aria-busy", String(busy));
      headingLabel.textContent = agentName(state.provider);
      savingLabel.textContent = busy ? "Saving…" : "";
      models.replaceChildren(
        ...choices.map((choice) =>
          el(
            "button",
            {
              type: "button",
              "data-model-id": choice.id,
              "data-choice": `model:${choice.id}`,
              "aria-pressed": String(choice.id === state.settings.model),
              title: choice.description,
              disabled: disabled || busy,
              onClick: () => {
                if (!disabled && !busy)
                  void onModel(choice.id).then((saved) => {
                    if (saved) close();
                  });
              },
            },
            [
              el("span", { textContent: choice.name }),
              el("span", { textContent: choice.id === state.settings.model ? "✓" : "", "aria-hidden": "true" }),
            ],
          ),
        ),
      );
      if (!choices.length)
        models.append(
          el("p", {
            className: "glosa-model-picker-note",
            textContent: "Load this subscription’s models in Settings.",
          }),
        );
      account.replaceChildren(
        el("span", { textContent: profile?.label ?? "Choose subscription" }),
        el("span", { className: "glosa-picker-chevron", "aria-hidden": "true" }),
      );
      account.setAttribute("aria-label", `Subscription: ${profile?.label ?? "Choose subscription"}`);
      account.disabled = busy || disabled || subscriptionBlocked;
      blocked = subscriptionBlocked;
      started = !!state.turns.length;
      view(subscriptionView);
      accounts.replaceChildren(
        ...profiles.map((entry) => {
          const ready = !entry.auth || entry.auth.state === "authenticated";
          const otherProvider = entry.provider !== state.provider;
          const detail = !ready
            ? "Sign in in Settings"
            : otherProvider
              ? `${agentName(entry.provider)}${state.turns.length ? " · New chat" : ""}`
              : (entry.auth?.plan ?? "");
          return el(
            "button",
            {
              type: "button",
              "data-profile-id": entry.id,
              title: entry.label,
              "data-choice": `profile:${entry.id}`,
              "aria-pressed": String(entry.id === state.profileId),
              disabled: busy || disabled || subscriptionBlocked || !ready,
              onClick: () => {
                if (entry.id === state.profileId) {
                  view(false, true);
                  return;
                }
                if (!ready || busy || disabled || subscriptionBlocked) return;
                error.hidden = true;
                void onProfile(entry.id).then((saved) => {
                  if (!saved) return;
                  if (otherProvider && state.turns.length) close();
                  else view(false, true);
                });
              },
            },
            [
              agentIcon(entry.provider),
              el("span", { className: "glosa-model-picker-account-label" }, [
                el("span", { textContent: entry.label }),
                ...(detail ? [el("small", { textContent: detail })] : []),
              ]),
              el("span", { textContent: entry.id === state.profileId ? "✓" : "", "aria-hidden": "true" }),
            ],
          );
        }),
      );
      if (focusedChoice)
        [...popup.querySelectorAll("[data-choice]")]
          .find((button) => button.dataset.choice === focusedChoice && !button.disabled)
          ?.focus({ preventScroll: true });
      if (open) position();
    },
  };
}
