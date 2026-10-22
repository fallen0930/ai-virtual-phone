// lib/mascot-state.ts
// Global mascot state — shared between widget and floating ball.

type MascotState = "widget" | "animating_in" | "animating_out" | "floating";

export const MASCOT_TRANSITION_MS = 320;

let _state: MascotState = "widget";
let _panelOpen = false;
let _widgetRect: DOMRect | null = null;
const _listeners = new Set<() => void>();
let _transitionTimer: ReturnType<typeof setTimeout> | null = null;

function notify() { _listeners.forEach((fn) => fn()); }

function scheduleState(nextState: MascotState) {
  if (_transitionTimer) clearTimeout(_transitionTimer);
  _transitionTimer = setTimeout(() => {
    _state = nextState;
    _transitionTimer = null;
    notify();
  }, MASCOT_TRANSITION_MS);
}

export function getMascotState() { return _state; }
export function isMascotPanelOpen() { return _panelOpen; }
export function getMascotWidgetRect() { return _widgetRect; }

export function activateMascot(widgetRect: DOMRect) {
  if (_transitionTimer) clearTimeout(_transitionTimer);
  _widgetRect = widgetRect;
  _state = "animating_in";
  notify();
  scheduleState("floating");
}

export function deactivateMascot() {
  if (_transitionTimer) clearTimeout(_transitionTimer);
  _panelOpen = false;
  _state = "animating_out";
  notify();
  scheduleState("widget");
}

export function toggleMascotPanel() {
  _panelOpen = !_panelOpen;
  notify();
}

export function closeMascotPanel() {
  _panelOpen = false;
  notify();
}

export function subscribeMascot(fn: () => void) {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}
