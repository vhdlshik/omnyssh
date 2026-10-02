import { describe, expect, it } from 'vitest';
import { fileManagerKey, FKEY_BAR } from './sftpKeys';
import type { KeyPress } from './terminalInput';

function key(k: string, mods: Partial<KeyPress> = {}): KeyPress {
  return {
    type: 'keydown',
    key: k,
    code: '',
    keyCode: 0,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...mods
  };
}

describe('the file manager keys (Total Commander layout)', () => {
  it('maps the function-key row', () => {
    expect(fileManagerKey(key('F3'))).toBe('view');
    expect(fileManagerKey(key('F5'))).toBe('copy');
    expect(fileManagerKey(key('F6'))).toBe('move');
    expect(fileManagerKey(key('F6', { shiftKey: true }))).toBe('rename');
    expect(fileManagerKey(key('F2'))).toBe('rename');
    expect(fileManagerKey(key('F7'))).toBe('mkdir');
    expect(fileManagerKey(key('F8'))).toBe('delete');
    expect(fileManagerKey(key('Delete'))).toBe('delete');
  });

  it('moves the cursor, marks, opens and switches panes', () => {
    expect(fileManagerKey(key('ArrowDown'))).toBe('down');
    expect(fileManagerKey(key('ArrowUp'))).toBe('up');
    expect(fileManagerKey(key('Home'))).toBe('first');
    expect(fileManagerKey(key('End'))).toBe('last');
    expect(fileManagerKey(key('PageDown'))).toBe('pageDown');
    expect(fileManagerKey(key('Insert'))).toBe('mark');
    expect(fileManagerKey(key(' '))).toBe('mark');
    expect(fileManagerKey(key('Enter'))).toBe('open');
    expect(fileManagerKey(key('Backspace'))).toBe('parent');
    expect(fileManagerKey(key('Tab'))).toBe('switch');
    expect(fileManagerKey(key('Tab', { shiftKey: true }))).toBe('switch');
    expect(fileManagerKey(key('a', { ctrlKey: true }))).toBe('markAll');
    expect(fileManagerKey(key('R', { ctrlKey: true }))).toBe('refresh');
  });

  it('leaves Enter, Space and Tab to a focused button outside the lists', () => {
    expect(fileManagerKey(key('Enter'), true)).toBeNull();
    expect(fileManagerKey(key(' '), true)).toBeNull();
    expect(fileManagerKey(key('Tab'), true)).toBeNull();
    // The function keys still work from there.
    expect(fileManagerKey(key('F5'), true)).toBe('copy');
  });

  it('ignores other chords, keyups and IME composition', () => {
    expect(fileManagerKey(key('k', { ctrlKey: true }))).toBeNull();
    expect(fileManagerKey(key('b', { ctrlKey: true }))).toBeNull();
    expect(fileManagerKey(key('F5', { altKey: true }))).toBeNull();
    expect(fileManagerKey(key('F5', { metaKey: true }))).toBeNull();
    expect(fileManagerKey(key('F5', { type: 'keyup' }))).toBeNull();
    expect(fileManagerKey(key('Enter', { isComposing: true }))).toBeNull();
    expect(fileManagerKey(key('x'))).toBeNull();
  });

  it('lists every bar command under a key that produces it', () => {
    for (const fkey of FKEY_BAR) {
      const [mod, name] = fkey.key.includes('+') ? fkey.key.split('+') : ['', fkey.key];
      expect(fileManagerKey(key(name, { shiftKey: mod === 'Shift' }))).toBe(fkey.command);
    }
  });
});
