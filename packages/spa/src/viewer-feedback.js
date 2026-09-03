// SPDX-License-Identifier: Apache-2.0
// Workspace connection/wiring lifecycle. All I/O and dialogs are caller-injected so this module
// stays transport-free and the SPA retains one data-access boundary.

export function createViewerFeedbackController({
  dataAccess,
  view,
  getWorkspaceSlug,
  confirmDialog,
  noticeDialog,
  pollIntervalMs = 15_000,
}) {
  let wiring = null;
  let status = null;
  let latestRefresh = 0;
  const promptedSlugs = new Set();

  function render() {
    view.setState({ slug: getWorkspaceSlug(), wiring, status });
  }

  async function refresh() {
    const refreshId = ++latestRefresh;
    const slug = getWorkspaceSlug();
    if (!slug) {
      wiring = null;
      status = null;
      render();
      return;
    }
    try {
      const [fetchedWiring, fetchedStatus] = await Promise.all([
        dataAccess.getWiringStatus(slug),
        dataAccess.getStatus(),
      ]);
      if (getWorkspaceSlug() !== slug || refreshId !== latestRefresh) return;
      wiring = fetchedWiring;
      status = fetchedStatus;
    } catch {
      if (getWorkspaceSlug() === slug && refreshId === latestRefresh) {
        wiring = null;
        status = null;
      }
    }
    render();
  }

  function selectWorkspace() {
    wiring = null;
    status = null;
    render();
    void refresh();
  }

  async function wireWorkspace() {
    const slug = getWorkspaceSlug();
    if (!slug) return;
    try {
      const result = await dataAccess.triggerInit(slug);
      await refresh();
      if (result?.restart_required !== false) {
        await noticeDialog({
          title: "Wired — one step left",
          body: "Restart or resume your agent session so it loads glosa. Until then annotations queue locally — Agent feedback stays unbound until a session connects.",
        });
      } else {
        await noticeDialog({
          title: "Wired",
          body: "Agent feedback is set up and a live session is bound — annotations will be delivered.",
        });
      }
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
      await noticeDialog({
        title: "Couldn't set up agent feedback",
        body: `Run \`glosa init\` in the workspace terminal instead${detail}.`,
      });
      void refresh();
    }
  }

  async function maybeOfferWiring() {
    const slug = getWorkspaceSlug();
    if (wiring?.state !== "unwired" || !slug || promptedSlugs.has(slug)) return;
    promptedSlugs.add(slug);
    try {
      const wire = await confirmDialog({
        title: "This workspace isn't wired for agent feedback",
        body: "Your annotation will be saved here either way — but no agent session will see it until glosa's integration is installed. Wire it now?",
        confirmLabel: "Wire it now",
      });
      if (wire) await wireWorkspace();
    } catch {
      // An annotation save must never be blocked by the optional wiring offer.
    }
  }

  const pollTimer = setInterval(() => void refresh(), pollIntervalMs);
  pollTimer.unref?.();
  const onWindowFocus = () => void refresh();
  if (typeof window !== "undefined") window.addEventListener("focus", onWindowFocus);

  return {
    refresh,
    selectWorkspace,
    wireWorkspace,
    maybeOfferWiring,
    destroy() {
      clearInterval(pollTimer);
      if (typeof window !== "undefined") window.removeEventListener("focus", onWindowFocus);
    },
  };
}
