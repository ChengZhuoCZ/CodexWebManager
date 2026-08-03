import {
  accountSurfaceVisibility,
  createAccountSurfaceState,
  reduceAccountSurfaceState,
} from "./router-account-surface-lifecycle.js?v=r115";

const STATUS_PATH = "/__backend/codex-router/status";
const EVENTS_PATH = "/__backend/codex-router/events";
const SWITCH_PATH = "/__backend/codex-router/switch";
const QUOTA_REFRESH_PATH = "/__backend/codex-router/quota-refresh";
const ACCOUNT_AUTH_PATH = "/__backend/codex-router/accounts/device-auth";
const SESSION_PATH = "/__backend/session";
const ACCOUNT_CONTROLS_SECTION_ID = "codex-router-account-controls";
const OWNED_SURFACE_HOST_ID = "codex-router-owned-account-surface";
const PROFILE_BUTTON_SELECTOR = 'button[aria-label="Open profile menu"]';
const PROFILE_BUTTON_FALLBACK_SELECTOR = 'button[aria-haspopup="menu"]';
const PROFILE_MENU_SELECTOR = '[role="menu"]';
const PROFILE_MENU_ITEM_SELECTOR = '[role="menuitem"]';
const PROFILE_MENU_ACTIVATION_EVENTS = Object.freeze(["click", "keydown"]);
const PROFILE_MENU_RENDER_MAX_ATTEMPTS = 5;
const PROFILE_MENU_RENDER_DELAYS_MS = Object.freeze([0, 16, 40, 80, 160]);
const POLL_INTERVAL_MS = 30_000;
const PRUNED_NATIVE_MENU_LABELS = new Set(["Show pet", "Log out"]);
const DEVICE_CODE_PATTERN = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4})+$/u;

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
      weekly_resets_at: readTimestamp(candidate.weekly_resets_at ?? null),
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

export function buildManualSwitchRequest(account) {
  if (!isRecord(account) || account.switchDisabled !== false) {
    throw new Error("manual switch is unavailable");
  }
  return Object.freeze({ account_alias: readAlias(account.alias), reason: "manual" });
}

export function buildAccountEnrollmentRequest(value) {
  const alias = readAlias(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u.test(alias) || alias.includes("@")) {
    throw new Error("account alias is invalid");
  }
  return Object.freeze({ alias });
}

export function buildAccountRemovalRequest(alias, model) {
  const safe = readAlias(alias);
  if (
    !isRecord(model) || !Array.isArray(model.accounts) ||
    !Number.isSafeInteger(model.activeStreams) || model.activeStreams > 0 ||
    model.accounts.length <= 1 ||
    model.accounts.some((account) => isRecord(account) && account.alias === safe && account.isCurrent)
  ) throw new Error("account removal is unavailable");
  if (!model.accounts.some((account) => isRecord(account) && account.alias === safe)) {
    throw new Error("account removal is unavailable");
  }
  return Object.freeze({ confirm_alias: safe });
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

function compactUtcLabel(timestamp) {
  if (timestamp === null) return "Unavailable";
  return utcLabel(timestamp).replace(/^\d{4}-/u, "");
}

export function nativeUsagePresentation(model) {
  if (!isRecord(model) || !Array.isArray(model.accounts)) {
    throw new Error("router panel model is invalid");
  }
  const current = model.accounts.find(
    (account) => isRecord(account) && account.isCurrent === true,
  );
  if (current === undefined) return null;
  const alias = readAlias(current.alias);
  const weeklyValue = typeof current.weeklyLabel === "string"
    ? current.weeklyLabel.replace(" remaining", "").replace("Not observed yet", "Unavailable")
    : "Unavailable";
  const resetTimestamp = typeof current.weeklyResetDetail === "string" &&
      current.weeklyResetDetail.startsWith("Resets ")
    ? current.weeklyResetDetail.slice("Resets ".length)
    : null;
  const refreshedTimestamp = typeof current.weeklyDetail === "string" &&
      current.weeklyDetail.startsWith("Refreshed ")
    ? current.weeklyDetail.slice("Refreshed ".length)
    : null;
  return Object.freeze({
    alias,
    badgeLabel: alias,
    weeklyLabel: `Weekly · ${alias}`,
    weeklyValue,
    resetValue: resetTimestamp === null
      ? "Reset unavailable"
      : `Reset ${compactUtcLabel(resetTimestamp)}`,
    refreshedValue: refreshedTimestamp === null
      ? "Unavailable"
      : compactUtcLabel(refreshedTimestamp),
  });
}

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function accountControlsRenderSignature(model, busyAlias, quotaBusy, transientMessage, management) {
  return JSON.stringify({
    accounts: model.accounts,
    banner: model.banner,
    busyAlias,
    quotaBusy,
    transientMessage,
    management,
  });
}

function visibleRectangle(node) {
  if (!(node instanceof HTMLElement)) return null;
  const rectangle = node.getBoundingClientRect();
  if (
    !Number.isFinite(rectangle.left) || !Number.isFinite(rectangle.top) ||
    !Number.isFinite(rectangle.right) || !Number.isFinite(rectangle.bottom) ||
    rectangle.width <= 0 || rectangle.height <= 0
  ) return null;
  return rectangle;
}

function profileButtonCandidates() {
  const exact = [...document.querySelectorAll(PROFILE_BUTTON_SELECTOR)].filter(
    (button) => button instanceof HTMLElement,
  );
  if (exact.length > 0) return exact;
  return [...document.querySelectorAll(PROFILE_BUTTON_FALLBACK_SELECTOR)]
    .filter((button) =>
      button instanceof HTMLElement &&
      button.closest(PROFILE_MENU_SELECTOR) === null &&
      visibleRectangle(button) !== null
    )
    .sort((left, right) => {
      const leftRectangle = visibleRectangle(left);
      const rightRectangle = visibleRectangle(right);
      if (leftRectangle === null || rightRectangle === null) return 0;
      if (leftRectangle.bottom !== rightRectangle.bottom) {
        return rightRectangle.bottom - leftRectangle.bottom;
      }
      return leftRectangle.left - rightRectangle.left;
    });
}

function profileButton({ expandedOnly = false } = {}) {
  return profileButtonCandidates().find((button) =>
    !expandedOnly || button.getAttribute("aria-expanded") === "true"
  ) ?? null;
}

export function isPrunedNativeMenuLabel(value) {
  return typeof value === "string" && PRUNED_NATIVE_MENU_LABELS.has(value.trim());
}

export async function copyDeviceAuthorizationCode(value, {
  clipboardWrite,
  legacyCopy,
} = {}) {
  if (typeof value !== "string" || !DEVICE_CODE_PATTERN.test(value)) {
    throw new Error("device authorization code is invalid");
  }
  if (typeof clipboardWrite === "function") {
    try {
      await clipboardWrite(value);
      return "clipboard";
    } catch {}
  }
  if (typeof legacyCopy === "function" && legacyCopy(value) === true) {
    return "legacy";
  }
  throw new Error("device authorization code copy failed");
}

function legacyDocumentCopy(value) {
  if (typeof document.execCommand !== "function" || !(document.body instanceof HTMLElement)) {
    return false;
  }
  const input = element("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.setAttribute("aria-hidden", "true");
  Object.assign(input.style, {
    position: "absolute",
    insetInlineStart: "-10000px",
    top: "0",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, input.value.length);
    return document.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    input.remove();
  }
}

function copyDeviceCodeFromPage(value) {
  const clipboard = globalThis.navigator?.clipboard;
  return copyDeviceAuthorizationCode(value, {
    clipboardWrite: typeof clipboard?.writeText === "function"
      ? (text) => clipboard.writeText(text)
      : undefined,
    legacyCopy: legacyDocumentCopy,
  });
}

function controlledProfileMenu(button) {
  for (const attribute of ["aria-controls", "aria-owns"]) {
    const identifier = button.getAttribute(attribute);
    if (identifier === null || identifier === "") continue;
    const controlled = document.getElementById(identifier);
    if (!(controlled instanceof HTMLElement)) continue;
    if (controlled.matches(PROFILE_MENU_SELECTOR)) return controlled;
    const nested = controlled.querySelector(PROFILE_MENU_SELECTOR);
    if (nested instanceof HTMLElement) return nested;
  }
  return null;
}

function profileMenuDistance(menu, button) {
  const menuRectangle = visibleRectangle(menu);
  const buttonRectangle = visibleRectangle(button);
  if (menuRectangle === null || buttonRectangle === null) return Number.POSITIVE_INFINITY;
  const horizontalGap = Math.max(
    0,
    buttonRectangle.left - menuRectangle.right,
    menuRectangle.left - buttonRectangle.right,
  );
  const verticalGap = Math.abs(buttonRectangle.top - menuRectangle.bottom);
  return horizontalGap * 4 + verticalGap;
}

function findProfileMenu() {
  const button = profileButton({ expandedOnly: true });
  if (!(button instanceof HTMLElement)) {
    return null;
  }
  const controlled = controlledProfileMenu(button);
  if (controlled instanceof HTMLElement) return controlled;

  const structural = [...document.querySelectorAll(PROFILE_MENU_SELECTOR)]
    .filter((menu) =>
      menu instanceof HTMLElement &&
      visibleRectangle(menu) !== null &&
      menu.querySelector(PROFILE_MENU_ITEM_SELECTOR) !== null
    )
    .sort((left, right) =>
      profileMenuDistance(left, button) - profileMenuDistance(right, button)
    )[0];
  if (structural instanceof HTMLElement) return structural;

  return null;
}

function renderAccountControls(
  model,
  onSwitch,
  onQuotaRefresh,
  onBeginAdd,
  onSubmitAdd,
  onCancelManagement,
  onBeginRemove,
  onConfirmRemove,
  busyAlias = null,
  quotaBusy = false,
  transientMessage = null,
  management = { mode: "idle" },
  explicitContainer,
  sectionId = ACCOUNT_CONTROLS_SECTION_ID,
) {
  const container = explicitContainer;
  if (!(container instanceof HTMLElement)) return false;
  const signature = accountControlsRenderSignature(
    model,
    busyAlias,
    quotaBusy,
    transientMessage,
    management,
  );
  const currentSection = container.querySelector(`#${sectionId}`);
  if (currentSection instanceof HTMLElement && currentSection.dataset.renderSignature === signature) {
    return true;
  }
  const style = element("style");
  style.textContent = `
    #${sectionId} { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%;
      padding: 3px 5px 4px; color: inherit; font: inherit; }
    #${sectionId} * { box-sizing: border-box; }
    #${sectionId} .router-separator { height: 1px; margin: 2px -5px 5px;
      background: color-mix(in srgb, currentColor 12%, transparent); }
    #${sectionId} .router-heading { display: flex; align-items: center; justify-content: space-between;
      gap: 5px; padding: 1px 5px 3px; font-size: 12px; font-weight: 650; }
    #${sectionId} .router-heading-actions { display: inline-flex; align-items: center; gap: 3px; }
    #${sectionId} .router-limited { border-radius: 999px; padding: 1px 5px;
      background: color-mix(in srgb, #16a34a 13%, transparent); color: #16a34a;
      font-size: 9px; font-weight: 650; line-height: 1.35; }
    #${sectionId} .router-refresh { border: 0; border-radius: 5px; padding: 2px 4px;
      background: transparent; color: inherit; font: inherit; font-size: 10px; line-height: 1.25; }
    #${sectionId} .router-refresh:not(:disabled):hover { background: color-mix(in srgb, currentColor 8%, transparent); }
    #${sectionId} .router-refresh:disabled { opacity: .5; }
    #${sectionId} .router-management { margin: 2px 4px 6px; border-radius: 6px; padding: 7px;
      background: color-mix(in srgb, currentColor 6%, transparent); font-size: 11px; }
    #${sectionId} .router-management-row { display: flex; align-items: center; gap: 5px; }
    #${sectionId} .router-management input { min-width: 0; flex: 1; border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
      border-radius: 5px; padding: 5px 6px; background: transparent; color: inherit; font: inherit; }
    #${sectionId} .router-management button, #${sectionId} .router-remove { border: 0; border-radius: 5px;
      padding: 4px 6px; background: color-mix(in srgb, currentColor 9%, transparent); color: inherit; font: inherit; font-size: 10px; }
    #${sectionId} .router-management button:disabled, #${sectionId} .router-remove:disabled { opacity: .45; }
    #${sectionId} .router-device-code-row { display: flex; align-items: center; gap: 5px; margin: 4px 0; }
    #${sectionId} .router-device-code { display: block; min-width: 0; flex: 1; margin: 0;
      font: 600 14px/1.4 ui-monospace, monospace; letter-spacing: .08em; user-select: all; }
    #${sectionId} .router-auth-link { color: inherit; text-decoration: underline; }
    #${sectionId} .router-account-row { display: flex; align-items: center; gap: 1px; }
    #${sectionId} .router-banner { margin: 0 4px 6px; border-radius: 6px; padding: 6px 8px;
      background: color-mix(in srgb, #d97706 16%, transparent); font-size: 11px; }
    #${sectionId} .router-error { background: color-mix(in srgb, #dc2626 15%, transparent); }
    #${sectionId} .router-account { display: flex; min-width: 0; flex: 1; min-height: 38px; align-items: center;
      gap: 6px; border: 0; border-radius: 6px; padding: 4px 6px; background: transparent; color: inherit;
      font: inherit; text-align: left; }
    #${sectionId} .router-account:not(:disabled):hover { background: color-mix(in srgb, currentColor 8%, transparent); }
    #${sectionId} .router-account:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; }
    #${sectionId} .router-account:disabled { cursor: default; opacity: .72; }
    #${sectionId} .router-account-copy { min-width: 0; flex: 1; }
    #${sectionId} .router-account-title { display: flex; align-items: baseline; gap: 6px; font-weight: 600; }
    #${sectionId} .router-state { opacity: .62; font-size: 10px; font-weight: 500; }
    #${sectionId} .router-account-meta { display: flex; min-width: 0; flex-wrap: wrap; gap: 1px 5px;
      margin-top: 1px; opacity: .64; overflow-wrap: anywhere; font-size: 9.5px; line-height: 1.2; }
    #${sectionId} .router-account-reset { opacity: .5; font-size: 9px; }
    #${sectionId} .router-action { flex: none; font-size: 11px; font-weight: 600; }
    #${sectionId} .router-current { color: #16a34a; }
    #${sectionId} .router-remove { width: 24px; height: 28px; padding: 0; background: transparent;
      opacity: .62; font-size: 14px; line-height: 1; }
    #${sectionId} .router-remove:not(:disabled):hover { background: color-mix(in srgb, #dc2626 12%, transparent);
      color: #dc2626; opacity: 1; }
    #${sectionId} .router-footnote { margin: 4px 5px 1px; opacity: .52; font-size: 9px; line-height: 1.25; }
  `;
  const section = element("div");
  section.id = sectionId;
  section.dataset.routerPanelReady = "true";
  section.dataset.renderSignature = signature;
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", `Account route (${model.accounts.length})`);
  const separator = element("div", "router-separator");
  separator.setAttribute("role", "separator");
  const heading = element("div", "router-heading");
  const headingActions = element("span", "router-heading-actions");
  headingActions.append(element("span", "router-limited", "Auto"));
  const addButton = element("button", "router-refresh", "Add");
  addButton.type = "button";
  addButton.disabled = model.activeStreams > 0 || management.mode !== "idle";
  addButton.title = model.activeStreams > 0
    ? "Wait for the active response to finish"
    : "Add an account with OpenAI device authorization";
  addButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onBeginAdd();
  });
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
  headingActions.append(addButton, refreshButton);
  heading.append(element("span", undefined, "Account route"), headingActions);
  section.append(style, separator, heading);
  if (model.banner) section.append(element("p", "router-banner", model.banner));
  if (transientMessage) section.append(element("p", "router-banner router-error", transientMessage));
  if (management.mode === "add_alias") {
    const form = element("form", "router-management");
    const row = element("div", "router-management-row");
    const input = element("input");
    input.name = "account_alias";
    input.maxLength = 64;
    input.placeholder = "Account name";
    input.setAttribute("aria-label", "New account name");
    const submit = element("button", undefined, "Authorize");
    submit.type = "submit";
    const cancel = element("button", undefined, "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onCancelManagement();
    });
    row.append(input, submit, cancel);
    form.append(row);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSubmitAdd(input.value);
    });
    section.append(form);
    queueMicrotask(() => input.focus());
  } else if (new Set(["starting", "waiting", "installing"]).has(management.mode)) {
    const box = element("div", "router-management");
    box.append(element("div", undefined, management.mode === "installing"
      ? "Authorization received. Installing account…"
      : "Authorize this account in your browser:"));
    if (management.verificationUrl) {
      const link = element("a", "router-auth-link", management.verificationUrl);
      link.href = management.verificationUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      box.append(link);
    }
    if (management.userCode) {
      const codeRow = element("div", "router-device-code-row");
      const code = element("code", "router-device-code", management.userCode);
      const copy = element("button", undefined, "Copy code");
      copy.type = "button";
      copy.setAttribute("aria-label", "Copy device authorization code");
      copy.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        copy.disabled = true;
        try {
          await copyDeviceCodeFromPage(management.userCode);
          copy.textContent = "Copied";
        } catch {
          copy.textContent = "Copy failed";
        } finally {
          window.setTimeout(() => {
            if (copy.isConnected) {
              copy.disabled = false;
              copy.textContent = "Copy code";
            }
          }, 1_500);
        }
      });
      codeRow.append(code, copy);
      box.append(codeRow);
    }
    const cancel = element("button", undefined, "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onCancelManagement();
    });
    box.append(cancel);
    section.append(box);
  } else if (management.mode === "remove_confirm") {
    const box = element("div", "router-management");
    box.append(element("div", undefined, `Remove ${management.alias}? Its stored credential will be erased.`));
    const row = element("div", "router-management-row");
    const confirm = element("button", undefined, `Delete ${management.alias}`);
    confirm.type = "button";
    confirm.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onConfirmRemove(management.alias);
    });
    const cancel = element("button", undefined, "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onCancelManagement();
    });
    row.append(confirm, cancel);
    box.append(row);
    section.append(box);
  } else if (management.mode === "remove_working") {
    section.append(element("div", "router-management", `Deleting ${management.alias}…`));
  }
  for (const account of model.accounts) {
    const row = element("div", "router-account-row");
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
    const primaryMeta = element("span", "router-account-meta");
    primaryMeta.append(
      element("span", undefined, `Weekly ${account.weeklyLabel.replace(" remaining", "")}`),
      element("span", undefined, `Cooldown ${account.cooldownLabel}`),
    );
    const resetMeta = element("span", "router-account-meta router-account-reset");
    resetMeta.append(
      element("span", undefined, account.weeklyResetDetail),
      element("span", undefined, account.weeklyDetail),
    );
    copy.append(title, primaryMeta, resetMeta);
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
    const remove = element("button", "router-remove", "×");
    remove.type = "button";
    remove.disabled = model.accounts.length <= 1 || account.isCurrent || model.activeStreams > 0 || management.mode !== "idle";
    remove.title = model.accounts.length <= 1
      ? "The last account cannot be deleted"
      : account.isCurrent
        ? "Switch away before deleting this account"
        : model.activeStreams > 0
          ? "Wait for the active response to finish"
          : `Delete ${account.alias}`;
    remove.setAttribute("aria-label", `Delete ${account.alias}`);
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onBeginRemove(account.alias);
    });
    row.append(button, remove);
    section.append(row);
  }
  const footnote = element(
    "p",
    "router-footnote",
    "Auto failover · pre-output only · switching starts a new session.",
  );
  footnote.title = "Cross-account continuity is not verified.";
  section.append(footnote);
  if (currentSection instanceof HTMLElement) currentSection.replaceWith(section);
  else container.append(section);
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

function createOwnedAccountSurface({ onOpen, onClose, onRetry }) {
  document.getElementById(OWNED_SURFACE_HOST_ID)?.remove();
  const host = element("div");
  host.id = OWNED_SURFACE_HOST_ID;
  host.dataset.routerOwnedSurface = "true";
  const root = host.attachShadow({ mode: "open" });
  const style = element("style");
  style.textContent = `
    :host { all: initial; color-scheme: light dark; }
    * { box-sizing: border-box; }
    button { color: inherit; font: inherit; }
    .route-entry, .fallback-launcher { position: fixed; z-index: 2147483000; display: flex;
      min-width: 0; height: 40px; align-items: center; gap: 8px; border: 1px solid rgba(255,255,255,.14);
      border-radius: 8px; padding: 0 11px; background: rgba(31,31,31,.985); color: #f5f5f5;
      box-shadow: 0 8px 28px rgba(0,0,0,.28); font: 500 13px/1.2 -apple-system,
      BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: left; }
    .route-entry:hover, .fallback-launcher:hover { background: rgba(43,43,43,.99); }
    .route-entry:focus-visible, .fallback-launcher:focus-visible, .close:focus-visible {
      outline: 2px solid #3b82f6; outline-offset: 2px; }
    .route-entry { width: 280px; }
    .fallback-launcher { left: 8px; bottom: 56px; width: min(220px, calc(100vw - 16px)); }
    .icon { flex: none; font-size: 17px; opacity: .8; }
    .label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chevron { flex: none; opacity: .55; }
    .backdrop { position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center;
      padding: 16px; background: rgba(0,0,0,.28); font: 13px/1.35 -apple-system,
      BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .card { width: min(360px, calc(100vw - 32px)); max-height: min(720px, calc(100vh - 32px));
      overflow: auto; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 4px;
      background: rgba(31,31,31,.99); box-shadow: 0 20px 60px rgba(0,0,0,.45); color: #f5f5f5;
      overscroll-behavior: contain; }
    .dialog-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center;
      justify-content: space-between; gap: 8px; padding: 8px 9px 5px; background: inherit; }
    .dialog-title { font-size: 13px; font-weight: 650; }
    .close { width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent;
      color: inherit; font-size: 18px; line-height: 1; }
    .close:hover { background: rgba(127,127,127,.14); }
    .notice { padding: 10px; font-size: 12px; }
    .notice button { border: 0; border-radius: 5px; padding: 5px 8px;
      background: rgba(127,127,127,.16); }
    [hidden] { display: none !important; }
    @media (prefers-color-scheme: light) {
      .route-entry, .fallback-launcher, .card { border-color: rgba(0,0,0,.14);
        background: rgba(250,250,250,.99); color: #171717; }
      .route-entry:hover, .fallback-launcher:hover { background: rgba(240,240,240,.99); }
    }
  `;
  const nativeEntry = element("button", "route-entry");
  nativeEntry.type = "button";
  nativeEntry.hidden = true;
  nativeEntry.dataset.routerNativeMenuEntry = "true";
  nativeEntry.setAttribute("aria-haspopup", "dialog");
  const nativeEntryLabel = element("span", "label");
  nativeEntry.append(
    element("span", "icon", "⇄"),
    nativeEntryLabel,
    element("span", "chevron", "›"),
  );
  const fallbackLauncher = element("button", "fallback-launcher");
  fallbackLauncher.type = "button";
  fallbackLauncher.hidden = true;
  fallbackLauncher.dataset.routerFallbackLauncher = "true";
  fallbackLauncher.setAttribute("aria-haspopup", "dialog");
  const fallbackLabel = element("span", "label");
  fallbackLauncher.append(element("span", "icon", "⇄"), fallbackLabel);
  const backdrop = element("div", "backdrop");
  backdrop.hidden = true;
  const card = element("section", "card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Account routing settings");
  const header = element("header", "dialog-header");
  const close = element("button", "close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close account routing settings");
  header.append(element("span", "dialog-title", "Account routing"), close);
  const content = element("div");
  card.append(header, content);
  backdrop.append(card);
  root.append(style, nativeEntry, fallbackLauncher, backdrop);
  document.body.append(host);

  nativeEntry.addEventListener("click", onOpen);
  fallbackLauncher.addEventListener("click", onOpen);
  close.addEventListener("click", onClose);
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) onClose();
  });

  return Object.freeze({
    positionNativeEntry(rectangle) {
      const width = Math.min(320, Math.max(220, rectangle.width));
      const left = Math.max(8, Math.min(rectangle.left, window.innerWidth - width - 8));
      const preferredTop = rectangle.top - 46;
      const top = preferredTop >= 8
        ? preferredTop
        : Math.min(window.innerHeight - 48, rectangle.bottom + 6);
      nativeEntry.style.left = `${left}px`;
      nativeEntry.style.top = `${Math.max(8, top)}px`;
      nativeEntry.style.width = `${width}px`;
    },
    render({ state, label, renderControls }) {
      const visibility = accountSurfaceVisibility(state);
      nativeEntry.hidden = !visibility.nativeMenuEntry;
      fallbackLauncher.hidden = !visibility.fallbackLauncher;
      backdrop.hidden = !visibility.accountDialog;
      nativeEntryLabel.textContent = label;
      fallbackLabel.textContent = label;
      nativeEntry.setAttribute("aria-label", label);
      fallbackLauncher.setAttribute("aria-label", label);
      if (!visibility.accountDialog) return;
      content.replaceChildren();
      if (typeof renderControls === "function") {
        renderControls(content);
        return;
      }
      const notice = element("div", "notice");
      notice.append(element(
        "p",
        undefined,
        state.status === "unavailable"
          ? "Router status is temporarily unavailable."
          : "Account controls are loading…",
      ));
      const retry = element("button", undefined, "Retry");
      retry.type = "button";
      retry.addEventListener("click", onRetry);
      notice.append(retry);
      content.append(notice);
    },
    focusClose() {
      close.focus({ preventScroll: true });
    },
    destroy() {
      host.remove();
    },
  });
}

function createNativeProfileMenuAdapter({ onStateEvent, onMenuRectangle }) {
  let timer = null;
  let attempt = 0;
  let stopped = false;
  const inspect = () => {
    timer = null;
    if (stopped) return;
    const trigger = profileButton();
    onStateEvent({ type: trigger instanceof HTMLElement
      ? "native_trigger_present"
      : "native_trigger_absent" });
    const menu = findProfileMenu();
    if (menu instanceof HTMLElement) {
      onStateEvent({ type: "native_menu_opened" });
      const rectangle = visibleRectangle(menu);
      if (rectangle !== null) onMenuRectangle(rectangle);
    } else {
      onStateEvent({ type: "native_menu_closed" });
    }
    if (attempt + 1 >= PROFILE_MENU_RENDER_MAX_ATTEMPTS) return;
    attempt += 1;
    timer = window.setTimeout(inspect, PROFILE_MENU_RENDER_DELAYS_MS[attempt]);
  };
  const schedule = () => {
    if (stopped) return;
    if (timer !== null) window.clearTimeout(timer);
    attempt = 0;
    timer = window.setTimeout(inspect, PROFILE_MENU_RENDER_DELAYS_MS[0]);
  };
  const activationHandler = (event) => {
    if (
      event.type === "keydown" &&
      (!(event instanceof KeyboardEvent) || !new Set(["Enter", " "]).has(event.key))
    ) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest(PROFILE_BUTTON_FALLBACK_SELECTOR);
    if (button instanceof HTMLElement && profileButtonCandidates().includes(button)) {
      schedule();
      return;
    }
    if (findProfileMenu() instanceof HTMLElement) schedule();
  };
  for (const eventName of PROFILE_MENU_ACTIVATION_EVENTS) {
    document.addEventListener(eventName, activationHandler, true);
  }
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    for (const eventName of PROFILE_MENU_ACTIVATION_EVENTS) {
      document.removeEventListener(eventName, activationHandler, true);
    }
  };
}

export async function installRouterAccountPanel() {
  if (installedCleanup) return installedCleanup;
  await domReady();
  setPanelStage("dom_ready");
  let model = null;
  let eventSource = null;
  let pollTimer = null;
  let stopped = false;
  let busyAlias = null;
  let quotaBusy = false;
  let quotaRefreshAttempted = false;
  let transientMessage = null;
  let management = { mode: "idle" };
  let managementPollTimer = null;
  let surfaceState = createAccountSurfaceState();
  let ownedSurface = null;
  let profileAdapterCleanup = null;

  const renderOwnedSurface = () => {
    if (stopped || ownedSurface === null) return;
    const identity = model === null ? null : currentRouteIdentity(model);
    const label = identity === null
      ? surfaceState.status === "unavailable"
        ? "Account route · Unavailable"
        : "Account route · Loading…"
      : identity.label;
    ownedSurface.render({
      state: surfaceState,
      label,
      renderControls: model === null ? null : (container) => renderAccountControls(
        model,
        requestSwitch,
        () => requestQuotaRefresh(true),
        beginAdd,
        submitAdd,
        cancelManagement,
        beginRemove,
        confirmRemove,
        busyAlias,
        quotaBusy,
        transientMessage,
        management,
        container,
      ),
    });
  };
  const dispatchSurface = (event) => {
    surfaceState = reduceAccountSurfaceState(surfaceState, event);
    renderOwnedSurface();
  };
  ownedSurface = createOwnedAccountSurface({
    onOpen: () => {
      dispatchSurface({ type: "account_dialog_opened" });
      ownedSurface?.focusClose();
    },
    onClose: () => dispatchSurface({ type: "account_dialog_closed" }),
    onRetry: () => {
      dispatchSurface({ type: "status_changed", status: "loading" });
      refresh().catch(() => dispatchSurface({ type: "status_changed", status: "unavailable" }));
    },
  });
  profileAdapterCleanup = createNativeProfileMenuAdapter({
    onStateEvent: dispatchSurface,
    onMenuRectangle: (rectangle) => ownedSurface?.positionNativeEntry(rectangle),
  });
  const escapeHandler = (event) => {
    if (event.key === "Escape" && surfaceState.dialogOpen) {
      dispatchSurface({ type: "account_dialog_closed" });
    }
  };
  document.addEventListener("keydown", escapeHandler, true);
  const showError = (message) => {
    transientMessage = message;
    if (!model) {
      dispatchSurface({ type: "status_changed", status: "unavailable" });
      return;
    }
    renderOwnedSurface();
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
    dispatchSurface({ type: "status_changed", status: "ready" });
    transientMessage = null;
    renderOwnedSurface();
    setPanelStage("ready");
    return "enabled";
  };
  async function requestQuotaRefresh(showFailure) {
    if (stopped || quotaBusy) return;
    quotaBusy = true;
    quotaRefreshAttempted = true;
    transientMessage = null;
    renderOwnedSurface();
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
        (body.weekly_resets_at !== null &&
          (typeof body.weekly_resets_at !== "string" ||
            Number.isNaN(Date.parse(body.weekly_resets_at)))) ||
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
      renderOwnedSurface();
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
    renderOwnedSurface();
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
      renderOwnedSurface();
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
    renderOwnedSurface();
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
    renderOwnedSurface();
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
      renderOwnedSurface();
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
      renderOwnedSurface();
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
    renderOwnedSurface();
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
    renderOwnedSurface();
  }
  async function confirmRemove(alias) {
    if (stopped || management.mode !== "remove_confirm" || management.alias !== alias) return;
    management = { mode: "remove_working", alias };
    renderOwnedSurface();
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
      await refresh();
    } catch {
      management = { mode: "idle" };
      showError("Account deletion was rejected.");
    }
  }

  renderOwnedSurface();
  try {
    if (await refresh() === "disabled") {
      dispatchSurface({ type: "status_changed", status: "unavailable" });
      setPanelStage("disabled");
      renderOwnedSurface();
    }
  } catch {
    dispatchSurface({ type: "status_changed", status: "unavailable" });
    renderOwnedSurface();
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
    profileAdapterCleanup?.();
    document.removeEventListener("keydown", escapeHandler, true);
    if (pollTimer !== null) window.clearInterval(pollTimer);
    ownedSurface?.destroy();
    installedCleanup = null;
  };
  window.addEventListener("beforeunload", installedCleanup, { once: true });
  return installedCleanup;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  setPanelStage("module_loaded");
  installRouterAccountPanel().catch(() => setPanelStage("install_failed"));
}
