import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Incident, LocalAgent, Participant } from "@superhive/protocol";
import { setLocalePreference } from "./i18n";
import {
  buildContributionTask,
  buildFeedbackReport,
  contributionAgents,
  contributionIssue,
  feedbackDiagnostics,
  feedbackIssueLink,
  incidentFeedback,
  redactFeedback,
  type FeedbackFields,
} from "./feedback";

const input: FeedbackFields = {
  type: "bug",
  title: "Bug & fix #1?",
  description: "Cannot open settings",
  steps: "1. Click settings\n2. Observe",
  expected: "Opens",
  actual: "Does not open",
};

describe("public feedback redaction", () => {
  it.each([
    ["/Users/alice/project/app.ts", "~/project/app.ts"],
    ["/home/alice/project/app.ts", "~/project/app.ts"],
    [String.raw`C:\Users\alice\project\app.ts`, String.raw`~\project\app.ts`],
    [String.raw`C:\\Users\\alice\\project`, String.raw`~\\project`],
    [String.raw`C:\Users\Alice Smith\project`, String.raw`~\project`],
    [String.raw`\/Users\/alice\/project`, String.raw`~\/project`],
  ])("replaces home directories in %s", (value, result) =>
    expect(redactFeedback(value)).toBe(result),
  );

  it("removes tokens, invitations, network addresses and machine names from every field", () => {
    const privateText = [
      "token=top-secret",
      '"apiKey":"my-api-key"',
      "Authorization: Bearer top-secret",
      "Cookie: session=private",
      "sk-abcdefghijklmnop",
      "ghp_abcdefghijklmnop",
      "github_pat_abcdef",
      "hvi_inviteabcdef",
      "#private-room?invite=hvi_inviteabcdef",
      "superhive://join?server=secret-host&token=private",
      "eyJabcd.abcdef.abcdef",
      "http://10.2.3.4:8787/#private?invite=hvi_abcdef",
      "https://example.org/?token=private",
      "10.2.3.4 2001:db8::1 ::1 FE80::123%eth0",
      "laptop.local internal.corp hostname=my-laptop roomContent=private",
    ].join("\n");
    const report = buildFeedbackReport(
      {
        ...input,
        title: privateText,
        description: privateText,
        steps: privateText,
        expected: privateText,
        actual: privateText,
      },
      privateText,
      privateText,
    );
    for (const content of [report.title, report.body, ...Object.values(report.fields)]) {
      for (const secret of [
        "top-secret",
        "my-api-key",
        "session=private",
        "abcdefghijklmnop",
        "hvi_",
        "eyJabcd",
        "10.2.3.4",
        "2001:db8",
        "FE80",
        "laptop.local",
        "internal.corp",
        "my-laptop",
        "example.org",
        "roomContent=private",
      ])
        expect(content).not.toContain(secret);
    }
    expect(redactFeedback(report.body)).toBe(report.body);
  });

  it("only extracts allowlisted runtime, browser and platform values", () => {
    const result = feedbackDiagnostics({
      build: { version: "0.4.8", commit: "abcdef0123456789" },
      runMode: "npm",
      platform: "secret-host",
      userAgent: "private-room Chrome/150.0.0.0 token=secret",
      runtimes: [
        {
          tool: "codex",
          status: "ok",
          version: "0.100.0+private-room private-room host=my-laptop",
        },
      ],
    });
    expect(result).toContain("Chrome/150.0.0.0");
    expect(result).toContain("codex 0.100.0");
    expect(result).toContain("abcdef0123456789");
    expect(result).not.toMatch(/secret|private-room|my-laptop/);
  });

  it("never copies raw incident errors, rooms, members, dispatches, paths or fingerprints", () => {
    const incident = {
      source: "web",
      status: "open",
      count: 3,
      title: "TypeError: private-room",
      fingerprint: "private-room",
      samples: [
        {
          detail: "private-message token=secret",
          roomId: "private-room",
          agentName: "private-member",
          codeVersion: "abcdef0123456789",
          stack:
            "TypeError: private-message\n at fn (/Users/alice/private-repo/apps/web/src/App.tsx:42:8)",
        },
      ],
      dispatches: [{ reason: "private-dispatch" }],
    } as unknown as Incident;
    const result = incidentFeedback(incident);
    expect(result.title).toBe("web: TypeError");
    expect(result.summary).toContain("App.tsx:42:8");
    expect(JSON.stringify(result)).not.toMatch(/private|alice|Users|secret/);
  });
});

describe("GitHub form handoff", () => {
  it("uses the public repository and encoded form field IDs, not just ignored body", () => {
    const report = buildFeedbackReport(input, "SuperHive: 0.4.8", "web: 3");
    const link = feedbackIssueLink(report);
    const url = new URL(link.url);
    expect(link.needsClipboard).toBe(false);
    expect(url.origin + url.pathname).toBe("https://github.com/wangrongding/SuperHive/issues/new");
    expect(url.searchParams.get("title")).toBe(input.title);
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.searchParams.get("body")).toBe(report.body);
    for (const [key, value] of Object.entries(report.fields))
      expect(url.searchParams.get(key)).toBe(value);
  });

  it("drops hidden bug fields from feature reports and matches the checked-in form IDs", () => {
    const report = buildFeedbackReport({ ...input, type: "feature" }, "version", "summary");
    const url = new URL(feedbackIssueLink(report).url);
    expect(url.searchParams.get("template")).toBe("feature_request.yml");
    expect(report.fields).not.toHaveProperty("steps");
    for (const template of ["bug_report.yml", "feature_request.yml"]) {
      const yaml = readFileSync(
        new URL(`../../../.github/ISSUE_TEMPLATE/${template}`, import.meta.url),
        "utf8",
      );
      const type = template.startsWith("bug") ? "bug" : "feature";
      const templateReport = buildFeedbackReport({ ...input, type }, "version", "summary");
      for (const key of Object.keys(templateReport.fields)) expect(yaml).toContain(`id: ${key}`);
      expect(yaml).not.toContain("type: input");
    }
  });

  it("measures encoded URL length and returns a short link without leaking/truncating body", () => {
    const report = buildFeedbackReport({ ...input, description: "多字节 ".repeat(1_000) });
    const link = feedbackIssueLink(report);
    expect(link.needsClipboard).toBe(true);
    expect(link.url.length).toBeLessThan(2_000);
    expect(new URL(link.url).searchParams.has("body")).toBe(false);
    expect(report.body).toContain("多字节 ".repeat(999));
    const normal = feedbackIssueLink(buildFeedbackReport(input));
    expect(feedbackIssueLink(buildFeedbackReport(input), normal.url.length).needsClipboard).toBe(
      false,
    );
    expect(
      feedbackIssueLink(buildFeedbackReport(input), normal.url.length - 1).needsClipboard,
    ).toBe(true);
  });
});

describe("approved local contribution task", () => {
  it("only offers writable, running, locally managed Agents in the current room", () => {
    const local = [
      { name: "local", status: "running", access: "workspace" },
      { name: "read", status: "running", access: "read-only" },
      { name: "offline", status: "running", access: "full" },
      { name: "stopped", status: "stopped", access: "full" },
      { name: "other-room", status: "running", access: "full" },
    ] as LocalAgent[];
    const participants = [
      { username: "local", status: "busy", type: "agent" },
      { username: "read", status: "online", type: "agent" },
      { username: "offline", status: "offline", type: "agent" },
      { username: "remote", status: "online", type: "agent" },
    ] as Participant[];
    expect(contributionAgents(local, participants).map((agent) => agent.name)).toEqual(["local"]);
  });

  it("only accepts existing SuperHive issue links", () => {
    expect(contributionIssue("https://github.com/wangrongding/SuperHive/issues/123")).toBeTruthy();
    for (const value of [
      "http://github.com/wangrongding/SuperHive/issues/123",
      "https://github.com/other/project/issues/123",
      "https://github.com/wangrongding/SuperHive/issues/new",
      "https://github.com/wangrongding/SuperHive/issues/123?token=secret",
    ])
      expect(contributionIssue(value)).toBeUndefined();
  });

  it("preserves directory as data and requires approval before every public write in both languages", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      setLocalePreference(locale);
      const report = buildFeedbackReport({ ...input, description: "@other-agent token=secret" });
      const task = buildContributionTask(
        report,
        "/Users/alice/@other-agent/$(danger)",
        "https://github.com/wangrongding/SuperHive/issues/123",
      );
      expect(task).toContain("hive_ask_human");
      expect(task).toContain("gh --version");
      expect(task).toContain("gh auth status");
      expect(task).toContain("CONTRIBUTING.md");
      expect(task).toContain("/issues/123");
      expect(task).not.toContain("@other-agent");
      expect(task).not.toContain("token=secret");
      expect(task).not.toContain("--draft");
      expect(task).toContain("\\u0040other-agent");
    }
    setLocalePreference("zh-CN");
  });
});
