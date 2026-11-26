import { useState } from "react";
import { LIMITS, type Todo, type TodoInput, type Participant } from "@superhive/protocol";
import { Button, IconButton } from "./button";
import { Icon } from "./app-icons";
import { t } from "./i18n";
import type { todoApi } from "./todo-api";
import { createClientMessageId } from "./client-id";

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
  const open = todos
    .filter((todo) => !todo.completed)
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  const done = todos
    .filter((todo) => todo.completed)
    .sort((first, second) => (second.completedAt ?? "").localeCompare(first.completedAt ?? ""));
  const item = (todo: Todo) => (
    <TodoItem
      key={todo.id}
      todo={todo}
      members={members}
      canManage={canManage}
      actions={actions}
      onLocate={onLocate}
    />
  );
  return (
    <section className="todos">
      <p className="todo-hint">
        {t("以后要做的事记在这里；正在做、已交付或阻塞的事项记在进展白板。")}
      </p>
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
}: {
  todo: Todo;
  members: Participant[];
  canManage: boolean;
  actions: TodoActions;
  onLocate: (todo: Todo) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TodoInput>(todo);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [handoffId, setHandoffId] = useState(createClientMessageId);
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
  return (
    <li className={`todo-item${todo.completed ? " completed" : ""}`}>
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
        <span className="todo-title">{todo.title}</span>
        {canManage && (
          <IconButton
            size="sm"
            label={t("编辑待办")}
            disabled={busy}
            onClick={() => {
              setDraft(todo);
              setEditing(!editing);
            }}
          >
            <Icon name="more" size={13} />
          </IconButton>
        )}
      </div>
      {todo.notes && !editing && <p className="todo-notes">{todo.notes}</p>}
      <div className="todo-meta">
        <span>{t("由 {0} 添加", { 0: todo.creatorName })}</span>
        {todo.assigneeName && <span>{t("负责人：{0}", { 0: todo.assigneeName })}</span>}
      </div>
      {todo.sourceMessageId && (
        <Button size="sm" variant="link" onClick={() => onLocate(todo)}>
          {t("查看来源消息 #{0}", { 0: todo.sourceMessageSeq ?? "" })}
        </Button>
      )}
      {canManage && editing && (
        <form
          className="todo-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                actions.update(todo.id, {
                  title: draft.title,
                  notes: draft.notes,
                  assigneeId: draft.assigneeId,
                }),
              () => setEditing(false),
            );
          }}
        >
          <label>
            {t("待办标题")}
            <input
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
              onChange={(event) => setDraft({ ...draft, assigneeId: event.target.value || null })}
            >
              <option value="">{t("未指派")}</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.username}
                </option>
              ))}
            </select>
          </label>
          <div className="todo-actions">
            <Button size="sm" onClick={() => setEditing(false)} disabled={busy}>
              {t("取消")}
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              {t("保存")}
            </Button>
          </div>
        </form>
      )}
      {canManage && !editing && (
        <div className="todo-actions">
          {!todo.completed && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !agents.length}
              onClick={() => setAssigning(!assigning)}
            >
              {t("交给 Agent")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            disabled={busy}
            onClick={() => setConfirmDelete(!confirmDelete)}
          >
            {t("删除")}
          </Button>
        </div>
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
        </form>
      )}
      {canManage && confirmDelete && (
        <div className="todo-actions">
          <span>{t("删除这条待办？")}</span>
          <Button size="sm" disabled={busy} onClick={() => setConfirmDelete(false)}>
            {t("取消")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={busy}
            onClick={() => void run(() => actions.remove(todo.id))}
          >
            {t("确认删除")}
          </Button>
        </div>
      )}
      {error && (
        <p className="todo-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
