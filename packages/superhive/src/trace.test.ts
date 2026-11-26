import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeStream } from "./claude-stream.js";
import type { TraceStep } from "./hive-protocol.js";
import {
  claudeToolSummary,
  isMutatingStep,
  isHandoffSafeStep,
  isHiveProgress,
  redactTrace,
  sanitizeTraceStep,
  THINKING_TEXT_STEPS_MAX,
  ThinkingTrace,
  thinkingText,
  traceSummary,
} from "./trace.js";
import { isIrreversibleStep } from "./trace.js";

describe("execution trace", () => {
  it("masks common secrets and the home directory before anything leaves the bridge", () => {
    const text = [
      "curl -H 'Authorization: Bearer abcdefghijklmnop' https://user:hunter2@example.com",
      "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx npm publish --token npm_abcdefghijklmnopqrstu",
      "cat /Users/alice/.ssh/config password: s3cretvalue",
    ].join("\n");
    const masked = redactTrace(text, "/Users/alice");
    for (const secret of [
      "abcdefghijklmnop",
      "hunter2",
      "abcdefghijklmnopqrstuvwxyz0123",
      "proj-abcdefghijklmnopqrstuvwx",
      "npm_abcdefghijklmnopqrstu",
      "s3cretvalue",
      "/Users/alice",
    ]) {
      expect(masked).not.toContain(secret);
    }
    expect(masked).toContain("~/.ssh/config");
    expect(masked).toContain("Authorization: ***");
  });

  it("keeps one line per tool and clips long text", () => {
    expect(traceSummary("git add .\ngit commit -m x\ngit push")).toBe("git add . …（共 3 行）");
    expect(traceSummary("x".repeat(1000))).toHaveLength(300);
    const step = sanitizeTraceStep({
      id: "1",
      kind: "text",
      text: "y".repeat(5000),
      startedAt: new Date().toISOString(),
    });
    expect(step.text).toHaveLength(2000);
    expect(claudeToolSummary("Grep", { pattern: "TODO", path: "src" })).toBe("TODO  in src");
    expect(claudeToolSummary("mcp__hive__hive_board_update", {})).toBe("hive_board_update");
  });

  it("turns Claude stream-json into ordered steps: thinking, interim text, tool start and result", () => {
    const steps: TraceStep[] = [];
    const stream = new ClaudeStream(
      () => undefined,
      (step) => steps.push(step),
    );
    const lines = [
      { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      {
        type: "assistant",
        message: { id: "m1", content: [{ type: "text", text: "先看一下改动" }] },
      },
      {
        type: "assistant",
        message: {
          id: "m1",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] },
      },
    ];
    stream.push(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    expect(
      steps.map((step) => [step.kind, step.status ?? "", step.text ?? step.summary ?? ""]),
    ).toEqual([
      ["thinking", "running", ""],
      ["thinking", "ok", ""],
      ["text", "", "先看一下改动"],
      ["tool", "running", "git status"],
      ["tool", "error", "git status"],
    ]);
    expect(steps[4]).toMatchObject({ id: "t1", tool: "command", name: "Bash" });
    expect(steps[4]!.endedAt).toBeDefined();
  });
});

describe("ClaudeStream session", () => {
  it("reports the session id from the init event before the turn ends", () => {
    const sessions: string[] = [];
    const stream = new ClaudeStream(
      () => undefined,
      () => undefined,
      (id) => sessions.push(id),
    );
    stream.push(
      JSON.stringify({ type: "system", subtype: "init", session_id: "8e999bcd-f5ec" }) + "\n",
    );
    expect(sessions).toEqual(["8e999bcd-f5ec"]);
  });
});

describe("isMutatingStep", () => {
  const step = (tool: TraceStep["tool"], summary: string, name?: string): TraceStep => ({
    id: "x",
    kind: "tool",
    tool,
    summary,
    ...(name ? { name } : {}),
    startedAt: new Date().toISOString(),
  });
  it("allows preparation handoff without making its side effects replayable", () => {
    for (const name of ["hive.hive_worktree_create", "mcp__hive__hive_board_update"]) {
      const preparation = step("collaboration", name, name);
      expect(isHandoffSafeStep(preparation)).toBe(true);
      expect(isMutatingStep(preparation)).toBe(true);
    }
    const progress = {
      ...step("collaboration", "progress", "hive.hive_message_send"),
      hiveProgress: true as const,
    };
    expect(isHandoffSafeStep(progress)).toBe(true);
    expect(isMutatingStep(progress)).toBe(true);
    expect(sanitizeTraceStep(progress)).not.toHaveProperty("hiveProgress");
    expect(isHandoffSafeStep(step("collaboration", "list", "hive.hive_worktree_list"))).toBe(true);
    for (const name of [
      "hive.hive_message_send",
      "hive.hive_ask_human",
      "hive.hive_invoke",
      "evil.hive_worktree_create",
      "mcp__evil__hive_board_update",
    ]) {
      expect(isHandoffSafeStep(step("collaboration", "progress: true", name))).toBe(false);
    }
    expect(isHandoffSafeStep(step("write", "file"))).toBe(false);
    expect(isHandoffSafeStep(step("command", "git status"))).toBe(true);
  });

  it("identifies progress from strict tool arguments, not descriptions or other servers", () => {
    expect(isHiveProgress("hive.hive_message_send", { progress: true })).toBe(true);
    expect(isHiveProgress("mcp__hive__hive_message_send", '{"progress":true}')).toBe(true);
    for (const input of [
      undefined,
      null,
      "not JSON",
      "true",
      [],
      { progress: "true" },
      { progress: false },
      { content: "progress: true" },
    ]) {
      expect(isHiveProgress("hive.hive_message_send", input)).toBe(false);
    }
    expect(isHiveProgress("evil.hive_message_send", { progress: true })).toBe(false);
  });
  it("treats reads, searches and plainly read-only commands as safe to re-run", () => {
    expect(isMutatingStep(step("read", "src/a.ts"))).toBe(false);
    expect(
      isMutatingStep(step("collaboration", "hive_todo_list", "mcp__hive__hive_todo_list")),
    ).toBe(false);
    expect(isMutatingStep(step("collaboration", "hive_todo_add", "mcp__hive__hive_todo_add"))).toBe(
      true,
    );
    expect(
      isMutatingStep(step("collaboration", "hive_todo_update", "mcp__hive__hive_todo_update")),
    ).toBe(true);
    expect(isMutatingStep(step("search", "TODO"))).toBe(false);
    expect(isMutatingStep(step("command", "git status && git log --oneline -3"))).toBe(false);
    expect(isMutatingStep(step("command", "cd apps/web && ls -la | wc -l"))).toBe(false);
    expect(
      isMutatingStep(step("collaboration", "hive_room_read", "mcp__hive__hive_room_read")),
    ).toBe(false);
  });
  it("treats edits, unknown or redirecting commands and messages as side effects", () => {
    expect(isMutatingStep(step("write", "src/a.ts"))).toBe(true);
    expect(isMutatingStep(step("command", "git commit -m x"))).toBe(true);
    expect(isMutatingStep(step("command", "pnpm test"))).toBe(true);
    expect(isMutatingStep(step("command", "echo hi > a.txt"))).toBe(true);
    expect(isMutatingStep(step("command", "sed -i s/a/b/ f"))).toBe(true);
    expect(
      isMutatingStep(step("collaboration", "hive_message_send", "mcp__hive__hive_message_send")),
    ).toBe(true);
    expect(isMutatingStep(step("other", "canva.create"))).toBe(true);
  });
  it("catches multi-line scripts, substitutions, dangerous flags and writing redirects", () => {
    for (const command of [
      "ls\nrm -rf build",
      "echo $(rm a)",
      "echo `rm a`",
      "diff <(cat a) b",
      "find . -delete",
      "find . -exec rm {} +",
      "env rm a",
      "sed 'w out' a",
      "awk 'BEGIN{system(\"rm a\")}'",
      "sort -o f f",
      "date -s 2020",
      "git branch -D x",
      "git remote add o url",
      "git diff --output=x",
      "ls 2>err.txt",
      "sleep 100 &",
      "/bin/zsh -lc 'git commit -m x'",
      "ls & rm a",
      "ls &rm a",
      "rg --pre ./x.sh foo",
      "rg --pre=rm x",
      "git grep -O'rm' foo",
      "git log --output=x",
      "git show --output=x",
      "uniq in.txt out.txt",
      "tree -o out.txt",
      "GIT_EXTERNAL_DIFF=./x git diff",
      "PAGER=./x git log",
      // 引号外的 | 才是管道：引号里藏着的东西不能逃过检查
      "rg 'a|b' src | sh",
      "sed -n '1,5p;w out' f",
      "sed -n -i '1,5p' f",
      "cat <<EOF\nrm a\nEOF",
      'echo "$(rm a)"',
      "command rm a",
      "if true; then rm a; fi",
      "for f in *; do rm $f; done",
      "git branch new-branch",
      "git worktree add ../x",
      "git fetch --upload-pack=./x origin",
      "git -C /repo commit -m x",
      "git -c core.pager=./x -C /repo log",
      "git -C /repo -c alias.st=!rm st",
      "git --exec-path=./x status",
      "git ls-remote -u ./x origin",
      "ls > /dev/nullx",
      "/bin/zsh -lc 'ls '\\''a'\\''; rm a'",
    ]) {
      expect(isMutatingStep(step("command", command)), command).toBe(true);
    }
    for (const command of [
      "git branch -a",
      "git remote -v",
      "ls 2>/dev/null",
      "rg TODO src 2>&1 | head",
      "/bin/zsh -lc 'git status && git log --oneline -3'",
      "LANG=C git status",
      "NO_COLOR=1 git diff",
      // Codex 只读探查的常见写法：引号里的 | ; > 不是管道或重定向
      "rg -n '连接 IM|右下|bottom-.*right' apps/web/src | head -80",
      "rg -n 'a>b;c' src",
      "printf '\\nSIDEBAR\\n'; sed -n '5670,5945p' apps/web/src/App.tsx",
      "pwd; git status --short; if [ -d .codegraph ]; then printf 'yes\\n'; command -v codegraph; else printf 'no\\n'; fi",
      "for f in a b; do wc -l $f; done",
      "git worktree list; git branch --list 'feat/*'; git merge-base main HEAD",
      "git status --short; git fetch origin release/2.5.0 feat/x; git rev-parse origin/release/2.5.0",
      // rd-codex 2026-11-18 23:44 的原始命令：看另一个 worktree 的分支、提交和改动
      "printf 'DOCS TASK\\n'; git -C /Users/me/wt/docs branch --show-current; git -C /Users/me/wt/docs rev-parse --short HEAD; git -C /Users/me/wt/docs status --short; git -C /Users/me/wt/docs diff --stat; pwd; git status --short",
      "git --no-pager -C ../other log --oneline -3",
      "git --git-dir=/repo/.git --work-tree=/repo status",
      "ls >/dev/null 2>&1 && echo ok",
      "/bin/zsh -lc 'rg -n '\\''a|b'\\'' src; sed -n '\\''1,20p'\\'' f'",
    ]) {
      expect(isMutatingStep(step("command", command)), command).toBe(false);
    }
  });
  it("judges hive tools by name only, not by text in their arguments", () => {
    expect(
      isMutatingStep(
        step(
          "collaboration",
          "hive_message_send  提到 hive_board_read",
          "mcp__hive__hive_message_send",
        ),
      ),
    ).toBe(true);
    expect(
      isMutatingStep(step("collaboration", "hive.hive_board_read", "hive.hive_board_read")),
    ).toBe(false);
  });
});

describe("ThinkingTrace", () => {
  afterEach(() => vi.useRealTimers());

  function tracker() {
    vi.useFakeTimers();
    const steps: TraceStep[] = [];
    let now = 0;
    const thinking = new ThinkingTrace(
      (step) => steps.push(step),
      () => now,
    );
    return { thinking, steps, advance: (ms: number) => ((now += ms), vi.advanceTimersByTime(ms)) };
  }

  it("accumulates fragments on one step id and updates it at most once a second", () => {
    const { thinking, steps, advance } = tracker();
    thinking.start("th");
    thinking.append("th", "先看");
    thinking.append("th", "一下");
    // 开始时报一次，不到 1 秒的片段先攒着
    expect(steps.map((step) => step.text)).toEqual([undefined]);
    advance(1_000);
    expect(steps.at(-1)).toMatchObject({
      id: "th",
      kind: "thinking",
      status: "running",
      text: "先看一下",
    });
    thinking.append("th", "改动");
    thinking.end("th");
    expect(steps.at(-1)).toMatchObject({ id: "th", status: "ok", text: "先看一下改动" });
    expect(steps.at(-1)!.endedAt).toBeDefined();
    // 结束后不再有迟到的更新
    advance(5_000);
    expect(steps).toHaveLength(3);
  });

  it("keeps the tail of long thinking and redacts secrets", () => {
    const long = `开头 ${"x".repeat(5_000)} 结尾 api_key=sk-ant-abcdefgh12345678abcd`;
    const text = thinkingText(long);
    expect(text.length).toBe(2_000);
    expect(text.startsWith("…")).toBe(true);
    expect(text).toContain("结尾");
    expect(text).not.toContain("12345678abcd");
    expect(
      sanitizeTraceStep({ id: "t", kind: "thinking", text, startedAt: new Date().toISOString() })
        .text,
    ).toBe(text);
  });

  it("drops the text of the oldest steps beyond the per-turn limit, keeping their duration", () => {
    const { thinking, steps } = tracker();
    for (let index = 0; index <= THINKING_TEXT_STEPS_MAX; index += 1) {
      thinking.start(`th${index}`);
      thinking.append(`th${index}`, `第 ${index} 段`);
      thinking.end(`th${index}`);
    }
    const cleared = steps.filter((step) => step.text === "");
    expect(cleared).toEqual([expect.objectContaining({ id: "th0", status: "ok" })]);
    expect(steps.at(-1)).toMatchObject({
      id: `th${THINKING_TEXT_STEPS_MAX}`,
      text: `第 ${THINKING_TEXT_STEPS_MAX} 段`,
    });
  });

  it("emits no text for thinking without content (redacted)", () => {
    const { thinking, steps } = tracker();
    thinking.start("r");
    thinking.end("r");
    expect(steps.map((step) => [step.status, step.text])).toEqual([
      ["running", undefined],
      ["ok", undefined],
    ]);
  });

  it("puts Claude thinking_delta text on the thinking step; redacted_thinking only keeps time", () => {
    const steps: TraceStep[] = [];
    const stream = new ClaudeStream(
      () => undefined,
      (step) => steps.push(step),
    );
    const event = (value: unknown) => JSON.stringify({ type: "stream_event", event: value });
    stream.push(
      [
        event({ type: "message_start", message: { id: "m1" } }),
        event({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "I'm multiplying " },
        }),
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "17 by 23." },
        }),
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        }),
        event({ type: "content_block_stop", index: 0 }),
        event({
          type: "content_block_start",
          index: 1,
          content_block: { type: "redacted_thinking", data: "x" },
        }),
        event({ type: "content_block_stop", index: 1 }),
      ].join("\n") + "\n",
    );
    const done = steps.filter((step) => step.status === "ok");
    expect(done).toEqual([
      expect.objectContaining({
        id: "thinking:m1:0",
        kind: "thinking",
        text: "I'm multiplying 17 by 23.",
      }),
      expect.objectContaining({ id: "thinking:m1:1", kind: "thinking" }),
    ]);
    expect(done[1]!.text).toBeUndefined();
  });
});

describe("isIrreversibleStep", () => {
  it("flags pushes, publishes, deploys, migrations and outbound sends", () => {
    const tool = (summary: string, name = "command") =>
      ({ id: "x", kind: "tool", tool: "command", name, summary, startedAt: "" }) as const;
    for (const summary of [
      "git push origin main",
      "git -C ../x push",
      "npm publish --access public",
      "pnpm db:migrate",
      "curl -s -X POST https://api.example.com/x",
      "gh pr create --fill",
      "lark-cli im +messages-send --chat-id x",
      "git -c a=b push",
      "git --no-pager push origin",
      "pnpm -r publish",
      "pnpm --filter x publish",
      "changeset publish",
      "docker push img",
      "vercel --prod",
      "curl -d a=b https://x",
      "curl --request POST https://x",
      "gh api -X POST repos/x",
    ])
      expect(isIrreversibleStep(tool(summary)), summary).toBe(true);
    for (const summary of [
      "git status",
      "pnpm test",
      "curl https://example.com",
      "git commit -m x",
    ])
      expect(isIrreversibleStep(tool(summary)), summary).toBe(false);
  });
});
