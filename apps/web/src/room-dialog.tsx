import { AUTO_LEAD, isAutoLead } from "./lead-agent";
import { t } from "./i18n";
import { Icon } from "./app-icons";
import { Select } from "./select";
import { AvatarGlyph } from "./avatar";
import { DirectoryPicker, type LocalAgentsState } from "./local-agents";
import type { RefObject, Dispatch, SetStateAction } from "react";
import type { RoomSummary } from "@superhive/protocol";
import { Tooltip } from "./tooltip";
import { Button, IconButton } from "./button";

/** 新建房间 / 房间设置弹窗 */
export function RoomDialog({
  agentProviderByName,
  archiveConfirmOpen,
  clearConfirmOpen,
  clearRoom,
  clearWhiteboard,
  closeRoomDialog,
  currentRoomId,
  isOwner,
  leadCandidates,
  local,
  roomDialog,
  roomDialogBusy,
  roomDialogCloseRef,
  roomDialogError,
  roomDialogGuestFiles,
  roomDialogId,
  roomDialogLead,
  roomDialogName,
  roomDialogRef,
  roomDialogWorkspace,
  roomWorkspacePicking,
  setArchiveConfirmOpen,
  setClearConfirmOpen,
  setClearWhiteboard,
  setRoomArchived,
  setRoomDialogGuestFiles,
  setRoomDialogId,
  setRoomDialogLead,
  setRoomDialogName,
  setRoomDialogWorkspace,
  setRoomWorkspacePicking,
  submitCreateRoom,
  submitRenameRoom,
}: {
  agentProviderByName: Map<string, string | undefined>;
  archiveConfirmOpen: boolean;
  clearConfirmOpen: boolean;
  clearRoom: (room: RoomSummary) => Promise<void>;
  clearWhiteboard: boolean;
  closeRoomDialog: () => void;
  currentRoomId: string;
  isOwner: boolean;
  leadCandidates: (room: RoomSummary) => string[];
  local: LocalAgentsState;
  roomDialog: { mode: "create" } | { mode: "manage"; room: RoomSummary };
  roomDialogBusy: boolean;
  roomDialogCloseRef: RefObject<HTMLButtonElement | null>;
  roomDialogError: string | undefined;
  roomDialogGuestFiles: boolean;
  roomDialogId: string;
  roomDialogLead: string;
  roomDialogName: string;
  roomDialogRef: RefObject<HTMLDivElement | null>;
  roomDialogWorkspace: string;
  roomWorkspacePicking: boolean;
  setArchiveConfirmOpen: Dispatch<SetStateAction<boolean>>;
  setClearConfirmOpen: Dispatch<SetStateAction<boolean>>;
  setClearWhiteboard: Dispatch<SetStateAction<boolean>>;
  setRoomArchived: (room: RoomSummary, archived: boolean) => Promise<void>;
  setRoomDialogGuestFiles: Dispatch<SetStateAction<boolean>>;
  setRoomDialogId: Dispatch<SetStateAction<string>>;
  setRoomDialogLead: Dispatch<SetStateAction<string>>;
  setRoomDialogName: Dispatch<SetStateAction<string>>;
  setRoomDialogWorkspace: Dispatch<SetStateAction<string>>;
  setRoomWorkspacePicking: Dispatch<SetStateAction<boolean>>;
  submitCreateRoom: () => Promise<void>;
  submitRenameRoom: (room: RoomSummary) => Promise<void>;
}) {
  return (
    <div className="room-dialog-layer">
      <button
        className="room-dialog-scrim"
        type="button"
        aria-label={t("关闭房间弹窗")}
        onClick={closeRoomDialog}
      />
      <div
        ref={roomDialogRef}
        className="room-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-dialog-title"
      >
        <header className="room-dialog-header">
          <div>
            <h2 id="room-dialog-title">
              {roomDialog.mode === "create"
                ? t("新建房间")
                : t("房间设置 · # {0}", { 0: roomDialog.room.id })}
            </h2>
          </div>
          <IconButton
            ref={roomDialogCloseRef}
            className="dialog-close"
            label={t("关闭")}
            onClick={closeRoomDialog}
          >
            <Icon name="close" />
          </IconButton>
        </header>
        <form
          className="room-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            if (roomDialog.mode === "create") void submitCreateRoom();
            else void submitRenameRoom(roomDialog.room);
          }}
        >
          {roomDialog.mode === "create" && (
            <label className="room-field">
              <span>{t("房间 ID")}</span>
              <input
                value={roomDialogId}
                onChange={(event) => setRoomDialogId(event.target.value)}
                maxLength={64}
                placeholder={t("例如 frontend")}
                spellCheck={false}
                autoComplete="off"
              />
              <small>{t("仅字母、数字、下划线与连字符；创建后不可修改，Agent 用它加入。")}</small>
            </label>
          )}
          <label className="room-field">
            <span>
              {t("显示名称{0}", { 0: roomDialog.mode === "create" ? t("（可选）") : "" })}
            </span>
            <input
              value={roomDialogName}
              onChange={(event) => setRoomDialogName(event.target.value)}
              maxLength={64}
              placeholder={roomDialog.mode === "create" ? t("默认与房间 ID 相同") : ""}
            />
            <small>{t("仅影响界面展示，可随时修改。")}</small>
          </label>
          {isOwner && (
            <label className="room-field">
              <span>{t("工作区（可选）")}</span>
              <div className="local-launch-cwd-row">
                <input
                  value={roomDialogWorkspace}
                  onChange={(event) => setRoomDialogWorkspace(event.target.value)}
                  maxLength={4096}
                  placeholder={t("例如 ~/Coding/my-project，留空用各 Agent 自己的目录")}
                  spellCheck={false}
                  autoComplete="off"
                />
                {local.enabled && (
                  <Button
                    aria-expanded={roomWorkspacePicking}
                    onClick={() => setRoomWorkspacePicking((current) => !current)}
                  >
                    {t("选择…")}
                  </Button>
                )}
              </div>
              <small>
                {local.mode === "device"
                  ? t(
                      "Server 所在电脑（{0}）上的目录。在网页上启动的本机 Agent 会在这个房间改到这里工作；用命令行手动接入的 Agent 只跟随它启动目录及其上一级（或 --allow-root 追加的目录）。修改后 Agent 等手上的任务做完再切换，并开始新会话。",
                      { 0: local.hostLabel ?? "" },
                    )
                  : t(
                      "这台电脑上的目录。在网页上启动的本机 Agent 会在这个房间改到这里工作；用命令行手动接入的 Agent 只跟随它启动目录及其上一级（或 --allow-root 追加的目录）。修改后 Agent 等手上的任务做完再切换，并开始新会话。",
                    )}
              </small>
            </label>
          )}
          {isOwner && roomDialog.mode === "manage" && (
            <div className="room-field room-field-check">
              <label>
                <input
                  type="checkbox"
                  checked={roomDialogGuestFiles}
                  aria-describedby="room-guest-files-hint"
                  onChange={(event) => setRoomDialogGuestFiles(event.target.checked)}
                />
                {t("允许访客查看工作区文件与改动")}
              </label>
              <small id="room-guest-files-hint">
                {t(
                  "只读：访客能浏览文件、看 git 变更与提交，不能修改；疑似密钥文件（.env、私钥等）的内容始终只有房主能看。默认关闭。",
                )}
              </small>
            </div>
          )}
          {isOwner && roomDialog.mode === "manage" && (
            <label className="room-field">
              <span>{t("主 Agent（可选）")}</span>
              <Select
                value={roomDialogLead}
                onChange={setRoomDialogLead}
                options={[
                  {
                    value: AUTO_LEAD,
                    label: isAutoLead(roomDialog.room)
                      ? t("自动（现在是 {0}）", { 0: roomDialog.room.leadAgent ?? "" })
                      : t("自动"),
                  },
                  { value: "", label: t("不设置") },
                  ...(roomDialogLead &&
                  roomDialogLead !== AUTO_LEAD &&
                  !leadCandidates(roomDialog.room).includes(roomDialogLead)
                    ? [{ value: roomDialogLead, label: roomDialogLead }]
                    : []),
                  ...leadCandidates(roomDialog.room).map((name) => ({
                    value: name,
                    label: name,
                    icon: (
                      <span className="avatar agent select-avatar" aria-hidden="true">
                        <AvatarGlyph
                          type="agent"
                          name={name}
                          provider={agentProviderByName.get(name.toLocaleLowerCase())}
                        />
                      </span>
                    ),
                  })),
                ]}
              />
              {roomDialogLead &&
                roomDialogLead !== AUTO_LEAD &&
                roomDialog.room.id === currentRoomId &&
                !leadCandidates(roomDialog.room).includes(roomDialogLead) && (
                  <small className="room-field-warning" role="alert">
                    {t("主 Agent {0} 已不在这个房间，不带 @ 的消息现在没人接，请重新选择。", {
                      0: roomDialogLead,
                    })}
                  </small>
                )}
              <small>
                {roomDialog.room.id === currentRoomId
                  ? t(
                      "人发的、没有 @ 任何人的消息交给它接话，由它决定自己做还是用 hive_invoke 分派给其他 Agent；带 @ 的消息照常只发给被 @ 的成员。",
                    )
                  : t("进入这个房间后才能从它的 Agent 里选择。")}
              </small>
              <small>
                {roomDialogLead === AUTO_LEAD
                  ? t(
                      "自动：第一个加入的 Agent 当主 Agent（同时进来的优先本机的）；它被删除或移出房间时换成下一个在线的，只是离线不换。",
                    )
                  : t("手动设的不会被自动换掉；选「不设置」后也不再自动设。")}
              </small>
            </label>
          )}
          {isOwner && roomWorkspacePicking && local.enabled && (
            <DirectoryPicker
              load={local.directories}
              value={roomDialogWorkspace}
              onPick={(picked) => {
                setRoomDialogWorkspace(picked);
                setRoomWorkspacePicking(false);
              }}
              onClose={() => setRoomWorkspacePicking(false)}
            />
          )}
          {roomDialogError && (
            <p className="room-dialog-error" role="alert">
              {roomDialogError}
            </p>
          )}
          {roomDialog.mode === "manage" && archiveConfirmOpen && !roomDialog.room.archivedAt && (
            <div className="room-archive-confirmation" role="alert">
              <div>
                <strong>{t("确认归档该房间？")}</strong>
                <p>{t("归档后成员无法再加入，历史消息保留；随时可以恢复。")}</p>
              </div>
              <div className="dialog-actions">
                <Button size="sm" onClick={() => setArchiveConfirmOpen(false)}>
                  {t("取消")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={roomDialogBusy}
                  onClick={() => void setRoomArchived(roomDialog.room, true)}
                >
                  {t("确认归档")}
                </Button>
              </div>
            </div>
          )}
          {roomDialog.mode === "manage" && clearConfirmOpen && (
            <div className="room-archive-confirmation" role="alert">
              <div>
                <strong>{t("确认清空 # {0}？", { 0: roomDialog.room.name })}</strong>
                <p>
                  {t(
                    "将删除这个房间的全部消息和 Agent 调用记录，无法恢复；房间里的 Agent 会从新会话开始。",
                  )}
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={clearWhiteboard}
                    disabled={roomDialogBusy}
                    onChange={(event) => setClearWhiteboard(event.target.checked)}
                  />
                  {t("同时归档当前白板（历史可恢复）")}
                </label>
                <p>
                  {clearWhiteboard
                    ? t(
                        "进行中和阻塞的事项也会一起归档；仍占用工作区的事项会阻止清空，请先清理对应 worktree。",
                      )
                    : t("仅清空聊天与调用记录，保留白板，不解除工作区占用。")}
                </p>
              </div>
              <div className="dialog-actions">
                <Button size="sm" onClick={() => setClearConfirmOpen(false)}>
                  {t("取消")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={roomDialogBusy}
                  onClick={() => void clearRoom(roomDialog.room)}
                >
                  {t("确认清空")}
                </Button>
              </div>
            </div>
          )}
          <footer className="room-dialog-footer dialog-actions">
            {roomDialog.mode === "manage" && (
              <div className="dialog-actions-start room-dialog-secondary">
                {roomDialog.mode === "manage" && local.enabled && !roomDialog.room.archivedAt && (
                  <Tooltip
                    content={
                      local.canManage
                        ? t("仅房主可用，不可恢复")
                        : t("这台设备只能查看。要清空，先申请管理权。")
                    }
                  >
                    <Button
                      tone="danger"
                      disabled={roomDialogBusy || !local.canManage}
                      onClick={() => {
                        setArchiveConfirmOpen(false);
                        setClearWhiteboard(true);
                        setClearConfirmOpen(true);
                      }}
                    >
                      {t("清空房间")}
                    </Button>
                  </Tooltip>
                )}
                {roomDialog.mode === "manage" &&
                  (roomDialog.room.archivedAt ? (
                    <Button
                      disabled={roomDialogBusy}
                      onClick={() => void setRoomArchived(roomDialog.room, false)}
                    >
                      {t("恢复房间")}
                    </Button>
                  ) : (
                    <Tooltip
                      content={roomDialog.room.id === "general" ? t("默认房间不能归档") : undefined}
                    >
                      <Button
                        tone="danger"
                        disabled={roomDialogBusy || roomDialog.room.id === "general"}
                        onClick={() => {
                          setClearConfirmOpen(false);
                          setArchiveConfirmOpen(true);
                        }}
                      >
                        {t("归档房间")}
                      </Button>
                    </Tooltip>
                  ))}
              </div>
            )}
            <Button type="submit" variant="primary" disabled={roomDialogBusy}>
              {roomDialog.mode === "create" ? t("创建房间") : t("保存")}
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}
