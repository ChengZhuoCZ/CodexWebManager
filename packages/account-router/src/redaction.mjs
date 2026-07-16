import { SecretLease } from "./secrets.mjs";

const REDACTED = "[REDACTED]";
const SKIP = Symbol("skip");
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|token|secret|credential|password|email|sessionkey|apikey)/i;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const KNOWN_TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactString(value) {
  const redacted = value
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, REDACTED)
    .replace(KNOWN_TOKEN_PATTERN, REDACTED);
  return redacted.length <= 1_024 ? redacted : `${redacted.slice(0, 1_024)}[Truncated]`;
}

export function redactForLog(value, { maxDepth = 6, maxEntries = 64 } = {}) {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 32) {
    throw new Error("maxDepth must be an integer from 1 through 32");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_024) {
    throw new Error("maxEntries must be an integer from 1 through 1024");
  }
  const seen = new WeakSet();

  function visit(candidate, depth) {
    if (candidate === null || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      return Number.isFinite(candidate) ? candidate : String(candidate);
    }
    if (typeof candidate === "bigint") {
      return String(candidate);
    }
    if (typeof candidate === "string") {
      return redactString(candidate);
    }
    if (["undefined", "function", "symbol"].includes(typeof candidate)) {
      return SKIP;
    }
    if (candidate instanceof SecretLease) {
      return REDACTED;
    }
    if (Buffer.isBuffer(candidate) || ArrayBuffer.isView(candidate)) {
      return `[Binary ${candidate.byteLength} bytes]`;
    }
    if (candidate instanceof Date) {
      return Number.isNaN(candidate.getTime()) ? "Invalid Date" : candidate.toISOString();
    }
    if (candidate instanceof Error) {
      return {
        name: redactString(candidate.name),
        message: redactString(candidate.message),
      };
    }
    if (depth >= maxDepth) {
      return "[MaxDepth]";
    }
    if (seen.has(candidate)) {
      return "[Circular]";
    }
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      const output = [];
      for (const item of candidate.slice(0, maxEntries)) {
        const visited = visit(item, depth + 1);
        if (visited !== SKIP) {
          output.push(visited);
        }
      }
      if (candidate.length > maxEntries) {
        output.push("[Truncated]");
      }
      return output;
    }
    if (!isPlainObject(candidate)) {
      return "[Unsupported Object]";
    }

    const output = {};
    const entries = Object.entries(candidate);
    for (const [key, item] of entries.slice(0, maxEntries)) {
      if (SENSITIVE_KEY_PATTERN.test(key.replaceAll(/[^A-Za-z0-9]/g, ""))) {
        output[key] = REDACTED;
        continue;
      }
      const visited = visit(item, depth + 1);
      if (visited !== SKIP) {
        output[key] = visited;
      }
    }
    if (entries.length > maxEntries) {
      output._truncated = "[Truncated]";
    }
    return output;
  }

  const result = visit(value, 0);
  return result === SKIP ? "[Unsupported]" : result;
}

export function stringifyLogRecord(record, options) {
  if (!isPlainObject(record)) {
    throw new TypeError("structured log record must be a plain object");
  }
  return JSON.stringify(redactForLog(record, options));
}

export { REDACTED };
