// Mouse gestures layered over xterm (see stores/terminalMouse for the two prefs).
//
// Select over apps: while a program has turned on mouse reporting, xterm sends every
// press to the program and selects nothing unless the press carries Shift (Option on
// macOS, with `macOptionClickForcesSelection`). So a left press is held back here: if
// the pointer then moves, the press is re-issued with that modifier and xterm starts
// a selection from the original point; if it is released in place, the press is
// re-issued untouched and the program gets its click, just late by one gesture.
//
// Right-click copy/paste: the right button copies the selection (and clears it), or
// pastes when nothing is selected. Every other use of the button is swallowed — the
// context menu, xterm's own right-click handling and mouse reports to the program.

/** The slice of the xterm `Terminal` the gestures use. */
export interface GestureTerminal {
  modes: { mouseTrackingMode: string };
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  focus(): void;
}

export interface GestureOptions {
  isMac: boolean;
  rightClickCopyPaste: () => boolean;
  selectOverApps: () => boolean;
  writeClipboard: (text: string) => Promise<void>;
  /** Paste the system clipboard into the terminal (the platform decides how). */
  pasteClipboard: () => Promise<void>;
  onError: (message: string) => void;
}

/** How far (px) a held press must travel before it counts as a selection drag. */
export const DRAG_THRESHOLD = 4;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wire the gestures onto `host` (an ancestor of xterm's element). Returns a disposer. */
export function attachMouseGestures(
  host: HTMLElement,
  term: GestureTerminal,
  opts: GestureOptions
): () => void {
  const win = host.ownerDocument.defaultView ?? window;
  // Presses this module re-issued: they must pass through untouched.
  const reissued = new WeakSet<Event>();
  let held: MouseEvent | undefined;

  function swallow(e: Event): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function reissue(press: MouseEvent, forceSelection: boolean): void {
    const copy = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: press.view,
      detail: press.detail,
      screenX: press.screenX,
      screenY: press.screenY,
      clientX: press.clientX,
      clientY: press.clientY,
      ctrlKey: press.ctrlKey,
      metaKey: press.metaKey,
      altKey: press.altKey || (forceSelection && opts.isMac),
      shiftKey: press.shiftKey || (forceSelection && !opts.isMac),
      button: press.button,
      buttons: press.buttons
    });
    reissued.add(copy);
    (press.target ?? host).dispatchEvent(copy);
  }

  function copyOrPaste(): void {
    // Focus first: a native paste lands in whatever holds the keyboard.
    term.focus();
    if (term.hasSelection()) {
      const text = term.getSelection();
      term.clearSelection();
      opts.writeClipboard(text).catch((err) => opts.onError(`Copy failed: ${errMsg(err)}`));
    } else {
      opts.pasteClipboard().catch((err) => opts.onError(`Paste failed: ${errMsg(err)}`));
    }
  }

  function onMouseDown(e: MouseEvent): void {
    if (reissued.has(e)) return;
    if (e.button === 2 && opts.rightClickCopyPaste()) {
      swallow(e);
      copyOrPaste();
      return;
    }
    if (e.button !== 0 || !opts.selectOverApps()) return;
    if (term.modes.mouseTrackingMode === 'none') return; // xterm selects on its own
    if (opts.isMac ? e.altKey : e.shiftKey) return; // already forcing a selection
    swallow(e);
    held = e;
    term.focus();
  }

  function onMouseMove(e: MouseEvent): void {
    if (!held) return;
    if (Math.hypot(e.clientX - held.clientX, e.clientY - held.clientY) < DRAG_THRESHOLD) return;
    const press = held;
    held = undefined;
    reissue(press, true);
  }

  function onMouseUp(e: MouseEvent): void {
    if (e.button === 2 && opts.rightClickCopyPaste() && host.contains(e.target as Node)) {
      swallow(e);
      return;
    }
    if (!held || e.button !== 0) return;
    const press = held;
    held = undefined;
    // Re-issued before this release travels on, so the listener xterm adds for the
    // release is in place when it arrives.
    reissue(press, false);
  }

  function onContextMenu(e: MouseEvent): void {
    if (opts.rightClickCopyPaste()) swallow(e);
  }

  function onAuxClick(e: MouseEvent): void {
    if (e.button === 2 && opts.rightClickCopyPaste()) swallow(e);
  }

  host.addEventListener('mousedown', onMouseDown, true);
  host.addEventListener('contextmenu', onContextMenu, true);
  host.addEventListener('auxclick', onAuxClick, true);
  win.addEventListener('mousemove', onMouseMove, true);
  win.addEventListener('mouseup', onMouseUp, true);
  return () => {
    host.removeEventListener('mousedown', onMouseDown, true);
    host.removeEventListener('contextmenu', onContextMenu, true);
    host.removeEventListener('auxclick', onAuxClick, true);
    win.removeEventListener('mousemove', onMouseMove, true);
    win.removeEventListener('mouseup', onMouseUp, true);
  };
}
