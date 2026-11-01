/** Only the bounded, sanitized text actually shown to the model; never raw API metadata. */
export type PromptContextEntry = {
  id: string;
  label: string;
  group: string;
  text: string;
};

export type PromptContextSnapshot = { version: 1; entries: PromptContextEntry[] };
export type PromptContextUpdate = {
  mode: "full" | "delta";
  entries: PromptContextEntry[];
  removed: string[];
};

/** Old state files have no snapshot; invalid/newer formats fall back to one full refresh. */
export function isPromptContextSnapshot(value: unknown): value is PromptContextSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<PromptContextSnapshot>;
  return (
    snapshot.version === 1 &&
    Array.isArray(snapshot.entries) &&
    snapshot.entries.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        typeof entry.label === "string" &&
        typeof entry.group === "string" &&
        typeof entry.text === "string",
    ) &&
    new Set(snapshot.entries.map((entry) => entry.id)).size === snapshot.entries.length
  );
}

/** Compare visible semantics by stable identity, not timestamps or API ordering. */
export function diffPromptContext(
  current: PromptContextSnapshot,
  previous: PromptContextSnapshot | undefined,
  full: boolean,
): PromptContextUpdate | undefined {
  if (full || !isPromptContextSnapshot(previous)) {
    return { mode: "full", entries: current.entries, removed: [] };
  }
  const before = new Map(previous.entries.map((entry) => [entry.id, entry]));
  const after = new Map(current.entries.map((entry) => [entry.id, entry]));
  const entries = current.entries.filter((entry) => {
    const old = before.get(entry.id);
    return (
      !old || old.label !== entry.label || old.group !== entry.group || old.text !== entry.text
    );
  });
  const removed = previous.entries
    .filter((entry) => !after.has(entry.id) || after.get(entry.id)!.label !== entry.label)
    .map((entry) => entry.label);
  return entries.length || removed.length ? { mode: "delta", entries, removed } : undefined;
}

export function renderContextEntries(entries: PromptContextEntry[]): string {
  const lines: string[] = [];
  let lastGroup = "";
  for (const entry of entries) {
    if (entry.group && entry.group !== lastGroup) lines.push(`${entry.group}：`);
    lastGroup = entry.group;
    lines.push(entry.text);
  }
  return lines.join("\n");
}
