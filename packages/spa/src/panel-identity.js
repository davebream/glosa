// SPDX-License-Identifier: Apache-2.0
// Identity is a tuple, not a filename prefix. A real file named chat:notes.md remains a file.
export function artifactPanelId(path) {
  return JSON.stringify(["artifact", path]);
}
export function chatPanelId(id) {
  return JSON.stringify(["chat", id]);
}
export function externalPanelId(id) {
  return JSON.stringify(["external-chat", id]);
}
export function settingsPanelId() {
  return JSON.stringify(["agent-settings"]);
}
export function comparisonPanelId(path, from, to) {
  return JSON.stringify(["diff", path, from, to]);
}
export function panelIdentity(id, params = {}) {
  if (params.kind === "chat" && typeof params.chatId === "string")
    return { id: chatPanelId(params.chatId), params: { ...params, kind: "chat" } };
  if (params.kind === "external-chat" && typeof params.sessionId === "string")
    return { id: externalPanelId(params.sessionId), params: { ...params, kind: "external-chat" } };
  if (params.kind === "agent-settings") return { id: settingsPanelId(), params: { kind: "agent-settings" } };
  if (
    params.kind === "diff" &&
    typeof params.path === "string" &&
    typeof params.from === "string" &&
    typeof params.to === "string"
  )
    return { id: comparisonPanelId(params.path, params.from, params.to), params: { ...params, kind: "diff" } };
  if (params.kind && params.kind !== "artifact") return null;
  const path = typeof params.path === "string" ? params.path : id;
  return { id: artifactPanelId(path), params: { ...params, kind: "artifact", path } };
}
export function decodePanelId(id) {
  try {
    const value = JSON.parse(id);
    if (Array.isArray(value) && ["artifact", "diff", "chat", "external-chat", "agent-settings"].includes(value[0]))
      return value;
  } catch {
    /* Before migration, old ids are literal artifact paths. */
  }
  return ["artifact", id];
}

export function migratePanelLayout(saved, workspaceIdentity) {
  if (!saved || !saved.panels || typeof saved.panels !== "object" || Array.isArray(saved.panels))
    throw new Error("Invalid saved layout");
  const copy = structuredClone(saved),
    mapping = new Map(),
    panels = {};
  const sameWorkspace = !!workspaceIdentity && saved.glosa?.workspaceIdentity === workspaceIdentity;
  for (const [oldId, panel] of Object.entries(copy.panels)) {
    const identity = panelIdentity(oldId, panel.params ?? {});
    if (!identity || (["chat", "external-chat"].includes(identity.params.kind) && !sameWorkspace)) continue;
    mapping.set(oldId, identity.id);
    panels[identity.id] = { ...panel, id: identity.id, params: identity.params };
  }
  const visit = (node) => {
    if (!node) return;
    if (node.type === "leaf") {
      node.data.views = (node.data?.views ?? []).flatMap((id) => (mapping.has(id) ? [mapping.get(id)] : []));
      node.data.activeView = mapping.get(node.data.activeView) ?? node.data.views[0];
    } else if (Array.isArray(node.data)) node.data.forEach(visit);
  };
  visit(copy.grid?.root);
  copy.panels = panels;
  copy.glosa = { version: 2, workspaceIdentity };
  return copy;
}
