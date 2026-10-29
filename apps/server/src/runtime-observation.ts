import type { RuntimeEvent, RuntimeObservation } from "@ai-hive/protocol";

/** Server timestamps are authoritative. A heartbeat never clears a provider error. */
export function observeRuntime(
  previous: RuntimeObservation | undefined,
  event: RuntimeEvent | undefined,
  now: string,
): RuntimeObservation {
  const next: RuntimeObservation = {
    ...previous,
    observability: previous?.observability ?? "heartbeat",
    lastHeartbeatAt: now,
    history: [...(previous?.history ?? [])],
  };
  if (!event) return next;
  if (event.kind === "capabilities") {
    next.observability = event.observability ?? "partial";
  } else {
    next.lastRuntimeEventAt = now;
    if (event.kind === "activity") {
      next.phase = event.phase ?? "thinking";
      next.lastProgressAt = now;
      next.tool = event.tool;
      if (next.observability === "heartbeat") next.observability = "partial";
    }
    if (event.kind === "provider_error") {
      next.lastError = {
        at: now,
        ...(event.code !== undefined ? { code: event.code } : {}),
        ...(event.retryAttempt !== undefined ? { retryAttempt: event.retryAttempt } : {}),
        ...(event.retryInMs !== undefined
          ? { nextRetryAt: new Date(Date.parse(now) + event.retryInMs).toISOString() }
          : {}),
      };
    }
    // Only explicit evidence of a successful model response clears the active error.
    if (event.kind === "recovered") {
      next.lastProgressAt = now;
      if (next.lastError) next.lastError = { ...next.lastError, recoveredAt: now };
    }
  }
  const last = next.history.at(-1);
  if (
    event.kind === "activity" &&
    last?.kind === "activity" &&
    last.phase === event.phase &&
    last.tool === event.tool
  ) {
    next.history[next.history.length - 1] = { ...event, at: now };
  } else {
    next.history.push({ ...event, at: now });
  }
  next.history = next.history.slice(-12);
  return next;
}
