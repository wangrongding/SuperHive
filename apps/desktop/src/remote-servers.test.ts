import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deepLinkFromArgv,
  describeRoomLink,
  loadRemoteServers,
  normalizeRemoteUrl,
  parseDeepLink,
  remoteWindowTitle,
  saveRemoteServers,
  upsertRemoteServer,
} from "./remote-servers.js";

describe("normalizeRemoteUrl", () => {
  it("只认 http(s)，保留路径和带邀请的 hash", () => {
    expect(normalizeRemoteUrl(" http://192.168.1.8:8787/#kx001?invite=hvi_abc ")).toEqual({
      origin: "http://192.168.1.8:8787",
      url: "http://192.168.1.8:8787/#kx001?invite=hvi_abc",
    });
    expect(normalizeRemoteUrl("https://hive.example.com")?.origin).toBe("https://hive.example.com");
  });

  it("拒绝别的协议和带账号密码的地址", () => {
    expect(normalizeRemoteUrl("file:///etc/passwd")).toBeUndefined();
    expect(normalizeRemoteUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeRemoteUrl("http://user:pass@host:8787/")).toBeUndefined();
    expect(normalizeRemoteUrl("不是地址")).toBeUndefined();
  });
});

describe("parseDeepLink", () => {
  it("superhive://join 打开邀请链接", () => {
    const invite = "http://10.0.0.2:8787/#kx001?invite=hvi_abc";
    expect(parseDeepLink(`superhive://join?url=${encodeURIComponent(invite)}`)).toEqual({
      kind: "open",
      origin: "http://10.0.0.2:8787",
      url: invite,
    });
    expect(parseDeepLink("superhive://join?url=file%3A%2F%2F%2Fetc")).toBeUndefined();
  });

  it("superhive://agent-join 带上服务器、房间、名字和令牌", () => {
    expect(
      parseDeepLink(
        "superhive://agent-join?server=http%3A%2F%2F10.0.0.2%3A8787&room=kx001&name=caibao-claude&token=hvs_abcdefgh123",
      ),
    ).toEqual({
      kind: "agent-join",
      server: "http://10.0.0.2:8787",
      roomId: "kx001",
      name: "caibao-claude",
      token: "hvs_abcdefgh123",
    });
  });

  it("参数可疑时什么都不做", () => {
    expect(
      parseDeepLink(
        "superhive://agent-join?server=http%3A%2F%2Fa&room=..%2F&name=x&token=hvs_12345678",
      ),
    ).toBeUndefined();
    expect(
      parseDeepLink("superhive://agent-join?server=http%3A%2F%2Fa&room=r&name=x&token=a%20b"),
    ).toBeUndefined();
    expect(parseDeepLink("superhive://format-disk")).toBeUndefined();
    expect(parseDeepLink("https://example.com")).toBeUndefined();
  });

  it("从命令行参数里找出深链接", () => {
    expect(deepLinkFromArgv(["SuperHive.exe", "--flag", "superhive://join?url=x"])).toBe(
      "superhive://join?url=x",
    );
    expect(deepLinkFromArgv(["SuperHive.exe"])).toBeUndefined();
  });
});

describe("服务器列表", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("最近打开的排前面，重复打开只更新地址和时间", () => {
    const a = { origin: "http://a:8787", url: "http://a:8787/#r1?invite=hvi_1" };
    const b = { origin: "http://b:8787", url: "http://b:8787/" };
    let list = upsertRemoteServer([], a, new Date("2026-11-26T00:00:00Z"));
    list = upsertRemoteServer(list, b, new Date("2026-11-26T01:00:00Z"));
    list = upsertRemoteServer(
      list,
      { ...a, url: "http://a:8787/#r2" },
      new Date("2026-11-26T02:00:00Z"),
    );
    expect(list.map((item) => item.origin)).toEqual(["http://a:8787", "http://b:8787"]);
    expect(list[0]).toMatchObject({
      url: "http://a:8787/#r2",
      addedAt: "2026-11-26T00:00:00.000Z",
      lastOpenedAt: "2026-11-26T02:00:00.000Z",
    });
  });

  it("读写文件，丢掉格式不对的条目", () => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-servers-"));
    const file = path.join(dir, "remote-servers.json");
    const list = upsertRemoteServer(
      [],
      { origin: "http://a:8787", url: "http://a:8787/" },
      new Date("2026-11-26T00:00:00Z"),
    );
    saveRemoteServers(file, [
      ...list,
      { origin: "file://x", url: "file:///x", addedAt: "", lastOpenedAt: "" },
    ]);
    expect(JSON.parse(readFileSync(file, "utf8")).servers).toHaveLength(2);
    expect(loadRemoteServers(file)).toEqual(list);
    expect(loadRemoteServers(path.join(dir, "missing.json"))).toEqual([]);
  });

  it("窗口标题带上对方的地址", () => {
    expect(remoteWindowTitle("http://10.0.0.2:8787")).toBe("SuperHive — 10.0.0.2:8787");
    expect(remoteWindowTitle("http://10.0.0.2:8787", "# kx001")).toBe("# kx001 — 10.0.0.2:8787");
  });
});

describe("describeRoomLink", () => {
  it("确认框里写真实的服务器、房间和是否带邀请", () => {
    const target = normalizeRemoteUrl("http://192.168.1.8:8787/#kx001?invite=hvi_abcdefgh")!;
    expect(describeRoomLink(target)).toEqual({
      host: "192.168.1.8:8787",
      origin: "http://192.168.1.8:8787",
      roomId: "kx001",
      hasInvite: true,
    });
  });

  it("房间名可疑时不显示", () => {
    const target = normalizeRemoteUrl("https://hive.example.com/#<script>")!;
    expect(describeRoomLink(target)).toMatchObject({ roomId: undefined, hasInvite: false });
  });
});
