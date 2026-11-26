import { describe, expect, it } from "vitest";
import { agentJoinLink, parseJoinInput, roomJoinLink } from "./join-link";

describe("parseJoinInput", () => {
  it("邀请链接：认出房间和邀请", () => {
    expect(parseJoinInput(" http://192.168.1.8:8787/#kx001?invite=hvi_abc ")).toEqual({
      kind: "room",
      url: "http://192.168.1.8:8787/#kx001?invite=hvi_abc",
      origin: "http://192.168.1.8:8787",
      roomId: "kx001",
      hasInvite: true,
    });
    expect(parseJoinInput("https://hive.example.com")).toMatchObject({
      kind: "room",
      hasInvite: false,
    });
  });

  it("superhive://join 里的邀请链接", () => {
    const invite = "http://10.0.0.2:8787/#kx001?invite=hvi_abc";
    expect(parseJoinInput(roomJoinLink(invite))).toMatchObject({ kind: "room", url: invite });
  });

  it("接入命令：npx 和 hive 两种写法、--flag=value 和引号", () => {
    const command =
      "npx --yes superhive@latest join --server http://10.0.0.2:8787 --room kx001 --name caibao-claude --token hvs_abcdefgh123";
    const expected = {
      kind: "agent",
      server: "http://10.0.0.2:8787",
      roomId: "kx001",
      name: "caibao-claude",
      token: "hvs_abcdefgh123",
    };
    expect(parseJoinInput(command)).toEqual(expected);
    expect(
      parseJoinInput(
        `hive join --server="http://10.0.0.2:8787" --room=kx001 --name 'caibao-claude' --provider claude --token hvs_abcdefgh123`,
      ),
    ).toEqual(expected);
    expect(parseJoinInput(agentJoinLink(expected as never))).toEqual(expected);
  });

  it("不填房间时加入对方的所有房间", () => {
    expect(
      parseJoinInput("hive join --server http://h:8787 --name bot --token abcdefgh1234"),
    ).toEqual({ kind: "agent", server: "http://h:8787", name: "bot", token: "abcdefgh1234" });
  });

  it("可疑或不完整的内容不认", () => {
    expect(parseJoinInput("")).toBeUndefined();
    expect(parseJoinInput("file:///etc/passwd")).toBeUndefined();
    expect(parseJoinInput("javascript:alert(1)")).toBeUndefined();
    expect(parseJoinInput("hive join --server http://h:8787 --name bot")).toBeUndefined();
    expect(
      parseJoinInput(
        "hive join --server http://h:8787 --room ../x --name bot --token hvs_12345678",
      ),
    ).toBeUndefined();
    expect(parseJoinInput("superhive://format")).toBeUndefined();
  });
});
