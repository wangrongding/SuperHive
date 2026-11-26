import { useState } from "react";
import type { RuntimeCredentialProvider } from "@superhive/protocol";
import { AppDialog } from "./app-dialog";
import { t } from "./i18n";
import { RuntimeOverviewBlock, type RuntimeOverviewApi } from "./runtime-overview";
import { McpStore, type RuntimeStoreApi } from "./runtime-store";
import "./styles/runtime-overview.css";

/**
 * 「MCP 与技能」独立大面板：状态栏入口和设置里的按钮都打开它。
 * 两个页签：「已安装」是各 CLI 的统一管理表，「发现 / 安装」是精选 MCP 的卡片商店。
 * 只给 Server 所在电脑上的本机房主（调用方按 local.mode 判断）。
 */

export type RuntimeHubTab = "installed" | "discover";
export type RuntimeHubApi = RuntimeOverviewApi & RuntimeStoreApi;

export function RuntimeHubDialog({
  api,
  initialTab = "installed",
  onJump,
  onClose,
}: {
  api: RuntimeHubApi;
  initialTab?: RuntimeHubTab;
  /** 已安装表里点 CLI 名字：去设置里那个 CLI 的配置 */
  onJump?: (provider: RuntimeCredentialProvider) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<RuntimeHubTab>(initialTab);
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
          onJump={onJump ? (provider) => onJump(provider) : undefined}
          onDiscover={() => setTab("discover")}
        />
      ) : (
        <McpStore api={api} />
      )}
    </AppDialog>
  );
}
