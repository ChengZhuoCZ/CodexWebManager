const STATUS_PATH = "/__backend/codex-router/status";
const EVENTS_PATH = "/__backend/codex-router/events";
const SWITCH_PATH = "/__backend/codex-router/switch";
const QUOTA_REFRESH_PATH = "/__backend/codex-router/quota-refresh";
const SESSION_PATH = "/__backend/session";
const MENU_SECTION_ID = "codex-router-account-menu-section";
const PROFILE_ROUTE_ATTRIBUTE = "data-codex-router-current-route";
const PROFILE_BUTTON_SELECTOR = 'button[aria-label="Open profile menu"]';
const PROFILE_MENU_ITEM_SELECTOR = '[role="menuitem"]';
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
      detail: "Refreshed: never",
    };
  }
  return {
    label: `${Math.round(account.weekly_remaining_ratio * 100)}% remaining`,
    detail: account.snapshot_observed_at === null
      ? "Refreshed: unavailable"
      : `Refreshed ${utcLabel(account.snapshot_observed_at)}`,
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

export function currentRouteIdentity(model) {
  if (!isRecord(model) || !Array.isArray(model.accounts)) {
    throw new Error("router panel model is invalid");
  }
  const current = model.accounts.find(
    (account) => isRecord(account) && account.isCurrent === true,
  );
  if (current === undefined) return null;
  const alias = readAlias(current.alias);
  return Object.freeze({ alias, label: `Route: ${alias}` });
}

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function menuRenderSignature(model, busyAlias, quotaBusy, transientMessage) {
  return JSON.stringify({
    accounts: model.accounts,
    banner: model.banner,
    busyAlias,
    quotaBusy,
    transientMessage,
  });
}

function syncProfileRouteIdentity(identity) {
  for (const button of document.querySelectorAll(PROFILE_BUTTON_SELECTOR)) {
    if (!(button instanceof HTMLElement)) continue;
    let badge = button.querySelector(`[${PROFILE_ROUTE_ATTRIBUTE}]`);
    if (identity === null) {
      badge?.remove();
      continue;
    }
    if (!(badge instanceof HTMLElement)) {
      badge = element("span");
      badge.setAttribute(PROFILE_ROUTE_ATTRIBUTE, "");
      badge.setAttribute("aria-hidden", "true");
      Object.assign(badge.style, {
        display: "inline-flex",
        alignItems: "center",
        marginInlineStart: "6px",
        borderRadius: "999px",
        padding: "1px 6px",
        fontSize: "11px",
        fontWeight: "600",
        lineHeight: "1.4",
        whiteSpace: "nowrap",
        background: "color-mix(in srgb, currentColor 12%, transparent)",
      });
      button.append(badge);
    }
    if (badge.textContent !== identity.label) badge.textContent = identity.label;
  }
}

function findProfileMenu() {
  const profileButton = document.querySelector(PROFILE_BUTTON_SELECTOR);
  if (!(profileButton instanceof HTMLElement) || profileButton.getAttribute("aria-expanded") !== "true") {
    return null;
  }
  const usageItem = [...document.querySelectorAll(PROFILE_MENU_ITEM_SELECTOR)].find(
    (item) => item.textContent?.trim() === "Usage remaining",
  );
  if (!(usageItem instanceof HTMLElement)) return null;
  let candidate = usageItem.parentElement;
  while (candidate && candidate !== document.body) {
    const itemLabels = [...candidate.querySelectorAll(PROFILE_MENU_ITEM_SELECTOR)].map(
      (item) => item.textContent?.trim() ?? "",
    );
    if (
      itemLabels.includes("Usage remaining") &&
      itemLabels.some((label) => label.startsWith("Settings")) &&
      itemLabels.includes("Log out")
    ) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return null;
}

function renderProfileMenu(
  model,
  onSwitch,
  onQuotaRefresh,
  busyAlias = null,
  quotaBusy = false,
  transientMessage = null,
) {
  const menu = findProfileMenu();
  if (!(menu instanceof HTMLElement)) return false;
  const signature = menuRenderSignature(model, busyAlias, quotaBusy, transientMessage);
  const currentSection = menu.querySelector(`#${MENU_SECTION_ID}`);
  if (currentSection instanceof HTMLElement && currentSection.dataset.renderSignature === signature) {
    return true;
  }
  const style = element("style");
  style.textContent = `
    #${MENU_SECTION_ID} { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%;
      padding: 4px 6px 5px; color: inherit; font: inherit; }
    #${MENU_SECTION_ID} * { box-sizing: border-box; }
    #${MENU_SECTION_ID} .router-separator { height: 1px; margin: 2px -6px 6px;
      background: color-mix(in srgb, currentColor 12%, transparent); }
    #${MENU_SECTION_ID} .router-heading { display: flex; align-items: center; justify-content: space-between;
      gap: 6px; padding: 1px 6px 4px; font-size: 12px; font-weight: 650; }
    #${MENU_SECTION_ID} .router-heading-actions { display: inline-flex; align-items: center; gap: 5px; }
    #${MENU_SECTION_ID} .router-limited { opacity: .58; font-size: 9px; font-weight: 500; }
    #${MENU_SECTION_ID} .router-refresh { border: 0; border-radius: 5px; padding: 2px 5px;
      background: transparent; color: inherit; font: inherit; font-size: 10px; line-height: 1.25; }
    #${MENU_SECTION_ID} .router-refresh:not(:disabled):hover { background: color-mix(in srgb, currentColor 8%, transparent); }
    #${MENU_SECTION_ID} .router-refresh:disabled { opacity: .5; }
    #${MENU_SECTION_ID} .router-banner { margin: 0 4px 6px; border-radius: 6px; padding: 6px 8px;
      background: color-mix(in srgb, #d97706 16%, transparent); font-size: 11px; }
    #${MENU_SECTION_ID} .router-error { background: color-mix(in srgb, #dc2626 15%, transparent); }
    #${MENU_SECTION_ID} .router-account { display: flex; width: 100%; min-height: 42px; align-items: center;
      gap: 7px; border: 0; border-radius: 6px; padding: 5px 7px; background: transparent; color: inherit;
      font: inherit; text-align: left; }
    #${MENU_SECTION_ID} .router-account:not(:disabled):hover { background: color-mix(in srgb, currentColor 8%, transparent); }
    #${MENU_SECTION_ID} .router-account:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; }
    #${MENU_SECTION_ID} .router-account:disabled { cursor: default; opacity: .72; }
    #${MENU_SECTION_ID} .router-account-copy { min-width: 0; flex: 1; }
    #${MENU_SECTION_ID} .router-account-title { display: flex; align-items: baseline; gap: 6px; font-weight: 600; }
    #${MENU_SECTION_ID} .router-state { opacity: .62; font-size: 10px; font-weight: 500; }
    #${MENU_SECTION_ID} .router-account-detail { display: block; margin-top: 1px; opacity: .62;
      overflow-wrap: anywhere; font-size: 9px; line-height: 1.25; }
    #${MENU_SECTION_ID} .router-action { flex: none; font-size: 11px; font-weight: 600; }
    #${MENU_SECTION_ID} .router-current { color: #16a34a; }
    #${MENU_SECTION_ID} .router-footnote { margin: 5px 6px 1px; opacity: .55; font-size: 10px; line-height: 1.3; }
  `;
  const section = element("div");
  section.id = MENU_SECTION_ID;
  section.dataset.routerPanelReady = "true";
  section.dataset.renderSignature = signature;
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", `Account route (${model.accounts.length})`);
  const separator = element("div", "router-separator");
  separator.setAttribute("role", "separator");
  const heading = element("div", "router-heading");
  const headingActions = element("span", "router-heading-actions");
  headingActions.append(element("span", "router-limited", "New session"));
  const refreshButton = element("button", "router-refresh", quotaBusy ? "Refreshing…" : "Refresh");
  refreshButton.type = "button";
  refreshButton.disabled = quotaBusy;
  refreshButton.title = "Refresh Primary weekly quota without sending a model request";
  refreshButton.setAttribute("aria-label", "Refresh Primary weekly quota");
  refreshButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onQuotaRefresh();
  });
  headingActions.append(refreshButton);
  heading.append(element("span", undefined, "Account route"), headingActions);
  section.append(style, separator, heading);
  if (model.banner) section.append(element("p", "router-banner", model.banner));
  if (transientMessage) section.append(element("p", "router-banner router-error", transientMessage));
  for (const account of model.accounts) {
    const button = element("button", "router-account");
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(account.isCurrent));
    button.dataset.switchAlias = account.alias;
    button.disabled = account.switchDisabled || busyAlias !== null;
    button.title = account.switchDisabledReason ?? "Start a new backend session on this account";
    const copy = element("span", "router-account-copy");
    const title = element("span", "router-account-title");
    title.append(
      element("span", undefined, account.alias),
      element("span", "router-state", account.stateLabel),
    );
    copy.append(
      title,
      element(
        "span",
        "router-account-detail",
        `Weekly ${account.weeklyLabel}`,
      ),
      element(
        "span",
        "router-account-detail",
        `${account.weeklyDetail} · Cooldown ${account.cooldownLabel}`,
      ),
    );
    const action = element(
      "span",
      `router-action${account.isCurrent ? " router-current" : ""}`,
      account.isCurrent ? "Current" : busyAlias === account.alias ? "Switching…" : "Switch",
    );
    button.append(copy, action);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSwitch(account);
    });
    section.append(button);
  }
  section.append(element("p", "router-footnote", "Cross-account continuity is not verified."));
  if (currentSection instanceof HTMLElement) currentSection.replaceWith(section);
  else menu.append(section);
  return true;
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
  let model = null;
  let eventSource = null;
  let pollTimer = null;
  let profileMenuObserver = null;
  let stopped = false;
  let busyAlias = null;
  let quotaBusy = false;
  let quotaRefreshAttempted = false;
  let transientMessage = null;
  let menuRenderQueued = false;

  const renderSurfaces = () => {
    if (!model || stopped) return;
    syncProfileRouteIdentity(currentRouteIdentity(model));
    renderProfileMenu(
      model,
      requestSwitch,
      () => requestQuotaRefresh(true),
      busyAlias,
      quotaBusy,
      transientMessage,
    );
  };
  const queueSurfaceRender = () => {
    if (menuRenderQueued || stopped) return;
    menuRenderQueued = true;
    queueMicrotask(() => {
      menuRenderQueued = false;
      renderSurfaces();
    });
  };
  const showError = (message) => {
    transientMessage = message;
    renderSurfaces();
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
    renderSurfaces();
    setPanelStage("ready");
    return "enabled";
  };
  async function requestQuotaRefresh(showFailure) {
    if (stopped || quotaBusy) return;
    quotaBusy = true;
    quotaRefreshAttempted = true;
    transientMessage = null;
    renderSurfaces();
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
      ) {
        throw new Error("weekly quota refresh failed");
      }
      await refresh();
    } catch {
      if (showFailure) showError("Weekly quota refresh was not available.");
    } finally {
      quotaBusy = false;
      renderSurfaces();
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
    renderSurfaces();
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
      renderSurfaces();
    }
  }

  try {
    if (await refresh() === "disabled") return () => undefined;
  } catch {
    return () => undefined;
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
  if (typeof MutationObserver === "function") {
    profileMenuObserver = new MutationObserver(queueSurfaceRender);
    profileMenuObserver.observe(document.body, { childList: true, subtree: true });
    queueSurfaceRender();
  }
  installedCleanup = () => {
    if (stopped) return;
    stopped = true;
    eventSource?.close();
    profileMenuObserver?.disconnect();
    if (pollTimer !== null) window.clearInterval(pollTimer);
    document.getElementById(MENU_SECTION_ID)?.remove();
    document.querySelectorAll(`[${PROFILE_ROUTE_ATTRIBUTE}]`).forEach((badge) => badge.remove());
    installedCleanup = null;
  };
  window.addEventListener("beforeunload", installedCleanup, { once: true });
  return installedCleanup;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  setPanelStage("module_loaded");
  installRouterAccountPanel().catch(() => setPanelStage("install_failed"));
}
