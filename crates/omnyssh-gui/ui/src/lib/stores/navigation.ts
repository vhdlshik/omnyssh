import { get } from 'svelte/store';
import { activeEntity } from './activeEntity';
import type { LocalTargetDto } from '$lib/bindings';
import { sessions, type Session, type SessionKind } from './sessions';

// Composed navigation actions that keep the sessions list and the active entity in
// step (tech-gui.md §2). A spawn appends a session and makes it active (both spawn
// paths do this); closing the active session falls back to the Dashboard so Content
// is never left pointing at a closed tab.
export function spawnSession(
  kind: SessionKind,
  hostName: string,
  local?: LocalTargetDto
): Session {
  const session = sessions.spawn(kind, hostName, local);
  activeEntity.activateSession(session.id);
  return session;
}

export function closeSession(id: number): void {
  const active = get(activeEntity);
  if (active.kind === 'session' && active.id === id) {
    activeEntity.selectDashboard();
  }
  sessions.close(id);
}
