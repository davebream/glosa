// SPDX-License-Identifier: Apache-2.0
// Maintainer-only bundle entry. Copy into the isolated, pinned vendor workspace before building.

import { ComposerPrimitiveRoot } from "./node_modules/@assistant-ui/react/dist/primitives/composer/ComposerRoot.js";
import { MessagePrimitiveRoot } from "./node_modules/@assistant-ui/react/dist/primitives/message/MessageRoot.js";
// Pin-scoped entry points avoid bundling unused namespace members (including cloud adapters).
// These exact dist paths are checked by the maintainer build and its frozen dependency lock.
import { ThreadPrimitiveRoot } from "./node_modules/@assistant-ui/react/dist/primitives/thread/ThreadRoot.js";
import { ThreadPrimitiveViewport } from "./node_modules/@assistant-ui/react/dist/primitives/thread/ThreadViewport.js";

export { AssistantRuntimeProvider } from "./node_modules/@assistant-ui/react/dist/legacy-runtime/AssistantRuntimeProvider.js";

import { ThreadPrimitiveMessages } from "@assistant-ui/core/react";

export { useExternalStoreRuntime } from "@assistant-ui/core/react";
export const ThreadPrimitive = {
  Root: ThreadPrimitiveRoot,
  Viewport: ThreadPrimitiveViewport,
  Messages: ThreadPrimitiveMessages,
};
export const MessagePrimitive = { Root: MessagePrimitiveRoot };
export const ComposerPrimitive = { Root: ComposerPrimitiveRoot };
export * as React from "react";
export { flushSync } from "react-dom";
export { createRoot } from "react-dom/client";
