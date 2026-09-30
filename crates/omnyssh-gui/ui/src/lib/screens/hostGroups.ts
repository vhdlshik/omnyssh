// Dashboard host groups: `#--- Name ---` headings in ~/.ssh/config put the hosts after
// them in a named group; the dashboard lists each group under a header that folds.
import { writable } from 'svelte/store';
import type { ServerCard } from './serverCard';

export interface CardGroup {
  /** The group's name; `null` for the hosts outside any group. */
  name: string | null;
  /** Stable key for fold state and `{#each}`. */
  key: string;
  cards: ServerCard[];
  /** Hosts reporting in (any health), and hosts known to be down. */
  online: number;
  down: number;
}

const UNGROUPED = '\u0000ungrouped';

/** Split cards into groups in the order the groups first appear (the config's order),
 *  hosts keeping their own order inside each. Hosts in no group come last, and are
 *  the only group when nothing is grouped at all. */
export function groupCards(cards: ServerCard[]): CardGroup[] {
  const byKey = new Map<string, CardGroup>();
  for (const card of cards) {
    const name = card.host.group ?? null;
    const key = name ?? UNGROUPED;
    let group = byKey.get(key);
    if (!group) {
      group = { name, key, cards: [], online: 0, down: 0 };
      byKey.set(key, group);
    }
    group.cards.push(card);
    if (card.overall === 'ok' || card.overall === 'warn' || card.overall === 'crit') group.online++;
    else if (card.overall === 'off') group.down++;
  }
  const groups = [...byKey.values()];
  return [...groups.filter((g) => g.name !== null), ...groups.filter((g) => g.name === null)];
}

/** Whether the dashboard needs group headers at all: only when something is grouped. */
export function hasGroups(groups: CardGroup[]): boolean {
  return groups.some((g) => g.name !== null);
}

// Folded groups, per machine. A per-viewer convenience, so localStorage is enough.
const FOLD_KEY = 'omnyssh-folded-groups';

function loadFolded(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function createFolded() {
  const { subscribe, update } = writable<Set<string>>(loadFolded());
  const persist = (keys: Set<string>): Set<string> => {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify([...keys]));
    } catch {
      // Unavailable storage: folds last for this session only.
    }
    return keys;
  };
  return {
    subscribe,
    toggle(key: string): void {
      update((keys) => {
        const next = new Set(keys);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return persist(next);
      });
    },
    /** Fold every one of `keys`, or unfold them all. */
    setAll(keys: string[], folded: boolean): void {
      update((current) => {
        const next = new Set(current);
        for (const k of keys) {
          if (folded) next.add(k);
          else next.delete(k);
        }
        return persist(next);
      });
    }
  };
}

export const foldedGroups = createFolded();
