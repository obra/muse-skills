/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Pure URL + wire-codec helpers for the CVM (Confidential-VM) runtime tunnel.
//
// These are the security-critical decisions a CVM Space's `__tunnel` makes on
// every URL it sees — does this URL leave the opaque iframe (tunnel it) or is it
// a real resource the browser may load directly (pass it through)? The prelude
// keeps thin closure-wrappers that bind the live `SELF_HREF`/`SELF_BASE_DIR`/
// object-URL set and delegate here, so this module stays free of `window`/
// `document`/`location` and is unit-testable in isolation.
//
// The document loads from an opaque `blob:` URL with no real origin. Relative
// paths the app or SDK resolve against `location.href` therefore become
// absolute `blob:` URLs *under our own base directory* — those are internal and
// must be tunneled. Genuine object URLs the app mints via `URL.createObjectURL`
// are real resources and must pass through.
//
// The blob carries one of two origin shapes and BOTH are load-bearing:
// `blob:https://host/<uuid>` when the frame that minted it had a real origin,
// and `blob:null/<uuid>` when that frame was itself already origin-less. Only
// the first has an inner URL to resolve against; see `resolveAgainstBlobBase`
// for how the second is handled and why getting it wrong renders blank.
//
// Cases covered (mirror the test file `tunnel-url.test.ts`):
//   computeSelfBaseDir — strip #fragment + ?query, slice to the last "/".
//   isSelfOriginUrl    — absolute URL under our opaque base, excluding the
//                        document itself and tracked object URLs.
//   isExternalUrl      — fragment-only / data: / blob: / about: / javascript: /
//                        scheme-relative "//" / any absolute scheme → external;
//                        self-origin and bare relative refs → internal.
//   normalizeToRelPath — map "/foo", "foo", "./foo", and a self-base-absolute
//                        URL all to the same `{*subpath}` route param.
//   resolveTunnelUrl   — `new URL(rel, blobBase)` resolves against the blob's
//                        inner http(s) origin and is re-stamped `blob:`, landing
//                        back under our base; every other (url, base) pair keeps
//                        native semantics. This is what makes the SDK's
//                        `new URL("./actions", location.href)` and a bundler's
//                        `new URL("./asset", import.meta.url)` resolve to
//                        tunnelable self-origin URLs.
//   bytesToBase64 / base64ToBytes — chunked binary <-> base64 wire codec shared
//                        verbatim with the parent-side tunnel.
//   importMetaUrl      — `import.meta.url` shim anchored under the space's
//                        `assets/` dir so imported-asset URLs tunnel correctly.

const B64_CHUNK = 0x8000;

/** Minimal shape of the native `URL` constructor we resolve against. */
type UrlCtor = typeof URL;

/**
 * Derive the base directory of the opaque document from its href: drop any
 * `#fragment` and `?query`, then keep everything up to and including the final
 * `/`. Returns "" for an empty href or one with no slash.
 */
export function computeSelfBaseDir(selfHref: string): string {
  if (!selfHref) return "";
  let h = selfHref;
  const hash = h.indexOf("#");
  if (hash >= 0) h = h.slice(0, hash);
  const q = h.indexOf("?");
  if (q >= 0) h = h.slice(0, q);
  const slash = h.lastIndexOf("/");
  return slash >= 0 ? h.slice(0, slash + 1) : "";
}

/**
 * True for an absolute URL that is a relative path resolved against our own
 * opaque base (tunnel it); false for the document itself and for genuine object
 * URLs (real resources that pass through).
 */
export function isSelfOriginUrl(
  u: string,
  selfBaseDir: string,
  selfHref: string,
  objectUrls: ReadonlySet<string>,
): boolean {
  if (!selfBaseDir || !u.startsWith(selfBaseDir)) return false;
  if (u === selfHref) return false;
  return !objectUrls.has(u);
}

/**
 * True for a URL that must NOT be tunneled — it points outside the space
 * sandbox (external scheme/origin) or is a non-network reference the browser
 * resolves locally. A self-origin URL or a bare relative ref returns false
 * (those are tunneled / resolved into the sandbox).
 */
export function isExternalUrl(
  u: string,
  selfBaseDir: string,
  selfHref: string,
  objectUrls: ReadonlySet<string>,
): boolean {
  if (!u) return false;
  if (u.startsWith("#")) return true; // fragment-only ref → same document
  // A path resolved against our own opaque base is internal — tunnel it, even
  // though it is technically an absolute blob: URL.
  if (isSelfOriginUrl(u, selfBaseDir, selfHref, objectUrls)) return false;
  if (u.startsWith("data:") || u.startsWith("blob:")) return true;
  if (u.startsWith("about:") || u.startsWith("javascript:")) return true;
  if (u.startsWith("//")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) {
    // any absolute scheme (http(s), ws(s), mailto, …) → external
    return true;
  }
  return false;
}

/**
 * Reduce a tunneled URL to the relative path the daemon's `{*subpath}` route
 * expects: strip our base dir, a leading "./", and leading slashes, so "/foo",
 * "foo", "./foo", and `${selfBaseDir}foo` all collapse to "foo".
 */
export function normalizeToRelPath(u: string, selfBaseDir: string): string {
  let s = u;
  if (selfBaseDir && s.startsWith(selfBaseDir)) {
    s = s.slice(selfBaseDir.length);
  }
  s = s.replace(/^\.\//, ""); // strip leading "./"
  s = s.replace(/^\/+/, ""); // strip leading "/"
  return s;
}

/**
 * The inner string of a `blob:` URL, or null if `base` is not a blob: URL.
 * `new URL(relative, blobUrl)` throws because a blob path is opaque, so we
 * resolve against this inner part instead. It is an http(s) origin plus path
 * for `blob:https://host/<uuid>` and the bare token `null/<uuid>` for a blob
 * minted in an opaque origin; `resolveAgainstBlobBase` handles both.
 */
export function blobInner(base: unknown, NativeURL: UrlCtor): string | null {
  if (base == null) return null;
  const s =
    typeof base === "string"
      ? base
      : base instanceof NativeURL
        ? base.href
        : String(base);
  return s.startsWith("blob:") ? s.slice("blob:".length) : null;
}

/**
 * Stand-in origin for resolving a relative reference against an ORIGIN-LESS
 * blob base. Only its path arithmetic is kept (see `resolveAgainstBlobBase`);
 * the host never reaches the network or any comparison, and `.invalid` is the
 * RFC 2606 reserved TLD precisely so it cannot resolve if one ever escaped.
 */
const OPAQUE_BLOB_ORIGIN = "https://hatch-cvm-opaque.invalid";

/** True when `s` parses as an absolute URL on its own. */
function isAbsoluteUrlString(s: string, NativeURL: UrlCtor): boolean {
  try {
    new NativeURL(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `u` against a `blob:` base, whichever origin shape the blob carries.
 * Returns null when `base` is not a blob: URL at all (caller keeps native
 * semantics).
 *
 * TWO SHAPES, and the second is not a corner case — it is what a released VM
 * actually serves. A blob minted by a page at a real origin is
 * `blob:https://host/<uuid>`, whose inner part is itself an absolute URL, so
 * the relative reference resolves against it directly. But a blob minted
 * INSIDE an opaque origin — the sandboxed iframe a web artifact renders in,
 * when its own parent frame is already origin-less — is `blob:null/<uuid>`,
 * and `null/<uuid>` is not a URL. Feeding that to `new URL(u, inner)` throws
 * `TypeError: Invalid URL`, which is fatal rather than cosmetic: the SDK
 * builds its action endpoint with `new URL("./actions", location.href)`, so
 * every server action on a stateful artifact dies on the first call and the
 * page renders blank.
 *
 * For that shape there is no origin to resolve against, only a path, so we
 * borrow one: resolve against `OPAQUE_BLOB_ORIGIN` + the blob's path, keep the
 * resolved path, and re-stamp the original opaque token. `./actions` against
 * `blob:null/<uuid>` lands on `blob:null/actions`, under the `blob:null/` base
 * dir `computeSelfBaseDir` already derives, where `isSelfOriginUrl` and
 * `normalizeToRelPath` tunnel it exactly as they do the http(s) shape.
 */
function resolveAgainstBlobBase(u: string, base: unknown, NativeURL: UrlCtor): URL | null {
  const inner = blobInner(base, NativeURL);
  if (inner === null) return null;
  if (isAbsoluteUrlString(inner, NativeURL)) {
    return new NativeURL("blob:" + new NativeURL(u, inner).href);
  }
  const slash = inner.indexOf("/");
  const token = slash >= 0 ? inner.slice(0, slash) : inner;
  const path = slash >= 0 ? inner.slice(slash) : "/";
  const resolved = new NativeURL(u, OPAQUE_BLOB_ORIGIN + path);
  return new NativeURL(
    "blob:" + token + resolved.pathname + resolved.search + resolved.hash,
  );
}

/**
 * The core of the prelude's `URL` constructor override. A relative reference
 * resolved against a `blob:` base (the document's own opaque origin, which
 * native `new URL` chokes on) is resolved through `resolveAgainstBlobBase` and
 * re-stamped `blob:`, so it lands back under `selfBaseDir` where
 * `isSelfOriginUrl`/`normalizeToRelPath` will tunnel it. Every other (url, base)
 * pair keeps native semantics.
 */
export function resolveTunnelUrl(
  url: unknown,
  base: unknown,
  selfHref: string,
  NativeURL: UrlCtor,
): URL {
  const u =
    url == null
      ? ""
      : typeof url === "string"
        ? url
        : url instanceof NativeURL
          ? url.href
          : String(url);
  const uAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//");
  if (base !== undefined && base !== null && !uAbsolute) {
    const viaBlob = resolveAgainstBlobBase(u, base, NativeURL);
    if (viaBlob !== null) return viaBlob;
    return new NativeURL(u, base as string);
  }
  if (!uAbsolute && selfHref) {
    const viaBlob = resolveAgainstBlobBase(u, selfHref, NativeURL);
    if (viaBlob !== null) return viaBlob;
  }
  return base === undefined ? new NativeURL(u) : new NativeURL(u, base as string);
}

/** Chunked bytes → base64, matching the parent-side tunnel's wire format. */
export function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += B64_CHUNK) {
    s += String.fromCharCode.apply(
      null,
      Array.from(u8.subarray(i, i + B64_CHUNK)) as unknown as number[],
    );
  }
  return btoa(s);
}

/** base64 → bytes, the inverse of {@link bytesToBase64}. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * `import.meta.url` shim for the inlined bundle. The AST rewrite turns
 * `import.meta` into `__tunnel._importMeta`; bundlers then resolve imported
 * asset URLs as `new URL("./asset", import.meta.url)`. Assets are served under
 * the space's `assets/` dir, so anchoring `.url` there makes `resolveTunnelUrl`
 * land "./asset" at a self-origin URL the tunnel maps to "assets/asset".
 */
export function importMetaUrl(selfHref: string, selfBaseDir: string): string {
  return selfBaseDir ? `${selfBaseDir}assets/cvm-bundle.js` : selfHref;
}
