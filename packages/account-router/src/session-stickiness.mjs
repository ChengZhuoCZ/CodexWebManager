import { inspect } from "node:util";

const ASSIGNMENT_FIELDS = new Set(["routingSessionId", "accountId", "backendSessionId"]);
const ROUTING_SESSION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const BACKEND_SESSION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_ENTRIES = 10_000;
const MAX_ACTIVE_STREAMS = 16;
const MAX_SEQUENCE = 1_000_000_000;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new Error(`unsupported ${label} field: ${field}`);
    }
  }
}

function assertRoutingSessionId(value) {
  if (typeof value !== "string" || !ROUTING_SESSION_PATTERN.test(value)) {
    throw new Error("routing session id is invalid");
  }
  return value;
}

function assertAccountId(value) {
  if (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value)) {
    throw new Error("session account id is invalid");
  }
  return value;
}

function assertBackendSessionId(value) {
  if (typeof value !== "string" || !BACKEND_SESSION_PATTERN.test(value)) {
    throw new Error("backend session id is invalid");
  }
  return value;
}

function readClock(now) {
  const milliseconds = now();
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(milliseconds)) {
    throw new Error("session clock must return integer epoch milliseconds");
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new Error("session clock returned an out-of-range timestamp");
  }
  return milliseconds;
}

function timestamp(milliseconds) {
  const date = new Date(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(date.getTime())) {
    throw new Error("session timestamp is out of range");
  }
  return date.toISOString();
}

function nextSequence(value) {
  return value >= MAX_SEQUENCE ? 1 : value + 1;
}

function snapshot(session) {
  return Object.freeze({
    routing_session_id: session.routingSessionId,
    account_id: session.accountId,
    backend_session_id: session.backendSessionId,
    active_semantic_streams: session.activeStreamTokens.size,
    created_at: timestamp(session.createdAtMilliseconds),
    last_activity_at: timestamp(session.lastActivityMilliseconds),
    expires_at: timestamp(session.expiresAtMilliseconds),
  });
}

function assignmentResult(transition, route) {
  return Object.freeze({
    transition,
    continuity:
      transition === "sticky_backend_session"
        ? "existing_backend_session"
        : "new_backend_session",
    architecture_mode: "LIMITED_MODE",
    cross_account_e2e_verified: false,
    route,
  });
}

export function createSessionStickiness({
  now = () => Date.now(),
  ttlMs = 60 * 60_000,
  maxEntries = 10_000,
  maxActiveStreamsPerSession = 1,
} = {}) {
  if (typeof now !== "function") {
    throw new TypeError("session clock must be a function");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new Error("ttlMs must be an integer from 1 through 2592000000");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) {
    throw new Error("maxEntries must be an integer from 1 through 10000");
  }
  if (
    !Number.isSafeInteger(maxActiveStreamsPerSession) ||
    maxActiveStreamsPerSession < 1 ||
    maxActiveStreamsPerSession > MAX_ACTIVE_STREAMS
  ) {
    throw new Error("maxActiveStreamsPerSession must be an integer from 1 through 16");
  }

  const sessions = new Map();
  const backendOwners = new Map();
  const activeTokenOwners = new Map();
  let streamSequence = 0;

  function removeSession(session) {
    sessions.delete(session.routingSessionId);
    if (backendOwners.get(session.backendSessionId) === session.routingSessionId) {
      backendOwners.delete(session.backendSessionId);
    }
  }

  function pruneAt(currentMilliseconds) {
    let removed = 0;
    for (const session of sessions.values()) {
      if (
        session.activeStreamTokens.size === 0 &&
        currentMilliseconds >= session.expiresAtMilliseconds
      ) {
        removeSession(session);
        removed += 1;
      }
    }
    return removed;
  }

  function touch(session, currentMilliseconds) {
    const activityMilliseconds = Math.max(
      currentMilliseconds,
      session.lastActivityMilliseconds,
    );
    const expiresAtMilliseconds = activityMilliseconds + ttlMs;
    timestamp(expiresAtMilliseconds);
    session.lastActivityMilliseconds = activityMilliseconds;
    session.expiresAtMilliseconds = expiresAtMilliseconds;
  }

  function evictOneInactive() {
    const candidate = [...sessions.values()]
      .filter((session) => session.activeStreamTokens.size === 0)
      .sort((left, right) => {
        if (left.lastActivityMilliseconds !== right.lastActivityMilliseconds) {
          return left.lastActivityMilliseconds - right.lastActivityMilliseconds;
        }
        return left.routingSessionId < right.routingSessionId
          ? -1
          : left.routingSessionId > right.routingSessionId
            ? 1
            : 0;
      })[0];
    if (!candidate) {
      throw new Error("session mapping capacity is occupied by active semantic streams");
    }
    removeSession(candidate);
  }

  function routeFor(routingSessionId, currentMilliseconds) {
    pruneAt(currentMilliseconds);
    return sessions.get(routingSessionId) ?? null;
  }

  const store = {
    get size() {
      const currentMilliseconds = readClock(now);
      pruneAt(currentMilliseconds);
      return sessions.size;
    },
    assign(assignment) {
      if (!isPlainObject(assignment)) {
        throw new Error("session assignment must be a plain object");
      }
      assertOnlyFields(assignment, ASSIGNMENT_FIELDS, "assignment");
      const routingSessionId = assertRoutingSessionId(assignment.routingSessionId);
      const accountId = assertAccountId(assignment.accountId);
      const backendSessionId = assertBackendSessionId(assignment.backendSessionId);
      const currentMilliseconds = readClock(now);
      pruneAt(currentMilliseconds);
      const existing = sessions.get(routingSessionId);

      if (existing) {
        const sameAccount = existing.accountId === accountId;
        const sameBackend = existing.backendSessionId === backendSessionId;
        if (sameAccount && sameBackend) {
          touch(existing, currentMilliseconds);
          return assignmentResult("sticky_backend_session", snapshot(existing));
        }
        if (existing.activeStreamTokens.size > 0) {
          throw new Error("cannot change route during an active semantic stream");
        }
        if (!sameAccount && sameBackend) {
          throw new Error("LIMITED_MODE account change requires a new backend session");
        }
        const owner = backendOwners.get(backendSessionId);
        if (owner !== undefined && owner !== routingSessionId) {
          throw new Error("backend session is already assigned to another routing session");
        }
        backendOwners.delete(existing.backendSessionId);
        existing.accountId = accountId;
        existing.backendSessionId = backendSessionId;
        existing.generation = nextSequence(existing.generation);
        touch(existing, currentMilliseconds);
        backendOwners.set(backendSessionId, routingSessionId);
        return assignmentResult("limited_mode_new_session", snapshot(existing));
      }

      const owner = backendOwners.get(backendSessionId);
      if (owner !== undefined) {
        throw new Error("backend session is already assigned to another routing session");
      }
      if (sessions.size >= maxEntries) {
        evictOneInactive();
      }
      const expiresAtMilliseconds = currentMilliseconds + ttlMs;
      timestamp(expiresAtMilliseconds);
      const session = {
        routingSessionId,
        accountId,
        backendSessionId,
        createdAtMilliseconds: currentMilliseconds,
        lastActivityMilliseconds: currentMilliseconds,
        expiresAtMilliseconds,
        generation: 1,
        activeStreamTokens: new Set(),
      };
      sessions.set(routingSessionId, session);
      backendOwners.set(backendSessionId, routingSessionId);
      return assignmentResult("initial_backend_session", snapshot(session));
    },
    resolve(routingSessionId) {
      assertRoutingSessionId(routingSessionId);
      const currentMilliseconds = readClock(now);
      const session = routeFor(routingSessionId, currentMilliseconds);
      return session ? snapshot(session) : null;
    },
    beginSemanticStream(routingSessionId) {
      assertRoutingSessionId(routingSessionId);
      const currentMilliseconds = readClock(now);
      const session = routeFor(routingSessionId, currentMilliseconds);
      if (!session) {
        throw new Error("routing session mapping is unavailable or expired");
      }
      if (session.activeStreamTokens.size >= maxActiveStreamsPerSession) {
        throw new Error("semantic stream limit reached for routing session");
      }
      touch(session, currentMilliseconds);
      let streamToken;
      do {
        streamSequence = nextSequence(streamSequence);
        streamToken = `semantic-stream.${session.generation}.${streamSequence}`;
      } while (activeTokenOwners.has(streamToken));
      session.activeStreamTokens.add(streamToken);
      activeTokenOwners.set(streamToken, routingSessionId);
      return Object.freeze({
        stream_token: streamToken,
        account_id: session.accountId,
        backend_session_id: session.backendSessionId,
        continuity: "existing_backend_session",
        architecture_mode: "LIMITED_MODE",
      });
    },
    endSemanticStream(streamToken) {
      if (typeof streamToken !== "string" || !activeTokenOwners.has(streamToken)) {
        throw new Error("semantic stream token is invalid or stale");
      }
      const currentMilliseconds = readClock(now);
      const routingSessionId = activeTokenOwners.get(streamToken);
      const session = sessions.get(routingSessionId);
      if (!session || !session.activeStreamTokens.has(streamToken)) {
        throw new Error("semantic stream token is invalid or stale");
      }
      activeTokenOwners.delete(streamToken);
      session.activeStreamTokens.delete(streamToken);
      touch(session, currentMilliseconds);
      return true;
    },
    deleteSession(routingSessionId) {
      assertRoutingSessionId(routingSessionId);
      const currentMilliseconds = readClock(now);
      pruneAt(currentMilliseconds);
      const session = sessions.get(routingSessionId);
      if (!session) {
        return false;
      }
      if (session.activeStreamTokens.size > 0) {
        throw new Error("cannot delete a routing session with an active semantic stream");
      }
      removeSession(session);
      return true;
    },
    prune() {
      return pruneAt(readClock(now));
    },
    listSnapshots() {
      const currentMilliseconds = readClock(now);
      pruneAt(currentMilliseconds);
      return Object.freeze(
        [...sessions.values()]
          .sort((left, right) =>
            left.routingSessionId < right.routingSessionId
              ? -1
              : left.routingSessionId > right.routingSessionId
                ? 1
                : 0)
          .map(snapshot),
      );
    },
    toString() {
      return "[SessionStickiness]";
    },
    toJSON() {
      return "[SessionStickiness]";
    },
    [inspect.custom]() {
      return "[SessionStickiness]";
    },
  };
  return Object.freeze(store);
}
