import { useRef, useState } from "react";
import { LIMITS, type Todo, type TodoInput, type Participant } from "@superhive/protocol";
import { Button, IconButton } from "./button";
import { Icon } from "./app-icons";
import { t } from "./i18n";
import type { todoApi } from "./todo-api";
import { createClientMessageId } from "./client-id";
import { ContextMenu, type ContextMenuState } from "./context-menu";
import { ConfirmPopover } from "./confirm-popover";

type TodoActions = ReturnType<typeof todoApi>;

export function TodoPanel({
  todos,
  members,
  canManage,
  actions,
  onLocate,
}: {
  todos: Todo[];
  members: Participant[];
  canManage: boolean;
  actions: TodoActions;
  onLocate: (todo: Todo) => void;
}) {
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const [moving, setMoving] = useState(false);
  const open = todos
    .filter((todo) => !todo.completed)
    .sort(
      (first, second) =>
        (first.sortOrder ?? 0) - (second.sortOrder ?? 0) ||
        second.createdAt.localeCompare(first.createdAt),
    );
  const done = todos
    .filter((todo) => todo.completed)
    .sort((first, second) => (second.completedAt ?? "").localeCompare(first.completedAt ?? ""));
  async function move(todo: Todo, direction: "up" | "down") {
    if (moving) return;
    setMoving(true);
    setError(undefined);
    try {
      await actions.move(todo.id, direction);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMoving(false);
    }
  }
  const item = (todo: Todo, index: number) => (
    <TodoItem
      key={todo.id}
      todo={todo}
      members={members}
      canManage={canManage}
      actions={actions}
      onLocate={onLocate}
      canMoveUp={!todo.completed && index > 0}
      canMoveDown={!todo.completed && index < open.length - 1}
      moving={moving}
      onMove={(direction) => void move(todo, direction)}
    />
  );
  return (
    <section className="progress-section todos" aria-labelledby="progress-todos">
      <h3 id="progress-todos">
        <span className="progress-dot" aria-hidden="true" />
        {t("待办")}
        {open.length > 0 && <span className="progress-count">{open.length}</span>}
      </h3>
      {!open.length && (
        <p className="todo-hint">
          {t("以后要做的事记在这里；正在做、已交付或阻塞的事项记在进展白板。")}
        </p>
      )}
      {canManage ? (
        <form
          className="todo-add"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!title.trim() || adding) return;
            setAdding(true);
            setError(undefined);
            try {
              await actions.add({
                title: title.trim(),
                notes: "",
                assigneeId: null,
                sourceMessageId: null,
              });
              setTitle("");
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason));
            } finally {
              setAdding(false);
            }
          }}
        >
          <input
            aria-label={t("待办标题")}
            placeholder={t("记下一件以后要做的事…")}
            value={title}
            maxLength={LIMITS.maxTodoTitleLength}
            onChange={(event) => setTitle(event.target.value)}
            disabled={adding}
          />
          <Button type="submit" size="sm" loading={adding} disabled={!title.trim()}>
            {t("添加")}
          </Button>
        </form>
      ) : (
        <p className="todo-hint">{t("当前只读：需要房间成员权限和有效连接才能修改待办。")}</p>
      )}
      {error && (
        <p role="alert" className="todo-error">
          {error}
        </p>
      )}
      <ul className="todo-list">{open.map(item)}</ul>
      {!open.length && <p className="todo-empty">{t("没有未完成的待办")}</p>}
      {done.length > 0 && (
        <details className="todo-completed">
          <summary>{t("已完成 ({0})", { 0: done.length })}</summary>
          <ul className="todo-list">{done.map(item)}</ul>
        </details>
      )}
    </section>
  );
}

function TodoItem({
  todo,
  members,
  canManage,
  actions,
  onLocate,
  canMoveUp,
  canMoveDown,
  moving,
  onMove,
}: {
  todo: Todo;
  members: Participant[];
  canManage: boolean;
  actions: TodoActions;
  onLocate: (todo: Todo) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  moving: boolean;
  onMove: (direction: "up" | "down") => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TodoInput>(todo);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState>();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [assigning, setAssigning] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [handoffId, setHandoffId] = useState(createClientMessageId);
  const [editAgentId, setEditAgentId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run(action: () => Promise<void>, after?: () => void) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
      after?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const agents = members.filter((member) => member.type === "agent");
  function closeMenu() {
    setMenu(undefined);
    menuButtonRef.current?.focus({ preventScroll: true });
  }
  return (
    <li className={`progress-item todo-item${todo.completed ? " completed" : ""}`}>
      <div className="progress-row todo-row">
        <div className="todo-heading">
          <input
            type="checkbox"
            checked={todo.completed}
            disabled={!canManage || busy}
            aria-label={t("完成待办：{0}", { 0: todo.title })}
            onChange={(event) =>
              void run(() => actions.update(todo.id, { completed: event.target.checked }))
            }
          />
          <span className="progress-title todo-title" title={todo.title}>
            {todo.title}
          </span>
          {canManage && !todo.completed && (canMoveUp || canMoveDown) && renderOrderControls()}
          {canManage && (
            <IconButton
              ref={menuButtonRef}
              size="sm"
              variant="secondary"
              className="todo-menu-trigger"
              label={t("待办操作：{0}", { 0: todo.title })}
              aria-haspopup="menu"
              aria-expanded={Boolean(menu)}
              disabled={busy}
              onClick={(event) => {
                if (menu) return closeMenu();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({
                  x: rect.right,
                  y: rect.bottom + 4,
                  align: "end",
                  title: t("待办操作"),
                  items: [
                    ...(!todo.completed
                      ? [
                          {
                            label: t("交给 Agent"),
                            disabled: !agents.length,
                            onSelect: () => {
                              setAssigning(true);
                              setEditing(false);
                            },
                          },
                        ]
                      : []),
                    {
                      label: t("编辑待办"),
                      onSelect: () => {
                        setDraft(todo);
                        setEditAgentId(undefined);
                        setEditing(true);
                        setAssigning(false);
                      },
                    },
                    "separator",
                    { label: t("删除"), onSelect: () => setConfirmDelete(true) },
                  ],
                });
              }}
            >
              <Icon name="more" size={16} />
            </IconButton>
          )}
        </div>
        <div className="progress-meta todo-meta">
          <span
            aria-label={t("由 {0} 添加", { 0: todo.creatorName })}
            title={t("由 {0} 添加", { 0: todo.creatorName })}
          >
            <span className="todo-attribution">{todo.creatorName}</span>
          </span>
          <span title={t("负责人：{0}", { 0: todo.assigneeName ?? t("未指派") })}>
            <span className="todo-attribution">
              {t("负责人：{0}", { 0: todo.assigneeName ?? t("未指派") })}
            </span>
          </span>
          {todo.sourceMessageId && (
            <span className="todo-source">
              <Button
                size="sm"
                variant="link"
                aria-label={t("查看来源消息 #{0}", { 0: todo.sourceMessageSeq ?? "" })}
                onClick={() => onLocate(todo)}
              >
                {t("来源 #{0}", { 0: todo.sourceMessageSeq ?? "" })}
              </Button>
            </span>
          )}
        </div>
        {todo.notes && !editing && <p className="todo-notes">{todo.notes}</p>}
        {canManage && editing && (
          <form
            className="todo-edit"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                async () => {
                  await actions.update(todo.id, {
                    title: draft.title,
                    notes: draft.notes,
                    assigneeId: editAgentId && !todo.completed ? todo.assigneeId : draft.assigneeId,
                  });
                  if (editAgentId && !todo.completed)
                    await actions.handoff(todo.id, editAgentId, handoffId);
                },
                () => {
                  setEditing(false);
                  setEditAgentId(undefined);
                  setHandoffId(createClientMessageId());
                },
              );
            }}
          >
            <label>
              {t("待办标题")}
              <input
                autoFocus
                value={draft.title}
                required
                maxLength={LIMITS.maxTodoTitleLength}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </label>
            <label>
              {t("待办备注")}
              <textarea
                value={draft.notes}
                maxLength={LIMITS.maxTodoNoteLength}
                rows={3}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              />
            </label>
            <label>
              {t("负责人")}
              <select
                value={draft.assigneeId ?? ""}
                onChange={(event) => {
                  setDraft({ ...draft, assigneeId: event.target.value || null });
                  setEditAgentId(agents.find((agent) => agent.id === event.target.value)?.id);
                  setHandoffId(createClientMessageId());
                }}
              >
                <option value="">{t("未指派")}</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.username}
                  </option>
                ))}
              </select>
            </label>
            {editAgentId && !todo.completed && (
              <p className="todo-hint">
                {t("以你的名义发送一条 @ 消息；离线的 Agent 上线后接活。")}
              </p>
            )}
            <div className="todo-actions">
              <Button size="sm" onClick={() => setEditing(false)} disabled={busy}>
                {t("取消")}
              </Button>
              <Button type="submit" size="sm" loading={busy}>
                {editAgentId && !todo.completed ? t("保存并派给 Agent") : t("保存")}
              </Button>
            </div>
          </form>
        )}
        {canManage && !todo.completed && assigning && (
          <form
            className="todo-handoff"
            onSubmit={(event) => {
              event.preventDefault();
              if (agentId)
                void run(
                  () => actions.handoff(todo.id, agentId, handoffId),
                  () => {
                    setAssigning(false);
                    setHandoffId(createClientMessageId());
                  },
                );
            }}
          >
            <label>
              {t("选择 Agent")}
              <select
                autoFocus
                value={agentId}
                onChange={(event) => {
                  setAgentId(event.target.value);
                  setHandoffId(createClientMessageId());
                }}
                required
              >
                <option value="">{t("选择 Agent")}</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.username}
                    {agent.status === "offline" ? ` · ${t("离线")}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="todo-hint">{t("以你的名义发送一条 @ 消息；离线的 Agent 上线后接活。")}</p>
            <Button type="submit" size="sm" loading={busy} disabled={!agentId}>
              {t("发送任务")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setAssigning(false);
                menuButtonRef.current?.focus({ preventScroll: true });
              }}
            >
              {t("取消")}
            </Button>
          </form>
        )}
        {canManage && confirmDelete && (
          <ConfirmPopover
            anchorRef={menuButtonRef}
            ariaLabel={t("删除这条待办？")}
            title={t("删除这条待办？")}
            message={todo.title}
            confirmLabel={t("确认删除")}
            cancelLabel={t("取消")}
            danger
            busy={busy}
            onCancel={() => {
              if (busy) return;
              setConfirmDelete(false);
              menuButtonRef.current?.focus({ preventScroll: true });
            }}
            onConfirm={() =>
              void run(
                () => actions.remove(todo.id),
                () => setConfirmDelete(false),
              )
            }
          />
        )}
        {error && (
          <p className="todo-error" role="alert">
            {error}
          </p>
        )}
        {canManage && menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      </div>
    </li>
  );

  function renderOrderControls() {
    return (
      <span className="todo-order">
        <IconButton
          size="sm"
          label={t("上移待办：{0}", { 0: todo.title })}
          disabled={!canMoveUp || busy || moving}
          onClick={() => onMove("up")}
        >
          <Icon name="arrow-up" size={12} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("下移待办：{0}", { 0: todo.title })}
          disabled={!canMoveDown || busy || moving}
          onClick={() => onMove("down")}
        >
          <Icon name="arrow-down" size={12} />
        </IconButton>
      </span>
    );
  }
}
