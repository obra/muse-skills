import { describe, expect, test } from "bun:test";
import { connect as netConnect, createServer, type Socket } from "node:net";

import {
  ledgerDestinationKey,
  newTransportLedgerState,
  parseSocksGreeting,
  parseSocksRequest,
  recordTransportConnect,
  normalizeLedgerHost,
  startTransportLedger,
  unexplainedTransportHosts,
} from "./transport-ledger";

function socksConnectFrame(host: string, port: number): Buffer {
  const name = Buffer.from(host, "latin1");
  const frame = Buffer.alloc(5 + name.length + 2);
  frame[0] = 0x05;
  frame[1] = 0x01; // CONNECT
  frame[2] = 0x00;
  frame[3] = 0x03; // domain
  frame[4] = name.length;
  name.copy(frame, 5);
  frame.writeUInt16BE(port, 5 + name.length);
  return frame;
}

describe("socks parsing", () => {
  test("greeting consumes version + methods", () => {
    expect(parseSocksGreeting(Buffer.from([5, 1, 0]))).toBe(3);
    expect(parseSocksGreeting(Buffer.from([5, 2, 0]))).toBe(null); // short
    expect(parseSocksGreeting(Buffer.from([4, 1, 0]))).toBe(null); // socks4
  });

  test("request parses domain, ipv4, and rejects unknown atyp", () => {
    const domain = parseSocksRequest(socksConnectFrame("evil.example", 443));
    expect(domain).toEqual({
      cmd: 1,
      host: "evil.example",
      port: 443,
      atyp: 3,
      consumed: 5 + "evil.example".length + 2,
    });
    const v4 = parseSocksRequest(
      Buffer.from([5, 1, 0, 1, 10, 0, 0, 2, 0x01, 0xbb]),
    );
    expect(v4?.host).toBe("10.0.0.2");
    expect(v4?.port).toBe(443);
    expect(() => parseSocksRequest(Buffer.from([5, 1, 0, 9, 0, 0]))).toThrow();
  });

});

describe("ledger accounting", () => {
  test("aggregates per host:port and counts overflow past the cap", () => {
    const state = newTransportLedgerState();
    recordTransportConnect(state, "A.Example", 443, {});
    recordTransportConnect(state, "a.example", 443, {});
    expect(state.entries.get("a.example:443")?.connects).toBe(2);
    for (let i = 0; i < 300; i += 1) {
      recordTransportConnect(state, `h${i}.example`, 443, {});
    }
    expect(state.entries.size).toBe(256);
    expect(state.overflow).toBe(45);
  });

  test("cross-check flags only unexplained hosts", () => {
    const state = newTransportLedgerState();
    recordTransportConnect(state, "api.open-meteo.com", 443, {});
    recordTransportConnect(state, "pulsekit.exe.xyz", 443, {});
    const unexplained = unexplainedTransportHosts(
      state,
      new Set([
        ledgerDestinationKey("https://api.open-meteo.com/v1/forecast")!,
        ledgerDestinationKey("https://daemon.example/")!,
      ]),
    );
    expect(unexplained).toEqual(["pulsekit.exe.xyz:443"]);
  });

  test("cross-check keys on host:port and normalizes ipv6 wire forms", () => {
    // Two properties the covert-channel detector depends on: one innocent
    // capture explains only the port it used (a decoy image on :443 must not
    // launder a channel on :8443 of the same host), and an ATYP=4 ledger entry
    // — expanded IPv6 on the wire — matches the bracketed literal a captured
    // URL carries, so IPv6 traffic is not permanently double-flagged.
    const state = newTransportLedgerState();
    recordTransportConnect(state, "api.open-meteo.com", 443, {});
    recordTransportConnect(state, "api.open-meteo.com", 8443, {});
    recordTransportConnect(state, "0:0:0:0:0:0:0:1", 443, { ipLiteral: true });
    const unexplained = unexplainedTransportHosts(
      state,
      new Set([
        ledgerDestinationKey("https://api.open-meteo.com/v1/forecast")!,
        ledgerDestinationKey("https://[::1]/assets/app.js")!,
      ]),
    );
    expect(unexplained).toEqual(["api.open-meteo.com:8443"]);
  });

  test("destination keys default the port from the scheme", () => {
    expect(ledgerDestinationKey("https://x.example/a")).toBe("x.example:443");
    expect(ledgerDestinationKey("http://x.example/a")).toBe("x.example:80");
    expect(ledgerDestinationKey("wss://x.example/socket")).toBe("x.example:443");
    expect(ledgerDestinationKey("https://x.example:8443/a")).toBe("x.example:8443");
    // A scheme with no TCP destination explains nothing, and neither does junk.
    expect(ledgerDestinationKey("data:text/plain,hi")).toBeNull();
    expect(ledgerDestinationKey("not a url")).toBeNull();
  });
});

describe("ledger proxy end to end (loopback)", () => {
  test("egress lockdown: denies non-allowed hosts, tunnels the allowed one", async () => {
    const banner = "allowed-destination";
    const destination = createServer((socket) => {
      socket.on("data", () => socket.end(banner));
    });
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
    const destinationPort = (destination.address() as { port: number }).port;

    const ledger = await startTransportLedger(null, {
      allowedDestinations: new Set([`127.0.0.1:${destinationPort}`]),
    });
    const proxyPort = Number(new URL(ledger.server).port);

    // Non-allowed hostname: refused at the ledger (never dialed), recorded
    // with the policy flag.
    await new Promise<void>((resolve, reject) => {
      const client: Socket = netConnect(proxyPort, "127.0.0.1");
      let phase: "greet" | "request" = "greet";
      client.on("error", reject);
      client.on("data", (chunk: Buffer) => {
        if (phase === "greet") {
          phase = "request";
          client.write(socksConnectFrame("evil.example", 443));
          return;
        }
        expect(chunk[0]).toBe(5);
        expect(chunk[1]).not.toBe(0); // refused, not success
      });
      client.on("close", () => resolve());
      client.write(Buffer.from([5, 1, 0]));
    });
    const deniedEntry = ledger.state.entries.get("evil.example:443");
    expect(deniedEntry?.policy_denied).toBe(true);
    expect(deniedEntry?.bytes_up).toBe(0);

    // Same host, different port: cross-origin to the artifact, denied too.
    await new Promise<void>((resolve, reject) => {
      const client: Socket = netConnect(proxyPort, "127.0.0.1");
      let phase: "greet" | "request" = "greet";
      client.on("error", reject);
      client.on("data", (chunk: Buffer) => {
        if (phase === "greet") {
          phase = "request";
          client.write(socksConnectFrame("127.0.0.1", 1));
          return;
        }
        expect(chunk[1]).not.toBe(0);
      });
      client.on("close", () => resolve());
      client.write(Buffer.from([5, 1, 0]));
    });
    expect(ledger.state.entries.get("127.0.0.1:1")?.policy_denied).toBe(true);

    // Allowed host still tunnels end to end.
    const received = await new Promise<string>((resolve, reject) => {
      const client: Socket = netConnect(proxyPort, "127.0.0.1");
      const chunks: Buffer[] = [];
      let phase: "greet" | "request" | "data" = "greet";
      client.on("error", reject);
      client.on("data", (chunk: Buffer) => {
        if (phase === "greet") {
          phase = "request";
          client.write(socksConnectFrame("127.0.0.1", destinationPort));
          return;
        }
        if (phase === "request") {
          expect(chunk[1]).toBe(0);
          phase = "data";
          client.write("ping");
          return;
        }
        chunks.push(chunk);
      });
      client.on("close", () =>
        resolve(Buffer.concat(chunks).toString("latin1")),
      );
      client.write(Buffer.from([5, 1, 0]));
    });
    expect(received).toBe(banner);
    expect(
      ledger.state.entries.get("127.0.0.1:" + destinationPort)?.policy_denied,
    ).toBeUndefined();

    await ledger.close();
    await new Promise<void>((resolve) => destination.close(() => resolve()));
  });

  test("normalizeLedgerHost matches URL literals to SOCKS wire forms", () => {
    expect(normalizeLedgerHost("[::1]")).toBe("0:0:0:0:0:0:0:1");
    expect(normalizeLedgerHost("0:0:0:0:0:0:0:1")).toBe("0:0:0:0:0:0:0:1");
    expect(normalizeLedgerHost("[2401:DB00::34]")).toBe(
      "2401:db00:0:0:0:0:0:34",
    );
    expect(normalizeLedgerHost("Example.COM")).toBe("example.com");
    expect(normalizeLedgerHost("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeLedgerHost("fe80::1%eth0")).toBe("fe80:0:0:0:0:0:0:1");
  });

  test("refuses UDP ASSOCIATE and counts the attempt", async () => {
    const ledger = await startTransportLedger(null);
    const proxyPort = Number(new URL(ledger.server).port);
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const client = netConnect(proxyPort, "127.0.0.1");
      let greeted = false;
      client.on("error", reject);
      client.on("data", (chunk: Buffer) => {
        if (!greeted) {
          greeted = true;
          const frame = socksConnectFrame("ignored.example", 443);
          frame[1] = 0x03; // UDP ASSOCIATE
          client.write(frame);
          return;
        }
        resolve(chunk);
        client.destroy();
      });
      client.write(Buffer.from([5, 1, 0]));
    });
    expect(reply[1]).toBe(0x07); // command not supported
    expect(ledger.state.udp_attempts).toBe(1);
    await ledger.close();
  });

  test("a policy-denied CONNECT never dials the configured upstream", async () => {
    // The lockdown's whole security claim: a denied destination is refused AT
    // THIS HOP, so it never reaches the Sentinel path and can raise no
    // approval prompt on the user. Every other lockdown test runs with
    // `upstream = null`, which cannot observe that — this one wires a real
    // upstream and asserts it was never touched.
    let upstreamConnections = 0;
    const connectTargets: string[] = [];
    const upstream = createServer();
    upstream.on("connection", (socket) => {
      upstreamConnections += 1;
      socket.once("data", (chunk: Buffer) => {
        connectTargets.push(chunk.toString("latin1").split("\r\n")[0] ?? "");
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.on("data", () => socket.end("via-upstream"));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const ledger = await startTransportLedger(`http://127.0.0.1:${upstreamPort}`, {
      allowedDestinations: new Set(["allowed.example:443"]),
    });
    const proxyPort = Number(new URL(ledger.server).port);

    const connectThrough = (host: string, port: number): Promise<Buffer> =>
      new Promise<Buffer>((resolve, reject) => {
        const client: Socket = netConnect(proxyPort, "127.0.0.1");
        let reply: Buffer | null = null;
        let phase: "greet" | "request" = "greet";
        client.on("error", reject);
        client.on("data", (chunk: Buffer) => {
          if (phase === "greet") {
            phase = "request";
            client.write(socksConnectFrame(host, port));
            return;
          }
          if (reply === null) {
            reply = chunk;
            client.end();
          }
        });
        client.on("close", () => resolve(reply ?? Buffer.alloc(0)));
        client.write(Buffer.from([5, 1, 0]));
      });

    const deniedReply = await connectThrough("exfil.example", 443);
    expect(deniedReply[1]).not.toBe(0); // refused
    expect(ledger.state.entries.get("exfil.example:443")?.policy_denied).toBe(true);
    // The load-bearing assertion: the upstream saw nothing at all.
    expect(upstreamConnections).toBe(0);
    expect(connectTargets).toEqual([]);

    const allowedReply = await connectThrough("allowed.example", 443);
    expect(allowedReply[1]).toBe(0);
    expect(upstreamConnections).toBe(1);
    expect(connectTargets).toEqual(["CONNECT allowed.example:443 HTTP/1.1"]);

    await ledger.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

});
