import React, {
  FormEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { createRoot, Root } from "react-dom/client";

const CONTROLLER_READY_EVENT = "codex-router-account-settings-ready";
const HOST_ID = "codex-router-account-settings-react-root";
const PROFILE_BUTTON_SELECTOR = 'button[aria-label="Open profile menu"]';
const PROFILE_BUTTON_FALLBACK_SELECTOR = 'button[aria-haspopup="menu"]';
const PROFILE_MENU_SELECTOR = '[role="menu"]';
const PROFILE_MENU_ITEM_SELECTOR = '[role="menuitem"]';
const MENU_INSPECTION_DELAYS_MS = [0, 16, 40, 80, 160] as const;

export type AccountSettingsAccount = {
  alias: string;
  stateLabel: string;
  weeklyLabel: string;
  weeklyDetail: string;
  weeklyResetDetail: string;
  cooldownLabel: string;
  cooldownDetail: string | null;
  lastSwitchLabel: string;
  isCurrent: boolean;
  switchDisabled: boolean;
  switchDisabledReason: string | null;
};

export type AccountSettingsModel = {
  activeStreams: number;
  allExhausted: boolean;
  banner: string | null;
  accounts: readonly AccountSettingsAccount[];
};

export type AccountManagementState = {
  mode: "idle" | "add_alias" | "starting" | "waiting" | "installing" |
    "remove_confirm" | "remove_working";
  alias?: string;
  operationId?: string | null;
  verificationUrl?: string | null;
  userCode?: string | null;
};

export type AccountSettingsSnapshot = {
  label: string;
  status: "loading" | "ready" | "unavailable";
  model: AccountSettingsModel | null;
  busyAlias: string | null;
  quotaBusy: boolean;
  transientMessage: string | null;
  management: AccountManagementState;
};

export type AccountSettingsController = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AccountSettingsSnapshot;
  actions: {
    switchAccount(account: AccountSettingsAccount): void;
    refreshQuota(): void;
    beginAdd(): void;
    submitAdd(alias: string): void;
    cancelManagement(): void;
    beginRemove(alias: string): void;
    confirmRemove(alias: string): void;
    retryStatus(): void;
  };
};

declare global {
  interface Window {
    __CODEX_ROUTER_ACCOUNT_SETTINGS__?: AccountSettingsController;
  }
}

const EMPTY_SNAPSHOT: AccountSettingsSnapshot = Object.freeze({
  label: "Account route · Loading…",
  status: "loading",
  model: null,
  busyAlias: null,
  quotaBusy: false,
  transientMessage: null,
  management: Object.freeze({ mode: "idle" }),
});

function visibleRectangle(element: Element): DOMRect | null {
  const rectangle = element.getBoundingClientRect();
  if (
    rectangle.width <= 0 || rectangle.height <= 0 ||
    rectangle.bottom < 0 || rectangle.right < 0 ||
    rectangle.top > window.innerHeight || rectangle.left > window.innerWidth
  ) return null;
  return rectangle;
}

function profileButtonCandidates(): HTMLElement[] {
  const exact = document.querySelector(PROFILE_BUTTON_SELECTOR);
  const candidates = exact instanceof HTMLElement ? [exact] : [];
  for (const candidate of document.querySelectorAll(PROFILE_BUTTON_FALLBACK_SELECTOR)) {
    if (!(candidate instanceof HTMLElement) || candidates.includes(candidate)) continue;
    const rectangle = visibleRectangle(candidate);
    if (rectangle !== null && rectangle.left < Math.max(420, window.innerWidth * 0.4)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function expandedProfileButton(): HTMLElement | null {
  return profileButtonCandidates().find((candidate) =>
    candidate.getAttribute("aria-expanded") === "true"
  ) ?? null;
}

function controlledMenu(button: HTMLElement): HTMLElement | null {
  for (const attribute of ["aria-controls", "aria-owns"]) {
    const identifier = button.getAttribute(attribute);
    if (!identifier) continue;
    const controlled = document.getElementById(identifier);
    if (!(controlled instanceof HTMLElement)) continue;
    if (controlled.matches(PROFILE_MENU_SELECTOR)) return controlled;
    const nested = controlled.querySelector(PROFILE_MENU_SELECTOR);
    if (nested instanceof HTMLElement) return nested;
  }
  return null;
}

function profileMenuDistance(menu: HTMLElement, button: HTMLElement): number {
  const menuRectangle = visibleRectangle(menu);
  const buttonRectangle = visibleRectangle(button);
  if (menuRectangle === null || buttonRectangle === null) return Number.POSITIVE_INFINITY;
  const horizontalGap = Math.max(
    0,
    buttonRectangle.left - menuRectangle.right,
    menuRectangle.left - buttonRectangle.right,
  );
  return horizontalGap * 4 + Math.abs(buttonRectangle.top - menuRectangle.bottom);
}

function findProfileMenu(): HTMLElement | null {
  const button = expandedProfileButton();
  if (button === null) return null;
  const controlled = controlledMenu(button);
  if (controlled !== null) return controlled;
  return [...document.querySelectorAll(PROFILE_MENU_SELECTOR)]
    .filter((candidate): candidate is HTMLElement =>
      candidate instanceof HTMLElement &&
      visibleRectangle(candidate) !== null &&
      candidate.querySelector(PROFILE_MENU_ITEM_SELECTOR) !== null
    )
    .sort((left, right) =>
      profileMenuDistance(left, button) - profileMenuDistance(right, button)
    )[0] ?? null;
}

function useNativeProfileMenu(): HTMLElement | null {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let timers: number[] = [];
    const cancel = (): void => {
      for (const timer of timers) window.clearTimeout(timer);
      timers = [];
    };
    const schedule = (): void => {
      cancel();
      for (const delay of MENU_INSPECTION_DELAYS_MS) {
        timers.push(window.setTimeout(() => setMenu(findProfileMenu()), delay));
      }
    };
    const activation = (event: Event): void => {
      if (
        event.type === "keydown" &&
        (!(event instanceof KeyboardEvent) || !new Set(["Enter", " "]).has(event.key))
      ) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest(PROFILE_BUTTON_FALLBACK_SELECTOR);
      if (
        (button instanceof HTMLElement && profileButtonCandidates().includes(button)) ||
        findProfileMenu() !== null
      ) schedule();
    };
    document.addEventListener("click", activation, true);
    document.addEventListener("keydown", activation, true);
    schedule();
    return () => {
      cancel();
      document.removeEventListener("click", activation, true);
      document.removeEventListener("keydown", activation, true);
    };
  }, []);
  return menu?.isConnected ? menu : null;
}

function useAccountController(): {
  controller: AccountSettingsController | null;
  snapshot: AccountSettingsSnapshot;
} {
  const [controller, setController] = useState<AccountSettingsController | null>(
    () => window.__CODEX_ROUTER_ACCOUNT_SETTINGS__ ?? null,
  );
  useEffect(() => {
    const refresh = (): void => {
      setController(window.__CODEX_ROUTER_ACCOUNT_SETTINGS__ ?? null);
    };
    window.addEventListener(CONTROLLER_READY_EVENT, refresh);
    refresh();
    return () => window.removeEventListener(CONTROLLER_READY_EVENT, refresh);
  }, []);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    () => EMPTY_SNAPSHOT,
  );
  return { controller, snapshot };
}

async function copyDeviceCode(value: string): Promise<void> {
  if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4})+$/u.test(value)) {
    throw new Error("device authorization code is invalid");
  }
  const writeText = navigator.clipboard?.writeText;
  if (typeof writeText === "function") {
    try {
      await writeText.call(navigator.clipboard, value);
      return;
    } catch {}
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  input.setAttribute("aria-hidden", "true");
  Object.assign(input.style, {
    position: "fixed",
    insetInlineStart: "-10000px",
    opacity: "0",
  });
  document.body.append(input);
  try {
    input.select();
    if (document.execCommand("copy") !== true) throw new Error("copy failed");
  } finally {
    input.remove();
  }
}

function ManagementPanel({
  snapshot,
  controller,
}: {
  snapshot: AccountSettingsSnapshot;
  controller: AccountSettingsController;
}): React.ReactElement | null {
  const [alias, setAlias] = useState("");
  const [copyLabel, setCopyLabel] = useState("Copy code");
  const management = snapshot.management;
  if (management.mode === "add_alias") {
    const submit = (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      controller.actions.submitAdd(alias);
    };
    return (
      <form className="mt-3 rounded-xl bg-token-bg-tertiary p-3" onSubmit={submit}>
        <label className="flex flex-col gap-2 text-sm font-medium">
          Account name
          <input
            aria-label="New account name"
            autoFocus
            className="h-9 rounded-lg border border-token-border bg-transparent px-3 text-token-text-primary outline-none focus:ring-2 focus:ring-token-border-heavy"
            maxLength={64}
            onChange={(event) => setAlias(event.target.value)}
            placeholder="Research 2"
            value={alias}
          />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button className="rounded-lg px-3 py-2 text-sm hover:bg-token-bg-secondary" onClick={controller.actions.cancelManagement} type="button">Cancel</button>
          <button className="rounded-lg bg-token-text-primary px-3 py-2 text-sm text-token-bg-primary" type="submit">Authorize</button>
        </div>
      </form>
    );
  }
  if (new Set(["starting", "waiting", "installing"]).has(management.mode)) {
    return (
      <div className="mt-3 rounded-xl bg-token-bg-tertiary p-3 text-sm">
        <p>{management.mode === "installing" ? "Authorization received. Installing account…" : "Authorize this account in your browser:"}</p>
        {management.verificationUrl ? <a className="mt-2 block underline" href={management.verificationUrl} rel="noopener noreferrer" target="_blank">{management.verificationUrl}</a> : null}
        {management.userCode ? (
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all text-base font-semibold tracking-wider">{management.userCode}</code>
            <button
              aria-label="Copy device authorization code"
              className="rounded-lg px-3 py-2 hover:bg-token-bg-secondary"
              onClick={async () => {
                try {
                  await copyDeviceCode(management.userCode ?? "");
                  setCopyLabel("Copied");
                } catch {
                  setCopyLabel("Copy failed");
                }
                window.setTimeout(() => setCopyLabel("Copy code"), 1_500);
              }}
              type="button"
            >{copyLabel}</button>
          </div>
        ) : null}
        <button className="mt-3 rounded-lg px-3 py-2 hover:bg-token-bg-secondary" onClick={controller.actions.cancelManagement} type="button">Cancel</button>
      </div>
    );
  }
  if (management.mode === "remove_confirm" && management.alias) {
    return (
      <div className="mt-3 rounded-xl bg-token-bg-tertiary p-3 text-sm">
        <p>Remove {management.alias}? Its stored credential will be erased.</p>
        <div className="mt-3 flex justify-end gap-2">
          <button className="rounded-lg px-3 py-2 hover:bg-token-bg-secondary" onClick={controller.actions.cancelManagement} type="button">Cancel</button>
          <button className="rounded-lg bg-red-600 px-3 py-2 text-white" onClick={() => controller.actions.confirmRemove(management.alias ?? "")} type="button">Delete {management.alias}</button>
        </div>
      </div>
    );
  }
  if (management.mode === "remove_working") {
    return <div className="mt-3 rounded-xl bg-token-bg-tertiary p-3 text-sm">Deleting {management.alias}…</div>;
  }
  return null;
}

function AccountRow({
  account,
  snapshot,
  controller,
}: {
  account: AccountSettingsAccount;
  snapshot: AccountSettingsSnapshot;
  controller: AccountSettingsController;
}): React.ReactElement {
  const removalDisabled =
    snapshot.model === null || snapshot.model.accounts.length <= 1 || account.isCurrent ||
    snapshot.model.activeStreams > 0 || snapshot.management.mode !== "idle";
  return (
    <div className="flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-token-bg-secondary">
      <button
        aria-checked={account.isCurrent}
        className="min-w-0 flex-1 text-left"
        disabled={account.switchDisabled || snapshot.busyAlias !== null}
        onClick={() => controller.actions.switchAccount(account)}
        role="radio"
        title={account.switchDisabledReason ?? "Start a new backend session on this account"}
        type="button"
      >
        <span className="flex items-baseline gap-2 font-medium">
          <span className="truncate">{account.alias}</span>
          <span className="text-xs text-token-text-secondary">{account.stateLabel}</span>
        </span>
        <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-token-text-secondary">
          <span>Weekly {account.weeklyLabel.replace(" remaining", "")}</span>
          <span>Cooldown {account.cooldownLabel}</span>
        </span>
        <span className="mt-1 block text-xs text-token-text-tertiary">{account.weeklyResetDetail} · {account.weeklyDetail}</span>
      </button>
      <span className={account.isCurrent ? "text-xs font-semibold text-green-600" : "text-xs font-semibold"}>
        {account.isCurrent ? "Current" : snapshot.busyAlias === account.alias ? "Switching…" : "Switch"}
      </span>
      <button
        aria-label={`Delete ${account.alias}`}
        className="h-8 w-8 rounded-lg text-token-text-secondary hover:bg-red-500/10 hover:text-red-600 disabled:opacity-30"
        disabled={removalDisabled}
        onClick={() => controller.actions.beginRemove(account.alias)}
        title={account.isCurrent ? "Switch away before deleting this account" : `Delete ${account.alias}`}
        type="button"
      >×</button>
    </div>
  );
}

function AccountSettingsDialog({
  controller,
  snapshot,
  onClose,
}: {
  controller: AccountSettingsController | null;
  snapshot: AccountSettingsSnapshot;
  onClose(): void;
}): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose]);
  return (
    <>
      <div aria-hidden="true" className="codex-dialog-overlay fixed inset-0 z-50 electron:bg-[#00000022] extension:bg-token-editor-background/80" data-state="open" onClick={onClose} style={{ pointerEvents: "auto" }} />
      <div
        aria-label="Account settings"
        aria-modal="true"
        className="codex-dialog fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl bg-token-dropdown-background/90 text-token-foreground shadow-lg ring-[0.5px] ring-token-border backdrop-blur-xl outline-none"
        data-router-account-settings-dialog="true"
        data-state="open"
        ref={dialogRef}
        role="dialog"
        style={{ pointerEvents: "auto" }}
        tabIndex={-1}
      >
        <header className="flex items-center justify-between border-b border-token-border px-5 py-4">
          <div>
            <h2 className="heading-dialog font-semibold">Account settings</h2>
            <p className="mt-1 text-xs text-token-text-secondary">Automatic failover is limited to requests before semantic output.</p>
          </div>
          <button aria-label="Close account settings" className="h-8 w-8 rounded-lg text-xl hover:bg-token-bg-secondary" onClick={onClose} type="button">×</button>
        </header>
        <main className="max-h-[calc(92vh-82px)] overflow-y-auto px-4 py-4">
          {snapshot.transientMessage ? <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{snapshot.transientMessage}</p> : null}
          {snapshot.model?.banner ? <p className="mb-3 rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-700">{snapshot.model.banner}</p> : null}
          <div className="mb-2 flex items-center justify-between px-2">
            <div>
              <p className="text-sm font-semibold">Account route</p>
              <p className="text-xs text-token-text-secondary">Switching starts a new backend session.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-green-500/10 px-2 py-1 text-xs font-semibold text-green-600">Auto</span>
              <button className="rounded-lg px-3 py-2 text-sm hover:bg-token-bg-secondary disabled:opacity-40" disabled={snapshot.model?.activeStreams !== 0 || snapshot.management.mode !== "idle"} onClick={() => controller?.actions.beginAdd()} type="button">Add</button>
              <button aria-label="Refresh current account weekly quota" className="rounded-lg px-3 py-2 text-sm hover:bg-token-bg-secondary disabled:opacity-40" disabled={snapshot.quotaBusy || controller === null} onClick={() => controller?.actions.refreshQuota()} type="button">{snapshot.quotaBusy ? "Refreshing…" : "Refresh"}</button>
            </div>
          </div>
          {controller ? <ManagementPanel controller={controller} snapshot={snapshot} /> : null}
          {snapshot.model ? (
            <div aria-label={`Account route (${snapshot.model.accounts.length})`} className="mt-3 flex flex-col" role="radiogroup">
              {snapshot.model.accounts.map((account) => <AccountRow account={account} controller={controller!} key={account.alias} snapshot={snapshot} />)}
            </div>
          ) : (
            <div className="mt-3 rounded-xl bg-token-bg-tertiary p-4 text-sm text-token-text-secondary">
              {snapshot.status === "unavailable" ? "Router status is temporarily unavailable." : "Account settings are loading…"}
              {snapshot.status === "unavailable" && controller ? <button className="ml-2 underline" onClick={controller.actions.retryStatus} type="button">Retry</button> : null}
            </div>
          )}
          <p className="mt-4 px-2 text-xs text-token-text-tertiary" title="Cross-account continuity is not verified.">No request is replayed after semantic output. Existing sessions and in-flight work are not migrated.</p>
        </main>
      </div>
    </>
  );
}

function nativeMenuClassName(menu: HTMLElement): string {
  const item = menu.querySelector(PROFILE_MENU_ITEM_SELECTOR);
  return item instanceof HTMLElement && typeof item.className === "string"
    ? item.className
    : "no-drag text-token-foreground outline-hidden rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm group hover:bg-token-list-hover-background focus:bg-token-list-hover-background cursor-interaction";
}

function RouteIcon({ className }: { className?: string }): React.ReactElement {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 20 20">
      <path d="M4 6.5h10.5m0 0-2.75-2.75M14.5 6.5l-2.75 2.75M16 13.5H5.5m0 0 2.75 2.75M5.5 13.5l2.75-2.75" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }): React.ReactElement {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 18 18">
      <path d="m6.75 3.75 5.25 5.25-5.25 5.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

function currentRouteAlias(snapshot: AccountSettingsSnapshot): string {
  const current = snapshot.model?.accounts.find((account) => account.isCurrent);
  if (current) return current.alias;
  return snapshot.status === "unavailable" ? "Unavailable" : "Loading…";
}

function AccountSettingsApp(): React.ReactElement {
  const menu = useNativeProfileMenu();
  const { controller, snapshot } = useAccountController();
  const [open, setOpen] = useState(false);
  const menuClassName = menu ? nativeMenuClassName(menu) : "";
  const routeAlias = currentRouteAlias(snapshot);
  return (
    <>
      {menu ? createPortal(
        <div
          aria-label={snapshot.label}
          aria-haspopup="dialog"
          className={menuClassName}
          data-router-account-menu-entry="true"
          data-router-account-menu-layout="native-contract"
          onClick={() => setOpen(true)}
          role="menuitem"
          tabIndex={-1}
        >
          <div className="flex flex-col">
            <div className="flex w-full items-center gap-1.5">
              <RouteIcon className="icon-xs shrink-0 opacity-75 group-focus:opacity-100 group-hover:opacity-100" />
              <span className="flex-1 min-w-0 truncate">Account route</span>
              <span className="ml-2 shrink-0 text-xs text-token-description-foreground">{routeAlias}</span>
              <ChevronRightIcon className="icon-xs shrink-0 opacity-75 group-focus:opacity-100 group-hover:opacity-100" />
            </div>
          </div>
        </div>,
        menu,
      ) : null}
      {open ? <AccountSettingsDialog controller={controller} onClose={() => setOpen(false)} snapshot={snapshot} /> : null}
    </>
  );
}

let installedRoot: Root | null = null;

export function installAccountSettingsWindow(): () => void {
  if (installedRoot !== null) return () => {};
  const install = (): void => {
    if (installedRoot !== null) return;
    let host = document.getElementById(HOST_ID);
    if (host === null) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.style.display = "contents";
      document.body.append(host);
    }
    installedRoot = createRoot(host);
    installedRoot.render(<AccountSettingsApp />);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
  return () => {
    document.removeEventListener("DOMContentLoaded", install);
    installedRoot?.unmount();
    installedRoot = null;
    document.getElementById(HOST_ID)?.remove();
  };
}
