import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../public/boot-theme.js", import.meta.url), "utf8");

function boot(saved: Record<string, string>, languages = ["en-US"], blocked = false) {
  const root = { dataset: {} as Record<string, string>, lang: "zh-CN" };
  runInNewContext(script, {
    document: { documentElement: root },
    window: {
      matchMedia: () => ({ matches: true }),
      navigator: { languages, language: languages[0] },
    },
    localStorage: {
      getItem: (key: string) => {
        if (blocked) throw new Error("Blocked storage");
        return saved[key] ?? null;
      },
    },
  });
  return root;
}

describe("boot preferences before the application bundle", () => {
  it("honors saved language, theme and reduced motion without waiting for React", () => {
    const root = boot({
      "superhive.locale": "zh-CN",
      "superhive.theme": "light",
      "superhive.reduce-motion": "true",
    });
    expect(root.lang).toBe("zh-CN");
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.reduceMotion).toBe("true");
  });

  it("matches the application's system language ordering and falls back when storage is blocked", () => {
    expect(boot({}, ["fr-FR", "en-US", "zh-CN"]).lang).toBe("en");
    expect(boot({}, ["zh-TW", "en-US"]).lang).toBe("zh-CN");
    expect(boot({}, ["de-DE"]).lang).toBe("zh-CN");
    expect(boot({}, ["en-US"], true).lang).toBe("en");
  });
});
