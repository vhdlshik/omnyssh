// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { ServerCard } from './serverCard';
import { groupCards, hasGroups } from './hostGroups';

function card(name: string, group: string | undefined, overall: ServerCard['overall']): ServerCard {
  return { host: { name, group }, overall } as unknown as ServerCard;
}

describe('grouping dashboard cards', () => {
  it('keeps the config order of groups and hosts, with ungrouped hosts last', () => {
    const groups = groupCards([
      card('mine', undefined, 'ok'),
      card('web', 'Prod', 'ok'),
      card('pi', 'Lab', 'off'),
      card('db', 'Prod', 'unknown')
    ]);
    expect(groups.map((g) => [g.name, g.cards.map((c) => c.host.name)])).toEqual([
      ['Prod', ['web', 'db']],
      ['Lab', ['pi']],
      [null, ['mine']]
    ]);
    expect(hasGroups(groups)).toBe(true);
  });

  it('counts hosts reporting in and hosts down', () => {
    const [prod] = groupCards([
      card('a', 'Prod', 'ok'),
      card('b', 'Prod', 'crit'),
      card('c', 'Prod', 'off'),
      card('d', 'Prod', 'unknown')
    ]);
    expect([prod.online, prod.down]).toEqual([2, 1]);
  });

  it('needs no headers when nothing is grouped', () => {
    const groups = groupCards([card('a', undefined, 'ok')]);
    expect(groups).toHaveLength(1);
    expect(hasGroups(groups)).toBe(false);
    expect(groupCards([])).toEqual([]);
  });
});

describe('folded groups', () => {
  beforeEach(() => localStorage.clear());

  it('toggle, fold all and unfold all, and persist', async () => {
    const { foldedGroups } = await import('./hostGroups');
    foldedGroups.setAll(['Prod', 'Lab'], false);
    foldedGroups.toggle('Prod');
    expect([...get(foldedGroups)]).toEqual(['Prod']);
    expect(JSON.parse(localStorage.getItem('omnyssh-folded-groups')!)).toEqual(['Prod']);
    foldedGroups.setAll(['Prod', 'Lab'], true);
    expect(get(foldedGroups)).toEqual(new Set(['Prod', 'Lab']));
    foldedGroups.setAll(['Prod', 'Lab'], false);
    expect(get(foldedGroups).size).toBe(0);
  });
});
