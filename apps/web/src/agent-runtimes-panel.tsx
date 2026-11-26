import { useCallback, useState, type ReactNode } from "react";
import type { AgentCliTool, RuntimeCredentialProvider } from "@superhive/protocol";
import { t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";
import { AgentClisGroup } from "./agent-clis";
import type { RuntimeConfigSection } from "./runtime-config-panel";
import { Button } from "./button";

/**
 * 设置里的「Agent 运行时」：管理这台电脑上各 Agent CLI 的设置，只给本机房主（调用方按 local.mode 判断）。
 * 由多个独立区块组成，每块自己取数据、自己报错；要加新区块（例如已安装 CLI 的检测与升级），
 * 往 blocks 里加一项即可。
 */

/** 跳到某个 CLI 的配置里某一组：key 每次递增，同一处再点也会重新滚过去 */
type Focus = {
  tool: AgentCliTool | undefined;
  section?: RuntimeConfigSection;
  key?: number;
  jump: (provider: RuntimeCredentialProvider, section: RuntimeConfigSection) => void;
};

type RuntimeBlock = {
  id: string;
  render: (local: LocalAgentsState, focus: Focus, openHub?: () => void) => ReactNode;
};

const blocks: RuntimeBlock[] = [
  {
    id: "hub",
    // MCP 与技能有自己的大面板，这里只留入口
    render: (_local, _focus, openHub) =>
      openHub && (
        <div className="agent-runtime-hub">
          <div>
            <h4>{t("MCP 与技能")}</h4>
            <p>{t("给各 CLI 装 MCP、管理技能，在单独的大面板里做。")}</p>
          </div>
          <Button variant="primary" onClick={openHub}>
            {t("打开 MCP 与技能管理")}
          </Button>
        </div>
      ),
  },
  {
    id: "clis",
    render: (local, focus) => (
      <AgentClisGroup
        api={local}
        focusTool={focus.tool}
        focusSection={focus.section}
        focusKey={focus.key}
      />
    ),
  },
];

/** focusTool：从别处（例如接入 Agent 弹窗）跳过来时，滚到并突出这个 CLI */
export function AgentRuntimesPanel({
  local,
  focusTool,
  openHub,
}: {
  local: LocalAgentsState;
  focusTool?: AgentCliTool | undefined;
  /** 打开「MCP 与技能」大面板 */
  openHub?: () => void;
}) {
  const [jumped, setJumped] = useState<{
    tool: AgentCliTool;
    section: RuntimeConfigSection;
    key: number;
  }>();
  const jump = useCallback((provider: RuntimeCredentialProvider, section: RuntimeConfigSection) => {
    setJumped((current) => ({ tool: provider, section, key: (current?.key ?? 0) + 1 }));
  }, []);
  const focus: Focus = jumped ? { ...jumped, jump } : { tool: focusTool, jump };
  return (
    <section id="settings-panel-runtimes" role="tabpanel" aria-label={t("Agent 运行时")}>
      <div className="settings-panel-heading">
        <h3>{t("Agent 运行时")}</h3>
        <p>
          {t(
            "这台电脑上 Claude Code、Codex 等 CLI 自己的设置，对用它们的所有 Agent 和终端里的 CLI 都生效。只有在运行 Hive Server 的这台电脑上打开网页时才能看到。",
          )}
        </p>
      </div>
      <div className="agent-runtime-blocks">
        {blocks.map((block) => (
          <div key={block.id} className="agent-runtime-block">
            {block.render(local, focus, openHub)}
          </div>
        ))}
      </div>
    </section>
  );
}
