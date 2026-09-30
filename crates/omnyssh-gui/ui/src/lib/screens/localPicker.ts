// Labels and remembered choices for the local-terminal picker (LocalPicker.svelte).
import type { LocalTargetDto } from '$lib/bindings';

/** The speed a serial console starts at unless the user picked another. */
export const DEFAULT_BAUD = 115200;
const BAUD_KEY = 'omnyssh-serial-baud';

/** A serial port's short name for a tab: `/dev/ttyUSB0` reads as `ttyUSB0`. */
export function portShortName(port: string): string {
  return port.replace(/^\/dev\//, '').replace(/^\\\\\.\\/, '');
}

/** The sidebar label of a local session. */
export function localLabel(target: LocalTargetDto, shellName?: string): string {
  if (target.kind === 'serial') return `${portShortName(target.port)} · ${target.baud}`;
  return shellName ?? target.id;
}

/** The speed to preselect: the last one used, if the machine still offers it. */
export function rememberedBaud(offered: number[]): number {
  let saved: number | undefined;
  try {
    saved = Number(localStorage.getItem(BAUD_KEY)) || undefined;
  } catch {
    saved = undefined;
  }
  if (saved && offered.includes(saved)) return saved;
  return offered.includes(DEFAULT_BAUD) ? DEFAULT_BAUD : (offered[0] ?? DEFAULT_BAUD);
}

export function rememberBaud(baud: number): void {
  try {
    localStorage.setItem(BAUD_KEY, String(baud));
  } catch {
    // Per-machine convenience only.
  }
}

/** Shell-quote dropped local paths for pasting at a prompt, the way terminal
 *  emulators do: single quotes on Unix shells, double quotes for Windows ones. */
export function quotePaths(paths: string[], windows: boolean): string {
  return paths
    .map((p) => {
      if (windows) return /[\s&()^;,'"]/.test(p) ? `"${p}"` : p;
      return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}
