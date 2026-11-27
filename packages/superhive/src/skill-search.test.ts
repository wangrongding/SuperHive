import { describe, expect, it } from "vitest";
// 这个包不依赖 protocol；测试直接读源码核对两边的校验和排序一致
import * as protocol from "../../protocol/src/skill-market.js";
import {
  formatSkillInstalls,
  formatSkillResults,
  normalizeSkillQuery,
  normalizeSkillSearch,
  skillSearchCommand,
  type SkillSearchFetch,
} from "./skill-search.js";

/** 网络用替身，不访问 skills.sh */
function fake(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetchImpl: SkillSearchFetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

describe("hive skill search", () => {
  it("normalizes exactly like the server (protocol skill-market.ts)", () => {
    const raw = {
      skills: [
        { source: "someone/skills", skillId: "pdf", name: "pdf\u001b[31m", installs: 10 },
        { source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 238446 },
        { source: "anthropics/skills", skillId: "PDF", name: "dupe", installs: 1 },
        { source: "not a repo", skillId: "pdf", installs: 1 },
        { source: "openai/skills", skillId: "../evil", installs: 1 },
        { source: "openai/skills", skillId: "pdf", installs: -5 },
        { source: "github/awesome-copilot", skillId: "x", name: "x", installs: 10 },
        null,
      ],
    };
    expect(normalizeSkillSearch(raw)).toEqual(protocol.normalizeSkillSearch(raw));
    for (const query of ["a", " pdf ", "x\ny", "a".repeat(101)]) {
      expect(normalizeSkillQuery(query)).toEqual(protocol.normalizeSkillQuery(query));
    }
    for (const count of [0, 999, 1500, 2_000_000]) {
      expect(formatSkillInstalls(count)).toBe(protocol.formatSkillInstalls(count));
    }
  });

  it("lists skills.sh results sorted by installs and marks popular sources", async () => {
    const net = fake({
      skills: [
        { source: "someone/skills", skillId: "pdf-tool", name: "pdf-tool", installs: 120 },
        { source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 238446 },
      ],
    });
    let out = "";
    await skillSearchCommand(["pdf", "--owner", "Anthropics"], {
      fetch: net.fetchImpl,
      write: (text) => (out += text),
    });
    expect(net.calls).toEqual(["https://skills.sh/api/search?q=pdf&owner=anthropics"]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("skills.sh 上「pdf」的结果（2 个，按安装量排序）：");
    expect(lines[1]).toMatch(/^anthropics\/skills\/pdf\s+238.4K 次安装 {2}常用来源$/);
    expect(lines[2]).toMatch(/^someone\/skills\/pdf-tool\s+120 次安装$/);
    expect(out).toContain("MCP 与技能 → 发现 / 安装 → 技能");
  });

  it("prints JSON with --json, the same shape the web uses", async () => {
    const net = fake({ skills: [{ source: "a/b", skillId: "c", name: "c", installs: 1 }] });
    let out = "";
    await skillSearchCommand(["c c", "--json"], {
      fetch: net.fetchImpl,
      write: (text) => (out += text),
    });
    expect(JSON.parse(out)).toEqual({
      query: "c c",
      skills: [
        { id: "a/b/c", source: "a/b", skillId: "c", name: "c", installs: 1, popular: false },
      ],
    });
  });

  it("explains bad input and an unreachable skills.sh", async () => {
    const net = fake({});
    await expect(skillSearchCommand(["x"], { fetch: net.fetchImpl })).rejects.toThrow(/用法/);
    await expect(
      skillSearchCommand(["pdf", "--owner", "no/slash"], { fetch: net.fetchImpl }),
    ).rejects.toThrow(/--owner/);
    expect(net.calls).toEqual([]);
    await expect(skillSearchCommand(["pdf"], { fetch: fake({}, 503).fetchImpl })).rejects.toThrow(
      /HTTP 503/,
    );
    expect(formatSkillResults([], "zzz")).toContain("没有找到「zzz」");
  });
});
