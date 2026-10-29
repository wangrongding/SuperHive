// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderLogo, providerLogoName } from "./provider-logos";

afterEach(cleanup);

describe("providerLogoName", () => {
  it("识别已知厂商（忽略大小写和空白），未知或缺失时返回 undefined 以便回退", () => {
    expect(providerLogoName("codex")).toBe("codex");
    expect(providerLogoName(" Claude ")).toBe("claude");
    expect(providerLogoName("omp")).toBe("omp");
    expect(providerLogoName("echo")).toBeUndefined();
    expect(providerLogoName("toString")).toBeUndefined();
    expect(providerLogoName(undefined)).toBeUndefined();
  });
});

describe("ProviderLogo", () => {
  it("单色标识继承文字色，跟随明暗主题", () => {
    const { container } = render(<ProviderLogo provider="codex" />);
    expect(container.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
  });

  it("同页多个实例的渐变 id 互不冲突，且引用指向自己的渐变", () => {
    const { container } = render(
      <>
        <ProviderLogo provider="omp" />
        <ProviderLogo provider="omp" />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map((node) => node.id);
    expect(new Set(ids).size).toBe(2);
    for (const svg of container.querySelectorAll("svg")) {
      const own = svg.querySelector("linearGradient")!.id;
      expect(svg.querySelector("path")!.getAttribute("fill")).toBe(`url(#${own})`);
    }
  });
});
