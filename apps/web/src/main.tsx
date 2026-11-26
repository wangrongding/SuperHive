import "./storage-migration";
import "./scrollbar-mode";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessGate } from "./access-gate";
import { serverBase } from "./server-base";
import { DevStatusBanner } from "./dev-status-banner";
import { SandboxBadge } from "./sandbox-badge";
import { syncDesktopTitlebar } from "./desktop-titlebar";
import { installStaleChunkRecovery } from "./stale-chunk";
import "./styles.css";

// 桌面端：顶栏高度和主题颜色同步给窗口按钮（浏览器里什么都不做）
syncDesktopTitlebar();
// 发版后旧页面加载不到按需拆分的代码块：自动刷新一次（访客页面也要）
installStaleChunkRecovery();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccessGate />
    {import.meta.env.DEV ? <DevStatusBanner /> : null}
    <SandboxBadge base={serverBase()} />
  </StrictMode>,
);
