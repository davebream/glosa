// SPDX-License-Identifier: Apache-2.0
// Browser state is a disposable projection of the journal. Recovery stores unsent intent only.

import { chatQueue } from "./chat-activity.js";
import { editReferences } from "./composer-picker.js";

const ACTIVE = new Set(["dispatching", "running", "waiting", "stopping"]);
const WAITING = new Set(["accepted", "queued", "held"]);
const REFUSED = new Set([
  "stale-chat",
  "stale-draft",
  "account-disabled",
  "account-unavailable",
  "unsupported-model",
  "queue-full",
  "chat-read-only",
  "consent-required",
  "runtime-unqualified",
  "managed-unavailable",
  "account-mismatch",
]);
const copy = (value) => JSON.parse(JSON.stringify(value));

/** Apply a contiguous journal frame. A gap or unsupported change requires an authoritative read. */
export function applyChatEvent(state, record) {
  if (!state || record.seq <= state.revision) return state;
  if (record.seq !== state.revision + 1) return null;
  const event = record.data;
  state.revision = record.seq;
  if (event.type === "turn") {
    if (!state.turns.some((turn) => turn.id === event.turn.id)) state.turns.push({ ...event.turn });
    if (event.title && !state.titleEdited && state.title === "New chat") state.title = event.title;
    if (event.consumedDraftRevision !== undefined) {
      state.draftRevision = event.consumedDraftRevision + 1;
      state.draft = "";
      state.draftAttachments = [];
      state.draftReferences = [];
    }
  } else if (event.type === "draft") {
    if (typeof event.text !== "string") return null;
    state.draft = event.text;
    state.draftHash = event.textHash;
    state.draftRevision = event.revision;
    state.draftAttachments = event.attachments;
    state.draftReferences = event.references ?? [];
  } else if (event.type === "changed") {
    if (
      (event.provider && event.provider !== state.provider) ||
      (event.profileId && event.profileId !== state.profileId)
    )
      state.draftReferences = [];
    if (event.profileId && event.profileId !== state.profileId) {
      state.runtime = state.runtime ? { ...state.runtime, state: "stopped", nativeId: undefined } : undefined;
      state.usage = undefined;
    }
    for (const key of ["title", "archived", "pinned", "settings", "provider", "profileId", "sessionId"])
      if (event[key] !== undefined) state[key] = event[key];
    if (event.title !== undefined) state.titleEdited = true;
    state.configRevision++;
  } else if (event.type === "turn_revised") {
    const turn = state.turns.find((value) => value.id === event.turnId);
    if (!turn || typeof event.text !== "string") return null;
    Object.assign(turn, {
      text: event.text,
      revision: event.revision,
      references: event.references,
      attachments: event.attachments,
    });
  } else if (event.type === "content") {
    const prior = state.content.find((c) => c.id === event.content.id && c.turnId === event.content.turnId);
    if (prior && event.content.kind !== "tool") {
      const combined = prior.text + event.content.text;
      prior.text = combined.slice(0, 131072);
      prior.truncated ||= combined.length > 131072;
    } else if (prior) Object.assign(prior, event.content);
    else if (!state.page?.hasLater) state.content.push({ ...event.content });
  } else if (event.type === "decision") state.decisions.push(event.decision);
  else if (event.type === "decision_status") {
    const value = state.decisions.find((d) => d.id === event.id);
    if (value) value.status = event.status;
  } else if (event.type === "turn_status") {
    const value = state.turns.find((t) => t.id === event.turnId);
    if (value) {
      Object.assign(value, { status: event.status, error: event.error, failure: event.failure });
      if (event.attemptId) value.attemptId = event.attemptId;
      if (ACTIVE.has(event.status)) value.started = true;
    }
  } else if (event.type === "effective_settings") {
    const turn = state.turns.find((t) => t.id === event.turnId);
    if (turn) turn.effective = { model: event.model, effort: event.effort };
  } else if (event.type === "usage") state.usage = { ...state.usage, ...event.value };
  else if (event.type === "runtime") {
    state.runtime = event;
    const turn = event.turnId && state.turns.find((value) => value.id === event.turnId);
    if (turn && event.attemptId) turn.attemptId = event.attemptId;
  } else if (event.type === "reauthorized") {
    const turn = state.turns.find((value) => value.id === event.turnId);
    if (turn)
      Object.assign(turn, {
        profileEpoch: event.profileEpoch,
        identityRevision: event.identityRevision,
        runtimeManifestId: event.runtimeManifestId,
        mcpDigest: event.mcpDigest,
      });
  } else return null;
  return state;
}

// Sharing is scoped to the data-access instance (one authenticated desk) and chat identity.
const registries = new WeakMap();
export function acquireChatStore(dataAccess, slug, chatId) {
  let registry = registries.get(dataAccess);
  if (!registry) registries.set(dataAccess, (registry = new Map()));
  const key = JSON.stringify([slug, chatId]);
  let entry = registry.get(key);
  if (!entry) {
    entry = { store: createChatStore(dataAccess, slug, chatId), references: 0 };
    registry.set(key, entry);
  }
  entry.references++;
  let released = false;
  return {
    store: entry.store,
    release() {
      if (released) return;
      released = true;
      if (--entry.references) return;
      entry.store.dispose();
      registry.delete(key);
    },
  };
}

export function createChatStore(dataAccess, slug, chatId) {
  let chat = null,
    catalog = null,
    text = "",
    attachments = [],
    references = [],
    retryOfTurnId = null,
    dirty = false;
  let baseRevision = 0,
    lastDraft = "",
    disposed = false,
    stopStream,
    saveTimer,
    operation = Promise.resolve();
  let pending = false,
    uploading = false,
    changing = false,
    stopping = false,
    checking = false,
    paging = false;
  let notice = "",
    error = null,
    connection = "up",
    pageBefore,
    lastEventAt = Date.now();
  let draftIntent = null,
    feedbackIntent = null,
    recoveryReady = false;
  const preparing = new Set();
  let recoveryWrites = Promise.resolve();
  const outbox = [],
    decisions = new Map(),
    kept = new Set(),
    listeners = new Set();
  let snapshot;
  const publish = () => {
    snapshot = {
      chat,
      catalog,
      draft: { text, attachments, references, dirty, baseRevision, retryOfTurnId },
      outbox: [...outbox],
      kept,
      pending,
      uploading,
      changing,
      stopping,
      checking,
      paging,
      notice,
      error,
      connection,
      lastEventAt,
      queue: chatQueue(chat?.turns ?? [], outbox, kept),
    };
    for (const listener of listeners) listener();
  };
  const tell = (message, problem = null) => {
    notice = message;
    error = problem;
    publish();
  };
  const fail = (problem) => tell(problem.message || "The chat could not be updated.", problem);
  const recovery = () => ({
    version: 1,
    draft: { text, attachments, references, baseRevision, dirty, retryOfTurnId },
    outbox: outbox.map((entry) => ({ ...entry, state: "failed" })),
    decisions: [...decisions],
  });
  const persist = () => {
    const value = copy(recovery());
    recoveryWrites = recoveryWrites.catch(() => {}).then(() => dataAccess.writeChatRecovery?.(slug, chatId, value));
    return recoveryWrites;
  };
  const serialize = (work) => {
    const next = operation.catch(() => {}).then(work);
    operation = next;
    return next;
  };
  function accept(next, force = false) {
    if (disposed || (chat && next.revision < chat.revision && !force)) return;
    if (connection === "unavailable") {
      connection = "up";
      notice = "";
      error = null;
    }
    // The daemon returns old turn metadata for replay. Only hydrated rows belong to this page.
    // Keeping that metadata in the render store makes every token scan the complete history.
    const hydrated = new Set(next.content.map((part) => part.turnId));
    if (!chat || next.revision > chat.revision) lastEventAt = Date.now();
    chat = {
      ...next,
      turns: next.turns.filter(
        (turn) =>
          typeof turn.text === "string" || hydrated.has(turn.id) || ACTIVE.has(turn.status) || WAITING.has(turn.status),
      ),
    };
    // A recovered/ambiguous send may have reached the journal. Reading never dispatches it.
    for (let i = outbox.length - 1; i >= 0; i--)
      if (chat.turns.some((turn) => turn.id === outbox[i].id)) outbox.splice(i, 1);
    if (!dirty && !outbox.length) {
      if (text !== (next.draft ?? "")) retryOfTurnId = null;
      text = next.draft ?? "";
      attachments = next.draftAttachments ?? [];
      references = next.draftReferences ?? [];
      baseRevision = next.draftRevision;
      lastDraft = text;
    }
    publish();
  }
  async function refresh(before = pageBefore) {
    const next = await dataAccess.getChat(slug, chatId, before);
    accept(next, before !== pageBefore);
    return next;
  }
  function connect() {
    stopStream?.();
    stopStream = dataAccess.openChatStream(
      slug,
      chatId,
      {
        onEvent(frame) {
          if (disposed) return;
          if (frame.event === "chat_unavailable") {
            connection = "unavailable";
            tell(
              "This chat is unavailable. Your draft has been kept on this device. Refresh status to check whether it is available again.",
            );
          } else if (frame.event === "chat_snapshot") accept(frame.data);
          else if (frame.event === "chat_event") {
            if (chat && frame.data.seq <= chat.revision) return;
            const projected = chat && {
              ...chat,
              turns: [...chat.turns],
              content: [...chat.content],
              decisions: [...chat.decisions],
            };
            const event = frame.data.data;
            if (projected && event.type === "content") {
              const index = projected.content.findIndex(
                (part) => part.id === event.content.id && part.turnId === event.content.turnId,
              );
              if (index >= 0) projected.content[index] = { ...projected.content[index] };
            } else if (
              projected &&
              ["turn_status", "turn_revised", "effective_settings", "reauthorized", "runtime"].includes(event.type)
            ) {
              projected.turns = projected.turns.map((turn) => (turn.id === event.turnId ? { ...turn } : turn));
            } else if (projected && event.type === "decision_status") {
              projected.decisions = projected.decisions.map((decision) =>
                decision.id === event.id ? { ...decision } : decision,
              );
            }
            const next = applyChatEvent(projected, frame.data);
            if (next) accept(next);
            else void refresh().catch(fail);
          }
        },
        onStatus(value) {
          if (!disposed) {
            if (connection === "unavailable") return;
            connection = value;
            publish();
          }
        },
      },
      pageBefore,
    );
  }
  async function saveDraftNow() {
    if (!dirty || !chat || pending || disposed) return;
    const draft = { text, attachments: [...attachments], references: [...references] };
    draftIntent ??= { requestId: crypto.randomUUID(), revision: baseRevision, ...draft };
    await persist();
    try {
      const result = await dataAccess.saveChatDraft(slug, chatId, draftIntent);
      baseRevision = result.draftRevision;
      chat = {
        ...chat,
        draftRevision: baseRevision,
        draft: draftIntent.text,
        draftAttachments: draftIntent.attachments,
        draftReferences: draftIntent.references,
      };
      lastDraft = draftIntent.text;
      dirty =
        text !== draftIntent.text ||
        JSON.stringify(attachments) !== JSON.stringify(draftIntent.attachments) ||
        JSON.stringify(references) !== JSON.stringify(draftIntent.references);
      draftIntent = null;
      await persist();
      if (!outbox.length) {
        notice = dirty ? "Draft changed while saving" : "Draft saved";
        error = null;
      }
      publish();
    } catch (problem) {
      if (problem.refused || REFUSED.has(problem.problem?.type?.split("/").pop())) draftIntent = null;
      fail(problem);
      throw problem;
    }
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void serialize(saveDraftNow).catch(() => {}), 500);
  }
  async function ensureModels() {
    if (catalog?.capabilities?.[chat.profileId]?.models?.length || !dataAccess.discoverAgentModels) return true;
    checking = true;
    tell("Checking which models this account offers…");
    try {
      await dataAccess.discoverAgentModels(chat.profileId);
      if (disposed) return false;
      catalog = await dataAccess.getAgentStatus();
      if (disposed) return false;
      const model =
        catalog.capabilities?.[chat.profileId]?.models?.find((m) => m.id === chat.settings.model) ??
        catalog.capabilities?.[chat.profileId]?.models?.[0];
      if (!model) throw new Error("This account reported no models. Check it under Agents & accounts.");
      const effort = model.efforts.includes(chat.settings.effort) ? chat.settings.effort : (model.efforts[0] ?? "");
      if (model.id !== chat.settings.model || effort !== chat.settings.effort) {
        await dataAccess.changeChat(slug, chatId, {
          requestId: crypto.randomUUID(),
          revision: chat.configRevision,
          settings: { model: model.id, effort, permissionMode: chat.settings.permissionMode },
        });
        await refresh();
      }
      notice = "";
      return true;
    } catch (problem) {
      fail(problem);
      return false;
    } finally {
      checking = false;
      publish();
    }
  }
  const store = {
    ready: /** @type {Promise<void> | null} */ (null),
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tell,
    fail,
    refresh,
    async refreshCatalog() {
      catalog = await dataAccess.getAgentStatus();
      await refresh();
      publish();
    },
    setChanging(value) {
      changing = value;
      publish();
    },
    setDraft(value, nextReferences) {
      references = nextReferences ?? editReferences(text, value, references);
      text = value;
      if (!text.trim()) retryOfTurnId = null;
      dirty = true;
      publish();
      scheduleSave();
      // Save recovery immediately too. Failure remains visible and sending stays loss-safe.
      void persist().catch(fail);
    },
    async replaceDraft(message, retrySource = null) {
      text = message.text ?? "";
      retryOfTurnId = retrySource;
      attachments = [...(message.attachments ?? [])];
      references = [...(message.references ?? [])];
      dirty = true;
      publish();
      await persist();
      await store.save();
    },
    save() {
      clearTimeout(saveTimer);
      return serialize(saveDraftNow);
    },
    async submit() {
      if (!chat || connection === "unavailable" || changing || uploading || checking || chat.archived || !text.trim())
        return;
      const submitted = {
        text,
        references: [...references],
        attachments: [...attachments],
        ...(retryOfTurnId ? { retryOfTurnId } : {}),
      };
      const signature = JSON.stringify(submitted);
      if (preparing.has(signature)) return;
      const profile = catalog?.profiles?.find((p) => p.id === chat.profileId);
      const available = catalog?.providers?.find((p) => p.id === chat.provider)?.available ?? catalog?.available;
      if (
        !available ||
        !profile?.enabled ||
        profile.removed ||
        (profile.auth && profile.auth.state !== "authenticated")
      ) {
        tell("Sign in to this account before sending. Your draft has been kept.");
        return;
      }
      if (chat.turns.filter((turn) => WAITING.has(turn.status)).length + outbox.length >= 5) {
        tell("Five messages are already waiting. Remove one, or wait for a reply.");
        return;
      }
      preparing.add(signature);
      if (!catalog?.capabilities?.[chat.profileId]?.models?.length && (!(await ensureModels()) || disposed)) {
        preparing.delete(signature);
        return;
      }
      const selected = catalog?.capabilities?.[chat.profileId]?.models?.find((m) => m.id === chat.settings.model);
      if (selected && chat.settings.effort && !selected.efforts.includes(chat.settings.effort)) {
        preparing.delete(signature);
        tell("Choose an available model and effort to continue.");
        return;
      }
      clearTimeout(saveTimer);
      const entry = {
        id: crypto.randomUUID(),
        ...submitted,
        state: "sending",
        intent: null,
        unsaved: true,
      };
      outbox.push(entry);
      try {
        await persist();
      } catch (problem) {
        preparing.delete(signature);
        outbox.splice(outbox.indexOf(entry), 1);
        fail(problem);
        return;
      }
      // The recovery write above must finish before the composer gives up its bytes.
      if (text === entry.text) {
        text = "";
        retryOfTurnId = null;
        references = [];
        attachments = [];
        dirty = false;
      }
      preparing.delete(signature);
      if (!outbox.some((item) => item.state === "failed")) {
        notice = "";
        error = null;
      }
      publish();
      await store.drain();
    },
    drain() {
      return serialize(async () => {
        if (pending || disposed || !recoveryReady) return;
        pending = true;
        publish();
        try {
          while (!disposed && outbox[0]?.state === "sending") {
            const entry = outbox[0];
            let saveFailed = true;
            try {
              if (entry.unsaved) {
                const saved = await dataAccess.saveChatDraft(slug, chatId, {
                  requestId: crypto.randomUUID(),
                  revision: baseRevision,
                  text: entry.text,
                  attachments: entry.attachments,
                  references: entry.references,
                });
                baseRevision = saved.draftRevision;
                lastDraft = entry.text;
                entry.unsaved = false;
              }
              saveFailed = false;
              entry.intent ??= {
                requestId: crypto.randomUUID(),
                turnId: entry.id,
                configRevision: chat.configRevision,
                draftRevision: baseRevision,
                text: entry.text,
                references: entry.references,
                attachments: entry.attachments,
                ...(entry.retryOfTurnId ? { retryOfTurnId: entry.retryOfTurnId } : {}),
              };
              await persist(); // The exact receipt survives a crash after the daemon accepts it.
              await dataAccess.sendChatTurn(slug, chatId, entry.intent);
              baseRevision = entry.intent.draftRevision + 1;
              lastDraft = "";
              // A stream acknowledgement can remove this exact item before HTTP answers.
              // Removing the queue head here would then discard the following local message.
              const acknowledged = outbox.indexOf(entry);
              if (acknowledged >= 0) outbox.splice(acknowledged, 1);
              await persist();
              await refresh();
            } catch (problem) {
              if (entry.intent && chat.turns.some((turn) => turn.id === entry.id)) {
                // Journal acknowledgement is stronger evidence than a lost HTTP response.
                baseRevision = Math.max(baseRevision, entry.intent.draftRevision + 1);
                const index = outbox.indexOf(entry);
                if (index >= 0) outbox.splice(index, 1);
                await persist();
                publish();
                continue;
              }
              const refusal = problem.problem?.type?.split("/").pop();
              const refused = !entry.intent || problem.refused || REFUSED.has(refusal);
              if (refused) entry.intent = null;
              entry.error = problem.message;
              for (const queued of outbox) queued.state = "failed";
              if (refused && outbox.length === 1 && !text.trim() && !attachments.length) {
                outbox.shift();
                text = entry.text;
                retryOfTurnId = entry.retryOfTurnId ?? null;
                references = entry.references;
                attachments = entry.attachments;
                dirty = true;
                notice = `${problem.message} Your message has been kept.`;
              } else {
                entry.conflict = !entry.intent && (saveFailed || ["stale-chat", "stale-draft"].includes(refusal));
                notice = `${problem.message}${entry.conflict ? " Retry sends it as it is and replaces the draft saved elsewhere." : refused ? " Your message has been kept." : " Retry sends the same request; it will not create a duplicate."}`;
              }
              error = problem;
              await persist().catch(() => {});
              publish();
              break;
            }
          }
        } finally {
          pending = false;
          dirty ||= text !== lastDraft || references.length > 0;
          publish();
          if (dirty && !outbox.length) scheduleSave();
        }
      });
    },
    async retryOutbox() {
      await refresh();
      if (outbox.some((entry) => entry.conflict)) {
        baseRevision = chat.draftRevision;
        for (const entry of outbox) {
          entry.conflict = false;
          entry.unsaved = false;
        }
      }
      for (const entry of outbox) entry.state = "sending";
      await persist();
      publish();
      return store.drain();
    },
    async removeQueued(id) {
      const entry = outbox.find((item) => item.id === id);
      if (entry) {
        await refresh();
        if (outbox.includes(entry)) outbox.splice(outbox.indexOf(entry), 1);
        else throw new Error("That message was sent after all. Stop its reply to cancel it.");
        await persist();
        publish();
        return;
      }
      await dataAccess.stopChat(slug, chatId, id);
      await refresh();
    },
    async editQueued(id, value) {
      const entry = outbox.find((item) => item.id === id);
      if (entry) {
        if (entry.intent) {
          await refresh();
          if (!outbox.includes(entry)) throw new Error("That message was sent after all. Edit the waiting turn again.");
          throw new Error(
            "Check this message's send status before changing it. Its original request may have arrived.",
          );
        }
        entry.references = editReferences(entry.text, value, entry.references ?? []);
        entry.text = value;
        entry.unsaved = true;
        await persist();
        publish();
        return;
      }
      const turn = chat.turns.find((item) => item.id === id);
      if (!turn || !WAITING.has(turn.status))
        throw new Error("This message has already started. Your edit has been kept.");
      await dataAccess.editQueuedChatTurn(slug, chatId, {
        requestId: crypto.randomUUID(),
        turnId: id,
        expectedRevision: turn.revision ?? 1,
        text: value,
        references: editReferences(turn.text ?? "", value, turn.references ?? []),
        attachments: turn.attachments ?? [],
      });
      await refresh();
    },
    async sendNow(id) {
      await dataAccess.sendChatTurnNow(slug, chatId, id);
      await refresh();
    },
    async continueTurn(id) {
      await dataAccess.resumeChatTurn(slug, chatId, id);
      await refresh();
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      publish();
      const target = snapshot.queue.active ?? snapshot.queue.head;
      if (target && !target.started) kept.add(target.id);
      try {
        await dataAccess.stopChat(slug, chatId, target?.id);
        await refresh();
      } finally {
        stopping = false;
        publish();
      }
    },
    async answerDecision(decision, choice, answer) {
      const key = `${decision.id}:${decision.generation}`;
      let intent = decisions.get(key);
      intent ??= {
        requestId: crypto.randomUUID(),
        decisionId: decision.id,
        generation: decision.generation,
        choice,
        ...(answer ? { text: answer } : {}),
      };
      decisions.set(key, intent);
      await persist();
      await dataAccess.answerChatDecision(slug, chatId, intent);
      await refresh();
    },
    getDecisionIntent(id, generation) {
      return decisions.get(`${id}:${generation}`);
    },
    async attach(files) {
      if (uploading || changing) return;
      uploading = true;
      notice = "";
      error = null;
      publish();
      try {
        for (const file of files) {
          const attachment = await dataAccess.uploadChatAttachment(slug, chatId, file);
          attachments = [...attachments, attachment];
          dirty = true;
          await persist();
          publish();
          await store.save();
        }
        await store.save();
      } finally {
        uploading = false;
        publish();
      }
    },
    removeAttachment(hash) {
      attachments = attachments.filter((item) => item.hash !== hash);
      dirty = true;
      publish();
      scheduleSave();
      void persist().catch(fail);
    },
    async change(input) {
      if (changing || uploading || outbox.length) return false;
      changing = true;
      publish();
      try {
        await dataAccess.changeChat(slug, chatId, {
          requestId: crypto.randomUUID(),
          revision: chat.configRevision,
          ...input,
        });
        await refresh();
        return true;
      } finally {
        changing = false;
        publish();
      }
    },
    async feedback() {
      if (changing || uploading || checking) return;
      feedbackIntent ??= {
        requestId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        configRevision: chat.configRevision,
      };
      try {
        await dataAccess.sendChatFeedback(slug, chatId, feedbackIntent);
        feedbackIntent = null;
        await refresh();
      } catch (problem) {
        if (problem.refused || (problem.status >= 400 && problem.status < 500)) feedbackIntent = null;
        throw problem;
      }
    },
    async loadEarlier(before) {
      if (paging) return;
      paging = true;
      publish();
      try {
        const next = await dataAccess.getChat(slug, chatId, before);
        // Keep live recent content while prepending a bounded earlier page.
        const hydrated = new Set(next.content.map((part) => part.turnId));
        const visible = next.turns.filter(
          (turn) =>
            typeof turn.text === "string" ||
            hydrated.has(turn.id) ||
            ACTIVE.has(turn.status) ||
            WAITING.has(turn.status),
        );
        const turns = new Map([...visible, ...chat.turns].map((turn) => [turn.id, turn]));
        const content = new Map([...next.content, ...chat.content].map((part) => [`${part.turnId}:${part.id}`, part]));
        const ordered = [...turns.values()];
        const selected =
          ordered.length <= 100
            ? ordered
            : [
                ...ordered.slice(0, 90),
                ...ordered.slice(90).filter((turn) => ACTIVE.has(turn.status) || WAITING.has(turn.status)),
              ];
        const selectedIds = new Set(selected.map((turn) => turn.id));
        chat = {
          ...chat,
          turns: selected,
          content: [...content.values()].filter((part) => selectedIds.has(part.turnId)),
          page: { ...next.page, hasLater: ordered.length > selected.length || chat.page?.hasLater },
        };
        publish();
      } finally {
        paging = false;
        publish();
      }
    },
    async loadRecent() {
      await refresh();
    },
    async retryTurn(turn) {
      if (turn.failure?.dispatchCertainty === "unknown" || turn.status === "outcome_unknown")
        throw new Error("The outcome is not confirmed. Refresh status or retry Stop before starting another reply.");
      await store.replaceDraft(turn, turn.id);
      tell("The previous message is ready in your draft. Review it, then send to start a new attempt.");
    },
    async dispose() {
      disposed = true;
      clearTimeout(saveTimer);
      stopStream?.();
      listeners.clear();
      // Closing never submits or retries recovered work.
      await persist().catch(() => {});
    },
  };
  publish();
  store.ready = (async () => {
    catalog = await dataAccess.getAgentStatus();
    chat = await dataAccess.getChat(slug, chatId);
    if (disposed) return;
    accept(chat);
    const recovered = await dataAccess.readChatRecovery?.(slug, chatId);
    if (disposed) return;
    if (recovered?.version === 1) {
      const saved = recovered.draft;
      const consumed = recovered.outbox?.some(
        (entry) => entry.text === saved?.text && chat.turns.some((turn) => turn.id === entry.id),
      );
      if (saved?.retryOfTurnId && !consumed && (saved.dirty || saved.text === chat.draft))
        retryOfTurnId = saved.retryOfTurnId;
      if (saved?.dirty && !consumed) {
        text = saved.text;
        attachments = saved.attachments ?? [];
        references = saved.references ?? [];
        baseRevision = saved.baseRevision;
        dirty = true;
      }
      for (const entry of recovered.outbox ?? [])
        if (!chat.turns.some((turn) => turn.id === entry.id))
          outbox.push({
            ...entry,
            state: "failed",
            error: entry.error ?? "Recovered after this window closed. Check status, then retry or remove.",
          });
      for (const [id, intent] of recovered.decisions ?? []) decisions.set(id, intent);
      if (dirty || outbox.length) notice = "Your unsent work was restored. Nothing has been sent automatically.";
    }
    recoveryReady = true;
    publish();
    connect();
    if (!recovered && !chat.turns.length && !chat.archived) {
      const profile = catalog?.profiles?.find((p) => p.id === chat.profileId);
      if (profile?.enabled && (!profile.auth || profile.auth.state === "authenticated")) void ensureModels();
    }
  })();
  return store;
}
