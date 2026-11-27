import { useState } from "react";
import type { RuntimeCredentialProvider } from "@superhive/protocol";
import { AppDialog } from "./app-dialog";
import { t } from "./i18n";
import {
  RuntimeOverviewBlock,
  type OverviewKind,
  type RuntimeOverviewApi,
} from "./runtime-overview";
import { SkillStore, type SkillStoreApi } from "./runtime-skill-store";
import { McpStore, type RuntimeStoreApi } from "./runtime-store";
import "./styles/runtime-overview.css";

/**
 * 「MCP 与技能」独立大面板：状态栏入口和设置里的按钮都打开它。
 * 两个页签：「已安装」是各 CLI 的统一管理表；「发现 / 安装」里 MCP 是精选卡片商店，
 * 技能是在 skills.sh 上搜、先看内容再装。
 * 只给 Server 所在电脑上的本机房主（调用方按 local.mode 判断）。
 */

export type RuntimeHubTab = "installed" | "discover";
export type RuntimeHubApi = RuntimeOverviewApi & RuntimeStoreApi & SkillStoreApi;

export function RuntimeHubDialog({
  api,
  initialTab = "installed",
  initialKind = "mcp",
  onJump,
  onClose,
}: {
  api: RuntimeHubApi;
  initialTab?: RuntimeHubTab;
  /** 「发现 / 安装」先显示 MCP 还是技能 */
  initialKind?: OverviewKind;
  /** 已安装表里点 CLI 名字：去设置里那个 CLI 的配置 */
  onJump?: (provider: RuntimeCredentialProvider) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<RuntimeHubTab>(initialTab);
  const [kind, setKind] = useState<OverviewKind>(initialKind);
  return (
    <AppDialog
      size="full"
      title={t("MCP 与技能")}
      className="runtime-hub"
      toolbar={
        <div className="runtime-hub-tabs" role="tablist" aria-label={t("MCP 与技能")}>
          {(
            [
              ["installed", t("已安装")],
              ["discover", t("发现 / 安装")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`runtime-hub-tab-${id}`}
              aria-selected={tab === id}
              aria-controls="runtime-hub-panel"
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      }
      bodyId="runtime-hub-panel"
      bodyRole="tabpanel"
      bodyClassName="runtime-hub-body"
      onClose={onClose}
    >
      {tab === "installed" ? (
        <RuntimeOverviewBlock
          api={api}
          initialKind={kind}
          onJump={onJump ? (provider) => onJump(provider) : undefined}
          onDiscover={(next) => {
            setKind(next);
            setTab("discover");
          }}
        />
      ) : (
        <>
          <div
            className="runtime-config-tabs runtime-hub-kinds"
            role="tablist"
            aria-label={t("类型")}
          >
            {(["mcp", "skills"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={kind === item}
                className={kind === item ? "active" : ""}
                onClick={() => setKind(item)}
              >
                {item === "mcp" ? "MCP" : t("技能")}
              </button>
            ))}
          </div>
          {kind === "mcp" ? <McpStore api={api} /> : <SkillStore api={api} />}
        </>
      )}
    </AppDialog>
  );
}
