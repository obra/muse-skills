import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { z } from "zod";

export { z };

/** A loose JSON value used by streaming `ctx.emit` frames. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Portable typed drizzle-orm DB surface for Muse Spaces.
 *
 * The schema TYPE flows from the agent's call site into Drizzle's query
 * types; no schema VALUE crosses into the SDK or worker. Local runtime uses
 * `drizzle-orm/libsql`; Cloudflare runtime uses `drizzle-orm/d1`.
 *
 * This is the conservative portable subset supported across both runtimes.
 * Use `batch` for simple atomic multi-statement write sets. Do not expose
 * `transaction` here: D1 rejects Drizzle's SQL BEGIN/SAVEPOINT transaction
 * implementation from Worker bindings.
 */
export type SpaceDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = Pick<
  LibSQLDatabase<TSchema>,
  "select" | "insert" | "update" | "delete" | "run" | "all" | "get" | "batch"
>;

/** Per-invocation typed DB accessor. */
export type SpaceDbAccessor = <
  TSchema extends Record<string, unknown> = Record<string, never>,
>() => SpaceDb<TSchema>;

/** User identity verified by the local daemon, without a share token. */
export type LocalViewer = {
  source: "local";
  authenticated: true;
  spaceSlug: string;
  userId: string;
  ownerUserId: string;
  isOwner: boolean;
};

export type CloudflareViewer = {
  source: "cloudflare";
  authenticated: true;
  shareId: string;
  spaceSlug: string;
  spaceId?: string;
  viewerFbid: string;
  ownerFbid: string;
  isOwner: boolean;
  tokenExpiresAt: number;
  tokenId: string;
  displayName?: string;
};

export type Viewer = LocalViewer | CloudflareViewer;

export type BlobPutData = string | ArrayBuffer | ArrayBufferView | Blob;

export interface BlobPutOptions {
  readonly contentType?: string;
  readonly public?: boolean;
}

export interface BlobUrlOptions {
  readonly expiresInSeconds?: number;
  readonly public?: boolean;
}

export interface BlobMetadata {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly sizeBytes: number;
  readonly etag: string;
  readonly visibility: "private" | "public";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly public: boolean;
}

export interface BlobClient {
  put(key: string, data: BlobPutData, options?: BlobPutOptions): Promise<void>;
  getUrl(key: string, options?: BlobUrlOptions): Promise<string>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<BlobMetadata | null>;
  list(prefix?: string): Promise<BlobMetadata[]>;
}

/**
 * Versioned brand for privileged function descriptors.
 *
 * Descriptors are the portable contract that action code imports and passes to
 * `ctx.executePrivileged(...)`. Host-capable implementations live in a
 * separate privileged bundle; action bundles should only carry descriptors.
 */
export const PRIVILEGED_CONTRACT_BRAND =
  "@hatch/space-sdk/privileged-contract/v1" as const;

export interface PrivilegedContract<
  Name extends string = string,
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly __brand: typeof PRIVILEGED_CONTRACT_BRAND;
  readonly name: Name;
  readonly request: Req;
  readonly response: Res;
  readonly capabilities?: readonly string[];
  readonly timeoutMs?: number;
}

export type PrivilegedContractSpec<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> = {
  readonly request: Req;
  readonly response: Res;
  readonly capabilities?: readonly string[];
  readonly timeoutMs?: number;
};

export type PrivilegedContractsFor<
  Specs extends Record<string, PrivilegedContractSpec>,
> = {
  readonly [Name in keyof Specs & string]: PrivilegedContract<
    Name,
    Specs[Name]["request"],
    Specs[Name]["response"]
  >;
};

export type PrivilegedRequest<C extends PrivilegedContract> = z.infer<
  C["request"]
>;
export type PrivilegedResponse<C extends PrivilegedContract> = z.infer<
  C["response"]
>;

export interface PrivilegedExecutor {
  executePrivileged<C extends PrivilegedContract>(
    contract: C,
    args: PrivilegedRequest<C>,
  ): Promise<PrivilegedResponse<C>>;
}

export type PrivilegedTransport = <C extends PrivilegedContract>(
  contract: C,
  args: PrivilegedRequest<C>,
) => Promise<unknown>;

export const PRIVILEGED_HANDLERS_FORMAT =
  "hatch-space-privileged-handlers-v1" as const;

export type PrivilegedHandler<C extends PrivilegedContract = PrivilegedContract> = (
  args: PrivilegedRequest<C>,
) => Promise<PrivilegedResponse<C>> | PrivilegedResponse<C>;

export type PrivilegedHandlersFor<
  Contracts extends Record<string, PrivilegedContract>,
> = {
  readonly [Name in keyof Contracts]?: PrivilegedHandler<Contracts[Name]>;
};

export interface PrivilegedHandlerEntry<C extends PrivilegedContract = PrivilegedContract> {
  readonly contract: C;
  readonly handler: PrivilegedHandler<C>;
}

export interface PrivilegedHandlers {
  readonly format: typeof PRIVILEGED_HANDLERS_FORMAT;
  readonly entries: readonly PrivilegedHandlerEntry[];
}

export function definePrivilegedContracts<
  const Specs extends Record<string, PrivilegedContractSpec>,
>(specs: Specs): PrivilegedContractsFor<Specs> {
  const contracts: Record<string, PrivilegedContract> = {};
  for (const [name, spec] of Object.entries(specs)) {
    contracts[name] = {
      __brand: PRIVILEGED_CONTRACT_BRAND,
      name,
      request: spec.request,
      response: spec.response,
      ...(spec.capabilities !== undefined
        ? { capabilities: spec.capabilities }
        : {}),
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    };
  }
  return contracts as PrivilegedContractsFor<Specs>;
}

export function definePrivilegedHandlers<
  const Contracts extends Record<string, PrivilegedContract>,
>(
  contracts: Contracts,
  handlers: PrivilegedHandlersFor<Contracts>,
): PrivilegedHandlers {
  const entries: PrivilegedHandlerEntry[] = [];
  for (const [key, handler] of Object.entries(handlers)) {
    if (handler === undefined) {
      continue;
    }
    const contract = contracts[key];
    if (!isPrivilegedContract(contract)) {
      throw new Error(`privileged handler '${key}' does not have a contract descriptor`);
    }
    entries.push({
      contract,
      handler: handler as PrivilegedHandler,
    });
  }
  return {
    format: PRIVILEGED_HANDLERS_FORMAT,
    entries,
  };
}

/** Runtime check used by workers to recognize privileged descriptors. */
export function isPrivilegedContract(value: unknown): value is PrivilegedContract {
  return (
    typeof value === "object" &&
    value !== null &&
    "__brand" in value &&
    (value as { __brand: unknown }).__brand === PRIVILEGED_CONTRACT_BRAND
  );
}

export function isPrivilegedHandlers(value: unknown): value is PrivilegedHandlers {
  return (
    typeof value === "object" &&
    value !== null &&
    "format" in value &&
    (value as { format: unknown }).format === PRIVILEGED_HANDLERS_FORMAT &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}

export function createPrivilegedExecutor(
  declared: readonly PrivilegedContract[] | undefined,
  transport: PrivilegedTransport,
): PrivilegedExecutor {
  const declaredNames = new Set((declared ?? []).map((contract) => contract.name));
  return {
    async executePrivileged<C extends PrivilegedContract>(
      contract: C,
      args: PrivilegedRequest<C>,
    ): Promise<PrivilegedResponse<C>> {
      if (!isPrivilegedContract(contract)) {
        throw new Error("ctx.executePrivileged requires a privileged contract descriptor");
      }
      if (!declaredNames.has(contract.name)) {
        throw new Error(
          `ctx.executePrivileged(${contract.name}) was not declared by this action`,
        );
      }
      const parsedArgs = contract.request.parse(args) as PrivilegedRequest<C>;
      const result = await transport(contract, parsedArgs);
      return contract.response.parse(result) as PrivilegedResponse<C>;
    },
  };
}

/** Runtime-neutral context fields available to portable Space actions. */
export interface PortableCtx extends PrivilegedExecutor {
  readonly slug: string;
  readonly invocationId: string;
  readonly spaceDir: string;
  readonly db: SpaceDbAccessor;
  readonly viewer?: Viewer;
  readonly blobs: BlobClient;
}

/**
 * Versioned brand. Identifies a value as an action definition produced by
 * `defineAction(...)`. The worker scans module exports for objects carrying
 * this brand to build its dispatch table.
 *
 * Versioning lets a future SDK reject stale-shape actions explicitly. The
 * string shape is stable across independently bundled SDK copies; avoid Symbol
 * identity here because Cloudflare and local bundles intentionally inline
 * separate module copies.
 */
export const ACTION_BRAND = "@hatch/space-sdk/action/v1" as const;
const LEGACY_ACTION_BRAND = Symbol.for("@hatch/space-sdk/action");

export interface ActionDefinition<
  TCtx extends PortableCtx = PortableCtx,
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly __brand: typeof ACTION_BRAND;
  readonly request: Req;
  readonly response: Res;
  readonly privileged?: readonly PrivilegedContract[];
  readonly handler: (ctx: TCtx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}

export type ActionFactoryInput<
  TCtx extends PortableCtx,
  Req extends z.ZodType,
  Res extends z.ZodType,
> = {
  request: Req;
  response: Res;
  privileged?: readonly PrivilegedContract[];
  handler: (ctx: TCtx, args: z.infer<Req>) => Promise<z.infer<Res>>;
};

/** Bind the shared action implementation to a runtime-specific Ctx type. */
export function createDefineAction<TCtx extends PortableCtx>() {
  return function defineAction<Req extends z.ZodType, Res extends z.ZodType>(
    spec: ActionFactoryInput<TCtx, Req, Res>,
  ): ActionDefinition<TCtx, Req, Res> {
    return {
      __brand: ACTION_BRAND,
      request: spec.request,
      response: spec.response,
      ...(spec.privileged !== undefined ? { privileged: spec.privileged } : {}),
      handler: spec.handler,
    };
  };
}

/** Runtime check used by workers to filter module exports. */
export function isAction(value: unknown): value is ActionDefinition {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    "__brand" in value &&
    (value as { __brand: unknown }).__brand === ACTION_BRAND
  ) {
    return true;
  }
  return (
    (value as { kind?: unknown }).kind === "action" &&
    (value as { [LEGACY_ACTION_BRAND]?: unknown })[LEGACY_ACTION_BRAND] === true
  );
}

/**
 * The shape every space's `actions.ts` must satisfy. Use as
 * `} satisfies ActionsModule;` to flag stray non-action values without
 * widening the inferred type.
 */
export type ActionsModuleFor<TCtx extends PortableCtx> = Record<
  string,
  Omit<ActionDefinition<TCtx>, "handler"> & {
    handler: (ctx: TCtx, args: any) => Promise<any>;
  }
>;

/** Extract the request payload type for a given action. */
export type ActionRequest<A extends { request: z.ZodType }> = z.infer<A["request"]>;

/** Extract the response payload type for a given action. */
export type ActionResponse<A extends { response: z.ZodType }> = z.infer<A["response"]>;
