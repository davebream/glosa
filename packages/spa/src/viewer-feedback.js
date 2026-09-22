// SPDX-License-Identifier: Apache-2.0
// Workspace connection lifecycle. All I/O is caller-injected so this module stays transport-free
// and the SPA retains one data-access boundary.

import { boundProviderName, deriveAgentConnection, providerNameForSession } from "./agent-feedback.js";

export function createViewerFeedbackController({ dataAccess, view, getWorkspaceSlug, pollIntervalMs = 15_000 }) {
  let status = null;
  let latestRefresh = 0;

  function render() {
    view.setState({ slug: getWorkspaceSlug(), status });
  }

  async function refresh() {
    const refreshId = ++latestRefresh;
    const slug = getWorkspaceSlug();
    if (!slug) {
      status = null;
      render();
      return;
    }
    try {
      const fetchedStatus = await dataAccess.getStatus();
      if (getWorkspaceSlug() !== slug || refreshId !== latestRefresh) return;
      status = fetchedStatus;
    } catch {
      if (getWorkspaceSlug() === slug && refreshId === latestRefresh) status = null;
    }
    render();
  }

  function selectWorkspace() {
    status = null;
    render();
    void refresh();
  }

  const pollTimer = setInterval(() => void refresh(), pollIntervalMs);
  pollTimer.unref?.();
  const onWindowFocus = () => void refresh();
  if (typeof window !== "undefined") window.addEventListener("focus", onWindowFocus);

  return {
    refresh,
    /** The provider's own display name for the session bound to this workspace, or null when
     * it cannot be proven. Feeds the margin's identity line, which must never present a
     * session's self-reported label as something glosa verified. */
    providerName() {
      return boundProviderName(deriveAgentConnection(status, getWorkspaceSlug()));
    },
    /** The provider's own display name for one session, or null when it cannot be proven
     * (issue #155). Names the holder of a claim; never a guess. */
    providerNameFor(sessionId) {
      return providerNameForSession(deriveAgentConnection(status, getWorkspaceSlug()), sessionId);
    },
    selectWorkspace,
    destroy() {
      clearInterval(pollTimer);
      if (typeof window !== "undefined") window.removeEventListener("focus", onWindowFocus);
    },
  };
}
