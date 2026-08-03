const STATUS_PATH = "/__backend/codex-router/status";
const EVENTS_PATH = "/__backend/codex-router/events";
const SWITCH_PATH = "/__backend/codex-router/switch";
const QUOTA_REFRESH_PATH = "/__backend/codex-router/quota-refresh";
const ACCOUNT_AUTH_PATH = "/__backend/codex-router/accounts/device-auth";
const SESSION_PATH = "/__backend/session";
const CONTROLLER_READY_EVENT = "codex-router-account-settings-ready";
const POLL_INTERVAL_MS = 30_000;

const ACCOUNT_STATES = new Set([
  "healthy",
  "cooling_down",
  "half_open",
  "auth_expired",
  "quota_exhausted",
  "disabled",
  "unknown",
]);
const SWITCH_REASONS = new Set([
  "manual",
  "startup",
  "quota_exhausted",
  "rate_limited",
  "auth_expired",
  "network_error",
  "upstream_5xx",
]);

let sessionSnapshotPromise = null;
let installedCleanup = null;

function setControllerStage(value) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.routerControllerStage = value;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readAlias(value) {
  if (
    typeof value !== "string" || value.trim() !== value ||
    [...value].length < 1 || [...value].length > 64
  ) throw new Error("router status is invalid");
  return value;
}

function readRatio(value) {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
  ) throw new Error("router status is invalid");
  return value;
}

function readTimestamp(value) {
  if (value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
    throw new Error("router status is invalid");
  }
  return value;
}

function readRouterStatus(value) {
  if (
    !isRecord(value) ||
    !new Set(["ready", "degraded", "unavailable"]).has(String(value.status)) ||
    value.architecture_mode !== "LIMITED_MODE" ||
    value.cross_account_e2e_verified !== false ||
    !Number.isSafeInteger(value.active_streams) || value.active_streams < 0 ||
    value.active_streams > 1_000_000 || !Array.isArray(value.accounts) ||
    value.accounts.length > 1_000
  ) throw new Error("router status is invalid");
  let currentRoute = null;
  if (value.current_route !== null) {
    if (
      !isRecord(value.current_route) ||
      value.current_route.continuity !== "new_backend_session"
    ) throw new Error("router status is invalid");
    currentRoute = {
      account_alias: readAlias(value.current_route.account_alias),
      continuity: "new_backend_session",
    };
  }
  const accounts = value.accounts.map((candidate) => {
    if (
      !isRecord(candidate) || !ACCOUNT_STATES.has(String(candidate.state)) ||
      typeof candidate.enabled !== "boolean" ||
      (candidate.last_switch_reason !== null &&
        !SWITCH_REASONS.has(String(candidate.last_switch_reason)))
    ) throw new Error("router status is invalid");
    return {
      alias: readAlias(candidate.alias),
      state: candidate.state,
      enabled: candidate.enabled,
      weekly_remaining_ratio: readRatio(candidate.weekly_remaining_ratio),
      weekly_resets_at: readTimestamp(candidate.weekly_resets_at ?? null),
      snapshot_observed_at: readTimestamp(candidate.snapshot_observed_at),
      cooldown_until: readTimestamp(candidate.cooldown_until),
      last_switch_reason: candidate.last_switch_reason,
    };
  });
  return {
    status: value.status,
    active_streams: value.active_streams,
    current_route: currentRoute,
    accounts,
  };
}

function titleCase(value) {
  return value.split("_").map((part) =>
    part.charAt(0).toUpperCase() + part.slice(1)
  ).join(" ");
}

function reasonLabel(reason) {
  const labels = {
    manual: "Manual",
    startup: "Startup",
    quota_exhausted: "Quota exhausted",
    rate_limited: "Rate limited",
    auth_expired: "Authentication expired",
    network_error: "Network error",
    upstream_5xx: "Upstream error",
  };
  return reason === null ? "None" : labels[reason];
}

function utcLabel(timestamp) {
  return new Date(timestamp).toISOString().replace("T", " ").replace(/:\d{2}\.\d{3}Z$/u, " UTC");
}

function remainingLabel(milliseconds) {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${minutes}m remaining`;
  if (remainder === 0) return `${hours}h remaining`;
  return `${hours}h ${remainder}m remaining`;
}

function weeklyPresentation(account) {
  if (account.weekly_remaining_ratio === null) {
    return {
      label: "Not observed yet",
      detail: "Refreshed: never",
      resetDetail: "Resets: unavailable",
    };
  }
  return {
    label: `${Math.round(account.weekly_remaining_ratio * 100)}% remaining`,
    detail: account.snapshot_observed_at === null
      ? "Refreshed: unavailable"
      : `Refreshed ${utcLabel(account.snapshot_observed_at)}`,
    resetDetail: account.weekly_resets_at === null
      ? "Resets: unavailable"
      : `Resets ${utcLabel(account.weekly_resets_at)}`,
  };
}

function cooldownPresentation(account, nowMilliseconds) {
  if (account.cooldown_until === null) return { label: "None", detail: null };
  const cooldownMilliseconds = Date.parse(account.cooldown_until);
  if (cooldownMilliseconds <= nowMilliseconds) {
    return { label: "Elapsed", detail: `Ended ${utcLabel(account.cooldown_until)}` };
  }
  return {
    label: `Active · ${remainingLabel(cooldownMilliseconds - nowMilliseconds)}`,
    detail: `Until ${utcLabel(account.cooldown_until)}`,
  };
}

function switchDisabledReason(account, status, nowMilliseconds) {
  if (status.active_streams > 0) return "Active response in progress";
  if (status.current_route?.account_alias === account.alias) return "Current route";
  if (!account.enabled || account.state === "disabled") return "Account disabled";
  if (account.state === "quota_exhausted") return "Quota exhausted";
  const recoveryEligible =
    account.cooldown_until !== null && Date.parse(account.cooldown_until) <= nowMilliseconds;
  if (account.state === "cooling_down" && !recoveryEligible) return "Account cooling down";
  if (account.state === "auth_expired" && !recoveryEligible) return "Authentication expired";
  if (account.state === "half_open") return "Account is probing recovery";
  return null;
}

export function deriveRouterAccountSettingsModel(value, nowMilliseconds = Date.now()) {
  if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) {
    throw new Error("router controller clock is invalid");
  }
  const status = readRouterStatus(value);
  const enabled = status.accounts.filter((account) => account.enabled);
  const allExhausted =
    enabled.length > 0 && enabled.every((account) => account.state === "quota_exhausted");
  return Object.freeze({
    activeStreams: status.active_streams,
    allExhausted,
    banner: allExhausted
      ? "All enabled accounts are quota exhausted."
      : status.active_streams > 0
        ? "Manual switching is unavailable while a response is streaming."
        : null,
    accounts: Object.freeze(status.accounts.map((account) => {
      const disabledReason = switchDisabledReason(account, status, nowMilliseconds);
      const weekly = weeklyPresentation(account);
      const cooldown = cooldownPresentation(account, nowMilliseconds);
      return Object.freeze({
        alias: account.alias,
        stateLabel: titleCase(account.state),
        weeklyLabel: weekly.label,
        weeklyDetail: weekly.detail,
        weeklyResetDetail: weekly.resetDetail,
        cooldownLabel: cooldown.label,
        cooldownDetail: cooldown.detail,
        lastSwitchLabel: reasonLabel(account.last_switch_reason),
        isCurrent: status.current_route?.account_alias === account.alias,
        switchDisabled: disabledReason !== null,
        switchDisabledReason: disabledReason,
      });
    })),
  });
}

function currentRouteLabel(model, status) {
  const current = model?.accounts.find((account) => account.isCurrent);
  if (current) return `Account route · ${current.alias}`;
  return status === "unavailable" ? "Account route · Unavailable" : "Account route · Loading…";
}

function buildManualSwitchRequest(account) {
  if (!isRecord(account) || account.switchDisabled !== false) {
    throw new Error("manual switch is unavailable");
  }
  return Object.freeze({ account_alias: readAlias(account.alias), reason: "manual" });
}

function buildAccountEnrollmentRequest(value) {
  const alias = readAlias(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u.test(alias) || alias.includes("@")) {
    throw new Error("account alias is invalid");
  }
  return Object.freeze({ alias });
}

function buildAccountRemovalRequest(alias, model) {
  const safe = readAlias(alias);
  if (
    !isRecord(model) || !Array.isArray(model.accounts) || model.activeStreams > 0 ||
    model.accounts.length <= 1 ||
    model.accounts.some((account) => account.alias === safe && account.isCurrent) ||
    !model.accounts.some((account) => account.alias === safe)
  ) throw new Error("account removal is unavailable");
  return Object.freeze({ confirm_alias: safe });
}

function requestJson(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url, true);
    request.responseType = "json";
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.addEventListener("load", () => resolve({
      ok: request.status >= 200 && request.status < 300,
      status: request.status,
      body: request.response,
    }), { once: true });
    request.addEventListener("error", () => reject(new Error("browser request failed")), { once: true });
    request.addEventListener("timeout", () => reject(new Error("browser request timed out")), { once: true });
    request.timeout = 10_000;
    request.send(body);
  });
}

async function browserCsrfHeaders() {
  sessionSnapshotPromise ??= requestJson(SESSION_PATH, {
    headers: { accept: "application/json" },
  }).then((response) => {
    const value = response.body;
    if (
      !response.ok || !isRecord(value) || typeof value.csrfToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.csrfToken) ||
      typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt))
    ) throw new Error("browser session is unavailable");
    return value;
  }).catch((error) => {
    sessionSnapshotPromise = null;
    throw error;
  });
  const snapshot = await sessionSnapshotPromise;
  return { "x-codex-csrf": snapshot.csrfToken };
}

export async function installRouterAccountController() {
  if (installedCleanup) return installedCleanup;
  let model = null;
  let status = "loading";
  let eventSource = null;
  let pollTimer = null;
  let managementPollTimer = null;
  let stopped = false;
  let busyAlias = null;
  let quotaBusy = false;
  let quotaRefreshAttempted = false;
  let transientMessage = null;
  let management = { mode: "idle" };
  let snapshot = Object.freeze({
    label: currentRouteLabel(model, status),
    status,
    model,
    busyAlias,
    quotaBusy,
    transientMessage,
    management: Object.freeze({ ...management }),
  });
  const listeners = new Set();
  const publish = () => {
    snapshot = Object.freeze({
      label: currentRouteLabel(model, status),
      status,
      model,
      busyAlias,
      quotaBusy,
      transientMessage,
      management: Object.freeze({ ...management }),
    });
    for (const listener of [...listeners]) listener();
  };
  const showError = (message) => {
    transientMessage = message;
    if (model === null) status = "unavailable";
    publish();
  };
  const refresh = async () => {
    setControllerStage("status_request");
    const response = await requestJson(STATUS_PATH, { headers: { accept: "application/json" } });
    const body = response.body;
    if (response.status === 404 && isRecord(body) && body.enabled === false) {
      status = "unavailable";
      publish();
      return "disabled";
    }
    if (!response.ok || !isRecord(body) || body.enabled !== true || !("router" in body)) {
      throw new Error("router status is unavailable");
    }
    model = deriveRouterAccountSettingsModel(body.router);
    status = "ready";
    transientMessage = null;
    publish();
    setControllerStage("ready");
    return "enabled";
  };
  async function requestQuotaRefresh(showFailure = true) {
    if (stopped || quotaBusy) return;
    quotaBusy = true;
    quotaRefreshAttempted = true;
    transientMessage = null;
    publish();
    try {
      const response = await requestJson(QUOTA_REFRESH_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(await browserCsrfHeaders()),
        },
        body: "{}",
      });
      const body = response.body;
      if (
        !response.ok || !isRecord(body) || body.enabled !== true || body.refreshed !== true ||
        typeof body.account_alias !== "string" ||
        typeof body.weekly_remaining_ratio !== "number" ||
        body.weekly_remaining_ratio < 0 || body.weekly_remaining_ratio > 1 ||
        typeof body.snapshot_observed_at !== "string" ||
        Number.isNaN(Date.parse(body.snapshot_observed_at))
      ) throw new Error("weekly quota refresh failed");
      await refresh();
    } catch {
      if (showFailure) showError("Weekly quota refresh was not available.");
    } finally {
      quotaBusy = false;
      publish();
    }
  }
  async function requestSwitch(account) {
    if (stopped || busyAlias !== null) return;
    let body;
    try {
      body = buildManualSwitchRequest(account);
    } catch {
      return;
    }
    busyAlias = account.alias;
    transientMessage = null;
    publish();
    try {
      const response = await requestJson(SWITCH_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(await browserCsrfHeaders()),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("manual switch request failed");
      await refresh();
    } catch {
      showError("Manual switch was not accepted.");
    } finally {
      busyAlias = null;
      publish();
    }
  }
  function clearManagementPoll() {
    if (managementPollTimer !== null) {
      window.clearTimeout(managementPollTimer);
      managementPollTimer = null;
    }
  }
  function beginAdd() {
    if (stopped || management.mode !== "idle" || model?.activeStreams > 0) return;
    management = { mode: "add_alias" };
    transientMessage = null;
    publish();
  }
  async function submitAdd(rawAlias) {
    if (stopped || management.mode !== "add_alias") return;
    let requestBody;
    try {
      requestBody = buildAccountEnrollmentRequest(rawAlias);
    } catch {
      showError("Use a short account name without an email address.");
      return;
    }
    const { alias } = requestBody;
    management = { mode: "starting", alias, operationId: null, verificationUrl: null, userCode: null };
    transientMessage = null;
    publish();
    try {
      const response = await requestJson(ACCOUNT_AUTH_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(await browserCsrfHeaders()),
        },
        body: JSON.stringify(requestBody),
      });
      const body = response.body;
      if (
        response.status !== 202 || !isRecord(body) || body.enabled !== true ||
        typeof body.operation_id !== "string" || !/^[a-f0-9]{32}$/u.test(body.operation_id)
      ) throw new Error("device authorization failed");
      management = {
        mode: body.phase === "waiting" ? "waiting" : "starting",
        alias,
        operationId: body.operation_id,
        verificationUrl: typeof body.verification_url === "string" ? body.verification_url : null,
        userCode: typeof body.user_code === "string" ? body.user_code : null,
      };
      publish();
      managementPollTimer = window.setTimeout(pollDeviceAuth, 750);
    } catch {
      management = { mode: "idle" };
      showError("Account authorization could not be started.");
    }
  }
  async function pollDeviceAuth() {
    managementPollTimer = null;
    const operationId = management.operationId;
    if (stopped || typeof operationId !== "string") return;
    try {
      const response = await requestJson(`${ACCOUNT_AUTH_PATH}/${operationId}`, {
        headers: { accept: "application/json" },
      });
      const body = response.body;
      if (!response.ok || !isRecord(body) || body.enabled !== true || body.operation_id !== operationId) {
        throw new Error("device authorization status failed");
      }
      if (body.phase === "complete") {
        management = { mode: "idle" };
        publish();
        await refresh();
        return;
      }
      if (body.phase === "failed" || body.phase === "cancelled") {
        management = { mode: "idle" };
        showError(body.phase === "failed" ? "Account authorization failed." : "Account authorization cancelled.");
        return;
      }
      if (!new Set(["starting", "waiting", "installing"]).has(body.phase)) {
        throw new Error("device authorization status failed");
      }
      management = {
        ...management,
        mode: body.phase,
        verificationUrl: typeof body.verification_url === "string" ? body.verification_url : null,
        userCode: typeof body.user_code === "string" ? body.user_code : null,
      };
      publish();
      managementPollTimer = window.setTimeout(pollDeviceAuth, 1_000);
    } catch {
      management = { mode: "idle" };
      showError("Account authorization status is unavailable.");
    }
  }
  async function cancelManagement() {
    clearManagementPoll();
    const operationId = management.operationId;
    management = { mode: "idle" };
    publish();
    if (typeof operationId !== "string") return;
    try {
      await requestJson(`${ACCOUNT_AUTH_PATH}/${operationId}`, {
        method: "DELETE",
        headers: { accept: "application/json", ...(await browserCsrfHeaders()) },
      });
    } catch {}
  }
  function beginRemove(alias) {
    if (
      stopped || management.mode !== "idle" || model?.activeStreams > 0 ||
      model?.accounts.length <= 1 || model?.accounts.some((account) => account.alias === alias && account.isCurrent)
    ) return;
    management = { mode: "remove_confirm", alias };
    transientMessage = null;
    publish();
  }
  async function confirmRemove(alias) {
    if (stopped || management.mode !== "remove_confirm" || management.alias !== alias) return;
    management = { mode: "remove_working", alias };
    publish();
    try {
      const requestBody = buildAccountRemovalRequest(alias, model);
      const response = await requestJson(`/__backend/codex-router/accounts/${encodeURIComponent(alias)}`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(await browserCsrfHeaders()),
        },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok || !isRecord(response.body) || response.body.removed !== true) {
        throw new Error("account removal rejected");
      }
      management = { mode: "idle" };
      publish();
      await refresh();
    } catch {
      management = { mode: "idle" };
      showError("Account deletion was rejected.");
    }
  }
  const controller = Object.freeze({
    subscribe(listener) {
      if (typeof listener !== "function") throw new Error("account settings listener is invalid");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    actions: Object.freeze({
      switchAccount: requestSwitch,
      refreshQuota: () => requestQuotaRefresh(true),
      beginAdd,
      submitAdd,
      cancelManagement,
      beginRemove,
      confirmRemove,
      retryStatus: () => {
        status = "loading";
        publish();
        refresh().catch(() => showError("Router status is temporarily unavailable."));
      },
    }),
  });
  window.__CODEX_ROUTER_ACCOUNT_SETTINGS__ = controller;
  window.dispatchEvent(new Event(CONTROLLER_READY_EVENT));
  publish();
  try {
    await refresh();
  } catch {
    status = "unavailable";
    publish();
  }
  if (!quotaRefreshAttempted && model?.accounts.some((account) => account.weeklyLabel === "Not observed yet")) {
    await requestQuotaRefresh(false);
  }
  if (typeof EventSource === "function") {
    eventSource = new EventSource(EVENTS_PATH);
    eventSource.addEventListener("router.switch", () => {
      refresh().catch(() => showError("Router status is temporarily unavailable."));
    });
  }
  pollTimer = window.setInterval(() => {
    refresh().catch(() => showError("Router status is temporarily unavailable."));
  }, POLL_INTERVAL_MS);
  installedCleanup = () => {
    if (stopped) return;
    stopped = true;
    clearManagementPoll();
    eventSource?.close();
    if (pollTimer !== null) window.clearInterval(pollTimer);
    listeners.clear();
    if (window.__CODEX_ROUTER_ACCOUNT_SETTINGS__ === controller) {
      delete window.__CODEX_ROUTER_ACCOUNT_SETTINGS__;
      window.dispatchEvent(new Event(CONTROLLER_READY_EVENT));
    }
    installedCleanup = null;
  };
  window.addEventListener("beforeunload", installedCleanup, { once: true });
  return installedCleanup;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  setControllerStage("module_loaded");
  installRouterAccountController().catch(() => setControllerStage("install_failed"));
}
