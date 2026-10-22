// lib/mascot-context.ts
// Global mascot page context — sync read/write + subscribe (same pattern as mascot-state.ts).

export type MascotPageContext = {
  page: string;       // "character" | "worldbook" | "regex" | "preset" | "chat" | "vn" | "desktop"
  mode: string;       // "idle" | "viewing" | "editing" | "chatting"
  label: string;      // e.g. "角色编辑 · 叶思恒"
  fields: Record<string, string>;  // current editable field values
};

const DEFAULT_CONTEXT: MascotPageContext = {
  page: "desktop",
  mode: "idle",
  label: "桌面",
  fields: {},
};

let _ctx: MascotPageContext = { ...DEFAULT_CONTEXT };
const _listeners = new Set<() => void>();

function notify() { _listeners.forEach((fn) => fn()); }

export function getMascotContext(): MascotPageContext { return _ctx; }

export function setMascotContext(ctx: MascotPageContext) {
  _ctx = ctx;
  notify();
}

export function subscribeMascotContext(fn: () => void) {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}
