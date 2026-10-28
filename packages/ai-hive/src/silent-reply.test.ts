import { describe, expect, it } from "vitest";
import { resolveReplyText } from "./silent-reply.js";

describe("resolveReplyText", () => {
  it.each(["NO_REPLY", "  no_reply \n", "`NO_REPLY`", "**NO_REPLY**", "“NO_REPLY”。", "NO_REPLY."])(
    "treats %j as an intentional silent reply",
    (text) => {
      expect(resolveReplyText(text)).toEqual({ silent: true });
    },
  );

  it("keeps the visible text when the token is mixed in", () => {
    expect(resolveReplyText("结论和 #127 一致。\n\nNO_REPLY")).toEqual({
      silent: false,
      text: "结论和 #127 一致。",
    });
    expect(resolveReplyText("NO_REPLY：补充一点，接口已改为 v2")).toEqual({
      silent: false,
      text: "补充一点，接口已改为 v2",
    });
  });

  it("does not touch ordinary replies or words that merely contain the token", () => {
    expect(resolveReplyText("好的，已更新白板")).toEqual({
      silent: false,
      text: "好的，已更新白板",
    });
    expect(resolveReplyText("变量 NO_REPLY_TIMEOUT 改成 30")).toEqual({
      silent: false,
      text: "变量 NO_REPLY_TIMEOUT 改成 30",
    });
    expect(resolveReplyText("NO_REPLY_TIMEOUT 改成 30")).toEqual({
      silent: false,
      text: "NO_REPLY_TIMEOUT 改成 30",
    });
  });

  it("leaves empty output to the caller as a failure", () => {
    expect(resolveReplyText("  ")).toEqual({ silent: false, text: "" });
  });
});
