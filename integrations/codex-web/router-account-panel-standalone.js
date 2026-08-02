const STATUS_PATH = "/__backend/codex-router/status";
const EVENTS_PATH = "/__backend/codex-router/events";
const SWITCH_PATH = "/__backend/codex-router/switch";
const QUOTA_REFRESH_PATH = "/__backend/codex-router/quota-refresh";
const ACCOUNT_AUTH_PATH = "/__backend/codex-router/accounts/device-auth";
const SESSION_PATH = "/__backend/session";
const MENU_SECTION_ID = "codex-router-account-menu-section";
const PROFILE_ROUTE_ATTRIBUTE = "data-codex-router-current-route";
const NATIVE_USAGE_BADGE_ATTRIBUTE = "data-codex-router-native-usage-badge";
const NATIVE_USAGE_SYNC_ATTRIBUTE = "data-codex-router-native-usage-sync";
const NATIVE_USAGE_ORIGINAL_ATTRIBUTE = "data-codex-router-native-usage-original";
const PROFILE_BUTTON_SELECTOR = 'button[aria-label="Open profile menu"]';
const PROFILE_MENU_ITEM_SELECTOR = '[role="menuitem"]';
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

function menuRenderSignature(model, busyAlias, quotaBusy, transientMessage, management) {
  return JSON.stringify({
    accounts: model.accounts,
    banner: model.banner,
    busyAlias,
    quotaBusy,
    transientMessage,
    management,
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

function findUsageMenuItem(root = document) {
  return [...root.querySelectorAll(PROFILE_MENU_ITEM_SELECTOR)].find(
    (item) => item.textContent?.trim().startsWith("Usage remaining"),
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

function pruneNativeProfileMenuItems(root = document) {
  let removed = 0;
  for (const item of root.querySelectorAll(PROFILE_MENU_ITEM_SELECTOR)) {
    if (!isPrunedNativeMenuLabel(item.textContent ?? "")) continue;
    item.remove();
    removed += 1;
  }
  return removed;
}

function nativeUsageRow(template, label, values) {
  const row = template.cloneNode(false);
  row.removeAttribute(NATIVE_USAGE_ORIGINAL_ATTRIBUTE);
  delete row.dataset.routerOriginalDisplay;
  row.style.display = template.dataset.routerOriginalDisplay ?? "";
  const leftTemplate = template.children[0];
  const rightTemplate = template.children[1];
  const left = leftTemplate instanceof HTMLElement
    ? leftTemplate.cloneNode(false)
    : element("span");
  const right = rightTemplate instanceof HTMLElement
    ? rightTemplate.cloneNode(false)
    : element("span");
  const leftValue = element("span", "shrink-0", label);
  left.append(leftValue);
  values.forEach((value, index) => {
    if (index > 0) {
      const separator = element("span", "shrink-0", "·");
      separator.setAttribute("aria-hidden", "true");
      right.append(separator);
    }
    right.append(element("span", "shrink-0", value));
  });
  row.append(left, right);
  return row;
}

function restoreNativeUsageSurfaces() {
  document.querySelectorAll(`[${NATIVE_USAGE_BADGE_ATTRIBUTE}]`).forEach((node) => node.remove());
  document.querySelectorAll(`[${NATIVE_USAGE_SYNC_ATTRIBUTE}]`).forEach((node) => node.remove());
  document.querySelectorAll(`[${NATIVE_USAGE_ORIGINAL_ATTRIBUTE}]`).forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    node.style.display = node.dataset.routerOriginalDisplay ?? "";
    delete node.dataset.routerOriginalDisplay;
    node.removeAttribute(NATIVE_USAGE_ORIGINAL_ATTRIBUTE);
  });
}

function syncNativeUsageSurface(model) {
  const presentation = nativeUsagePresentation(model);
  const usageItem = findUsageMenuItem();
  if (!(usageItem instanceof HTMLElement) || presentation === null) return false;

  const itemRow = usageItem.firstElementChild;
  if (itemRow instanceof HTMLElement) {
    let badge = usageItem.querySelector(`[${NATIVE_USAGE_BADGE_ATTRIBUTE}]`);
    if (!(badge instanceof HTMLElement)) {
      badge = element("span");
      badge.setAttribute(NATIVE_USAGE_BADGE_ATTRIBUTE, "");
      badge.setAttribute("aria-hidden", "true");
      Object.assign(badge.style, {
        marginInlineStart: "auto",
        marginInlineEnd: "4px",
        fontSize: "10px",
        fontWeight: "600",
        opacity: ".62",
        whiteSpace: "nowrap",
      });
      itemRow.insertBefore(badge, itemRow.lastElementChild);
    }
    if (badge.textContent !== presentation.badgeLabel) {
      badge.textContent = presentation.badgeLabel;
    }
  }

  const expansion = usageItem.nextElementSibling;
  if (!(expansion instanceof HTMLElement)) return true;
  let originalRow = expansion.querySelector(`[${NATIVE_USAGE_ORIGINAL_ATTRIBUTE}]`);
  if (!(originalRow instanceof HTMLElement)) {
    const weeklyLabel = [...expansion.querySelectorAll("span")].find(
      (node) => node.children.length === 0 && node.textContent?.trim() === "Weekly",
    );
    const candidate = weeklyLabel?.parentElement?.parentElement;
    if (!(candidate instanceof HTMLElement) || candidate.children.length < 2) return true;
    originalRow = candidate;
    originalRow.setAttribute(NATIVE_USAGE_ORIGINAL_ATTRIBUTE, "");
    originalRow.dataset.routerOriginalDisplay = originalRow.style.display;
    originalRow.style.display = "none";
  }
  const signature = JSON.stringify(presentation);
  const current = expansion.querySelector(`[${NATIVE_USAGE_SYNC_ATTRIBUTE}]`);
  if (current instanceof HTMLElement && current.dataset.renderSignature === signature) return true;

  const sync = element("div");
  sync.setAttribute(NATIVE_USAGE_SYNC_ATTRIBUTE, "");
  sync.dataset.renderSignature = signature;
  sync.setAttribute("aria-label", `Current model route ${presentation.alias}`);
  sync.append(
    nativeUsageRow(
      originalRow,
      presentation.weeklyLabel,
      [presentation.weeklyValue, presentation.resetValue],
    ),
    nativeUsageRow(originalRow, "Refreshed", [presentation.refreshedValue]),
  );
  if (current instanceof HTMLElement) current.replaceWith(sync);
  else originalRow.insertAdjacentElement("afterend", sync);
  return true;
}

function findProfileMenu() {
  const profileButton = document.querySelector(PROFILE_BUTTON_SELECTOR);
  if (!(profileButton instanceof HTMLElement) || profileButton.getAttribute("aria-expanded") !== "true") {
    return null;
  }
  const usageItem = findUsageMenuItem();
  if (!(usageItem instanceof HTMLElement)) return null;
  let candidate = usageItem.parentElement;
  while (candidate && candidate !== document.body) {
    const itemLabels = [...candidate.querySelectorAll(PROFILE_MENU_ITEM_SELECTOR)].map(
      (item) => item.textContent?.trim() ?? "",
    );
    if (
      itemLabels.some((label) => label.startsWith("Usage remaining")) &&
      itemLabels.some((label) => label.startsWith("Settings"))
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
  onBeginAdd,
  onSubmitAdd,
  onCancelManagement,
  onBeginRemove,
  onConfirmRemove,
  busyAlias = null,
  quotaBusy = false,
  transientMessage = null,
  management = { mode: "idle" },
) {
  const menu = findProfileMenu();
  if (!(menu instanceof HTMLElement)) return false;
  const signature = menuRenderSignature(model, busyAlias, quotaBusy, transientMessage, management);
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
    #${MENU_SECTION_ID} .router-management { margin: 2px 4px 6px; border-radius: 6px; padding: 7px;
      background: color-mix(in srgb, currentColor 6%, transparent); font-size: 11px; }
    #${MENU_SECTION_ID} .router-management-row { display: flex; align-items: center; gap: 5px; }
    #${MENU_SECTION_ID} .router-management input { min-width: 0; flex: 1; border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
      border-radius: 5px; padding: 5px 6px; background: transparent; color: inherit; font: inherit; }
    #${MENU_SECTION_ID} .router-management button, #${MENU_SECTION_ID} .router-remove { border: 0; border-radius: 5px;
      padding: 4px 6px; background: color-mix(in srgb, currentColor 9%, transparent); color: inherit; font: inherit; font-size: 10px; }
    #${MENU_SECTION_ID} .router-management button:disabled, #${MENU_SECTION_ID} .router-remove:disabled { opacity: .45; }
    #${MENU_SECTION_ID} .router-device-code-row { display: flex; align-items: center; gap: 5px; margin: 4px 0; }
    #${MENU_SECTION_ID} .router-device-code { display: block; min-width: 0; flex: 1; margin: 0;
      font: 600 14px/1.4 ui-monospace, monospace; letter-spacing: .08em; user-select: all; }
    #${MENU_SECTION_ID} .router-auth-link { color: inherit; text-decoration: underline; }
    #${MENU_SECTION_ID} .router-account-row { display: flex; align-items: center; gap: 2px; }
    #${MENU_SECTION_ID} .router-banner { margin: 0 4px 6px; border-radius: 6px; padding: 6px 8px;
      background: color-mix(in srgb, #d97706 16%, transparent); font-size: 11px; }
    #${MENU_SECTION_ID} .router-error { background: color-mix(in srgb, #dc2626 15%, transparent); }
    #${MENU_SECTION_ID} .router-account { display: flex; min-width: 0; flex: 1; min-height: 42px; align-items: center;
      gap: 7px; border: 0; border-radius: 6px; padding: 5px 7px; background: transparent; color: inherit;
      font: inherit; text-align: left; }
    #${MENU_SECTION_ID} .router-account:not(:disabled):hover { background: color-mix(in srgb, currentColor 8%, transparent); }
    #${MENU_SECTION_ID} .router-account:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; }
    #${MENU_SECTION_ID} .router-account:disabled { cursor: default; opacity: .72; }
    #${MENU_SECTION_ID} .router-account-copy { min-width: 0; flex: 1; }
    #${MENU_SECTION_ID} .router-account-title { display: flex; align-items: baseline; gap: 6px; font-weight: 600; }
    #${MENU_SECTION_ID} .router-state { opacity: .62; font-size: 10px; font-weight: 500; }
    #${MENU_SECTION_ID} .router-account-detail { display: block; margin-top: 1px; opacity: .62;
      overflow-wrap: anywhere; font-size: 10px; line-height: 1.25; }
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
    copy.append(
      title,
      element(
        "span",
        "router-account-detail",
        `Weekly ${account.weeklyLabel.replace(" remaining", "")} · Cooldown ${account.cooldownLabel}`,
      ),
      element(
        "span",
        "router-account-detail",
        account.weeklyResetDetail,
      ),
      element(
        "span",
        "router-account-detail",
        account.weeklyDetail,
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
    const remove = element("button", "router-remove", "Delete");
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
  let management = { mode: "idle" };
  let managementPollTimer = null;
  let menuRenderQueued = false;

  const renderSurfaces = () => {
    if (!model || stopped) return;
    pruneNativeProfileMenuItems();
    syncProfileRouteIdentity(currentRouteIdentity(model));
    syncNativeUsageSurface(model);
    renderProfileMenu(
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
    renderSurfaces();
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
    renderSurfaces();
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
      renderSurfaces();
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
      renderSurfaces();
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
    renderSurfaces();
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
    renderSurfaces();
  }
  async function confirmRemove(alias) {
    if (stopped || management.mode !== "remove_confirm" || management.alias !== alias) return;
    management = { mode: "remove_working", alias };
    renderSurfaces();
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
    clearManagementPoll();
    eventSource?.close();
    profileMenuObserver?.disconnect();
    if (pollTimer !== null) window.clearInterval(pollTimer);
    document.getElementById(MENU_SECTION_ID)?.remove();
    document.querySelectorAll(`[${PROFILE_ROUTE_ATTRIBUTE}]`).forEach((badge) => badge.remove());
    restoreNativeUsageSurfaces();
    installedCleanup = null;
  };
  window.addEventListener("beforeunload", installedCleanup, { once: true });
  return installedCleanup;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  setPanelStage("module_loaded");
  installRouterAccountPanel().catch(() => setPanelStage("install_failed"));
}
