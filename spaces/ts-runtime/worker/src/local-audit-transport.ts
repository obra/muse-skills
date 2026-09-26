import type { Route } from "playwright";

const MAX_CAPTURE_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_REQUEST_BYTES = 1024 * 1024;

/** Fulfill only the already-admitted audit URL through the runtime-cell UDS.
 * No browser credential or page-authored identity header crosses this boundary.
 * Responses are buffered for screenshot capture, including finite action streams.
 */
export async function fulfillLocalAuditRequest(
  route: Route,
  socket: string,
  url: string,
  auditSessionId: string | null,
  signal: AbortSignal,
  onTransportFailure?: () => void,
): Promise<void> {
  const request = route.request();
  try {
    const path = new URL(url).pathname;
    const relative = path.match(
      /^\/spaces\/v2\/hatch-audit-[a-f0-9-]+\/(.*)$/,
    )?.[1];
    const method = request.method();
    const read =
      method === "GET" &&
      relative !== undefined &&
      (relative === "" ||
        relative === "icon.jpg" ||
        relative === "icon.png" ||
        relative.startsWith("assets/") ||
        relative.startsWith("blobs/"));
    const action =
      method === "POST" &&
      (relative === "actions" || relative === "actions_stream");
    const body = request.postDataBuffer();
    if (
      auditSessionId === null ||
      (!read && !action) ||
      (body !== null && body.byteLength > MAX_CAPTURE_REQUEST_BYTES)
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    const headers = new Headers({ "x-hatch-audit-session": auditSessionId });
    for (const name of ["accept", "content-type", "range"]) {
      const value = request.headers()[name];
      if (value !== undefined) headers.set(name, value);
    }
    // Chromium retains an HTTPS origin (including secure-context APIs), while
    // the already-local Unix socket speaks plain HTTP.
    const localUrl = new URL(url);
    localUrl.protocol = "http:";
    const response = await fetch(localUrl, {
      unix: socket,
      method,
      headers,
      body,
      redirect: "manual",
      signal,
    }).catch((error) => {
      if (!signal.aborted) onTransportFailure?.();
      throw error;
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read().catch((error) => {
            if (!signal.aborted) onTransportFailure?.();
            throw error;
          });
          if (done) break;
          size += value.byteLength;
          if (size > MAX_CAPTURE_RESPONSE_BYTES) {
            throw new Error("Artifact capture response exceeds the size limit");
          }
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
    }
    // Bun decodes the response body; Chromium must not decode it a second time.
    const responseHeaders = Object.fromEntries(response.headers.entries());
    for (const name of [
      "content-encoding",
      "content-length",
      "transfer-encoding",
    ]) {
      delete responseHeaders[name];
    }
    await route.fulfill({
      status: response.status,
      headers: responseHeaders,
      body: Buffer.concat(chunks),
    });
  } catch {
    // A UDS failure must never fall through to direct network ingress.
    await route.abort("failed").catch(() => {});
  }
}
