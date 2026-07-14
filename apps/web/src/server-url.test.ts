import { describe, expect, it } from "vitest";
import { resolveServerBase } from "./server-url";

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
