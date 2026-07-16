import { redactForLog } from "./redaction.mjs";

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const EVENT_CURSOR_PATTERN = /^(?:0|[1-9][0-9]*)$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function validateTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("event clock must return an ISO timestamp");
  }
  return value;
}

export function createEventBroker({
  maxEvents = 256,
  now = () => new Date().toISOString(),
} = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000) {
    throw new Error("maxEvents must be an integer from 1 through 10000");
  }
  if (typeof now !== "function") {
    throw new TypeError("event clock must be a function");
  }
  const events = [];
  const subscribers = new Set();
  let sequence = 0;

  return Object.freeze({
    get subscriberCount() {
      return subscribers.size;
    },
    publish({ type, data }) {
      if (typeof type !== "string" || !EVENT_TYPE_PATTERN.test(type)) {
        throw new Error("event type is invalid");
      }
      if (!isPlainObject(data)) {
        throw new Error("event data must be a plain object");
      }
      const sanitizedData = redactForLog(data, { maxDepth: 6, maxEntries: 64 });
      const event = deepFreeze({
        id: String(++sequence),
        type,
        timestamp: validateTimestamp(now()),
        data: sanitizedData,
      });
      events.push(event);
      if (events.length > maxEvents) {
        events.splice(0, events.length - maxEvents);
      }
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(event);
        } catch {
          subscribers.delete(subscriber);
        }
      }
      return event;
    },
    snapshot() {
      return Object.freeze([...events]);
    },
    subscribe(subscriber, { afterId = "0" } = {}) {
      if (typeof subscriber !== "function") {
        throw new TypeError("event subscriber must be a function");
      }
      if (typeof afterId !== "string" || !EVENT_CURSOR_PATTERN.test(afterId)) {
        throw new Error("event cursor is invalid");
      }
      const cursor = BigInt(afterId);
      subscribers.add(subscriber);
      try {
        for (const event of events) {
          if (BigInt(event.id) > cursor) {
            subscriber(event);
          }
        }
      } catch (error) {
        subscribers.delete(subscriber);
        throw error;
      }
      let active = true;
      return () => {
        if (active) {
          active = false;
          subscribers.delete(subscriber);
        }
      };
    },
  });
}
