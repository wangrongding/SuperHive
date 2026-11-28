import { describe, expect, it } from "vitest";
import {
  isLoopbackUrl,
  resolveServerBase,
  resolveShareBase,
  resolveWebSocketUrl,
} from "./server-url";

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

  it("keeps the advertised production path when it is on the page's own host", () => {
    expect(
      resolveWebSocketUrl({
        serverBase: "https://hive.example.com",
        development: false,
        advertisedUrl: "wss://hive.example.com/custom/ws",
      }),
    ).toBe("wss://hive.example.com/custom/ws");
  });

  it.each([
    // Windows 上本机用 localhost 打开，Server 公布的是局域网 IP：连公布地址会被 CSP 拦掉
    ["http://127.0.0.1:8787", "ws://127.0.0.1:8787/ws"],
    ["http://localhost:8787", "ws://localhost:8787/ws"],
    ["https://hive.example.com/team", "wss://hive.example.com/team/ws"],
  ])(
    "uses the page's own endpoint %s in production when the advertised host differs",
    (serverBase, expected) => {
      expect(
        resolveWebSocketUrl({
          serverBase,
          development: false,
          advertisedUrl: "ws://10.253.210.139:8787/ws",
        }),
      ).toBe(expected);
    },
  );
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

describe("isLoopbackUrl", () => {
  it("认出本机回环地址，局域网地址、公网地址和解析不了的都不算", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8799")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8799/")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8799")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.5:8799")).toBe(false);
    expect(isLoopbackUrl("https://hive.example.com")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });
});
