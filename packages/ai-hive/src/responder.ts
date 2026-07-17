export type AgentProvider = "codex" | "claude" | "copilot" | "openclaw" | "echo";
export type AgentAccessMode = "read-only" | "workspace" | "full";

export type AgentReplyInput = {
  instructions: string;
  prompt: string;
  threadId?: string;
};

export type AgentReply = { text: string; threadId?: string };

export interface AgentResponder {
  reply(input: AgentReplyInput): Promise<AgentReply>;
  close?(): Promise<void>;
}

export class EchoResponder implements AgentResponder {
  constructor(private readonly agentName: string) {}

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    const trigger = input.prompt.match(
      /<trigger_message>\s*#\d+ \[[^\]]+\] ([\s\S]*?)\s*<\/trigger_message>/,
    )?.[1];
    return { text: `Echo from ${this.agentName}: ${trigger ?? "收到"}` };
  }
}
