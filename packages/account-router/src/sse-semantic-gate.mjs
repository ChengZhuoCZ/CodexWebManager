import { classifyResponseEvent } from "./semantic-events.mjs";

class SseLimitError extends Error {
  constructor(code) {
    super(code);
    this.name = "SseLimitError";
    this.code = code;
  }
}

function eventBoundary(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function eventMetadata(bytes) {
  const text = bytes.toString("utf8").replace(/(?:\r\n\r\n|\n\n)$/, "");
  const lines = text.split(/\r?\n/);
  let explicitType = null;
  const data = [];
  let hasField = false;
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    hasField = true;
    const separator = line.indexOf(":");
    const name = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") explicitType = value;
    if (name === "data") data.push(value);
  }
  if (!hasField) {
    return Object.freeze({ classification: "preflight", eventType: null, terminal: false });
  }

  let eventType = explicitType;
  const dataText = data.join("\n");
  if (!eventType && dataText !== "" && dataText !== "[DONE]") {
    try {
      const parsed = JSON.parse(dataText);
      if (typeof parsed?.type === "string") eventType = parsed.type;
    } catch {
      // Unknown or non-JSON data is semantic by default.
    }
  }
  const classification = dataText === "[DONE]" ? "terminal" : classifyResponseEvent(eventType);
  return Object.freeze({
    classification,
    eventType,
    terminal: classification === "terminal",
  });
}

export function createSseSemanticGate({
  maxEventBytes = 1024 * 1024,
  maxPreflightBytes = 2 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1 || maxEventBytes > 16 * 1024 * 1024) {
    throw new Error("maxEventBytes must be an integer from 1 through 16777216");
  }
  if (
    !Number.isSafeInteger(maxPreflightBytes) ||
    maxPreflightBytes < 1 ||
    maxPreflightBytes > 16 * 1024 * 1024
  ) {
    throw new Error("maxPreflightBytes must be an integer from 1 through 16777216");
  }
  let buffer = Buffer.alloc(0);
  let preflightBytes = 0;

  return Object.freeze({
    push(chunk) {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
        throw new TypeError("SSE chunk must be bytes");
      }
      buffer = Buffer.concat([buffer, chunk]);
      const events = [];
      for (;;) {
        const boundary = eventBoundary(buffer);
        if (!boundary) {
          if (buffer.length > maxEventBytes) throw new SseLimitError("sse_event_too_large");
          break;
        }
        const end = boundary.index + boundary.length;
        if (end > maxEventBytes) throw new SseLimitError("sse_event_too_large");
        const bytes = Buffer.from(buffer.subarray(0, end));
        buffer = buffer.subarray(end);
        const metadata = eventMetadata(bytes);
        if (metadata.classification === "preflight") {
          preflightBytes += bytes.length;
          if (preflightBytes > maxPreflightBytes) {
            throw new SseLimitError("sse_preflight_too_large");
          }
        }
        events.push(Object.freeze({ bytes, ...metadata }));
      }
      return Object.freeze(events);
    },
    finish() {
      if (buffer.length !== 0) throw new SseLimitError("sse_truncated_event");
    },
  });
}

export { SseLimitError };
