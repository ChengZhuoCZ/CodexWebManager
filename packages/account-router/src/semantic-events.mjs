const PREFLIGHT_EVENT_TYPES = new Set([
  "codex.rate_limits",
  "codex.response.metadata",
  "response.created",
  "response.in_progress",
  "response.queued",
]);

const TERMINAL_EVENT_TYPES = new Set([
  "error",
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

export function classifyResponseEvent(eventType) {
  if (typeof eventType === "string" && PREFLIGHT_EVENT_TYPES.has(eventType)) {
    return "preflight";
  }
  if (typeof eventType === "string" && TERMINAL_EVENT_TYPES.has(eventType)) {
    return "terminal";
  }
  return "semantic";
}

export function isSemanticResponseEvent(eventType) {
  return classifyResponseEvent(eventType) !== "preflight";
}

export const responseEventPolicy = Object.freeze({
  preflight_event_types: Object.freeze([...PREFLIGHT_EVENT_TYPES].sort()),
  terminal_event_types: Object.freeze([...TERMINAL_EVENT_TYPES].sort()),
  unknown_event_behavior: "semantic",
});
