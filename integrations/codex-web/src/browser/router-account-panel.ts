import { browserCsrfHeaders } from "./browser-session.js";

const STATUS_PATH = "/__backend/codex-router/status";
const EVENTS_PATH = "/__backend/codex-router/events";
const SWITCH_PATH = "/__backend/codex-router/switch";
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

type AccountState =
  | "healthy"
  | "cooling_down"
  | "half_open"
  | "auth_expired"
  | "quota_exhausted"
  | "disabled"
  | "unknown";

type SwitchReason =
  | "manual"
  | "startup"
  | "quota_exhausted"
  | "rate_limited"
  | "auth_expired"
  | "network_error"
  | "upstream_5xx";

type RouterAccountStatus = {
  alias: string;
  state: AccountState;
  enabled: boolean;
  five_hour_remaining_ratio: number | null;
  weekly_remaining_ratio: number | null;
  snapshot_observed_at: string | null;
  cooldown_until: string | null;
  last_switch_reason: SwitchReason | null;
};

type RouterStatus = {
  status: "ready" | "degraded" | "unavailable";
  architecture_mode: "LIMITED_MODE";
  cross_account_e2e_verified: false;
  active_streams: number;
  current_route: { account_alias: string; continuity: "new_backend_session" } | null;
  accounts: RouterAccountStatus[];
};

export type RouterAccountPanelItem = {
  alias: string;
  state: AccountState;
  stateLabel: string;
  fiveHourLabel: string;
  weeklyLabel: string;
  cooldownLabel: string;
  lastSwitchLabel: string;
  isCurrent: boolean;
  switchDisabled: boolean;
  switchDisabledReason: string | null;
};

export type RouterAccountPanelModel = {
  activeStreams: number;
  allExhausted: boolean;
  banner: string | null;
  accounts: readonly RouterAccountPanelItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readAlias(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    [...value].length < 1 ||
    [...value].length > 64
  ) {
    throw new Error("router status is invalid");
  }
  return value;
}

function readRatio(value: unknown): number | null {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error("router status is invalid");
  }
  return value as number | null;
}

function readTimestamp(value: unknown): string | null {
  if (value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
    throw new Error("router status is invalid");
  }
  return value as string | null;
}

function readRouterStatus(value: unknown): RouterStatus {
  if (
    !isRecord(value) ||
    !new Set(["ready", "degraded", "unavailable"]).has(String(value.status)) ||
    value.architecture_mode !== "LIMITED_MODE" ||
    value.cross_account_e2e_verified !== false ||
    !Number.isSafeInteger(value.active_streams) ||
    Number(value.active_streams) < 0 ||
    Number(value.active_streams) > 1_000_000 ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 1_000
  ) {
    throw new Error("router status is invalid");
  }
  let currentRoute: RouterStatus["current_route"] = null;
  if (value.current_route !== null) {
    if (!isRecord(value.current_route) || value.current_route.continuity !== "new_backend_session") {
      throw new Error("router status is invalid");
    }
    currentRoute = {
      account_alias: readAlias(value.current_route.account_alias),
      continuity: "new_backend_session",
    };
  }
  const accounts = value.accounts.map((candidate): RouterAccountStatus => {
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
      state: candidate.state as AccountState,
      enabled: candidate.enabled,
      five_hour_remaining_ratio: readRatio(candidate.five_hour_remaining_ratio),
      weekly_remaining_ratio: readRatio(candidate.weekly_remaining_ratio),
      snapshot_observed_at: readTimestamp(candidate.snapshot_observed_at),
      cooldown_until: readTimestamp(candidate.cooldown_until),
      last_switch_reason: candidate.last_switch_reason as SwitchReason | null,
    };
  });
  return {
    status: value.status as RouterStatus["status"],
    architecture_mode: "LIMITED_MODE",
    cross_account_e2e_verified: false,
    active_streams: Number(value.active_streams),
    current_route: currentRoute,
    accounts,
  };
}

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function reasonLabel(reason: SwitchReason | null): string {
  const labels: Record<SwitchReason, string> = {
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

function ratioLabel(value: number | null): string {
  return value === null ? "Unavailable" : `${Math.round(value * 100)}%`;
}

function switchDisabledReason(
  account: RouterAccountStatus,
  status: RouterStatus,
): string | null {
  if (status.active_streams > 0) return "Active response in progress";
  if (status.current_route?.account_alias === account.alias) return "Current route";
  if (!account.enabled || account.state === "disabled") return "Account disabled";
  if (account.state === "quota_exhausted") return "Quota exhausted";
  if (account.state === "cooling_down") return "Account cooling down";
  if (account.state === "auth_expired") return "Authentication expired";
  if (account.state === "half_open") return "Account is probing recovery";
  return null;
}

export function deriveRouterAccountPanelModel(value: unknown): RouterAccountPanelModel {
  const status = readRouterStatus(value);
  const enabledAccounts = status.accounts.filter((account) => account.enabled);
  const allExhausted =
    enabledAccounts.length > 0 &&
    enabledAccounts.every((account) => account.state === "quota_exhausted");
  const banner = allExhausted
    ? "All enabled accounts are quota exhausted."
    : status.active_streams > 0
      ? "Manual switching is unavailable while a response is streaming."
      : null;
  return Object.freeze({
    activeStreams: status.active_streams,
    allExhausted,
    banner,
    accounts: Object.freeze(
      status.accounts.map((account) => {
        const disabledReason = switchDisabledReason(account, status);
        return Object.freeze({
          alias: account.alias,
          state: account.state,
          stateLabel: titleCase(account.state),
          fiveHourLabel: ratioLabel(account.five_hour_remaining_ratio),
          weeklyLabel: ratioLabel(account.weekly_remaining_ratio),
          cooldownLabel:
            account.cooldown_until === null ? "None" : `Until ${account.cooldown_until}`,
          lastSwitchLabel: reasonLabel(account.last_switch_reason),
          isCurrent: status.current_route?.account_alias === account.alias,
          switchDisabled: disabledReason !== null,
          switchDisabledReason: disabledReason,
        });
      }),
    ),
  });
}

export function buildManualSwitchRequest(account: RouterAccountPanelItem) {
  if (!isRecord(account) || account.switchDisabled !== false) {
    throw new Error("manual switch is unavailable");
  }
  return Object.freeze({ account_alias: readAlias(account.alias), reason: "manual" });
}

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function detailRow(label: string, value: string): HTMLElement {
  const row = element("div", "detail-row");
  row.append(element("dt", undefined, label), element("dd", undefined, value));
  return row;
}

function renderPanel(
  root: ShadowRoot,
  model: RouterAccountPanelModel,
  onSwitch: (account: RouterAccountPanelItem) => void,
  busyAlias: string | null = null,
  transientMessage: string | null = null,
): void {
  const style = element("style");
  style.textContent = `
    :host { color-scheme: light dark; }
    * { box-sizing: border-box; }
    .panel { width: min(360px, calc(100vw - 24px)); max-height: min(620px, calc(100vh - 24px)); overflow: auto;
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
    .detail-row { display: grid; grid-template-columns: 1fr 1.2fr; gap: 8px; padding: 2px 0; }
    dt { color: color-mix(in srgb, CanvasText 65%, transparent); }
    dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
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
      detailRow("5-hour quota", account.fiveHourLabel),
      detailRow("Weekly quota", account.weeklyLabel),
      detailRow("Cooldown", account.cooldownLabel),
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
  content.append(
    element(
      "p",
      "footnote",
      "Switching starts a new backend session. Cross-account continuity is not verified.",
    ),
  );
  details.append(content);
  root.replaceChildren(style, details);
}

function appendHost(): { host: HTMLElement; root: ShadowRoot } {
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

function domReady(): Promise<void> {
  if (document.readyState !== "loading") return Promise.resolve();
  return new Promise((resolve) => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
}

let installedCleanup: (() => void) | null = null;

export async function installRouterAccountPanel(): Promise<() => void> {
  if (installedCleanup) return installedCleanup;
  await domReady();
  let host: HTMLElement | null = null;
  let root: ShadowRoot | null = null;
  let model: RouterAccountPanelModel | null = null;
  let eventSource: EventSource | null = null;
  let pollTimer: number | null = null;
  let stopped = false;
  let busyAlias: string | null = null;
  let transientMessage: string | null = null;

  const ensureHost = () => {
    if (!host || !root) ({ host, root } = appendHost());
    return root;
  };

  const showError = (message: string) => {
    transientMessage = message;
    if (model) renderPanel(ensureHost(), model, requestSwitch, busyAlias, transientMessage);
  };

  const refresh = async (): Promise<"enabled" | "disabled"> => {
    const response = await fetch(STATUS_PATH, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const body = await response.json() as unknown;
    if (response.status === 404 && isRecord(body) && body.enabled === false) return "disabled";
    if (!response.ok || !isRecord(body) || body.enabled !== true || !("router" in body)) {
      throw new Error("router status is unavailable");
    }
    model = deriveRouterAccountPanelModel(body.router);
    transientMessage = null;
    renderPanel(ensureHost(), model, requestSwitch, busyAlias, transientMessage);
    return "enabled";
  };

  async function requestSwitch(account: RouterAccountPanelItem): Promise<void> {
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
      const response = await fetch(SWITCH_PATH, {
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

  eventSource = new EventSource(EVENTS_PATH);
  eventSource.addEventListener("router.switch", () => {
    void refresh().catch(() => showError("Router status is temporarily unavailable."));
  });
  pollTimer = window.setInterval(() => {
    void refresh().catch(() => showError("Router status is temporarily unavailable."));
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
