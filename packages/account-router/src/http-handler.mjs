const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
});
const READ_METHODS = new Set(["GET", "HEAD"]);

function sendJson(request, response, statusCode, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    ...JSON_HEADERS,
    ...extraHeaders,
    "content-length": Buffer.byteLength(body),
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function routePath(rawUrl) {
  try {
    const url = new URL(rawUrl ?? "/", "http://127.0.0.1");
    return url.search ? null : url.pathname;
  } catch {
    return null;
  }
}

export function createHealthHandler({ getUsableAccountCount = () => 0 } = {}) {
  if (typeof getUsableAccountCount !== "function") {
    throw new TypeError("getUsableAccountCount must be a function");
  }

  return (request, response) => {
    const pathname = routePath(request.url);
    if (pathname === null) {
      sendJson(request, response, 400, { error: "invalid_request_target" });
      return;
    }
    if (!READ_METHODS.has(request.method)) {
      sendJson(
        request,
        response,
        405,
        { error: "method_not_allowed" },
        { allow: "GET, HEAD" },
      );
      return;
    }
    if (pathname === "/healthz") {
      sendJson(request, response, 200, {
        service: "codex-account-router",
        status: "ok",
      });
      return;
    }
    if (pathname === "/readyz") {
      let accountCount;
      try {
        accountCount = getUsableAccountCount();
      } catch {
        accountCount = null;
      }
      if (!Number.isSafeInteger(accountCount) || accountCount < 0) {
        sendJson(request, response, 503, {
          service: "codex-account-router",
          status: "not_ready",
          reason: "account_state_unavailable",
        });
        return;
      }
      if (accountCount === 0) {
        sendJson(request, response, 503, {
          service: "codex-account-router",
          status: "not_ready",
          reason: "no_accounts",
          usable_accounts: 0,
        });
        return;
      }
      sendJson(request, response, 200, {
        service: "codex-account-router",
        status: "ready",
        usable_accounts: accountCount,
      });
      return;
    }
    sendJson(request, response, 404, { error: "not_found" });
  };
}
