// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen. `createActionClient` returns a proxy that POSTs `{action, args}`
// to `./actions` and returns the typed response.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (bun:sqlite, file APIs, etc.). With
// `verbatimModuleSyntax: true`, dropping `type` is a compile error.

import type { Actions } from "../../server/src/actions";
import { createActionClient } from "@hatch/space-sdk/client";

export const api = createActionClient<typeof Actions>();

// Re-exported for convenience so client code can do
//
//     import { api, type ApiResponse } from "./api";
//     type Article = ApiResponse<typeof api, "listArticles">["articles"][number];
//
// They are also available directly from "@hatch/space-sdk/client".
export type { ApiRequest, ApiResponse } from "@hatch/space-sdk/client";
