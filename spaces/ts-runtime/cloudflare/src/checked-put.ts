import { checkBlob, type UploadChecker } from "./upload-integrity";
import { READ_ONLY_ACTIONS_PATH } from "./read-only-access";
import { isAction, type ActionDefinition, type BlobClient } from "./sdk";
import { createWorker as createOriginalWorker, normalizeBlobKey, r2Key } from "./worker-runtime";

type WorkerFetch = ReturnType<typeof createOriginalWorker>["fetch"];
type Env = Parameters<WorkerFetch>[1];
type Execution = Parameters<WorkerFetch>[2] & { readonly props?: { readonly HATCH?: UploadChecker } };

export function createCheckedPut(bucket: Env["BUCKET"], hatch: UploadChecker | undefined): BlobClient["put"] {
  return async (key, data, options) => {
    const normalizedKey = normalizeBlobKey(key);
    const visibility = options?.public === true ? "public" : "private";
    const releasedKey = r2Key(visibility, normalizedKey);
    const checked = await checkBlob(data, options?.contentType, hatch, releasedKey);
    const opposite = visibility === "public" ? "private" : "public";
    await bucket.delete(r2Key(opposite, normalizedKey));
    await bucket.put(releasedKey, checked.bytes, {
      httpMetadata: { contentType: checked.contentType },
      customMetadata: checked.customMetadata,
    });
  };
}

// Create the v1 worker per request because HATCH arrives via execution.props.
export function createWorker(actionsExport: Record<string, unknown>, slug: string) {
  return {
    fetch(request: Request, env: Env, execution: Execution): Promise<Response> {
      if (new URL(request.url).pathname === READ_ONLY_ACTIONS_PATH) {
        return createOriginalWorker(actionsExport, slug).fetch(request, env, execution);
      }
      const hatch = execution.props?.HATCH;
      const actions = Object.fromEntries(Object.entries(actionsExport).map(([name, action]) => {
        if (!isAction(action)) return [name, action];
        return [name, {
          ...action,
          handler(ctx, args) {
            ctx.blobs.put = createCheckedPut(env.BUCKET, hatch);
            return action.handler(ctx, args);
          },
        } satisfies ActionDefinition];
      }));
      return createOriginalWorker(actions, slug).fetch(request, env, execution);
    },
  };
}
