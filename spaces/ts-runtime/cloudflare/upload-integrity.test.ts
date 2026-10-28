import { expect, jest, mock, test } from "bun:test";
import { checkBlob, type UploadChecker } from "./src/upload-integrity";
import { createCheckedPut, createWorker } from "./src/checked-put";
import { defineAction, z } from "./src/sdk";

const DATA = Uint8Array.of(0, 255, 128, 17);
const ALLOW = { verdict: "allow", checkId: "checked", receipt: "not-for-storage" } as const;
const allow: UploadChecker = { async checkUpload() { return ALLOW; } };

function storage() {
  const objects = new Map<string, Uint8Array>();
  const mutations: unknown[][] = [];
  const bucket: Parameters<typeof createCheckedPut>[0] = {
    put: mock(async (key, data, options) => {
      mutations.push(["put", key, data, options]);
      const bytes = new Uint8Array(await new Response(data).arrayBuffer());
      objects.set(key, bytes);
      return { key, size: bytes.length, etag: key, uploaded: new Date(0), writeHttpMetadata() {} };
    }),
    delete: mock(async key => { mutations.push(["delete", key]); objects.delete(key); }),
    async get() { return null; }, async head() { return null; }, async list() { return { objects: [] }; },
  };
  return { bucket, objects, mutations };
}

test("checked bytes, valid original MIME and only check_id are released after allow", async () => {
  const f = storage();
  const checkUpload = mock(async () => ALLOW);
  const put = createCheckedPut(f.bucket, { checkUpload });
  await put(" uploads/雪%2F.txt ", "snow 雪", { public: true, contentType: "Text/Plain ; Charset=UTF-8" });
  const bytes = new TextEncoder().encode("snow 雪");
  expect(checkUpload).toHaveBeenCalledWith({ bytes, contentType: "text/plain", key: "blobs/public/uploads/雪%2F.txt" });
  expect(f.mutations).toEqual([
    ["delete", "blobs/private/uploads/雪%2F.txt"],
    ["put", "blobs/public/uploads/雪%2F.txt", bytes, { httpMetadata: { contentType: "Text/Plain ; Charset=UTF-8" }, customMetadata: { check_id: "checked" } }],
  ]);
  expect(await checkBlob(new Blob([DATA]), undefined, { async checkUpload() { return { ...ALLOW, receipt: null }; } }, "blob"))
    .toEqual({ bytes: DATA, contentType: "application/octet-stream", customMetadata: { check_id: "checked" } });
});

const MAX_CONTENT_TYPE = "text/plain; a=" + "x".repeat(242);
for (const [contentType, normalized, stored] of [
  ["text/plain; charset=utf-8", "text/plain", "text/plain; charset=utf-8"],
  ["multipart/form-data; boundary=----x", "multipart/form-data", "multipart/form-data; boundary=----x"],
  ['multipart/form-data; boundary="a,b"', "multipart/form-data", 'multipart/form-data; boundary="a,b"'],
  ["text/plain; a=b, text/html", "text/plain", "text/plain"],
  ['text/plain; note="a,b"', "text/plain", 'text/plain; note="a,b"'],
  [String.raw`text/plain; note="a\",b"`, "text/plain", String.raw`text/plain; note="a\",b"`],
  [String.raw`text/plain; note="a\\", text/html`, "text/plain", "text/plain"],
  ['text/plain; note="a; charset=ignored"; charset=utf-8', "text/plain", 'text/plain; note="a; charset=ignored"; charset=utf-8'],
  ['text/plain; charset="utf-8"; charset=ascii', "text/plain", 'text/plain; charset="utf-8"; charset=ascii'],
  ["text/plain; garbage", "text/plain", "text/plain"],
  ["text/plain; charset = utf-8", "text/plain", "text/plain"],
  ['text/plain; note="unterminated', "text/plain", "text/plain"],
  ["text/plain; a=b\n", "text/plain", "text/plain"],
  ["text/plain;\tcharset=utf-8", "text/plain", "text/plain"],
  ['text/plain; note="\x7f"', "text/plain", "text/plain"],
  ['text/plain; charset="utf-8\n"', "text/plain", "text/plain"],
  [" Text/Plain ; Charset=UTF-8 ", "text/plain", "text/plain"],
  [MAX_CONTENT_TYPE, "text/plain", MAX_CONTENT_TYPE],
  [MAX_CONTENT_TYPE + "x", "text/plain", "text/plain"],
  [undefined, "application/octet-stream", "application/octet-stream"],
] as const) {
  test(`preserves only valid MIME: ${JSON.stringify(contentType) ?? "the v1 default"}`, async () => {
    const f = storage();
    const checkUpload = mock(async () => ALLOW);
    await createCheckedPut(f.bucket, { checkUpload })("blob", DATA, { contentType });
    expect(checkUpload).toHaveBeenCalledWith({ bytes: DATA, contentType: normalized, key: "blobs/private/blob" });
    expect(f.bucket.put).toHaveBeenCalledWith("blobs/private/blob", DATA, {
      httpMetadata: { contentType: stored },
      customMetadata: { check_id: "checked" },
    });
  });
}

test("rev1.9 malformed MIME, storage keys and byte-size bounds never reach the checker or storage", async () => {
  const f = storage();
  const hatch = { checkUpload: mock(async () => ALLOW) };
  const put = createCheckedPut(f.bucket, hatch);
  for (const contentType of ["", "text/pläin", "text/", "x/" + "a".repeat(126), null]) {
    await expect(put("blob", DATA, { contentType: contentType as string })).rejects.toThrow("upload_integrity:unsupported_type");
  }
  for (const [key, message] of [
    ["", "Blob key must not be empty"],
    ["/blob", "Blob key must not start with /"],
    ["a//b", "Blob key must not contain empty, . or .. path segments"],
    ["a/./b", "Blob key must not contain empty, . or .. path segments"],
    ["a/../b", "Blob key must not contain empty, . or .. path segments"],
    ["a\\b", "Blob key must use / path separators"],
  ]) {
    await expect(put(key, DATA)).rejects.toThrow(message);
  }
  for (const key of ["雪".repeat(342), "x".repeat(1024)]) {
    await expect(put(key, DATA)).rejects.toThrow("upload_integrity:bad_request");
  }
  for (const [data, code] of [[new Uint8Array(0), "bad_request"], [new Uint8Array(8 * 1024 * 1024 + 1), "too_large"],
    ["雪".repeat(3 * 1024 * 1024), "too_large"]] as const) {
    await expect(put("blob", data)).rejects.toThrow(`upload_integrity:${code}`);
  }
  expect(hatch.checkUpload).not.toHaveBeenCalled();
  expect(f.mutations).toEqual([]);
  for (const size of [1, 8 * 1024 * 1024]) {
    await put("x".repeat(1024 - "blobs/private/".length), new Uint8Array(size));
  }
  expect(hatch.checkUpload).toHaveBeenCalledTimes(2);
});

test("malformed rev1.9 replies and block verdicts leave old blobs unchanged", async () => {
  for (const result of [null, {}, [], { ...ALLOW, verdict: "unknown" }, { ...ALLOW, checkId: "" },
    { ...ALLOW, checkId: "x".repeat(129) }, { ...ALLOW, checkId: 1 }, { ...ALLOW, receipt: undefined },
    { ...ALLOW, receipt: {} }, { ...ALLOW, verdict: "block" }]) {
    const f = storage();
    f.objects.set("blobs/public/blob", DATA);
    f.objects.set("blobs/private/blob", DATA);
    const put = createCheckedPut(f.bucket, { async checkUpload() { return result; } });
    await expect(put("blob", "replacement")).rejects.toThrow(
      result && "verdict" in result && result.verdict === "block" ? "upload_integrity:blocked" : "upload_integrity:unavailable");
    expect(f.mutations).toEqual([]);
    expect([...f.objects.values()]).toEqual([DATA, DATA]);
  }
  expect((await checkBlob(DATA, undefined, { async checkUpload() { return { ...ALLOW, checkId: "x".repeat(128) }; } }, "blob")).customMetadata)
    .toEqual({ check_id: "x".repeat(128) });
});

test("only rev1.9 RPC error codes escape; arbitrary exception details and missing HATCH fail closed", async () => {
  for (const code of ["bad_request", "replayed", "too_large", "unsupported_type", "body_mismatch", "rate_limited", "unavailable", "blocked", "private credential detail"]) {
    const f = storage();
    const put = createCheckedPut(f.bucket, { async checkUpload() { throw new Error(`upload_integrity:${code}`); } });
    await expect(put("blob", DATA)).rejects.toThrow(`upload_integrity:${["blocked", "private credential detail"].includes(code) ? "unavailable" : code}`);
    expect(f.mutations).toEqual([]);
  }
  const f = storage();
  await expect(createCheckedPut(f.bucket, undefined)("blob", DATA)).rejects.toThrow("upload_integrity:unavailable");
  expect(f.mutations).toEqual([]);
});

test("input mutation during a pending check cannot alter the private snapshot", async () => {
  for (const kind of ["buffer", "view", "data-view"] as const) {
    const f = storage();
    const data = DATA.slice();
    const started = Promise.withResolvers<void>();
    const verdict = Promise.withResolvers<typeof ALLOW>();
    const input = kind === "buffer" ? data.buffer : kind === "data-view" ? new DataView(data.buffer) : data;
    const pending = createCheckedPut(f.bucket, { async checkUpload(request) {
      expect(request.bytes).toEqual(DATA);
      started.resolve();
      return verdict.promise;
    } })("blob", input);
    await started.promise;
    data.fill(42);
    expect(f.mutations).toEqual([]);
    verdict.resolve(ALLOW);
    await pending;
    expect(f.objects.get("blobs/private/blob")).toEqual(DATA);
  }
});

test("a 30-second timeout never releases a late allow verdict", async () => {
  jest.useFakeTimers();
  try {
    const f = storage();
    const started = Promise.withResolvers<void>();
    const verdict = Promise.withResolvers<typeof ALLOW>();
    const pending = createCheckedPut(f.bucket, { async checkUpload() {
      started.resolve(); return verdict.promise;
    } })("blob", DATA);
    const settled = pending.then(() => null, error => error);
    await started.promise;
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(29_999);
    await Promise.resolve();
    expect(f.mutations).toEqual([]);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(1);
    expect(await settled).toEqual(new Error("upload_integrity:unavailable"));
    expect(jest.getTimerCount()).toBe(0);
    verdict.resolve(ALLOW);
    await Promise.resolve();
    expect(f.mutations).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test("delete-before-put matches v1 even when the write fails", async () => {
  for (const publicBlob of [false, true]) {
    const f = storage();
    const target = `blobs/${publicBlob ? "public" : "private"}/blob`;
    const opposite = `blobs/${publicBlob ? "private" : "public"}/blob`;
    f.objects.set(target, DATA);
    f.objects.set(opposite, DATA);
    const realPut = f.bucket.put;
    f.bucket.put = mock(async () => { throw new Error("write failed"); });
    await expect(createCheckedPut(f.bucket, allow)("blob", "new", { public: publicBlob })).rejects.toThrow("write failed");
    expect(f.mutations).toEqual([["delete", opposite]]);
    expect(f.objects.get(target)).toEqual(DATA);
    expect(f.objects.has(opposite)).toBe(false);
    f.bucket.put = realPut;
    f.mutations.length = 0;
    await createCheckedPut(f.bucket, allow)("blob", "new", { public: publicBlob });
    expect(f.mutations.map(m => m.slice(0, 2))).toEqual([["delete", opposite], ["put", target]]);
    expect(f.objects.get(target)).toEqual(new TextEncoder().encode("new"));
    expect(f.objects.has(opposite)).toBe(false);
  }
});

test("concurrent opposite-visibility puts do not delete both completed writes", async () => {
  const f = storage();
  const storagePut = f.bucket.put;
  const bothWritten = Promise.withResolvers<void>();
  let writes = 0;
  f.bucket.put = mock(async (...args: Parameters<typeof storagePut>) => {
    const result = await storagePut(...args);
    if (++writes === 2) bothWritten.resolve();
    await bothWritten.promise;
    return result;
  });
  const put = createCheckedPut(f.bucket, allow);
  await Promise.all([put("blob", DATA, { public: true }), put("blob", DATA)]);
  expect(f.objects.get("blobs/public/blob")).toEqual(DATA);
  expect(f.objects.get("blobs/private/blob")).toEqual(DATA);
});

test("concurrent puts cannot mix checker results, metadata or cleanup", async () => {
  const f = storage();
  const firstStarted = Promise.withResolvers<void>();
  const firstVerdict = Promise.withResolvers<typeof ALLOW>();
  const put = createCheckedPut(f.bucket, { async checkUpload(request) {
    if (request.key.endsWith("/first")) { firstStarted.resolve(); return firstVerdict.promise; }
    return { ...ALLOW, checkId: "second" };
  } });
  const first = put("first", DATA, { public: true });
  await firstStarted.promise;
  await put("second", "second");
  expect(f.mutations.map(m => m.slice(0, 2))).toEqual([["delete", "blobs/public/second"], ["put", "blobs/private/second"]]);
  firstVerdict.resolve(ALLOW);
  await first;
  expect(f.bucket.put).toHaveBeenNthCalledWith(1, "blobs/private/second", new TextEncoder().encode("second"),
    { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { check_id: "second" } });
  expect(f.bucket.put).toHaveBeenNthCalledWith(2, "blobs/public/first", DATA,
    { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { check_id: "checked" } });
});

test("the adapter captures per-request HATCH and preserves original authentication and error responses", async () => {
  const f = storage();
  const started = Promise.withResolvers<void>();
  const verdict = Promise.withResolvers<unknown>();
  const firstHatch = { async checkUpload() { started.resolve(); return verdict.promise; } };
  const secondHatch = { checkUpload: mock(async () => ({ ...ALLOW, checkId: "second" })) };
  const worker = createWorker({ upload: defineAction({ request: z.object({ key: z.string() }), response: z.null(),
    async handler(ctx, args) { await ctx.blobs.put(args.key, DATA); return null; },
  }) }, "demo");
  const env = {
    DB: { prepare() { return { bind() { return this; }, async run() {}, async first<T>() { return {} as T; } }; } },
    BUCKET: f.bucket, SPACE_SHORTCODE: "demo-123", ASSETS: { async fetch() { return new Response(); } },
  };
  const request = (key: string, authenticated = true) => new Request("https://demo-123.example/actions", {
    method: "POST", body: JSON.stringify({ action: "upload", args: { key } }),
    headers: { "content-type": "application/json", "x-cloudflare-spaces-viewer-authenticated": authenticated ? "1" : "0",
      "x-cloudflare-spaces-share-id": "share", "x-cloudflare-spaces-space-slug": "demo", "x-cloudflare-spaces-space-id": "123",
      "x-cloudflare-spaces-viewer-fbid": "owner", "x-cloudflare-spaces-owner-fbid": "owner", "x-cloudflare-spaces-is-owner": "true",
      "x-cloudflare-spaces-token-exp": "2000000000", "x-cloudflare-spaces-token-jti": "test" },
  });
  const execution = { props: { HATCH: firstHatch as UploadChecker }, waitUntil() {} };
  const first = worker.fetch(request("first"), env, execution);
  execution.props.HATCH = secondHatch;
  await started.promise;
  expect((await worker.fetch(request("second"), env, execution)).status).toBe(200);
  verdict.resolve({ ...ALLOW, verdict: "block" });
  const response = await first;
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "The app could not confirm the result. Reload to check your changes before trying again.", code: "action_outcome_unknown" });
  expect((await worker.fetch(request("no-hatch"), env, { waitUntil() {} })).status).toBe(409);
  expect((await worker.fetch(request("denied", false), env, execution)).status).toBe(401);
  expect(secondHatch.checkUpload).toHaveBeenCalledTimes(1);
  expect([...f.objects.keys()]).toEqual(["blobs/private/second"]);
});
