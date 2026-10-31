import { describe, expect, it } from "vitest";
import { resolveServerBase, resolveShareBase, resolveWebSocketUrl } from "./server-url";

describe("resolveServerBase", () => {
  it("uses the Hive Server on 8787 for any Vite development port", () => {
    expect(
      resolveServerBase({
        configured: undefined,
        development: true,
        protocol: "http:",
        hostname: "localhost",
        origin: "http://localhost:5188",
      }),
    ).toBe("http://localhost:8787");
  });

  it("uses the same origin in production", () => {
    expect(
      resolveServerBase({
        configured: undefined,
        development: false,
        protocol: "http:",
        hostname: "192.168.1.20",
        origin: "http://192.168.1.20:8787",
      }),
    ).toBe("http://192.168.1.20:8787");
  });

  it("prefers an explicitly configured server and removes its trailing slash", () => {
    expect(
      resolveServerBase({
        configured: "http://localhost:9000/",
        development: true,
        protocol: "http:",
        hostname: "localhost",
        origin: "http://localhost:5188",
      }),
    ).toBe("http://localhost:9000");
  });
});

describe("resolveWebSocketUrl", () => {
  it.each([
    ["http://localhost:8787", "ws://localhost:8787/ws"],
    ["http://127.0.0.1:8787", "ws://127.0.0.1:8787/ws"],
    ["http://192.168.1.110:8787", "ws://192.168.1.110:8787/ws"],
    ["http://[::1]:8787", "ws://[::1]:8787/ws"],
    ["https://dev.example.com/hive/", "wss://dev.example.com/hive/ws"],
  ])(
    "uses the resolved dev endpoint %s even when metadata advertises an old IP",
    (serverBase, expected) => {
      expect(
        resolveWebSocketUrl({
          serverBase,
          development: true,
          advertisedUrl: "ws://10.253.210.73:8787/ws",
        }),
      ).toBe(expected);
    },
  );

  it("preserves the advertised production endpoint and path", () => {
    expect(
      resolveWebSocketUrl({
        serverBase: "https://web.example.com",
        development: false,
        advertisedUrl: "wss://hive.example.com/custom/ws",
      }),
    ).toBe("wss://hive.example.com/custom/ws");
  });
});

describe("resolveShareBase", () => {
  const location = (hostname: string) => ({
    protocol: "http:",
    hostname,
    port: "5188",
    pathname: "/",
    origin: `http://${hostname}:5188`,
  });

  it("replaces localhost with the server's LAN host in development", () => {
    expect(
      resolveShareBase({
        development: true,
        location: location("localhost"),
        advertisedUrl: "http://192.168.1.110:8787",
      }),
    ).toBe("http://192.168.1.110:5188");
  });

  it("keeps a page already opened on a reachable host", () => {
    expect(
      resolveShareBase({
        development: true,
        location: location("10.0.0.5"),
        advertisedUrl: "http://192.168.1.110:8787",
      }),
    ).toBe("http://10.0.0.5:5188");
  });

  it("uses the advertised server URL in production", () => {
    expect(
      resolveShareBase({
        development: false,
        location: location("localhost"),
        advertisedUrl: "https://hive.example.com/",
      }),
    ).toBe("https://hive.example.com");
  });
});
