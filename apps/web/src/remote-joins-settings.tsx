import { useCallback, useEffect, useState } from "react";
import type { RemoteJoin } from "@superhive/protocol";
import { agentProviderLabel } from "./agent-setup";
import { Button } from "./button";
import { localized, t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";
import "./styles/local-agent-updates.css";

const POLL_MS = 5_000;

const statusText: Record<RemoteJoin["status"], string> = localized(() => ({
  online: t("在线"),
  connecting: t("连接中"),
  stopped: t("已离线"),
}));

/** 圆点沿用本机 Agent 列表的样式：在线绿、连接中黄、离线灰 */
const dotClass: Record<RemoteJoin["status"], string> = {
  online: "running",
  connecting: "starting",
  stopped: "stopped",
};

function serverLabel(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

export function remoteJoinSummary(join: RemoteJoin): string {
  const where = `${serverLabel(join.server)} · ${join.roomId ? `#${join.roomId}` : t("所有房间")}`;
  const parts = [statusText[join.status], agentProviderLabel(join.runtime), where];
  if (join.pid) parts.push(join.background ? t("后台进程 {0}", { 0: join.pid }) : t("终端里运行"));
  return parts.join(" · ");
}

/**
 * 设置 · 这台电脑 · 带到别处的 Agent：本机用 hive join 带进别人房间的 Agent。
 * 看得到在哪个 Server、哪个房间、在不在线，能让它离线、重新上线、退出那个房间。
 */
export function RemoteJoinsGroup({ local }: { local: LocalAgentsState }) {
  const { enabled, remoteJoins } = local;
  const [joins, setJoins] = useState<RemoteJoin[]>();
  const [acting, setActing] = useState<string>();
  const [message, setMessage] = useState<{ error: boolean; text: string }>();

  const refresh = useCallback(
    () =>
      remoteJoins().then(setJoins, (reason: unknown) => {
        // 旧版 Server 没有这个接口：整块不显示
        if ((reason as { status?: number }).status === 404) setJoins(undefined);
      }),
    [remoteJoins],
  );
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  if (!enabled || !joins) return null;
  const disabled = !local.canManage;

  const run = (join: RemoteJoin, action: () => Promise<string | undefined>) => {
    setActing(join.id);
    setMessage(undefined);
    action()
      .then((text) => text && setMessage({ error: false, text }))
      .catch((reason: unknown) =>
        setMessage({
          error: true,
          text: reason instanceof Error ? reason.message : String(reason),
        }),
      )
      .finally(() => {
        setActing(undefined);
        void refresh();
      });
  };
  const stop = (join: RemoteJoin) =>
    run(join, async () => {
      await local.remoteJoinAction(join.id, "stop");
      return t("{0} 已离线。", { 0: join.name });
    });
  const start = (join: RemoteJoin) =>
    run(join, async () => {
      const next = await local.remoteJoinAction(join.id, "start");
      return next.status === "online"
        ? t("{0} 已重新上线。", { 0: join.name })
        : t("{0} 已在后台启动，还在连接。", { 0: join.name });
    });
  const leave = (join: RemoteJoin) => {
    if (
      !window.confirm(
        t("让 {0} 退出 {1} 的房间？它会离线，对方房间里不再有它；要再加入需要对方重新邀请。", {
          0: join.name,
          1: serverLabel(join.server),
        }),
      )
    )
      return;
    run(join, async () => {
      const result = await local.removeRemoteJoin(join.id, true);
      return result.left
        ? t("{0} 已退出房间。", { 0: join.name })
        : t("{0} 已离线并从清单里删掉，但没能退出房间：{1}", {
            0: join.name,
            1: result.leaveError ?? "",
          });
    });
  };
  const forget = (join: RemoteJoin) =>
    run(join, async () => {
      await local.removeRemoteJoin(join.id, false);
      return undefined;
    });

  return (
    <div className="settings-group" id="settings-remote-joins">
      <div className="settings-section-heading">
        <div>
          <h4>{t("带到别处的 Agent")}</h4>
          <p>
            {t(
              "这台电脑上用 hive join 带进别人 Hive 房间的 Agent。在这里看它在不在线、让它离线或退出对方的房间。",
            )}
          </p>
        </div>
      </div>
      {joins.length === 0 ? (
        <p className="settings-note">
          {t(
            "还没有。要把 Agent 带进别人的房间，在终端里运行对方给的 hive join 命令，加上 --background 就能关掉终端也在线。",
          )}
        </p>
      ) : (
        <ul className="agent-updates" aria-label={t("带到别处的 Agent")}>
          {joins.map((join) => {
            const live = join.status !== "stopped";
            const busy = acting === join.id;
            return (
              <li key={join.id} className={`local-agent ${dotClass[join.status]}`}>
                <span className="local-agent-dot" aria-hidden="true" />
                <span className="agent-update-main">
                  <strong title={join.server}>{join.name}</strong>
                  <small title={join.logFile ?? undefined}>{remoteJoinSummary(join)}</small>
                  {!live && join.lastError && (
                    <small className="remote-join-error" title={join.lastError}>
                      {t("上次退出：{0}", { 0: join.lastError })}
                    </small>
                  )}
                </span>
                <span className="agent-update-actions">
                  {live ? (
                    <Button size="sm" disabled={disabled || busy} onClick={() => stop(join)}>
                      {t("让它离线")}
                    </Button>
                  ) : (
                    join.canRestart && (
                      <Button size="sm" disabled={disabled || busy} onClick={() => start(join)}>
                        {t("重新上线")}
                      </Button>
                    )
                  )}
                  <Button
                    size="sm"
                    tone="danger"
                    disabled={disabled || busy}
                    onClick={() => leave(join)}
                  >
                    {t("退出房间")}
                  </Button>
                  {!live && (
                    <Button size="sm" disabled={disabled || busy} onClick={() => forget(join)}>
                      {t("从清单删掉")}
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {joins.some((join) => join.pid && !join.background) && (
        <p className="settings-note">
          {t("「终端里运行」的 Agent 关掉终端就会离线；想一直在线，重新上线时会改成后台运行。")}
        </p>
      )}
      {message && (
        <p className={`settings-note${message.error ? " error" : ""}`} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
