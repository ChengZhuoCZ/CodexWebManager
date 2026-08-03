const STATUS_VALUES = new Set(["loading", "ready", "unavailable"]);

function validState(value) {
  return value !== null && typeof value === "object" &&
    typeof value.triggerAvailable === "boolean" &&
    typeof value.nativeMenuVisible === "boolean" &&
    typeof value.dialogOpen === "boolean" &&
    STATUS_VALUES.has(value.status);
}

export function createAccountSurfaceState() {
  return Object.freeze({
    triggerAvailable: false,
    nativeMenuVisible: false,
    dialogOpen: false,
    status: "loading",
  });
}

export function reduceAccountSurfaceState(state, event) {
  if (!validState(state) || event === null || typeof event !== "object") {
    throw new Error("account surface transition is invalid");
  }
  let next;
  switch (event.type) {
    case "native_trigger_present":
      next = { ...state, triggerAvailable: true };
      break;
    case "native_trigger_absent":
      next = { ...state, triggerAvailable: false, nativeMenuVisible: false };
      break;
    case "native_menu_opened":
      next = { ...state, triggerAvailable: true, nativeMenuVisible: true };
      break;
    case "native_menu_closed":
      next = { ...state, nativeMenuVisible: false };
      break;
    case "account_dialog_opened":
      next = { ...state, dialogOpen: true };
      break;
    case "account_dialog_closed":
      next = { ...state, dialogOpen: false };
      break;
    case "status_changed":
      if (!STATUS_VALUES.has(event.status)) {
        throw new Error("account surface status is invalid");
      }
      next = { ...state, status: event.status };
      break;
    default:
      throw new Error("account surface event is invalid");
  }
  return Object.freeze(next);
}

export function accountSurfaceVisibility(state) {
  if (!validState(state)) throw new Error("account surface state is invalid");
  return Object.freeze({
    fallbackLauncher: !state.triggerAvailable,
    nativeMenuEntry: state.triggerAvailable && state.nativeMenuVisible,
    accountDialog: state.dialogOpen,
  });
}
