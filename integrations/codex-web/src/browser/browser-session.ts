type SessionSnapshot = {
  csrfToken: string;
  expiresAt: string;
};

let snapshotPromise: Promise<SessionSnapshot> | null = null;

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
