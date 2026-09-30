import { writable } from 'svelte/store';
import type { IconName, Status } from '$lib/theme';
import type { LocalTargetDto } from '$lib/bindings';

// The open terminal/SFTP tabs (tech-gui.md §2, §3.5). Spawners append a row here;
// Stage 3 makes the sessions real (live PTY / SFTP). Ids come from one monotonic
// space so a closed tab's id is never reused and terminal/SFTP ids never collide in
// the frontend.
export type SessionKind = 'terminal' | 'sftp';
export type SessionStatus = 'connecting' | 'connected' | 'failed' | 'unknown';

/** Session state on the shared server-state palette — one source for every session dot
 *  (sidebar row + command palette) so the two never drift. */
export const sessionStatusDot: Record<SessionStatus, Status> = {
  connecting: 'unknown',
  connected: 'ok',
  failed: 'crit',
  unknown: 'unknown'
};

export interface Session {
  id: number;
  kind: SessionKind;
  hostName: string;
  status: SessionStatus;
  /** The backend public session id, set once `terminal_open` resolves (tech-gui.md
   *  §3.4). Undefined while connecting; the id crossing IPC is always this public id. */
  termId?: number;
  /** Set for a terminal on this machine (a local shell or a serial port) rather than
   *  an SSH host; `hostName` is then just its label. */
  local?: LocalTargetDto;
}

/** The glyph for a session row: a local shell or serial port reads apart from SSH. */
export function sessionIcon(s: Session): IconName {
  if (s.local?.kind === 'shell') return 'monitor';
  if (s.local?.kind === 'serial') return 'plug';
  return s.kind;
}

/** The visible session label: just the host name. The type (terminal/SFTP) is already
 *  carried by the row's type icon, so the text stays compact and readable at any width. */
export function sessionLabel(s: Session): string {
  return s.hostName;
}

/** The accessible/tooltip label: host + type, so hover and screen readers still convey
 *  the connection type the icon shows visually. */
export function sessionTitle(s: Session): string {
  return `${s.hostName} · ${s.kind}`;
}

function createSessions() {
  const { subscribe, update } = writable<Session[]>([]);
  let nextId = 1;
  return {
    subscribe,
    spawn(kind: SessionKind, hostName: string, local?: LocalTargetDto): Session {
      const session: Session = { id: nextId++, kind, hostName, status: 'connecting' };
      if (local) session.local = local;
      update((list) => [...list, session]);
      return session;
    },
    /** Record the backend public id once `terminal_open` resolves (tech-gui.md §3.4). */
    setTermId(id: number, termId: number): void {
      update((list) => list.map((s) => (s.id === id ? { ...s, termId } : s)));
    },
    /** Update a session's connection state (drives its status dot). */
    setStatus(id: number, status: SessionStatus): void {
      update((list) => list.map((s) => (s.id === id ? { ...s, status } : s)));
    },
    close(id: number): void {
      update((list) => list.filter((s) => s.id !== id));
    }
  };
}

export const sessions = createSessions();
