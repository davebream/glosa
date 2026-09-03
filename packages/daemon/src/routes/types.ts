// SPDX-License-Identifier: Apache-2.0

import type { RouteClass } from "../security/auth.ts";

export type BunServer = ReturnType<typeof Bun.serve>;

export interface RouteMatch {
  routeClass: RouteClass;
  handle: (req: Request, server?: BunServer, authSignal?: AbortSignal) => Response | Promise<Response>;
}
