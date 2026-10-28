import { describe, expect, it } from "vitest";
import { checkLocalRequest, type LocalRequestLike } from "./local-access.js";

const lan = new Set(["10.0.0.8", "fe80::1"]);

function request(
  remoteAddress: string | undefined,
  headers: Record<string, string> = {},
): LocalRequestLike {
  return { socket: { remoteAddress }, headers: { host: "localhost:8787", ...headers } };
}

describe("checkLocalRequest", () => {
  it("accepts loopback and this machine's own LAN address", () => {
    expect(checkLocalRequest(request("127.0.0.1"), lan)).toEqual({ local: true });
    expect(checkLocalRequest(request("::1", { host: "[::1]:8787" }), lan)).toEqual({ local: true });
    expect(checkLocalRequest(request("::ffff:127.0.0.1"), lan)).toEqual({ local: true });
    expect(
      checkLocalRequest(
        request("10.0.0.8", { host: "10.0.0.8:8787", origin: "http://10.0.0.8:5188" }),
        lan,
      ),
    ).toEqual({ local: true });
    // dev：页面在 5188，Server 在 8787
    expect(
      checkLocalRequest(request("127.0.0.1", { origin: "http://localhost:5188" }), lan),
    ).toEqual({ local: true });
  });

  it("rejects other machines", () => {
    expect(checkLocalRequest(request("10.0.0.9", { host: "10.0.0.8:8787" }), lan).local).toBe(
      false,
    );
    expect(checkLocalRequest(request(undefined), lan).local).toBe(false);
  });

  it("rejects anything that went through a reverse proxy", () => {
    for (const header of ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host"]) {
      expect(checkLocalRequest(request("127.0.0.1", { [header]: "203.0.113.5" }), lan)).toEqual({
        local: false,
        reason: "经过代理转发的请求不能使用本机 Agent",
      });
    }
  });

  it("rejects DNS-rebinding hosts and cross-site origins", () => {
    expect(checkLocalRequest(request("127.0.0.1", { host: "evil.example:8787" }), lan).local).toBe(
      false,
    );
    expect(
      checkLocalRequest(request("127.0.0.1", { origin: "https://evil.example" }), lan).local,
    ).toBe(false);
    expect(checkLocalRequest(request("127.0.0.1", { origin: "null" }), lan).local).toBe(false);
  });
});
