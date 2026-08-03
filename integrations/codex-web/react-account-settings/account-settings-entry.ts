const PROFILE_BUTTON_SELECTOR = 'button[aria-label="Open profile menu"]';
const PROFILE_BUTTON_FALLBACK_SELECTOR = 'button[aria-haspopup="menu"]';

let accountWindowPromise: Promise<void> | null = null;

function loadAccountWindow(): Promise<void> {
  accountWindowPromise ??= import("./account-settings-window").then((module) => {
    module.installAccountSettingsWindow();
  });
  return accountWindowPromise;
}

function isProfileActivation(event: Event): boolean {
  return event.composedPath().some((target) =>
    target instanceof Element &&
    target.matches(`${PROFILE_BUTTON_SELECTOR},${PROFILE_BUTTON_FALLBACK_SELECTOR}`));
}

export function installAccountSettingsEntry(): () => void {
  const prefetch = (event: Event): void => {
    if (isProfileActivation(event)) void loadAccountWindow();
  };
  const activate = (event: Event): void => {
    if (isProfileActivation(event)) void loadAccountWindow();
  };
  document.addEventListener("pointerover", prefetch, true);
  document.addEventListener("focusin", prefetch, true);
  document.addEventListener("pointerdown", activate, true);
  document.addEventListener("click", activate, true);
  return () => {
    document.removeEventListener("pointerover", prefetch, true);
    document.removeEventListener("focusin", prefetch, true);
    document.removeEventListener("pointerdown", activate, true);
    document.removeEventListener("click", activate, true);
  };
}
