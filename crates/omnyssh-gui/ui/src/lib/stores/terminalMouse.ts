import { writable } from 'svelte/store';

// Terminal mouse preferences. They persist like the other UI-chrome prefs
// (tauri-plugin-store + a localStorage mirror for first paint, tech-gui.md §4.3),
// matching streamer mode's shape.
//
// - `rightClickCopyPaste`: the right button copies the selection, or pastes when there
//   is none (PuTTY / Windows Terminal style). It takes the button over completely: no
//   context menu, and a program that reads the mouse never sees a right click.
// - `selectOverApps`: a left-button drag always selects text, even while a program
//   (vim, htop, a TUI such as Claude Code) has asked for the mouse. A plain click still
//   reaches the program.
const STORE_FILE = 'settings.json';

function createPref(localKey: string, storeKey: string, fallback: boolean) {
  function mirrored(): boolean {
    try {
      const raw = localStorage.getItem(localKey);
      return raw == null ? fallback : raw === 'true';
    } catch {
      return fallback; // localStorage unavailable: use the default.
    }
  }

  function mirrorLocal(on: boolean): void {
    try {
      localStorage.setItem(localKey, String(on));
    } catch {
      // localStorage unavailable (hardened webview): the store copy is canonical.
    }
  }

  async function persistStore(on: boolean): Promise<void> {
    try {
      const { load } = await import('@tauri-apps/plugin-store');
      const store = await load(STORE_FILE);
      await store.set(storeKey, on);
      await store.save();
    } catch {
      // Not under Tauri (tests, vite preview): the localStorage mirror suffices.
    }
  }

  const initial = mirrored();
  const { subscribe, set: setStore } = writable<boolean>(initial);
  let current = initial;
  let interacted = false;

  function apply(on: boolean, user: boolean): void {
    current = on;
    setStore(on);
    mirrorLocal(on);
    if (user) {
      interacted = true;
      void persistStore(on);
    }
  }

  return {
    subscribe,
    set: (on: boolean) => apply(on, true),
    toggle: () => apply(!current, true),
    /** Reconcile with the canonical tauri-plugin-store value once Tauri is reachable. */
    async hydrate(): Promise<void> {
      try {
        const { load } = await import('@tauri-apps/plugin-store');
        const store = await load(STORE_FILE);
        const saved = await store.get<boolean>(storeKey);
        if (!interacted && typeof saved === 'boolean') apply(saved, false);
      } catch {
        // Store unreachable: keep the mirrored value.
      }
    }
  };
}

export const rightClickCopyPaste = createPref(
  'omnyssh-right-click-copy-paste',
  'rightClickCopyPaste',
  false
);

export const selectOverApps = createPref('omnyssh-select-over-apps', 'selectOverApps', true);
