import { localBrowserStatsigResponse } from "./browser-message-policy.js";

type SessionSnapshot = {
  csrfToken: string;
  expiresAt: string;
};

let snapshotPromise: Promise<SessionSnapshot> | null = null;
let browserFetchPolicyInstalled = false;

function fetchMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  if (typeof init?.method === "string") {
    return init.method.toUpperCase();
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "method" in input &&
    typeof input.method === "string"
  ) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

export function installBrowserFetchPolicy(): void {
  if (browserFetchPolicyInstalled) {
    return;
  }
  const upstreamFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const localResponse =
      fetchMethod(input, init) === "POST"
        ? localBrowserStatsigResponse(fetchUrl(input))
        : null;
    if (localResponse !== null) {
      return new Response(JSON.stringify(localResponse), {
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        status: 200,
      });
    }
    return upstreamFetch(input, init);
  };
  browserFetchPolicyInstalled = true;
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "csrfToken" in value &&
    typeof value.csrfToken === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.csrfToken) &&
    "expiresAt" in value &&
    typeof value.expiresAt === "string" &&
    !Number.isNaN(Date.parse(value.expiresAt))
  );
}

async function loadSessionSnapshot(): Promise<SessionSnapshot> {
  const response = await fetch("/__backend/session", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const value = (await response.json()) as unknown;
  if (!response.ok || !isSessionSnapshot(value)) {
    throw new Error("Codex Web browser session is unavailable");
  }
  return value;
}

export async function browserCsrfHeaders(): Promise<Record<string, string>> {
  snapshotPromise ??= loadSessionSnapshot().catch((error) => {
    snapshotPromise = null;
    throw error;
  });
  const snapshot = await snapshotPromise;
  return {
    "x-codex-csrf": snapshot.csrfToken,
  };
}
