// Runtime tunnel (__tunnel) for the CVM hermetic Space bundle.
// This file is concatenated verbatim into every space bundle.
// It must run before any rewritten user code.
//
// The single global `__tunnel` is the only thing user code references.
// All URL-bearing browser APIs are funneled through it.
//
// Marker on first line lets the bundler skip rewriting this code.
/* __HATCH_TUNNEL_SOURCE__ */

// Pure URL + wire-codec helpers live in ./tunnel-url so they can be unit-tested
// without a DOM. The thin wrappers below bind the live SELF_HREF/SELF_BASE_DIR/
// objectUrls and delegate. bun inlines this import into the compiled prelude.
import {
  base64ToBytes,
  bytesToBase64,
  computeSelfBaseDir,
  importMetaUrl,
  isExternalUrl as isExternalUrlImpl,
  isSelfOriginUrl as isSelfOriginUrlImpl,
  normalizeToRelPath as normalizeToRelPathImpl,
  resolveTunnelUrl,
} from "./tunnel-url";
import { installDownloadLinks } from "./download-links";
import { installFragmentLinks } from "./fragment-links";

declare global {
  interface Window {
    __tunnel: any;
  }
}

(function installTunnel() {
  installFragmentLinks();

  // --- Handshake -----------------------------------------------------------
  let port: MessagePort | null = null;
  let portReadyResolve: ((p: MessagePort) => void) | null = null;
  const portReady: Promise<MessagePort> = new Promise((res) => {
    portReadyResolve = res;
  });

  // Pending HTTP requests, keyed by id.
  const pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();

  // Open WS instances keyed by id (we forward inbound msgs to them).
  const openWs = new Map<string, TunnelWebSocket>();

  function newId() {
    return (
      Math.random().toString(36).slice(2) +
      "-" +
      Date.now().toString(36)
    );
  }

  function bytesToB64(bytes: Uint8Array | ArrayBuffer): string {
    return bytesToBase64(bytes);
  }

  function b64ToBytes(b64: string): Uint8Array {
    return base64ToBytes(b64);
  }

  // --- Async port-readiness wrapper for HTTP requests ----------------------
  async function httpReq(
    method: string,
    path: string,
    body?: BodyInit | null,
    headers?: HeadersInit
  ): Promise<{
    status: number;
    headers: Array<[string, string]>;
    bytes: Uint8Array;
  }> {
    const p = port ?? (await portReady);
    const id = newId();
    // Normalize headers to array form
    const headerArr: Array<[string, string]> = [];
    if (headers) {
      const h = new Headers(headers);
      h.forEach((v, k) => headerArr.push([k, v]));
    }
    // Encode body
    let bodyB64 = "";
    if (body != null && body !== "") {
      let bytes: Uint8Array;
      if (typeof body === "string") {
        bytes = new TextEncoder().encode(body);
      } else if (body instanceof ArrayBuffer) {
        bytes = new Uint8Array(body);
      } else if (body instanceof Uint8Array) {
        bytes = body;
      } else if (body instanceof Blob) {
        bytes = new Uint8Array(await body.arrayBuffer());
      } else if (body instanceof FormData) {
        // Convert to multipart manually – simplest path.
        const boundary =
          "----HatchBoundary" + Math.random().toString(36).slice(2);
        let s = "";
        for (const [k, v] of body.entries()) {
          s += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"`;
          if (v instanceof File) {
            s += `; filename="${v.name}"\r\nContent-Type: ${v.type || "application/octet-stream"}\r\n\r\n`;
            const fb = new Uint8Array(await v.arrayBuffer());
            s += new TextDecoder("latin1").decode(fb);
          } else {
            s += `\r\n\r\n${v}`;
          }
          s += "\r\n";
        }
        s += `--${boundary}--\r\n`;
        bytes = new TextEncoder().encode(s);
        headerArr.push([
          "content-type",
          `multipart/form-data; boundary=${boundary}`,
        ]);
      } else {
        bytes = new TextEncoder().encode(String(body));
      }
      bodyB64 = bytesToB64(bytes);
    }
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (msg: any) => {
          if (msg.error) {
            reject(new Error(msg.error.message ?? "tunnel error"));
            return;
          }
          resolve({
            status: msg.status,
            headers: msg.headers,
            bytes: msg.bodyB64 ? b64ToBytes(msg.bodyB64) : new Uint8Array(0),
          });
        },
        reject,
      });
      p.postMessage({
        type: "http.req",
        id,
        method,
        path,
        headers: headerArr,
        bodyB64,
      });
    });
  }

  // --- fetch wrapper -------------------------------------------------------
  async function tunnelFetch(input: any, init?: RequestInit): Promise<Response> {
    let urlStr: string;
    let method = init?.method ?? "GET";
    let headers: HeadersInit | undefined = init?.headers;
    let body: BodyInit | null | undefined = init?.body;
    if (input instanceof Request) {
      urlStr = input.url;
      method = init?.method ?? input.method;
      headers = init?.headers ?? input.headers;
      if (body == null && input.body) {
        body = await input.arrayBuffer();
      }
    } else {
      urlStr = String(input);
    }
    if (isExternalUrl(urlStr)) {
      return originalFetch(input, init);
    }
    const relPath = normalizeToRelPath(urlStr);
    const r = await httpReq(method, relPath, body ?? null, headers);
    const respHeaders = new Headers();
    for (const [k, v] of r.headers ?? []) respHeaders.set(k, v);
    return new Response(r.bytes, {
      status: r.status,
      headers: respHeaders,
    });
  }

  // --- WebSocket wrapper ---------------------------------------------------
  class TunnelWebSocket extends EventTarget {
    readyState: number = 0; // CONNECTING
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    url: string;
    binaryType: "blob" | "arraybuffer" = "blob";
    bufferedAmount = 0;
    protocol = "";
    extensions = "";
    onopen: ((ev: Event) => any) | null = null;
    onmessage: ((ev: MessageEvent) => any) | null = null;
    onclose: ((ev: CloseEvent) => any) | null = null;
    onerror: ((ev: Event) => any) | null = null;
    _id: string;

    constructor(urlIn: string | URL, _protocols?: string | string[]) {
      super();
      const urlStr = String(urlIn);
      this.url = urlStr;
      this._id = newId();
      openWs.set(this._id, this);
      const path = normalizeToRelPath(urlStr);
      (async () => {
        const p = port ?? (await portReady);
        p.postMessage({ type: "ws.open", id: this._id, path });
      })();
    }

    _handle(msg: any) {
      if (msg.type === "ws.opened") {
        this.readyState = 1;
        const ev = new Event("open");
        this.onopen?.(ev);
        this.dispatchEvent(ev);
      } else if (msg.type === "ws.message") {
        const bytes = msg.dataB64 ? b64ToBytes(msg.dataB64) : new Uint8Array(0);
        let data: any;
        if (msg.binary) {
          data =
            this.binaryType === "arraybuffer"
              ? bytes.buffer
              : new Blob([bytes]);
        } else {
          data = new TextDecoder().decode(bytes);
        }
        const ev = new MessageEvent("message", { data });
        this.onmessage?.(ev);
        this.dispatchEvent(ev);
      } else if (msg.type === "ws.closed") {
        this.readyState = 3;
        const ev = new CloseEvent("close", {
          code: msg.code ?? 1000,
          reason: msg.reason ?? "",
        });
        this.onclose?.(ev);
        this.dispatchEvent(ev);
        openWs.delete(this._id);
      } else if (msg.type === "ws.error") {
        const ev = new Event("error");
        this.onerror?.(ev);
        this.dispatchEvent(ev);
      }
    }

    send(data: string | ArrayBuffer | Blob | ArrayBufferView) {
      (async () => {
        const p = port ?? (await portReady);
        let bytes: Uint8Array;
        let binary = false;
        if (typeof data === "string") {
          bytes = new TextEncoder().encode(data);
        } else if (data instanceof Blob) {
          bytes = new Uint8Array(await data.arrayBuffer());
          binary = true;
        } else if (data instanceof ArrayBuffer) {
          bytes = new Uint8Array(data);
          binary = true;
        } else if (ArrayBuffer.isView(data)) {
          bytes = new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength
          );
          binary = true;
        } else {
          bytes = new TextEncoder().encode(String(data));
        }
        p.postMessage({
          type: "ws.send",
          id: this._id,
          dataB64: bytesToB64(bytes),
          binary,
        });
      })();
    }

    close(code?: number, reason?: string) {
      (async () => {
        const p = port ?? (await portReady);
        p.postMessage({ type: "ws.close", id: this._id, code, reason });
      })();
    }

    addEventListener<K extends string>(
      type: K,
      listener: any,
      options?: AddEventListenerOptions | boolean
    ) {
      super.addEventListener(type as any, listener, options);
    }
  }

  // --- XHR wrapper ---------------------------------------------------------
  class TunnelXHR extends EventTarget {
    static UNSENT = 0;
    static OPENED = 1;
    static HEADERS_RECEIVED = 2;
    static LOADING = 3;
    static DONE = 4;
    UNSENT = 0;
    OPENED = 1;
    HEADERS_RECEIVED = 2;
    LOADING = 3;
    DONE = 4;
    readyState = 0;
    status = 0;
    statusText = "";
    responseText = "";
    response: any = null;
    responseType: XMLHttpRequestResponseType = "";
    responseURL = "";
    withCredentials = false;
    timeout = 0;
    upload: any = new EventTarget();
    onreadystatechange: any = null;
    onload: any = null;
    onerror: any = null;
    onloadend: any = null;
    onabort: any = null;
    onprogress: any = null;
    ontimeout: any = null;

    private _method = "GET";
    private _url = "";
    private _reqHeaders: Array<[string, string]> = [];
    private _respHeaders: Array<[string, string]> = [];
    private _aborted = false;

    open(method: string, url: string) {
      this._method = method;
      this._url = url;
      this.readyState = 1;
      this.onreadystatechange?.();
    }
    setRequestHeader(name: string, value: string) {
      this._reqHeaders.push([name, value]);
    }
    getAllResponseHeaders() {
      return this._respHeaders
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
    }
    getResponseHeader(name: string) {
      const lc = name.toLowerCase();
      const hit = this._respHeaders.find(([k]) => k.toLowerCase() === lc);
      return hit ? hit[1] : null;
    }
    abort() {
      this._aborted = true;
      this.readyState = 0;
    }
    send(body?: any) {
      if (isExternalUrl(this._url)) {
        // Fall through to real XHR
        const real = new (originalXHR as any)();
        real.open(this._method, this._url);
        for (const [k, v] of this._reqHeaders) real.setRequestHeader(k, v);
        real.onload = () => {
          this.status = real.status;
          this.responseText = real.responseText;
          this.response = real.response;
          this.readyState = 4;
          this.onreadystatechange?.();
          this.onload?.();
          this.onloadend?.();
          this.dispatchEvent(new Event("load"));
        };
        real.onerror = () => {
          this.onerror?.();
          this.dispatchEvent(new Event("error"));
        };
        real.send(body);
        return;
      }
      const relPath = normalizeToRelPath(this._url);
      httpReq(this._method, relPath, body ?? null, this._reqHeaders).then(
        (r) => {
          if (this._aborted) return;
          this.status = r.status;
          this._respHeaders = r.headers ?? [];
          this.responseText = new TextDecoder().decode(r.bytes);
          if (this.responseType === "arraybuffer") {
            this.response = r.bytes.buffer;
          } else if (this.responseType === "blob") {
            this.response = new Blob([r.bytes]);
          } else if (this.responseType === "json") {
            try {
              this.response = JSON.parse(this.responseText);
            } catch {
              this.response = null;
            }
          } else {
            this.response = this.responseText;
          }
          this.readyState = 4;
          this.onreadystatechange?.();
          this.onload?.();
          this.onloadend?.();
          this.dispatchEvent(new Event("load"));
        },
        () => {
          if (this._aborted) return;
          this.onerror?.();
          this.dispatchEvent(new Event("error"));
        }
      );
    }
  }

  // --- EventSource wrapper -------------------------------------------------
  class TunnelEventSource extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readyState = 0;
    url: string;
    withCredentials = false;
    onopen: any = null;
    onmessage: any = null;
    onerror: any = null;
    constructor(url: string | URL) {
      super();
      this.url = String(url);
      // Minimal: just connect once, read full body, parse "data:" lines.
      (async () => {
        try {
          const relPath = normalizeToRelPath(this.url);
          const r = await httpReq("GET", relPath, null, [
            ["accept", "text/event-stream"],
          ]);
          this.readyState = 1;
          this.onopen?.(new Event("open"));
          const text = new TextDecoder().decode(r.bytes);
          for (const block of text.split(/\n\n/)) {
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .join("\n");
            if (data) {
              const ev = new MessageEvent("message", { data });
              this.onmessage?.(ev);
              this.dispatchEvent(ev);
            }
          }
          this.readyState = 2;
        } catch {
          this.onerror?.(new Event("error"));
        }
      })();
    }
    close() {
      this.readyState = 2;
    }
  }

  // --- URL helpers ---------------------------------------------------------
  //
  // The document loads from an opaque blob: URL with no real origin. When app
  // or SDK code resolves a relative path against location.href (e.g. the SDK's
  // `new URL("./actions", location.href)`), the result is an absolute blob:
  // URL under our own base directory — those are internal and must be tunneled.
  // But genuine object URLs the app/tunnel mint via URL.createObjectURL are
  // real resources and must pass straight through. We capture our base dir and
  // the live object-URL set to tell the two apart, so neither the Space nor the
  // SDK has to know it is running over a tunnel.
  const SELF_HREF = (() => {
    try {
      return globalThis.location?.href ?? "";
    } catch {
      return "";
    }
  })();
  const SELF_BASE_DIR = computeSelfBaseDir(SELF_HREF);
  // blob: URLs minted via URL.createObjectURL (populated by the override near
  // the bottom of this prelude). Real resources — never tunneled.
  const objectUrls = new Set<string>();

  // Thin wrappers binding the live SELF_*/objectUrls to the pure helpers in
  // ./tunnel-url (see that file's "Cases" header for the full classification).
  function isSelfOriginUrl(u: string): boolean {
    return isSelfOriginUrlImpl(u, SELF_BASE_DIR, SELF_HREF, objectUrls);
  }

  function isExternalUrl(u: string): boolean {
    return isExternalUrlImpl(u, SELF_BASE_DIR, SELF_HREF, objectUrls);
  }

  function normalizeToRelPath(u: string): string {
    return normalizeToRelPathImpl(u, SELF_BASE_DIR);
  }

  // --- setAttr / setStyle / CSS rewriting ---------------------------------
  const URL_ATTRS = new Set([
    "src",
    "srcset",
    "href",
    "poster",
    "action",
    "formaction",
    "data",
    "background",
    "cite",
    "longdesc",
    "usemap",
    "manifest",
  ]);

  const URL_STYLE_PROPS = new Set([
    "background",
    "backgroundImage",
    "background-image",
    "borderImage",
    "border-image",
    "borderImageSource",
    "border-image-source",
    "listStyle",
    "list-style",
    "listStyleImage",
    "list-style-image",
    "cursor",
    "mask",
    "maskImage",
    "mask-image",
    "webkitMask",
    "-webkit-mask",
    "webkitMaskImage",
    "-webkit-mask-image",
    "content",
    "src",
  ]);

  // Resolve a tunneled URL into a blob: URL.
  //
  // CACHE POLICY: bounded LRU + delayed revoke.
  //   - cache size capped at __BLOB_CACHE_MAX entries (per-path, fragment-stripped).
  //   - on eviction, the URL is queued for URL.revokeObjectURL() with a
  //     __BLOB_REVOKE_DELAY_MS grace period so any in-flight load (img.src
  //     assignment in progress, decoder consuming the bytes) can complete.
  //   - re-fetching the same path after eviction creates a fresh blob URL.
  //   - if a key is re-requested while its blob is pending revoke, the
  //     revoke is cancelled and the URL is reinstated at the MRU end.
  //
  // Why not infinite cache: long-lived apps that cycle through unique URLs
  // (image galleries, tile maps, virtualized lists of remote thumbs) would
  // accumulate Blob bytes indefinitely. We can't refcount because we don't
  // know when consumers (img/link/css rules) release a URL.
  //
  // Why not zero cache: typical dashboards re-resolve the same set of
  // assets dozens of times per session (icons, avatars, etc.); fetching
  // each time would 10–100× the message-channel traffic.
  //
  // 256 entries is an arbitrary middle ground; tunable per-app if needed.
  // Preserves the fragment (#…) so SVG <use href="sprite.svg#x"> works.
  const __BLOB_CACHE_MAX = 256;
  const __BLOB_REVOKE_DELAY_MS = 30_000;
  type BlobEntry = { url: Promise<string>; pendingRevoke?: ReturnType<typeof setTimeout> };
  const blobCache = new Map<string, BlobEntry>();
  const blobStats = {
    created: 0,
    revoked: 0,
    hits: 0,
    misses: 0,
    inFlightRevokes: 0,
  };

  function __evictIfOverCap() {
    while (blobCache.size > __BLOB_CACHE_MAX) {
      const oldestKey = blobCache.keys().next().value;
      if (oldestKey === undefined) break;
      const ent = blobCache.get(oldestKey)!;
      blobCache.delete(oldestKey);
      // Schedule the actual revoke after a grace period — img.src=blobUrl
      // may still be decoding, css rules may still be in use. After the
      // delay, the browser will have either (a) finished decoding (bytes
      // pinned in raster cache, URL safe to revoke) or (b) released the
      // reference. Either way, releasing the blob bytes is safe here.
      blobStats.inFlightRevokes++;
      const t = setTimeout(() => {
        ent.url
          .then((u) => {
            if (typeof u === "string" && u.startsWith("blob:")) {
              try {
                URL.revokeObjectURL(u);
                blobStats.revoked++;
              } catch {}
            }
          })
          .finally(() => {
            blobStats.inFlightRevokes--;
          });
      }, __BLOB_REVOKE_DELAY_MS);
      ent.pendingRevoke = t;
    }
  }

  function resolveToBlobUrl(rel: string): Promise<string> {
    if (isExternalUrl(rel)) return Promise.resolve(rel);
    const hashIdx = rel.indexOf("#");
    const pathPart = hashIdx >= 0 ? rel.slice(0, hashIdx) : rel;
    const frag = hashIdx >= 0 ? rel.slice(hashIdx) : "";
    const key = normalizeToRelPath(pathPart);

    let ent = blobCache.get(key);
    if (ent) {
      // Cancel any pending revoke — the URL is being reused.
      if (ent.pendingRevoke != null) {
        clearTimeout(ent.pendingRevoke);
        ent.pendingRevoke = undefined;
        blobStats.inFlightRevokes--;
      }
      // Refresh LRU position by re-inserting at the end.
      blobCache.delete(key);
      blobCache.set(key, ent);
      blobStats.hits++;
    } else {
      blobStats.misses++;
      const url = httpReq("GET", key, null).then((r) => {
        const ctHeader = r.headers.find(
          ([k]) => k.toLowerCase() === "content-type"
        );
        const ct = ctHeader?.[1] ?? "application/octet-stream";
        const blob = new Blob([r.bytes], { type: ct });
        blobStats.created++;
        return URL.createObjectURL(blob);
      });
      ent = { url };
      blobCache.set(key, ent);
      __evictIfOverCap();
    }
    return frag ? ent.url.then((b) => b + frag) : ent.url;
  }

  // The CSS-pass placeholder shape:
  //   url("data:image/gif;base64,R0lGODlhAQAB...#hatch=<urlEncodedRel>")
  // We always emit this in compiled CSS so the browser parses a valid
  // data: image and does not fire a network request before our observer
  // can swap in the real blob: URL.
  const HATCH_PIXEL_PREFIX = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  const HATCH_FRAG = "#hatch=";

  function isHatchPlaceholder(url: string): boolean {
    return url.indexOf(HATCH_PIXEL_PREFIX + HATCH_FRAG) === 0;
  }
  function unwrapHatchPlaceholder(url: string): string | null {
    if (!isHatchPlaceholder(url)) return null;
    return decodeURIComponent(url.slice((HATCH_PIXEL_PREFIX + HATCH_FRAG).length));
  }

  // Parse a CSS text fragment for url(...) tokens, replacing each tunneled
  // url with a blob: url asynchronously. Returns a Promise<string>.
  async function rewriteCssTextAsync(text: string): Promise<string> {
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    const tasks: Array<{ match: string; index: number; url: string }> = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      tasks.push({ match: m[0], index: m.index, url: m[2].trim() });
    }
    if (tasks.length === 0) return text;
    // Resolve each
    const resolved = await Promise.all(
      tasks.map(async (t) => {
        // Already a blob: or external — leave alone.
        if (t.url.startsWith("blob:")) return t.url;
        // Build-time hatch placeholder — extract real path.
        const unwrapped = unwrapHatchPlaceholder(t.url);
        if (unwrapped != null) {
          try {
            return await resolveToBlobUrl(unwrapped);
          } catch {
            return t.url;
          }
        }
        if (isExternalUrl(t.url)) return t.url;
        try {
          return await resolveToBlobUrl(t.url);
        } catch {
          return t.url;
        }
      })
    );
    // Rebuild
    let out = "";
    let last = 0;
    tasks.forEach((t, i) => {
      out += text.slice(last, t.index);
      out += `url("${resolved[i]}")`;
      last = t.index + t.match.length;
    });
    out += text.slice(last);
    return out;
  }

  // Synchronous-ish: schedule the rewrite, return a Promise of result;
  // caller assigns when ready. Used by setStyleText etc.
  function rewriteCssText(text: string): Promise<string> {
    return rewriteCssTextAsync(text);
  }

  const mediaSourceLoads = new WeakMap<Element, "pending" | "settled">();

  // A tunneled SOURCE has no native src while its bytes are loading. The
  // browser reports that temporary absence as an error, including to React's
  // delegated media handlers. Keep this loader-owned event internal; once a
  // URL or a tunnel failure arrives, authored error handlers run normally.
  window.addEventListener("error", (event) => {
    const source = event.target;
    if (
      !event.isTrusted ||
      !(source instanceof HTMLSourceElement) ||
      !(source.parentElement instanceof HTMLMediaElement) ||
      source.hasAttribute("src")
    ) return;
    const state = mediaSourceLoads.get(source);
    if (
      state === "pending" ||
      (state === undefined && source.hasAttribute("data-hatch-src"))
    ) {
      event.stopImmediatePropagation();
    }
  }, true);

  // Method names alone do not identify DOM calls: Three.js geometries also
  // implement setAttribute. Preserve their arguments and fluent return value.
  function isElement(el: any): el is Element {
    if (el instanceof Element) return true;
    // Same-origin child frames have their own Element constructor.
    const ownerWindow = el?.ownerDocument?.defaultView;
    return ownerWindow != null && el instanceof ownerWindow.Element;
  }

  function setAttr(el: any, name: any, value: any, ...rest: any[]) {
    if (!isElement(el)) {
      return el.setAttribute(name, value, ...rest);
    }
    name = String(name);
    if (value == null) {
      if (name.toLowerCase() === "src" && el instanceof HTMLSourceElement) {
        mediaSourceLoads.set(el, "settled");
      }
      try {
        (el as Element).removeAttribute(name);
      } catch {}
      return;
    }
    const v = String(value);
    const lcName = name.toLowerCase();
    // Navigation hrefs stay intact. Download activation uses the tunnel below.
    const tag = (el as Element).tagName?.toUpperCase();
    if ((tag === "A" || tag === "BASE" || tag === "AREA") && lcName === "href") {
      el.setAttribute(name, v);
      return;
    }
    // Non-URL-bearing attribute — fast pass-through.
    if (!URL_ATTRS.has(lcName) && lcName !== "style" && lcName !== "srcset") {
      el.setAttribute(name, v);
      return;
    }
    if (lcName === "srcset") {
      // srcset is "url1 1x, url2 2x, ..." — split, resolve, rejoin.
      const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
      Promise.all(
        parts.map(async (p) => {
          const segs = p.split(/\s+/);
          const url = segs[0];
          const rest = segs.slice(1).join(" ");
          if (isExternalUrl(url)) return p;
          const resolved = await resolveToBlobUrl(url);
          return rest ? `${resolved} ${rest}` : resolved;
        })
      ).then((rebuilt) => {
        try {
          el.setAttribute("srcset", rebuilt.join(", "));
        } catch {}
      });
      return;
    }
    if (URL_ATTRS.has(lcName)) {
      const isMediaSource = tag === "SOURCE" && lcName === "src";
      if (isExternalUrl(v)) {
        if (isMediaSource) mediaSourceLoads.set(el, "settled");
        el.setAttribute(name, v);
        return;
      }
      if (isMediaSource) mediaSourceLoads.set(el, "pending");
      // Only image resources can use an image placeholder. Assigning it to
      // an audio/video source emits a media error before its asset arrives.
      if (tag === "IMG" || (tag === "VIDEO" && lcName === "poster")) {
        el.setAttribute(name, TRANSPARENT_PIXEL);
      }
      // For media sources and LINK/SCRIPT/IFRAME, leave the attribute UNSET
      // until the tunnel resolves — assigning a placeholder URL like
      // about:blank produces noisy "wrong MIME type" / scheme errors. The
      // brief flash of "no stylesheet" is acceptable before the tunnel resolves.
      resolveToBlobUrl(v).then(
        (blobUrl) => {
          if (isMediaSource) mediaSourceLoads.set(el, "settled");
          try {
            el.setAttribute(name, blobUrl);
            // Media selection may have exhausted an unresolved <source>.
            // Reinsert the ready candidate in its original position so native
            // selection resumes without load() aborting pending play promises.
            if (isMediaSource) {
              const media = el.parentElement;
              if (
                media instanceof HTMLMediaElement &&
                media.networkState === HTMLMediaElement.NETWORK_NO_SOURCE
              ) {
                const nextSibling = el.nextSibling;
                el.remove();
                media.insertBefore(el, nextSibling);
              }
            }
          } catch {}
        },
        () => {
          if (isMediaSource) {
            mediaSourceLoads.set(el, "settled");
            el.dispatchEvent(new Event("error"));
          }
        }
      );
      return;
    }
    if (lcName === "style") {
      setStyleAttr(el, v);
      return;
    }
    // Default: plain setAttribute.
    el.setAttribute(name, v);
  }

  function setAttrNS(el: any, ns: any, name: any, value: any, ...rest: any[]) {
    if (!isElement(el)) {
      return el.setAttributeNS(ns, name, value, ...rest);
    }
    name = String(name);
    if (value == null) {
      try {
        el.removeAttributeNS(ns ?? null, name);
      } catch {}
      return;
    }
    const v = String(value);
    const lcName = name.split(":").pop()!.toLowerCase();
    if (lcName === "href" && URL_ATTRS.has("href")) {
      // SVG xlink:href / href
      if (isExternalUrl(v)) {
        el.setAttributeNS(ns ?? null, name, v);
        return;
      }
      resolveToBlobUrl(v).then(
        (blobUrl) => {
          try {
            el.setAttributeNS(ns ?? null, name, blobUrl);
          } catch {}
        },
        () => {}
      );
      return;
    }
    try {
      el.setAttributeNS(ns ?? null, name, v);
    } catch {}
  }

  // Property writes are distinct from calls, even on objects that happen to
  // expose setAttribute. Keep the original property spelling and assignment
  // result; only DOM receivers use attribute URL rewriting.
  function setUrlProp(el: any, name: string, value: any) {
    if (isElement(el)) {
      setAttr(el, name.toLowerCase(), value);
    } else {
      el[name] = value;
    }
    return value;
  }

  // 1×1 transparent PNG for image placeholders that won't fire a network
  // request.
  const TRANSPARENT_PIXEL =
    "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

  // HTML rewriter: find <img|video|audio|source|script|link|iframe|...> with
  // src/href/srcset/poster attributes, swap them to data-hatch-* for the
  // sandbox runtime to resolve. <a href> is left alone.
  const HTML_TAG_ATTRS: Record<string, string[]> = {
    img: ["src", "srcset", "poster"],
    image: ["href"],
    video: ["src", "poster"],
    audio: ["src"],
    source: ["src", "srcset"],
    script: ["src"],
    link: ["href"],
    iframe: ["src"],
    embed: ["src"],
    object: ["data"],
    track: ["src"],
    input: ["src"],
    form: ["action"],
    button: ["formaction"],
    use: ["href"],
  };

  function rewriteHtmlString(html: string): string {
    return html.replace(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (m, tag, attrs) => {
      const lc = String(tag).toLowerCase();
      const candidates = HTML_TAG_ATTRS[lc];
      if (!candidates) return m;
      let out = attrs as string;
      for (const a of candidates) {
        const re = new RegExp(`\\b${a}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
        const matched = out.match(re);
        if (!matched) continue;
        const value = matched[2] ?? matched[3] ?? matched[4] ?? "";
        if (isExternalUrl(value)) continue;
        // swap to data-hatch-<attr>
        out = out.replace(re, `data-hatch-${a}="${value.replace(/"/g, "&quot;")}"`);
      }
      // Also handle inline style="..." that contains url(...)
      const styleRe = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i;
      const sm = out.match(styleRe);
      if (sm) {
        const value = sm[2] ?? sm[3] ?? "";
        if (value.includes("url(")) {
          out = out.replace(styleRe, `data-hatch-style="${value.replace(/"/g, "&quot;")}"`);
        }
      }
      return `<${tag}${out}>`;
    });
  }

  // The set of element-attribute pairs that the browser would fetch when
  // parsing HTML.  These are the attrs we MUST strip / re-route before any
  // resulting node enters the live DOM.  (<a href> deliberately omitted —
  // anchor href is metadata, not a fetch.)
  const HTML_URL_ATTRS_BY_TAG: Record<string, string[]> = {
    IMG: ["src", "srcset", "poster"],
    IMAGE: ["href"], // SVG <image>
    VIDEO: ["src", "poster"],
    AUDIO: ["src"],
    SOURCE: ["src", "srcset"],
    SCRIPT: ["src"],
    LINK: ["href"],
    IFRAME: ["src"],
    EMBED: ["src"],
    OBJECT: ["data"],
    TRACK: ["src"],
    INPUT: ["src"],
    FORM: ["action"],
    BUTTON: ["formaction"],
    USE: ["href", "xlink:href"],
  };

  // Walk a node tree (in an inert document) and swap URL-bearing attrs to
  // data-hatch-*. Inline style="..." with url(...) is moved to data-hatch-style.
  // Anchor href is left alone.
  function rewriteSubtreeForTunnel(root: Node) {
    if (!root) return;
    const walker = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
    let n: Node | null = walker.currentNode;
    // currentNode starts at root; if root is itself an element, process it too.
    if (root.nodeType === 1) processOne(root as Element);
    while ((n = walker.nextNode())) {
      processOne(n as Element);
    }
  }
  function processOne(el: Element) {
    const tag = (el.tagName ?? "").toUpperCase();
    const attrs = HTML_URL_ATTRS_BY_TAG[tag];
    if (attrs) {
      for (const a of attrs) {
        const v = el.getAttribute(a);
        if (v == null) continue;
        if (isExternalUrl(v)) continue;
        el.setAttribute("data-hatch-" + a, v);
        el.removeAttribute(a);
      }
    }
    // Inline style with url(...)
    const style = el.getAttribute("style");
    if (style && style.includes("url(")) {
      el.setAttribute("data-hatch-style", style);
      el.removeAttribute("style");
    }
  }

  // <template> parses HTML into an inert document (template.content is a
  // DocumentFragment that doesn't trigger resource loads or script execution
  // for elements inside it). We parse there, rewrite URL attrs to
  // data-hatch-*, then transplant the cleaned nodes into the live DOM.
  function parseAndCleanHtml(html: string): DocumentFragment {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    rewriteSubtreeForTunnel(tpl.content);
    return tpl.content;
  }

  function setInnerHTML(el: Element, html: any, which: string = "innerHTML") {
    const s = html == null ? "" : String(html);
    // <template>.innerHTML is INERT — parsing into a template never triggers
    // resource loads (the spec says so). Template-DSL libraries (lit-html,
    // hyperHTML, htm, …) generate marker attributes inside the template HTML
    // and then walk the parsed content to find the bindings; if we strip /
    // rewrite their attributes we break the binding map. Also, assigning to
    // `template.firstChild = ...` doesn't work the way one expects because
    // a <template>'s parsed children live on `.content`, not as direct
    // children. Skip our rewrite path for templates and assign natively.
    if (
      which === "innerHTML" &&
      typeof (el as any).tagName === "string" &&
      (el as any).tagName.toUpperCase() === "TEMPLATE"
    ) {
      try {
        (el as any).innerHTML = s;
      } catch {}
      return;
    }
    if (which === "outerHTML") {
      // outerHTML replaces the element itself; transplanting nodes won't
      // work the same way. Parse, then serialize back through the cleaned
      // template (so any URL-bearing attrs in the wrapper element are also
      // safe), then assign outerHTML.
      const frag = parseAndCleanHtml(s);
      const wrap = document.createElement("div");
      wrap.appendChild(frag);
      try {
        (el as any).outerHTML = wrap.innerHTML;
      } catch {}
      // After outerHTML reassignment we don't have a handle to the new
      // element; resolve placeholders over the whole document.
      queueMicrotask(() => processDataHatchAttrs(document.body));
      return;
    }
    // innerHTML: parse offline, clean, transplant.
    const frag = parseAndCleanHtml(s);
    try {
      // Clear existing children, then move the cleaned fragment in.
      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(frag);
    } catch {}
    // Resolve data-hatch-* placeholders to blob: URLs through the tunnel.
    queueMicrotask(() => processDataHatchAttrs(el));
  }

  function insertAdjacentHTMLT(
    el: Element,
    position: InsertPosition,
    html: any
  ) {
    const s = html == null ? "" : String(html);
    const frag = parseAndCleanHtml(s);
    // insertAdjacentHTML takes a string, but we have a fragment — use the
    // closest equivalent: a temporary span/range insertion. We
    // serialize the (already-cleaned) fragment back and use
    // the native API.
    const wrap = document.createElement("template");
    wrap.content.appendChild(frag);
    try {
      el.insertAdjacentHTML(position, wrap.innerHTML);
    } catch {}
    queueMicrotask(() => processDataHatchAttrs(document.body));
  }

  function processDataHatchAttrs(root: Element | Document) {
    const SELECTORS =
      "[data-hatch-src], [data-hatch-href], [data-hatch-srcset], [data-hatch-poster], [data-hatch-action], [data-hatch-data], [data-hatch-style]";
    root.querySelectorAll(SELECTORS).forEach((el) => {
      const attrs = el.getAttributeNames();
      for (const a of attrs) {
        if (!a.startsWith("data-hatch-")) continue;
        const real = a.slice("data-hatch-".length);
        const value = el.getAttribute(a) ?? "";
        el.removeAttribute(a);
        if (real === "style") setStyleAttr(el, value);
        else setAttr(el, real, value);
      }
    });
  }

  // Style Proxy: returned by getStyle(el). Traps set, forwards reads.
  //
  // CAUTION: the AST rewrites EVERY read of `.style`, not just on DOM
  // elements. Libraries like ProseMirror/TipTap use objects where `style` is
  // a plain string (e.g. `{ type: "image", style: "bold" }`). We must NOT
  // try to wrap non-objects in a Proxy (throws "Cannot create proxy with a
  // non-object as target"), and we must NOT try to put primitives in a
  // WeakMap (throws "Invalid value used as weak map key"). Pass through
  // anything that isn't a real CSSStyleDeclaration-shaped object.
  const styleProxyCache = new WeakMap<object, any>();
  function getStyle(el: any): any {
    if (el == null) return el;
    let real: any;
    try {
      real = el.style;
    } catch {
      return undefined;
    }
    // Non-object style → not a DOM element (some lib using `style` as a
    // plain property name). Return raw — the caller's code path already
    // treated it as a plain value before our rewrite.
    if (real == null || (typeof real !== "object" && typeof real !== "function")) {
      return real;
    }
    let proxy = styleProxyCache.get(real);
    if (proxy) return proxy;
    proxy = new Proxy(real, {
      get(target, prop, _receiver) {
        const v = Reflect.get(target, prop, target);
        if (typeof v === "function") return v.bind(target);
        return v;
      },
      set(target, prop, value) {
        if (typeof prop === "string") {
          setStyle(el, prop, value);
          return true;
        }
        return Reflect.set(target, prop, value, target);
      },
    });
    styleProxyCache.set(real, proxy);
    return proxy;
  }

  function setStyle(el: HTMLElement, propName: string, value: any) {
    const v = value == null ? "" : String(value);
    if (propName.startsWith("--")) {
      // Custom property — value may contain url()
      rewriteCssText(v).then((rewritten) => {
        try {
          el.style.setProperty(propName, rewritten);
        } catch {}
      });
      return;
    }
    if (URL_STYLE_PROPS.has(propName) && v.includes("url(")) {
      rewriteCssText(v).then((rewritten) => {
        try {
          (el.style as any)[propName] = rewritten;
        } catch {}
      });
      return;
    }
    try {
      (el.style as any)[propName] = v;
    } catch {}
  }

  function setStyleAttr(el: Element, attrValue: string) {
    if (!attrValue.includes("url(")) {
      el.setAttribute("style", attrValue);
      return;
    }
    rewriteCssText(attrValue).then((rewritten) => {
      try {
        el.setAttribute("style", rewritten);
      } catch {}
    });
  }

  function setStyleText(styleEl: any, text: string) {
    if (!(styleEl instanceof HTMLStyleElement)) {
      try {
        styleEl.textContent = text;
      } catch {}
      return;
    }
    if (!text.includes("url(")) {
      styleEl.textContent = text;
      return;
    }
    rewriteCssText(text).then((rewritten) => {
      try {
        styleEl.textContent = rewritten;
      } catch {}
    });
  }

  function tunnelImage(_w?: number, _h?: number): HTMLImageElement {
    const img = new (originalImage as any)();
    const desc = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "src"
    );
    if (desc?.set) {
      const origSet = desc.set;
      const origGet = desc.get!;
      Object.defineProperty(img, "src", {
        configurable: true,
        get() {
          return origGet.call(img);
        },
        set(v: any) {
          if (v == null) return origSet.call(img, "");
          const s = String(v);
          if (isExternalUrl(s)) return origSet.call(img, s);
          resolveToBlobUrl(s).then(
            (b) => origSet.call(img, b),
            () => origSet.call(img, s)
          );
        },
      });
    }
    return img;
  }

  function tunnelSendBeacon(url: string, data?: any) {
    // Fire-and-forget
    tunnelFetch(url, { method: "POST", body: data, keepalive: true } as any).catch(
      () => {}
    );
    return true;
  }

  function tunnelWorker(_url: any): never {
    throw new Error(
      "[__tunnel] new Worker() is not supported in Muse web artifacts."
    );
  }

  function tunnelImport(spec: any): Promise<any> {
    throw new Error(
      "[__tunnel] dynamic import() of '" +
        String(spec) +
        "' is not supported in Muse web artifacts."
    );
  }

  // --- CSS observer: catches late-added stylesheets ------------------------
  function installCssObserver() {
    // Patch CSSStyleSheet methods.
    try {
      const proto: any = (window as any).CSSStyleSheet?.prototype;
      if (proto) {
        const origInsertRule = proto.insertRule;
        proto.insertRule = function (rule: string, index?: number) {
          if (typeof rule === "string" && rule.includes("url(")) {
            // We need a sync rewrite at the call site; since we have no
            // sync way, insert a placeholder and async-replace.
            const idx = origInsertRule.call(this, rule, index);
            rewriteCssText(rule).then((rewritten) => {
              if (rewritten !== rule) {
                try {
                  // Delete and re-insert at same index
                  this.deleteRule(idx);
                  origInsertRule.call(this, rewritten, idx);
                } catch {}
              }
            });
            return idx;
          }
          return origInsertRule.call(this, rule, index);
        };
        const origReplace = proto.replace;
        if (origReplace) {
          proto.replace = function (text: string) {
            if (typeof text === "string" && text.includes("url(")) {
              return rewriteCssText(text).then((rewritten) =>
                origReplace.call(this, rewritten)
              );
            }
            return origReplace.call(this, text);
          };
        }
        const origReplaceSync = proto.replaceSync;
        if (origReplaceSync) {
          proto.replaceSync = function (text: string) {
            if (typeof text === "string" && text.includes("url(")) {
              // sync caller; do sync placeholder + async patch
              const ret = origReplaceSync.call(this, text);
              rewriteCssText(text).then((rewritten) => {
                try {
                  origReplaceSync.call(this, rewritten);
                } catch {}
              });
              return ret;
            }
            return origReplaceSync.call(this, text);
          };
        }
      }
    } catch (e) {
      // ignore
    }

    // Boot-time sweep of existing stylesheets for __hatch_asset: placeholders.
    function sweepSheet(sheet: CSSStyleSheet) {
      try {
        const rules = sheet.cssRules;
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i];
          const txt = (rule as any).cssText as string | undefined;
          if (txt && (txt.includes(HATCH_FRAG) || (txt.includes("url(") && !/url\(\s*["']?(blob:|https?:|data:image\/gif;base64,R0)/.test(txt)))) {
            rewriteCssText(txt).then((rewritten) => {
              if (rewritten !== txt) {
                try {
                  sheet.deleteRule(i);
                  sheet.insertRule(rewritten, i);
                } catch {}
              }
            });
          }
        }
      } catch {
        // cross-origin / opaque sheet, skip
      }
    }

    function sweepAll() {
      for (const sheet of Array.from(document.styleSheets)) {
        sweepSheet(sheet as CSSStyleSheet);
      }
    }

    // MutationObserver on <style> additions
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (node instanceof HTMLStyleElement) {
            const txt = node.textContent ?? "";
            if (txt.includes("url(")) {
              rewriteCssText(txt).then((rewritten) => {
                if (rewritten !== txt) {
                  try {
                    node.textContent = rewritten;
                  } catch {}
                }
              });
            }
          } else if (node instanceof HTMLLinkElement && node.rel === "stylesheet") {
            // The link's href was already routed through setAttr to a blob;
            // but if not, the load will fail. Try a sweep after load.
            node.addEventListener("load", () => sweepSheet(node.sheet!), { once: true });
          }
        }
      }
    });
    mo.observe(document, { subtree: true, childList: true });

    // Initial sweep, deferred so document.styleSheets is populated.
    Promise.resolve().then(sweepAll);
    setTimeout(sweepAll, 0);
    setTimeout(sweepAll, 50);
    setTimeout(sweepAll, 250);
  }

  // --- Bootstrap: handle inline <img>/<link> with data-hatch-src --------
  function rewriteAuthoredHtml() {
    // Elements with data-hatch-src / data-hatch-href as belt-and-suspenders.
    const SELECTORS = "[data-hatch-src], [data-hatch-href], [data-hatch-srcset]";
    document.querySelectorAll(SELECTORS).forEach((el) => {
      const src = el.getAttribute("data-hatch-src");
      const href = el.getAttribute("data-hatch-href");
      const srcset = el.getAttribute("data-hatch-srcset");
      if (src) setAttr(el, "src", src);
      if (href) setAttr(el, "href", href);
      if (srcset) setAttr(el, "srcset", srcset);
    });
  }

  // Once per document: a router pushes on every navigation, and a warning per
  // click would bury the console the artifact's own errors land in.
  let historyUrlWarned = false;
  function warnHistoryUrlDropped(method: string, url: unknown): void {
    // No url is the legal, already-working call — say nothing.
    if (url === undefined || url === null) return;
    if (historyUrlWarned) return;
    historyUrlWarned = true;
    try {
      console.warn(
        "[__tunnel] history." +
          method +
          "() was called with a URL; the URL was ignored. A Muse web artifact " +
          "renders in an opaque origin with no navigable URL of its own, so " +
          "the browser rejects any URL change. State kept in the URL will not " +
          "persist or survive a reload — keep it in component state, or in " +
          "the artifact's database through a server action.",
      );
    } catch {}
  }

  // --- Save original references --------------------------------------------
  const originalFetch = (globalThis as any).fetch?.bind(globalThis) ?? (() => {
    throw new Error("no native fetch");
  });
  const originalXHR = (globalThis as any).XMLHttpRequest;
  const originalImage = (globalThis as any).Image;

  // --- The exposed __tunnel object ----------------------------------------
  const tunnel = {
    fetch: tunnelFetch,
    XHR: TunnelXHR,
    WebSocket: TunnelWebSocket,
    EventSource: TunnelEventSource,
    Image: tunnelImage,
    Worker: tunnelWorker,
    import: tunnelImport,
    sendBeacon: tunnelSendBeacon,
    setAttr,
    setAttrNS,
    setUrlProp,
    setStyle,
    getStyle,
    setStyleAttr,
    setStyleText,
    setInnerHTML,
    insertAdjacentHTML: insertAdjacentHTMLT,
    rewriteCssText,
    resolveToBlobUrl,
    processDataHatchAttrs,
    rewriteHtmlString,
    // Passthrough hooks for JSX-prop AST wraps (not currently used by the
    // rewriter — kept for experimentation / future tightening).
    _resolveUrlString: (v: any) => v,
    _resolveCssValue: (v: any) => v,
    _resolveCssText: (v: any) => v,
    _resolveStyleProp: (v: any) => v,
    // Shim for `import.meta` in the inlined bundle (the AST rewrites
    // `import.meta` → `__tunnel._importMeta`). Bundlers resolve imported asset
    // URLs as `new URL("./asset", import.meta.url)`; assets are served under
    // the space's `assets/` dir, so `.url` is a self-origin URL inside assets/
    // — the URL override resolves "./asset" against it to a self URL the tunnel
    // maps to "assets/asset".
    _importMeta: {
      get url(): string {
        return importMetaUrl(SELF_HREF, SELF_BASE_DIR);
      },
    },
    _state: {
      get port() {
        return port;
      },
      get inFlight() {
        return pending.size;
      },
      get blobCacheSize() {
        return blobCache.size;
      },
      get blobStats() {
        return { ...blobStats };
      },
    },
  };
  (globalThis as any).__tunnel = tunnel;
  (window as any).__tunnel = tunnel;

  // --- Transparent global interception -------------------------------------
  // The Space and the SDK never reference `__tunnel`; they call the ordinary
  // web platform APIs. The build-time AST rewrite covers direct call sites and
  // DOM/CSS mutations, but code that captures a global into a local (e.g. the
  // SDK's `const fetchImpl = globalThis.fetch`) or aliases a constructor would
  // otherwise slip past and hit the (unreachable) opaque origin directly.
  // Overriding the globals here closes that gap, so every network egress is
  // tunneled with zero CVM-awareness in user or SDK code.
  try {
    (globalThis as any).fetch = tunnelFetch;
    (window as any).fetch = tunnelFetch;
    (globalThis as any).XMLHttpRequest = TunnelXHR;
    (window as any).XMLHttpRequest = TunnelXHR;
    (globalThis as any).WebSocket = TunnelWebSocket;
    (window as any).WebSocket = TunnelWebSocket;
    (globalThis as any).EventSource = TunnelEventSource;
    (window as any).EventSource = TunnelEventSource;
    const nav = (globalThis as any).navigator;
    if (nav && typeof nav.sendBeacon === "function") {
      nav.sendBeacon = (url: string, data?: any) => tunnelSendBeacon(url, data);
    }

    // URL constructor: the document loads from a `blob:` URL whose path is
    // OPAQUE, so the platform `new URL(relative, location.href)` THROWS
    // ("Invalid URL") rather than resolving — e.g. the SDK's
    // `new URL("./actions", location.href)` to build the action endpoint.
    // We wrap the constructor so a relative reference resolved against our own
    // blob: origin (the one base native resolution chokes on) is resolved
    // against the blob's inner http(s) origin and re-stamped `blob:`, landing
    // under SELF_BASE_DIR where isSelfOriginUrl()/normalizeToRelPath() tunnel
    // it. Every other (url, base) pair keeps native semantics. This closes the
    // same gap as the fetch/XHR overrides for code that calls `new URL(...)`
    // directly, with zero CVM-awareness in user or SDK code.
    const NativeURL = (globalThis as any).URL;
    const TunnelURL = function (this: any, url?: any, base?: any): any {
      return resolveTunnelUrl(url, base, SELF_HREF, NativeURL);
    } as any;
    TunnelURL.prototype = NativeURL.prototype;
    // Carry over statics (createObjectURL/revokeObjectURL/canParse/parse). The
    // object-URL tracking block below re-wraps createObjectURL on TunnelURL.
    for (const k of Object.getOwnPropertyNames(NativeURL)) {
      if (k === "prototype" || k === "length" || k === "name") continue;
      try {
        TunnelURL[k] = NativeURL[k];
      } catch {}
    }
    (globalThis as any).URL = TunnelURL;
    (window as any).URL = TunnelURL;
  } catch {
    // Read-only platform binding in some embeddings; AST-rewritten call sites
    // still route through __tunnel.
  }

  // --- History: neutralize the url argument --------------------------------
  //
  // This document is a blob in an opaque origin, so the platform THROWS on any
  // pushState/replaceState carrying a url: "A history state object with URL ''
  // cannot be created in a document with origin 'null'". Routers call it during
  // first render, so one such call blanks the whole artifact.
  //
  // Keep the STATE half (what popstate consumers read), drop the url half,
  // which has nowhere to land here. A crash becomes a no-op; an artifact that
  // genuinely round-trips state through the URL degrades to not persisting it.
  //
  // A runtime override, not a build-time rewrite, so it also covers call sites
  // that captured the method into a local — as the fetch/XHR overrides above
  // do. Its own try/catch so a read-only History cannot cost us those.
  try {
    const hist = (globalThis as any).history;
    // Check BOTH before binding EITHER: on a History with only pushState, the
    // replaceState bind throws, the outer catch swallows it, and NEITHER
    // override installs — reinstating the very crash this prevents.
    if (
      hist &&
      typeof hist.pushState === "function" &&
      typeof hist.replaceState === "function"
    ) {
      const nativePushState = hist.pushState.bind(hist);
      const nativeReplaceState = hist.replaceState.bind(hist);
      hist.pushState = function (state: any, title?: any, url?: any): void {
        warnHistoryUrlDropped("pushState", url);
        return nativePushState(state, title ?? "");
      };
      hist.replaceState = function (state: any, title?: any, url?: any): void {
        warnHistoryUrlDropped("replaceState", url);
        return nativeReplaceState(state, title ?? "");
      };
    }
  } catch {
    // Read-only History binding in some embeddings. Nothing else to do: the
    // platform call would throw anyway, and it already did before this shim.
  }

  // Track object URLs minted by the app or the tunnel so a genuine `blob:`
  // resource (passed straight to <img src>/fetch) passes through, while a path
  // the app resolved against our opaque base (also a `blob:` string) is
  // recognized as internal and tunneled. See isSelfOriginUrl above.
  try {
    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = function (obj: Blob | MediaSource): string {
      const created = nativeCreateObjectURL(obj as any);
      try {
        objectUrls.add(created);
      } catch {}
      return created;
    };
    URL.revokeObjectURL = function (objectUrl: string): void {
      try {
        objectUrls.delete(objectUrl);
      } catch {}
      nativeRevokeObjectURL(objectUrl);
    };
  } catch {}

  // --- Wire up postMessage handshake --------------------------------------
  // A stable per-document id so the parent transfers exactly ONE port per
  // bundle load. We re-announce until the port arrives (the parent's listener
  // mounts around the same time and a single announce can race ahead of it);
  // tagging every repeat with the same epoch lets the parent ignore the
  // repeats instead of closing+recreating the channel under our in-flight
  // requests. A genuine reload mints a new epoch, so the parent re-establishes.
  const announceEpoch =
    Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
  let announceTimer: ReturnType<typeof setInterval> | null = null;

  function announce() {
    try {
      window.parent.postMessage(
        { type: "bundle:ready", epoch: announceEpoch },
        "*",
      );
    } catch {}
  }

  function startAnnouncing() {
    announce();
    announceTimer = setInterval(() => {
      if (port != null) {
        if (announceTimer != null) clearInterval(announceTimer);
        announceTimer = null;
        return;
      }
      announce();
    }, 120);
  }

  function onParentMessage(ev: MessageEvent) {
    const data = ev.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "bundle:init-port" && ev.ports && ev.ports[0]) {
      // Keep the first port; a duplicate (from our retry announces) must not
      // replace a live channel and strand in-flight requests.
      if (port != null) return;
      if (announceTimer != null) {
        clearInterval(announceTimer);
        announceTimer = null;
      }
      port = ev.ports[0];
      port.onmessage = (pe: MessageEvent) => {
        const msg = pe.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "http.res") {
          const ent = pending.get(msg.id);
          if (ent) {
            pending.delete(msg.id);
            ent.resolve(msg);
          }
        } else if (
          msg.type === "ws.opened" ||
          msg.type === "ws.message" ||
          msg.type === "ws.closed" ||
          msg.type === "ws.error"
        ) {
          openWs.get(msg.id)?._handle(msg);
        }
      };
      port.start?.();
      portReadyResolve?.(port);
      // After port ready, perform CSS observer sweeps + authored-HTML rewrites.
      installCssObserver();
      rewriteAuthoredHtml();
      // Status ping back to host (optional)
      try {
        window.parent.postMessage({ type: "bundle:port-attached" }, "*");
      } catch {}
    }
  }

  window.addEventListener("message", onParentMessage);
  installDownloadLinks(tunnelFetch, isExternalUrl, __BLOB_REVOKE_DELAY_MS);

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    startAnnouncing();
  } else {
    document.addEventListener("DOMContentLoaded", startAnnouncing);
  }
})();

export {};
