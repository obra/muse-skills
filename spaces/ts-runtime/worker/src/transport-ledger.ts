// Transport-level connection ledger for the web-artifact audit: a minimal
// loopback SOCKS5 proxy Chromium is pointed at, chained to the existing
// Sentinel egress path (the proxy-auth relay, or the forward proxy directly).
//
// Why it exists: the in-browser capture (page.route) sees full request
// content but only for traffic that flows through Chromium's fetch stack of
// the pages Playwright attached to. Popups, WebSocket frames, and any
// non-fetch channel escape it. The transport ledger is the complement: every
// TCP connection the browser PROCESS makes must traverse this hop, so the
// ledger is complete at host:port granularity even when the content layer is
// blind. The audit cross-checks the two: a transport connection with no
// matching captured request is itself a finding (an unobserved channel), and
// a hostile page that floods the content capture's entry cap only makes its
// extra hosts show up here as unexplained.
//
// Scope and posture:
// - CONNECT only. BIND and UDP ASSOCIATE are refused (and counted): with
//   Chromium's WebRTC policy forced to proxied-UDP-only, refusing SOCKS UDP
//   closes the WebRTC covert channel fail-closed.
// - Audit egress lockdown: with `allowedDestinations` set (the audit passes
//   the artifact's own daemon origin, host AND port), every other CONNECT is
//   recorded, marked
//   `policy_denied`, and refused AT THIS HOP. The connection never reaches
//   the Sentinel path, so an audit render cannot raise approval prompts;
//   the attempt still lands in the ledger and is screened and disclosed
//   like any other. Without `allowedDestinations` (dev/tests) the ledger records
//   and forwards, and enforcement stays with Sentinel upstream. A refused
//   upstream CONNECT is recorded as denied, never hidden.
// - No credentials live here: when the upstream is the proxy-auth relay, the
//   relay injects Proxy-Authorization; this hop stays token-free by design.

import { createServer, connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

// Aggregated per host:port so a chatty page cannot bloat the report; the
// entry cap bounds distinct destinations, and overflow is counted rather than
// silently dropped (a connection storm is itself a signal).
const MAX_TRANSPORT_ENTRIES = 256;
const MAX_TRANSPORT_HOST_CHARS = 255; // DNS maximum; hostnames carry exfil, do not over-truncate

export interface TransportConnection {
  host: string;
  port: number;
  connects: number;
  bytes_up: number;
  bytes_down: number;
  /** Chromium sent an IP literal instead of a hostname (local resolution or
   *  a hardcoded address; with forced proxy-side DNS this is anomalous). */
  ip_literal?: boolean;
  /** TLS SNI in the first client bytes disagreed with the CONNECT host
   *  (domain-fronting shape). Best-effort parse. */
  sni_mismatch?: boolean;
  /** The upstream (Sentinel path) refused the tunnel; the attempt is still
   *  the signal. */
  denied?: boolean;
  /** Refused by the audit egress lockdown before any upstream dial: the
   *  host is not on the audit's allowed set, so the connection never left
   *  the ledger (and never reached Sentinel, so it can raise no approval
   *  prompt). The attempt is recorded and screened like any other. */
  policy_denied?: boolean;
}

export interface TransportLedgerState {
  entries: Map<string, TransportConnection>;
  /** Distinct destinations beyond the entry cap (their detail is dropped,
   *  their existence is not). */
  overflow: number;
  /** SOCKS UDP-ASSOCIATE/BIND attempts refused (WebRTC or other non-TCP). */
  udp_attempts: number;
}

export function newTransportLedgerState(): TransportLedgerState {
  return { entries: new Map(), overflow: 0, udp_attempts: 0 };
}

/** Record one CONNECT against the aggregate ledger. Pure state-in/state-out
 *  so the accounting is unit-testable without sockets. */
export function recordTransportConnect(
  state: TransportLedgerState,
  host: string,
  port: number,
  flags: { ipLiteral?: boolean },
): TransportConnection | null {
  const boundedHost = host.toLowerCase().slice(0, MAX_TRANSPORT_HOST_CHARS);
  const key = `${boundedHost}:${port}`;
  const existing = state.entries.get(key);
  if (existing !== undefined) {
    existing.connects += 1;
    return existing;
  }
  if (state.entries.size >= MAX_TRANSPORT_ENTRIES) {
    state.overflow += 1;
    return null;
  }
  const entry: TransportConnection = {
    host: boundedHost,
    port,
    connects: 1,
    bytes_up: 0,
    bytes_down: 0,
  };
  if (flags.ipLiteral) {
    entry.ip_literal = true;
  }
  state.entries.set(key, entry);
  return entry;
}

// --- SOCKS5 wire parsing (pure, for tests) ---------------------------------

export interface SocksRequest {
  cmd: number;
  host: string;
  port: number;
  atyp: number;
  consumed: number;
}

/** Parse the SOCKS5 greeting; returns bytes consumed or null when the buffer
 *  is short or not SOCKS5. */
export function parseSocksGreeting(buf: Buffer): number | null {
  if (buf.length < 2) {
    return null;
  }
  if (buf[0] !== 0x05) {
    return null;
  }
  const nMethods = buf[1];
  if (nMethods === undefined || buf.length < 2 + nMethods) {
    return null;
  }
  return 2 + nMethods;
}

/** Parse a SOCKS5 request (after the greeting). Returns null while the
 *  buffer is incomplete; throws on a malformed request. */
export function parseSocksRequest(buf: Buffer): SocksRequest | null {
  if (buf.length < 5) {
    return null;
  }
  if (buf[0] !== 0x05) {
    throw new Error("not a SOCKS5 request");
  }
  const cmd = buf[1];
  const atyp = buf[3];
  if (cmd === undefined || atyp === undefined) {
    return null;
  }
  let host: string;
  let portOffset: number;
  if (atyp === 0x01) {
    if (buf.length < 10) {
      return null;
    }
    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    portOffset = 8;
  } else if (atyp === 0x03) {
    const len = buf[4];
    if (len === undefined || buf.length < 5 + len + 2) {
      return null;
    }
    host = buf.subarray(5, 5 + len).toString("latin1");
    portOffset = 5 + len;
  } else if (atyp === 0x04) {
    if (buf.length < 22) {
      return null;
    }
    const parts: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
    }
    host = parts.join(":");
    portOffset = 20;
  } else {
    throw new Error(`unsupported SOCKS address type ${atyp}`);
  }
  const port = buf.readUInt16BE(portOffset);
  return { cmd, host, port, atyp, consumed: portOffset + 2 };
}

/** Normalize a host for allowed-set comparison: lowercase, IPv6 brackets
 *  stripped, and IPv6 expanded to the uncompressed leading-zero-free form the
 *  SOCKS ATYP=4 parse above emits ("::1" -> "0:0:0:0:0:0:0:1"), so a URL's
 *  canonical compressed literal matches what Chromium puts on the wire. A
 *  malformed IPv6-looking value is returned lowercased as-is (it can only
 *  fail to match, never widen the allowed set). */
export function normalizeLedgerHost(host: string): string {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  if (!h.includes(":")) {
    return h;
  }
  const zone = h.indexOf("%");
  if (zone !== -1) {
    h = h.slice(0, zone);
  }
  const halves = h.split("::");
  if (halves.length > 2) {
    return h;
  }
  const first = halves[0] ?? "";
  const second = halves[1] ?? "";
  const head = first === "" ? [] : first.split(":");
  const tail = halves.length === 2 ? (second === "" ? [] : second.split(":")) : [];
  const groups =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
      : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) {
    return h;
  }
  return groups.map((g) => String(parseInt(g, 16).toString(16))).join(":");
}

// Default TCP port per URL scheme, for turning a URL into the `host:port` key
// the ledger records and matches on. A scheme that is not one of these carries
// no TCP destination we can compare (data:, blob:, about:), so it keys nothing.
const DEFAULT_SCHEME_PORTS: Record<string, string> = {
  "https:": "443",
  "wss:": "443",
  "http:": "80",
  "ws:": "80",
};

/** Ledger key (`<normalized-host>:<port>`) for a URL, or null when the URL does
 *  not parse or carries no TCP-shaped scheme. One implementation so the audit's
 *  egress-lockdown allowed set and the covert-channel cross-check key
 *  identically — a mismatch between them either widens the lockdown or turns
 *  every IPv6/implicit-port capture into a false covert-channel finding. */
export function ledgerDestinationKey(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const port =
    parsed.port.length > 0 ? parsed.port : DEFAULT_SCHEME_PORTS[parsed.protocol];
  if (port === undefined) {
    return null;
  }
  return `${normalizeLedgerHost(parsed.hostname)}:${port}`;
}

/** Best-effort TLS ClientHello SNI extraction from the first client bytes of
 *  a tunnel. Returns null on anything short, non-TLS, or malformed. */
export function parseClientHelloSni(buf: Buffer): string | null {
  try {
    if (buf.length < 5 || buf[0] !== 0x16) {
      return null;
    }
    const recordLen = buf.readUInt16BE(3);
    const record = buf.subarray(5, 5 + recordLen);
    if (record.length < 42 || record[0] !== 0x01) {
      return null;
    }
    let at = 4 + 2 + 32; // handshake header, client version, random
    const sessionIdLen = record[at];
    if (sessionIdLen === undefined) {
      return null;
    }
    at += 1 + sessionIdLen;
    const cipherLen = record.readUInt16BE(at);
    at += 2 + cipherLen;
    const compLen = record[at];
    if (compLen === undefined) {
      return null;
    }
    at += 1 + compLen;
    if (at + 2 > record.length) {
      return null;
    }
    const extTotal = record.readUInt16BE(at);
    at += 2;
    const extEnd = Math.min(at + extTotal, record.length);
    while (at + 4 <= extEnd) {
      const extType = record.readUInt16BE(at);
      const extLen = record.readUInt16BE(at + 2);
      at += 4;
      if (extType === 0x0000) {
        // server_name: list length (2), name type (1), name length (2), name
        if (extLen < 5 || at + extLen > record.length) {
          return null;
        }
        const nameLen = record.readUInt16BE(at + 3);
        if (5 + nameLen > extLen) {
          return null;
        }
        return record.subarray(at + 5, at + 5 + nameLen).toString("latin1");
      }
      at += extLen;
    }
    return null;
  } catch {
    return null;
  }
}

// --- Cross-check (pure, for tests) ------------------------------------------

/** Transport destinations no content-layer record explains, as `host:port`
 *  (IPv6 hosts bracketed in the emitted form).
 *
 *  `explainedDestinations` carries `ledgerDestinationKey` values from the
 *  captured external requests plus the audit's own daemon origin; the
 *  phone-home bypass hosts never reach the proxy (Chromium sends them DIRECT
 *  into the resolver blackhole), so they need no entry.
 *
 *  Matching is per host:port, not per host: a single innocent capture to a
 *  host must not launder every other port on that host — the same reason the
 *  egress lockdown keys on host:port. Both sides run through
 *  `normalizeLedgerHost` so an ATYP=4 wire-form IPv6 entry matches the URL's
 *  compressed literal. */
export function unexplainedTransportHosts(
  state: TransportLedgerState,
  explainedDestinations: Set<string>,
): string[] {
  const unexplained = new Set<string>();
  for (const entry of state.entries.values()) {
    const host = normalizeLedgerHost(entry.host);
    if (explainedDestinations.has(`${host}:${entry.port}`)) {
      continue;
    }
    unexplained.add(`${host.includes(":") ? `[${host}]` : host}:${entry.port}`);
  }
  return [...unexplained].sort();
}

// --- The proxy itself --------------------------------------------------------

export interface TransportLedgerHandle {
  /** Chromium-facing proxy URL (`socks5://127.0.0.1:<port>`). */
  server: string;
  state: TransportLedgerState;
  close(): Promise<void>;
}

const SOCKS_REPLY_OK = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
const SOCKS_REPLY_REFUSED = Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
const SOCKS_REPLY_CMD_UNSUPPORTED = Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]);

interface UpstreamTarget {
  host: string;
  port: number;
  tls: boolean;
}

function parseUpstream(upstreamProxyUrl: string | null): UpstreamTarget | null {
  if (upstreamProxyUrl === null) {
    return null;
  }
  const url = new URL(upstreamProxyUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported upstream proxy protocol: ${url.protocol}`);
  }
  const tls = url.protocol === "https:";
  return {
    host: url.hostname.replace(/^\[/, "").replace(/\]$/, ""),
    port: url.port.length > 0 ? Number(url.port) : tls ? 443 : 80,
    tls,
  };
}

/** Dial the destination: through the upstream HTTP proxy (plain CONNECT; the
 *  relay owns credentials) when one is configured, or directly otherwise
 *  (host test/dev path). Resolves once the tunnel is ready for bytes. */
function dialUpstream(
  upstream: UpstreamTarget | null,
  host: string,
  port: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (upstream === null) {
      const direct = netConnect(port, host);
      direct.once("connect", () => resolve(direct));
      direct.once("error", reject);
      return;
    }
    const socket = upstream.tls
      ? tlsConnect({
          host: upstream.host,
          port: upstream.port,
          servername: isIP(upstream.host) ? undefined : upstream.host,
        })
      : netConnect(upstream.port, upstream.host);
    const readyEvent = upstream.tls ? "secureConnect" : "connect";
    socket.once("error", reject);
    socket.once(readyEvent, () => {
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`,
      );
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          if (buffer.length > 16384) {
            socket.removeListener("data", onData);
            socket.destroy();
            reject(new Error("oversized upstream CONNECT response"));
          }
          return;
        }
        socket.removeListener("data", onData);
        const statusLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1");
        if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
          socket.destroy();
          reject(new Error(`upstream CONNECT refused: ${statusLine.slice(0, 80)}`));
          return;
        }
        const leftover = buffer.subarray(headerEnd + 4);
        if (leftover.length > 0) {
          socket.unshift(leftover);
        }
        resolve(socket);
      };
      socket.on("data", onData);
    });
  });
}

/** Start the loopback SOCKS5 ledger proxy. `upstreamProxyUrl` is whatever
 *  Chromium would otherwise have used as its proxy (the auth relay, or the
 *  Sentinel forward proxy when no token is in play); null means direct
 *  egress (dev). */
export async function startTransportLedger(
  upstreamProxyUrl: string | null,
  options?: {
    /** Audit egress lockdown: when set, only these exact
     *  `<normalized-host>:<port>` destinations may tunnel upstream; every
     *  other CONNECT is recorded, marked `policy_denied`, and refused at
     *  this hop — it never reaches the Sentinel path, so an audit render can
     *  raise no approval prompt. Host-only matching would let same-host,
     *  different-port traffic (a cross-origin fetch to another service on
     *  the artifact's public host) slip through to Sentinel, so the port is
     *  part of the key. Build keys with `normalizeLedgerHost(host)`.
     *  Omitted/null preserves the observe-and-forward behavior (dev/tests). */
    allowedDestinations?: Set<string> | null;
  },
): Promise<TransportLedgerHandle> {
  const upstream = parseUpstream(upstreamProxyUrl);
  const allowedDestinations = options?.allowedDestinations ?? null;
  const state = newTransportLedgerState();
  const sockets = new Set<Socket>();

  const server = createServer((client) => {
    sockets.add(client);
    let phase: "greeting" | "request" | "tunnel" = "greeting";
    let buffer = Buffer.alloc(0);
    client.on("error", () => client.destroy());
    client.on("close", () => sockets.delete(client));
    client.on("data", (chunk: Buffer) => {
      if (phase === "tunnel") {
        return; // piped; nothing to parse
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === "greeting") {
        const consumed = parseSocksGreeting(buffer);
        if (consumed === null) {
          if (buffer.length > 512) {
            client.destroy();
          }
          return;
        }
        client.write(Buffer.from([5, 0]));
        buffer = buffer.subarray(consumed);
        phase = "request";
      }
      if (phase === "request") {
        let request: SocksRequest | null;
        try {
          request = parseSocksRequest(buffer);
        } catch {
          client.end(SOCKS_REPLY_REFUSED);
          return;
        }
        if (request === null) {
          if (buffer.length > 4096) {
            client.destroy();
          }
          return;
        }
        buffer = buffer.subarray(request.consumed);
        if (request.cmd !== 0x01) {
          // BIND / UDP ASSOCIATE: refused and counted. With WebRTC pinned to
          // proxied UDP only, this is the WebRTC channel failing closed.
          state.udp_attempts += 1;
          client.end(SOCKS_REPLY_CMD_UNSUPPORTED);
          return;
        }
        phase = "tunnel";
        const entry = recordTransportConnect(state, request.host, request.port, {
          ipLiteral: request.atyp !== 0x03,
        });
        if (
          allowedDestinations !== null &&
          !allowedDestinations.has(
            `${normalizeLedgerHost(request.host)}:${request.port}`,
          )
        ) {
          if (entry !== null) {
            entry.policy_denied = true;
          }
          client.end(SOCKS_REPLY_REFUSED);
          return;
        }
        client.pause();
        dialUpstream(upstream, request.host, request.port)
          .then((remote) => {
            sockets.add(remote);
            remote.on("close", () => sockets.delete(remote));
            client.write(SOCKS_REPLY_OK);
            // Byte accounting + best-effort SNI cross-check on the first
            // client bytes (the TLS ClientHello when the tunnel is HTTPS).
            let sawFirst = false;
            client.on("data", (data: Buffer) => {
              if (entry !== null) {
                entry.bytes_up += data.length;
                if (!sawFirst) {
                  sawFirst = true;
                  const sni = parseClientHelloSni(data);
                  if (
                    sni !== null &&
                    request !== null &&
                    request.atyp === 0x03 &&
                    sni.toLowerCase() !== request.host.toLowerCase()
                  ) {
                    entry.sni_mismatch = true;
                  }
                }
              }
            });
            remote.on("data", (data: Buffer) => {
              if (entry !== null) {
                entry.bytes_down += data.length;
              }
            });
            // Leftover bytes parsed past the request (early TLS hello) flow
            // through the same pipe once resumed.
            if (buffer.length > 0) {
              client.unshift(buffer);
              buffer = Buffer.alloc(0);
            }
            client.pipe(remote);
            remote.pipe(client);
            const teardown = () => {
              client.destroy();
              remote.destroy();
            };
            client.on("close", teardown);
            remote.on("close", teardown);
            remote.on("error", teardown);
            client.resume();
          })
          .catch(() => {
            if (entry !== null) {
              entry.denied = true;
            }
            try {
              client.end(SOCKS_REPLY_REFUSED);
            } catch {
              /* client gone */
            }
          });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("transport ledger failed to bind");
  }
  return {
    server: `socks5://127.0.0.1:${address.port}`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}
