// Total Commander's keyboard model for the SFTP view: a cursor in each pane, Tab to
// switch panes, Insert/Space to mark, and the function-key row — F3 view, F5 copy,
// F6 move (Shift+F6 rename), F7 new folder, F8 delete. This is the pure key → command
// map; SftpView owns what each command does.

import type { KeyPress } from './terminalInput';

export type FmCommand =
  | 'up'
  | 'down'
  | 'pageUp'
  | 'pageDown'
  | 'first'
  | 'last'
  | 'open'
  | 'parent'
  | 'switch'
  | 'mark'
  | 'markAll'
  | 'view'
  | 'copy'
  | 'move'
  | 'rename'
  | 'mkdir'
  | 'delete'
  | 'refresh';

/** The function-key bar along the bottom of the view, in Total Commander's order. */
export const FKEY_BAR: ReadonlyArray<{ key: string; label: string; command: FmCommand }> = [
  { key: 'F3', label: 'View', command: 'view' },
  { key: 'F5', label: 'Copy', command: 'copy' },
  { key: 'F6', label: 'Move', command: 'move' },
  { key: 'Shift+F6', label: 'Rename', command: 'rename' },
  { key: 'F7', label: 'MkDir', command: 'mkdir' },
  { key: 'F8', label: 'Delete', command: 'delete' }
];

/** The command a keydown maps to, or `null` to leave the key alone. `onControl` is
 *  true when focus sits on a button or link outside the file lists — Enter, Space and
 *  Tab then keep their native meaning (press it, move focus). */
export function fileManagerKey(e: KeyPress, onControl = false): FmCommand | null {
  if (e.type !== 'keydown' || e.isComposing || e.altKey || e.metaKey) return null;

  if (e.ctrlKey) {
    if (e.shiftKey) return null;
    switch (e.key) {
      case 'a':
      case 'A':
        return 'markAll';
      case 'r':
      case 'R':
        return 'refresh';
      default:
        return null;
    }
  }

  if (e.shiftKey) {
    // Shift+F6 renames in place; Shift+Tab switches panes as Tab does.
    if (e.key === 'F6') return 'rename';
    if (e.key === 'Tab' && !onControl) return 'switch';
    return null;
  }

  switch (e.key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'PageUp':
      return 'pageUp';
    case 'PageDown':
      return 'pageDown';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'Backspace':
      return 'parent';
    case 'Insert':
      return 'mark';
    case 'F2':
      return 'rename';
    case 'F3':
      return 'view';
    case 'F5':
      return 'copy';
    case 'F6':
      return 'move';
    case 'F7':
      return 'mkdir';
    case 'F8':
    case 'Delete':
      return 'delete';
    case 'Enter':
      return onControl ? null : 'open';
    case ' ':
      return onControl ? null : 'mark';
    case 'Tab':
      return onControl ? null : 'switch';
    default:
      return null;
  }
}
