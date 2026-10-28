import { describe, expect, it } from "vitest";
import { plainPreview } from "./activity";

describe("plainPreview", () => {
  it("strips markdown markers for list previews", () => {
    expect(
      plainPreview(
        "好，按 **REST** 来做，字段用 `snake_case`：\n\n1. 登录返回 token\n> 只处理一种错误",
      ),
    ).toBe("好，按 REST 来做，字段用 snake_case： 登录返回 token 只处理一种错误");
    expect(plainPreview("看下\n```ts\nconst a = 1;\n```\n[文档](https://x.y)")).toBe(
      "看下 [代码] 文档",
    );
  });
});
