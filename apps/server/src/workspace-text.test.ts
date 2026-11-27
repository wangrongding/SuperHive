import { describe, expect, it } from "vitest";
import { decodeDiff, decodeText } from "./workspace-text.js";

const hex = (value: string) => Buffer.from(value.replace(/\s/g, ""), "hex");
const utf16 = (text: string, endian: "le" | "be") => {
  const le = Buffer.from(text, "utf16le");
  if (endian === "be") le.swap16();
  return Buffer.concat([hex(endian === "le" ? "fffe" : "feff"), le]);
};

describe("工作区文本解码", () => {
  it("普通 UTF-8 不带编码标记；带 BOM 的去掉 BOM", () => {
    expect(decodeText(Buffer.from("中文\nok\n"))).toEqual({ text: "中文\nok\n" });
    expect(decodeText(Buffer.concat([hex("efbbbf"), Buffer.from("中文")]))).toEqual({
      text: "中文",
    });
    expect(decodeText(Buffer.alloc(0))).toEqual({ text: "" });
  });

  it("GBK 与 GB18030 四字节字符退回 GB18030 解码，标 gbk", () => {
    // 「// 中文注释」
    expect(decodeText(hex("2f2f20 d6d0 cec4 d7a2 cacd 0a"))).toEqual({
      text: "// 中文注释\n",
      encoding: "gbk",
    });
    // 「修改 😀 é」：😀 在 GB18030 里是四字节 9439fc36
    expect(decodeText(hex("d0deb8c4 20 9439fc36 20 a8a6"))).toEqual({
      text: "修改 😀 é",
      encoding: "gbk",
    });
  });

  it("UTF-16LE / UTF-16BE 带 BOM 按 UTF-16 解码，不因 NUL 判成二进制", () => {
    expect(decodeText(utf16("中文\r\nabc\r\n", "le"))).toEqual({
      text: "中文\r\nabc\r\n",
      encoding: "utf-16",
    });
    expect(decodeText(utf16("上海 abc", "be"))).toEqual({ text: "上海 abc", encoding: "utf-16" });
  });

  it("真二进制：有 NUL，或 GB18030 也解不出大量字节", () => {
    expect(decodeText(Buffer.from([137, 80, 78, 71, 0, 0, 1]))).toBeNull();
    expect(decodeText(Buffer.from(Array.from({ length: 200 }, () => 0xff)))).toBeNull();
    // 没有 BOM 的 UTF-16 也算二进制（没法可靠认出来）
    expect(decodeText(Buffer.from("abc", "utf16le"))).toBeNull();
  });

  it("只读了开头时，截在多字节字符中间的半个字符丢掉，不算解码失败", () => {
    const utf8 = Buffer.from("ab中");
    expect(decodeText(utf8.subarray(0, 4), { partial: true })).toEqual({ text: "ab" });
    expect(decodeText(hex("d6d0 cec4 d6"), { partial: true })).toEqual({
      text: "中文",
      encoding: "gbk",
    });
    const wide = utf16("中文", "le");
    expect(decodeText(wide.subarray(0, wide.length - 1), { partial: true })).toEqual({
      text: "中",
      encoding: "utf-16",
    });
  });

  it("diff 输出整份用同一种编码：UTF-8 原样，含 GBK 的整份按 GB18030", () => {
    const head = Buffer.from("diff --git a/中文.c b/中文.c\n@@ -1 +1 @@\n");
    expect(decodeDiff(Buffer.concat([head, Buffer.from("-旧\n+新\n")]))).toEqual({
      text: "diff --git a/中文.c b/中文.c\n@@ -1 +1 @@\n-旧\n+新\n",
    });
    const gbk = decodeDiff(
      Buffer.concat([
        Buffer.from("@@ -1 +1 @@\n-"),
        hex("d6d0cec4"),
        Buffer.from("\n+"),
        hex("d0deb8c4"),
        Buffer.from("\n"),
      ]),
    );
    expect(gbk).toEqual({ text: "@@ -1 +1 @@\n-中文\n+修改\n", encoding: "gbk" });
  });
});
