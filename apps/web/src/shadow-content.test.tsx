// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShadowContent, adaptCssForShadow } from "./shadow-content";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  document.head.querySelectorAll("[data-test-style]").forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

/** 模拟一个已加载的 <link> 样式表：jsdom 不会真的解析外链 CSS */
function addLinkedSheet(href: string, sheet: { cssRules: { cssText: string }[] } | null) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.setAttribute("data-test-style", "");
  Object.defineProperty(link, "sheet", { value: sheet });
  document.head.appendChild(link);
}

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

  it("内容挂进 shadow root 时样式已经就位，<link> 样式表直接读 CSSOM、不重新下载", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const style = document.createElement("style");
    style.setAttribute("data-test-style", "");
    style.textContent = ".inside { color: red; }";
    document.head.appendChild(style);
    addLinkedSheet("/assets/app.css", { cssRules: [{ cssText: ".from-link { color: blue; }" }] });

    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      <ShadowContent host={host}>
        <p className="inside">内容</p>
      </ShadowContent>,
    );
    // render 返回时（首帧绘制前）内容与样式同时存在：不会出现无样式的一帧
    const shadow = host.shadowRoot!;
    expect(shadow.querySelector(".inside")).not.toBeNull();
    const css = shadow.querySelector("style[data-hive-shadow-styles]")?.textContent ?? "";
    expect(css).toContain(".inside { color: red; }");
    expect(css).toContain(".from-link { color: blue; }");
    expect(fetchSpy).not.toHaveBeenCalled();
    host.remove();
  });

  it("样式表不可读时先拉取样式，拿到后才挂载内容", async () => {
    let resolveCss!: (css: string) => void;
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      text: () => new Promise<string>((resolve) => (resolveCss = resolve)),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    addLinkedSheet("/assets/cross-origin.css", null);

    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      <ShadowContent host={host}>
        <p className="inside">内容</p>
      </ShadowContent>,
    );
    expect(host.shadowRoot!.querySelector(".inside")).toBeNull();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await act(async () => resolveCss(".fetched { color: green; }"));
    await waitFor(() => expect(host.shadowRoot!.querySelector(".inside")).not.toBeNull());
    expect(host.shadowRoot!.querySelector("style[data-hive-shadow-styles]")?.textContent).toContain(
      ".fetched { color: green; }",
    );
    host.remove();
  });
});
