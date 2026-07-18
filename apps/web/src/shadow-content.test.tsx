// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ShadowContent, adaptCssForShadow } from "./shadow-content";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

describe("adaptCssForShadow", () => {
  it("把 :root 和 html 前缀选择器转写为 :host", () => {
    const css = [
      ":root { --line: #333; }",
      ':root[data-theme="light"] .message-body { color: #000; }',
      'html[data-message-size="small"] .message-body { font-size: 13px; }',
      ".message-body pre { margin: 0; }",
    ].join("\n");
    const out = adaptCssForShadow(css);
    expect(out).toContain(":host { --line: #333; }");
    expect(out).toContain(':host([data-theme="light"]) .message-body');
    expect(out).toContain(':host([data-message-size="small"]) .message-body');
    expect(out).toContain(".message-body pre { margin: 0; }");
    expect(out).not.toContain(":root");
  });
});

describe("ShadowContent", () => {
  it("把子树渲染进宿主的 shadow root 并镜像 data 属性", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      <ShadowContent host={host}>
        <p className="inside">shadow 内容</p>
      </ShadowContent>,
    );
    await waitFor(() => {
      expect(host.shadowRoot).not.toBeNull();
      expect(host.shadowRoot?.querySelector(".inside")?.textContent).toBe("shadow 内容");
    });
    // 内容不在 light DOM（对页面级选择器不可见）
    expect(document.querySelector(".inside")).toBeNull();
    // 主题属性被镜像到宿主
    expect(host.getAttribute("data-theme")).toBe("light");
    host.remove();
  });
});
