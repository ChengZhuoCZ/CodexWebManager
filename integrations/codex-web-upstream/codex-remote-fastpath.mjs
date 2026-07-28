const FAST_LOCAL_METHODS = new Map([
  [
    "app/list",
    Object.freeze({
      data: Object.freeze([]),
      nextCursor: null,
    }),
  ],
  [
    "mcpServerStatus/list",
    Object.freeze({
      data: Object.freeze([]),
      nextCursor: null,
    }),
  ],
  [
    "plugin/list",
    Object.freeze({
      featuredPluginIds: Object.freeze([]),
      marketplaceLoadErrors: Object.freeze([]),
      marketplaces: Object.freeze([]),
    }),
  ],
]);

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeId(value) {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 256) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function eligibleDefaultRead(request) {
  if (
    !isRecord(request) ||
    !safeId(request.id) ||
    typeof request.method !== "string" ||
    !FAST_LOCAL_METHODS.has(request.method)
  ) {
    return false;
  }
  const params = request.params ?? {};
  if (!isRecord(params)) {
    return false;
  }
  if (
    params.forceRefetch === true ||
    params.forceRefresh === true ||
    (typeof params.threadId === "string" && params.threadId.length > 0)
  ) {
    return false;
  }
  return true;
}

export function localStartupRpcResponse(line) {
  if (typeof line !== "string" || line.length === 0 || line.length > 1024 * 1024) {
    return null;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return null;
  }
  if (!eligibleDefaultRead(request)) {
    return null;
  }
  return `${JSON.stringify({
    id: request.id,
    result: FAST_LOCAL_METHODS.get(request.method),
  })}\n`;
}
