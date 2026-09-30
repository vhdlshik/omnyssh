// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachMouseGestures, type GestureOptions, type GestureTerminal } from './terminalGestures';

// `inner` stands in for xterm's element: whatever reaches it is what xterm would see.
let host: HTMLDivElement;
let inner: HTMLDivElement;
let seen: MouseEvent[];
let term: GestureTerminal & { selection: string; pasted: string[] };
let clipboard: string;
let prefs: { right: boolean; select: boolean };
let errors: string[];
let dispose: () => void;

function attach(isMac = false): void {
  const opts: GestureOptions = {
    isMac,
    rightClickCopyPaste: () => prefs.right,
    selectOverApps: () => prefs.select,
    writeClipboard: vi.fn(async (text: string) => {
      clipboard = text;
    }),
    pasteClipboard: vi.fn(async () => {
      term.pasted.push(clipboard);
    }),
    onError: (m) => errors.push(m)
  };
  dispose = attachMouseGestures(host, term, opts);
}

function fire(target: EventTarget, type: string, init: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  host = document.createElement('div');
  inner = document.createElement('div');
  host.appendChild(inner);
  document.body.appendChild(host);
  seen = [];
  for (const type of ['mousedown', 'mouseup', 'contextmenu']) {
    inner.addEventListener(type, (e) => seen.push(e as MouseEvent));
  }
  clipboard = '';
  errors = [];
  prefs = { right: false, select: true };
  term = {
    modes: { mouseTrackingMode: 'none' },
    selection: '',
    pasted: [],
    hasSelection() {
      return this.selection !== '';
    },
    getSelection() {
      return this.selection;
    },
    clearSelection() {
      this.selection = '';
    },
    focus() {}
  };
});

afterEach(() => {
  dispose();
  host.remove();
});

describe('selecting over a program that reads the mouse', () => {
  it('leaves presses alone while no program reads the mouse', () => {
    attach();
    fire(inner, 'mousedown', { button: 0, clientX: 10, clientY: 10 });
    expect(seen.map((e) => e.type)).toEqual(['mousedown']);
    expect(seen[0].shiftKey).toBe(false);
  });

  it('turns a drag into a forced selection from the press point', () => {
    term.modes.mouseTrackingMode = 'any';
    attach();
    fire(inner, 'mousedown', { button: 0, clientX: 10, clientY: 20 });
    expect(seen).toEqual([]);
    fire(window, 'mousemove', { clientX: 12, clientY: 21 }); // under the threshold
    expect(seen).toEqual([]);
    fire(window, 'mousemove', { clientX: 30, clientY: 20 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'mousedown', shiftKey: true, clientX: 10, clientY: 20 });
    fire(inner, 'mouseup', { button: 0, clientX: 30, clientY: 20 });
    expect(seen.map((e) => e.type)).toEqual(['mousedown', 'mouseup']);
  });

  it('forces the selection with Option on macOS', () => {
    term.modes.mouseTrackingMode = 'drag';
    attach(true);
    fire(inner, 'mousedown', { button: 0, clientX: 0, clientY: 0 });
    fire(window, 'mousemove', { clientX: 20, clientY: 0 });
    expect(seen[0]).toMatchObject({ altKey: true, shiftKey: false });
  });

  it('hands a click without a drag to the program, press before release', () => {
    term.modes.mouseTrackingMode = 'vt200';
    attach();
    fire(inner, 'mousedown', { button: 0, clientX: 5, clientY: 5 });
    fire(inner, 'mouseup', { button: 0, clientX: 5, clientY: 5 });
    expect(seen.map((e) => [e.type, e.shiftKey])).toEqual([
      ['mousedown', false],
      ['mouseup', false]
    ]);
  });

  it('stays out of the way when turned off', () => {
    term.modes.mouseTrackingMode = 'any';
    prefs.select = false;
    attach();
    fire(inner, 'mousedown', { button: 0 });
    expect(seen).toHaveLength(1);
  });
});

describe('right-click copy and paste', () => {
  it('copies and clears the selection', async () => {
    prefs.right = true;
    term.selection = 'hello';
    attach();
    fire(inner, 'mousedown', { button: 2 });
    await flush();
    expect(clipboard).toBe('hello');
    expect(term.hasSelection()).toBe(false);
    expect(term.pasted).toEqual([]);
  });

  it('pastes when nothing is selected', async () => {
    prefs.right = true;
    clipboard = 'ls -la';
    attach();
    fire(inner, 'mousedown', { button: 2 });
    await flush();
    expect(term.pasted).toEqual(['ls -la']);
  });

  it('swallows every other right-button event, even with a program reading the mouse', () => {
    prefs.right = true;
    term.modes.mouseTrackingMode = 'any';
    attach();
    const down = fire(inner, 'mousedown', { button: 2 });
    const up = fire(inner, 'mouseup', { button: 2 });
    const menu = fire(inner, 'contextmenu', { button: 2 });
    expect(seen).toEqual([]);
    expect([down, up, menu].every((e) => e.defaultPrevented)).toBe(true);
  });

  it('leaves the right button alone when turned off', () => {
    attach();
    fire(inner, 'mousedown', { button: 2 });
    const menu = fire(inner, 'contextmenu', { button: 2 });
    expect(seen.map((e) => e.type)).toEqual(['mousedown', 'contextmenu']);
    expect(menu.defaultPrevented).toBe(false);
  });

  it('reports a clipboard that cannot be read', async () => {
    prefs.right = true;
    const opts: GestureOptions = {
      isMac: false,
      rightClickCopyPaste: () => true,
      selectOverApps: () => true,
      writeClipboard: async () => {},
      pasteClipboard: async () => {
        throw new Error('denied');
      },
      onError: (m) => errors.push(m)
    };
    dispose = attachMouseGestures(host, term, opts);
    fire(inner, 'mousedown', { button: 2 });
    await flush();
    expect(errors).toEqual(['Paste failed: denied']);
  });
});
