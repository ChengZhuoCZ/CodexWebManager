const STATUS_PATH = "/__backend/codex-router/status";
const EVENTS_PATH = "/__backend/codex-router/events";
const SWITCH_PATH = "/__backend/codex-router/switch";
const SESSION_PATH = "/__backend/session";
const PANEL_ID = "codex-router-account-panel";
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

function setPanelStage(value) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.routerPanelStage = value;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readAlias(value) {
  if (
    typeof value !== "string" || value.trim() !== value ||
    [...value].length < 1 || [...value].length > 64
  ) {
    throw new Error("router status is invalid");
  }
  return value;
}

function readRatio(value) {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error("router status is invalid");
  }
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
    !Number.isSafeInteger(value.active_streams) ||
    Number(value.active_streams) < 0 || Number(value.active_streams) > 1_000_000 ||
    !Array.isArray(value.accounts) || value.accounts.length > 1_000
  ) {
    throw new Error("router status is invalid");
  }
  let currentRoute = null;
  if (value.current_route !== null) {
    if (
      !isRecord(value.current_route) ||
      value.current_route.continuity !== "new_backend_session"
    ) {
      throw new Error("router status is invalid");
    }
    currentRoute = {
      account_alias: readAlias(value.current_route.account_alias),
      continuity: "new_backend_session",
    };
  }
  const accounts = value.accounts.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !ACCOUNT_STATES.has(String(candidate.state)) ||
      typeof candidate.enabled !== "boolean" ||
      (candidate.last_switch_reason !== null &&
        !SWITCH_REASONS.has(String(candidate.last_switch_reason)))
    ) {
      throw new Error("router status is invalid");
    }
    return {
      alias: readAlias(candidate.alias),
      state: candidate.state,
      enabled: candidate.enabled,
      weekly_remaining_ratio: readRatio(candidate.weekly_remaining_ratio),
      snapshot_observed_at: readTimestamp(candidate.snapshot_observed_at),
      cooldown_until: readTimestamp(candidate.cooldown_until),
      last_switch_reason: candidate.last_switch_reason,
    };
  });
  return {
    status: value.status,
    architecture_mode: "LIMITED_MODE",
    cross_account_e2e_verified: false,
    active_streams: Number(value.active_streams),
    current_route: currentRoute,
    accounts,
  };
}

function titleCase(value) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
  return new Date(timestamp).toISOString().replace("T", " ").replace(/\.\d{3}Z$/u, " UTC");
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
      detail: "No weekly quota observation is available.",
    };
  }
  return {
    label: `${Math.round(account.weekly_remaining_ratio * 100)}% remaining`,
    detail: account.snapshot_observed_at === null
      ? "No observation timestamp is available."
      : `Observed ${utcLabel(account.snapshot_observed_at)}`,
  };
}

function cooldownPresentation(account, nowMilliseconds) {
  if (account.cooldown_until === null) return { label: "None", detail: null };
  const cooldownMilliseconds = Date.parse(account.cooldown_until);
  if (cooldownMilliseconds <= nowMilliseconds) {
    return {
      label: "Elapsed",
      detail: `Ended ${utcLabel(account.cooldown_until)}`,
    };
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

export function deriveRouterAccountPanelModel(value, nowMilliseconds = Date.now()) {
  if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) {
    throw new Error("router panel clock is invalid");
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
        state: account.state,
        stateLabel: titleCase(account.state),
        weeklyLabel: weekly.label,
        weeklyDetail: weekly.detail,
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

export function buildManualSwitchRequest(account) {
  if (!isRecord(account) || account.switchDisabled !== false) {
    throw new Error("manual switch is unavailable");
  }
  return Object.freeze({ account_alias: readAlias(account.alias), reason: "manual" });
}

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function detailRow(label, value, detail = null) {
  const row = element("div", "detail-row");
  const description = element("dd");
  description.append(element("span", "value-main", value));
  if (detail !== null) description.append(element("span", "value-detail", detail));
  row.append(element("dt", undefined, label), description);
  return row;
}

function renderPanel(root, model, onSwitch, busyAlias = null, transientMessage = null) {
  const style = element("style");
  style.textContent = `
    :host { color-scheme: light dark; }
    * { box-sizing: border-box; }
    .panel { width: min(420px, calc(100vw - 24px)); max-height: min(620px, calc(100vh - 24px)); overflow: auto;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 12px;
      background: color-mix(in srgb, Canvas 96%, transparent); color: CanvasText;
      box-shadow: 0 12px 32px rgb(0 0 0 / 20%); font: 13px/1.35 system-ui, sans-serif; }
    summary { cursor: pointer; padding: 10px 12px; font-weight: 650; user-select: none; }
    .content { border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); padding: 10px; }
    .banner { margin: 0 0 8px; border-radius: 8px; padding: 8px; background: color-mix(in srgb, #d97706 18%, Canvas); }
    .error { background: color-mix(in srgb, #dc2626 16%, Canvas); }
    .account { border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 9px; padding: 9px; }
    .account + .account { margin-top: 8px; }
    .account-head { display: flex; align-items: center; gap: 7px; }
    .alias { flex: 1; min-width: 0; overflow-wrap: anywhere; font-weight: 650; }
    .state { border-radius: 999px; padding: 2px 7px; background: color-mix(in srgb, CanvasText 9%, transparent); font-size: 11px; }
    .current { color: #15803d; font-size: 11px; font-weight: 650; }
    dl { margin: 8px 0; }
    .detail-row { display: grid; grid-template-columns: minmax(96px, auto) minmax(0, 1fr); gap: 10px; padding: 3px 0; }
    dt { color: color-mix(in srgb, CanvasText 65%, transparent); }
    dd { min-width: 0; margin: 0; text-align: right; }
    .value-main, .value-detail { display: block; overflow-wrap: anywhere; }
    .value-main { font-weight: 550; }
    .value-detail { margin-top: 1px; color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 11px; }
    button { width: 100%; border: 0; border-radius: 7px; padding: 7px 9px; background: #2563eb; color: white; font: inherit; font-weight: 650; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    .footnote { margin: 9px 2px 1px; color: color-mix(in srgb, CanvasText 65%, transparent); font-size: 11px; }
  `;
  const details = element("details", "panel");
  details.open = true;
  details.dataset.routerPanelReady = "true";
  details.append(element("summary", undefined, `Router accounts (${model.accounts.length})`));
  const content = element("div", "content");
  if (model.banner) content.append(element("p", "banner", model.banner));
  if (transientMessage) content.append(element("p", "banner error", transientMessage));
  for (const account of model.accounts) {
    const card = element("section", "account");
    card.dataset.accountAlias = account.alias;
    const head = element("div", "account-head");
    head.append(
      element("span", "alias", account.alias),
      element("span", "state", account.stateLabel),
    );
    if (account.isCurrent) head.append(element("span", "current", "Current"));
    const description = element("dl");
    description.append(
      detailRow("Weekly quota", account.weeklyLabel, account.weeklyDetail),
      detailRow("Cooldown", account.cooldownLabel, account.cooldownDetail),
      detailRow("Last switch", account.lastSwitchLabel),
    );
    const button = element("button", undefined, account.isCurrent ? "Current route" : "Switch");
    button.type = "button";
    button.disabled = account.switchDisabled || busyAlias !== null;
    button.dataset.switchAlias = account.alias;
    button.title = account.switchDisabledReason ?? "Start a new backend session on this account";
    button.addEventListener("click", () => onSwitch(account));
    card.append(head, description, button);
    content.append(card);
  }
  content.append(element(
    "p",
    "footnote",
    "Switching starts a new backend session. Cross-account continuity is not verified.",
  ));
  details.append(content);
  root.replaceChildren(style, details);
}

function appendHost() {
  const host = element("aside");
  host.id = PANEL_ID;
  host.setAttribute("aria-label", "Router account status");
  Object.assign(host.style, {
    position: "fixed",
    right: "12px",
    top: "12px",
    zIndex: "2147483000",
  });
  const root = host.attachShadow({ mode: "open" });
  document.body.append(host);
  return { host, root };
}

function requestJson(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url, true);
    request.responseType = "json";
    for (const [name, value] of Object.entries(headers)) {
      request.setRequestHeader(name, value);
    }
    request.addEventListener("load", () => {
      resolve({
        ok: request.status >= 200 && request.status < 300,
        status: request.status,
        body: request.response,
      });
    }, { once: true });
    request.addEventListener("error", () => {
      setPanelStage("request_error");
      reject(new Error("browser request failed"));
    }, {
      once: true,
    });
    request.addEventListener("timeout", () => {
      setPanelStage("request_timeout");
      reject(new Error("browser request timed out"));
    }, {
      once: true,
    });
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
      !response.ok || !isRecord(value) ||
      typeof value.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.csrfToken) ||
      typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt))
    ) {
      throw new Error("browser session is unavailable");
    }
    return value;
  }).catch((error) => {
    sessionSnapshotPromise = null;
    throw error;
  });
  const snapshot = await sessionSnapshotPromise;
  return { "x-codex-csrf": snapshot.csrfToken };
}

function domReady() {
  if (document.readyState !== "loading") return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener("DOMContentLoaded", resolve, { once: true });
  });
}

export async function installRouterAccountPanel() {
  if (installedCleanup) return installedCleanup;
  await domReady();
  setPanelStage("dom_ready");
  let host = null;
  let root = null;
  let model = null;
  let eventSource = null;
  let pollTimer = null;
  let stopped = false;
  let busyAlias = null;
  let transientMessage = null;

  const ensureHost = () => {
    if (!host || !root) ({ host, root } = appendHost());
    return root;
  };
  const showError = (message) => {
    transientMessage = message;
    if (model) renderPanel(ensureHost(), model, requestSwitch, busyAlias, transientMessage);
  };
  const refresh = async () => {
    setPanelStage("status_request");
    const response = await requestJson(STATUS_PATH, {
      headers: { accept: "application/json" },
    });
    setPanelStage("status_received");
    const body = response.body;
    if (response.status === 404 && isRecord(body) && body.enabled === false) return "disabled";
    if (!response.ok || !isRecord(body) || body.enabled !== true || !("router" in body)) {
      setPanelStage("status_invalid");
      throw new Error("router status is unavailable");
    }
    model = deriveRouterAccountPanelModel(body.router);
    transientMessage = null;
    renderPanel(ensureHost(), model, requestSwitch, busyAlias, transientMessage);
    setPanelStage("ready");
    return "enabled";
  };
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
    if (model) renderPanel(ensureHost(), model, requestSwitch, busyAlias, transientMessage);
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
      if (model) renderPanel(ensureHost(), model, requestSwitch, busyAlias, transientMessage);
    }
  }

  try {
    if (await refresh() === "disabled") return () => undefined;
  } catch {
    return () => undefined;
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
    eventSource?.close();
    if (pollTimer !== null) window.clearInterval(pollTimer);
    host?.remove();
    installedCleanup = null;
  };
  window.addEventListener("beforeunload", installedCleanup, { once: true });
  return installedCleanup;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  setPanelStage("module_loaded");
  installRouterAccountPanel().catch(() => setPanelStage("install_failed"));
}
