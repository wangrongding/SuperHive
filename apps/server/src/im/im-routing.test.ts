import { describe, expect, it } from "vitest";
import { applyChoice, commonPrefix, resolveAliases } from "./im-routing.js";

const agents = ["rd-claude", "rd-claude2", "rd-claude3", "rd-codex", "rd-omp"];

describe("Agent 简写", () => {
  it("公共前缀到分隔符为止", () => {
    expect(commonPrefix(agents)).toBe("rd-");
    expect(commonPrefix(["alpha", "beta"])).toBe("");
  });

  it("唯一匹配补全成全名：带 @ 或消息开头的英文词", () => {
    expect(resolveAliases("@codex 看下测试", agents)).toEqual({
      kind: "resolved",
      content: "@rd-codex 看下测试",
    });
    expect(resolveAliases("codex 看下测试", agents)).toEqual({
      kind: "resolved",
      content: "@rd-codex 看下测试",
    });
    expect(resolveAliases("claude2，你看看", agents)).toEqual({
      kind: "resolved",
      content: "@rd-claude2，你看看",
    });
    // 去掉前缀后完全相同优先：claude 就是 rd-claude
    expect(resolveAliases("@claude 帮忙", agents)).toMatchObject({ content: "@rd-claude 帮忙" });
    // 全名照旧
    expect(resolveAliases("@rd-omp 你好", agents)).toEqual({ kind: "none" });
  });

  it("多个匹配交给人选，没匹配到按普通文字处理", () => {
    expect(resolveAliases("@cl 看下", agents)).toEqual({
      kind: "ambiguous",
      token: "cl",
      candidates: ["rd-claude", "rd-claude2", "rd-claude3"],
    });
    expect(resolveAliases("test 一下这个", agents)).toEqual({ kind: "none" });
    expect(resolveAliases("今天天气不错", agents)).toEqual({ kind: "none" });
    expect(resolveAliases("hello world", agents)).toEqual({ kind: "none" });
  });

  it("选好之后替换原来的简写", () => {
    expect(applyChoice("@cl 看下", "cl", "rd-claude3")).toBe("@rd-claude3 看下");
    expect(applyChoice("cl 看下", "cl", "rd-claude3")).toBe("@rd-claude3 看下");
    expect(applyChoice("@rd-cl 看下", "rd-cl", "rd-claude")).toBe("@rd-claude 看下");
  });
});
