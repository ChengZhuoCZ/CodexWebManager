import { createHash } from "node:crypto";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);

const SAFE_HEADER_VALUE_NAMES = new Set(["accept", "content-type"]);

const SAFE_PROTOCOL_FIELDS = new Set([
  "background",
  "call_id",
  "client_version",
  "content",
  "conversation",
  "cursor",
  "description",
  "effort",
  "encrypted_content",
  "format",
  "id",
  "include",
  "input",
  "instructions",
  "max_output_tokens",
  "limit",
  "metadata",
  "model",
  "name",
  "output",
  "parallel_tool_calls",
  "parameters",
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_retention",
  "reasoning",
  "response",
  "role",
  "safety_identifier",
  "service_tier",
  "store",
  "stream",
  "strict",
  "summary",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_p",
  "truncation",
  "type",
  "user",
]);

const STATIC_PATH_SEGMENTS = new Set([
  "alpha",
  "backend-api",
  "codex",
  "compact",
  "delete",
  "get",
  "list",
  "memory",
  "memories",
  "models",
  "responses",
  "retrieve",
  "search",
  "status",
  "v1",
]);

function stableLabel(prefix, value) {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${prefix}_${digest}`;
}

function sanitizeFieldName(name) {
  if (SAFE_PROTOCOL_FIELDS.has(name)) {
    return name;
  }
  return stableLabel("unknown_field", name);
}

function valueType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value === "object" ? "object" : typeof value;
}

export function describeJsonShape(value, { maxDepth = 8, maxEntries = 500 } = {}) {
  const entries = new Map();

  function add(path, type) {
    if (entries.size >= maxEntries) {
      return false;
    }
    entries.set(`${path}:${type}`, { path, type });
    return true;
  }

  function walk(current, path, depth) {
    const type = valueType(current);
    if (!add(path, type) || depth >= maxDepth) {
      return;
    }

    if (Array.isArray(current)) {
      for (const item of current.slice(0, 50)) {
        walk(item, `${path}[]`, depth + 1);
      }
      return;
    }

    if (current && typeof current === "object") {
      for (const key of Object.keys(current).sort()) {
        walk(current[key], `${path}.${sanitizeFieldName(key)}`, depth + 1);
      }
    }
  }

  walk(value, "$", 0);
  return [...entries.values()].sort((left, right) =>
    left.path === right.path
      ? left.type.localeCompare(right.type)
      : left.path.localeCompare(right.path),
  );
}

export function describeJsonBody(buffer, contentType) {
  if (!contentType?.toLowerCase().includes("json")) {
    return { encoding: "not-json", fields: [] };
  }

  if (buffer.length === 0) {
    return { encoding: "json", valid: false, fields: [] };
  }

  try {
    return {
      encoding: "json",
      valid: true,
      fields: describeJsonShape(JSON.parse(buffer.toString("utf8"))),
    };
  } catch {
    return { encoding: "json", valid: false, fields: [] };
  }
}

export function describeHeaders(headers) {
  const safeHeaderNames = [];
  const sensitiveHeaderNamesPresent = [];
  const safeValues = {};

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(name)) {
      sensitiveHeaderNamesPresent.push(name);
      continue;
    }

    safeHeaderNames.push(name);
    if (SAFE_HEADER_VALUE_NAMES.has(name) && rawValue !== undefined) {
      safeValues[name] = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    }
  }

  return {
    safe_header_names: [...new Set(safeHeaderNames)].sort(),
    sensitive_header_names_present: [...new Set(sensitiveHeaderNamesPresent)].sort(),
    safe_values: Object.fromEntries(Object.entries(safeValues).sort()),
  };
}

export function sanitizePath(pathname) {
  const segments = pathname.split("/").map((segment) => {
    if (!segment || STATIC_PATH_SEGMENTS.has(segment)) {
      return segment;
    }

    if (
      !STATIC_PATH_SEGMENTS.has(segment) ||
      segment.length > 24 ||
      /^(resp|thread|turn|conv|sess|req)[_-]/i.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ||
      !/^[A-Za-z0-9._~-]+$/.test(segment)
    ) {
      return ":id";
    }

    return segment;
  });

  return segments.join("/") || "/";
}

export function describeUrl(rawUrl) {
  const parsed = new URL(rawUrl, "http://127.0.0.1");
  return {
    path: sanitizePath(parsed.pathname),
    query_keys: [...new Set([...parsed.searchParams.keys()].map(sanitizeFieldName))].sort(),
  };
}

export function sanitizeEventType(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "unknown";
  }
  if (/^[A-Za-z0-9._/-]{1,128}$/.test(value)) {
    return value;
  }
  return stableLabel("unknown_event", value);
}
