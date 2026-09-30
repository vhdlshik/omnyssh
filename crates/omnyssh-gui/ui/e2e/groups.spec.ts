import { expect, test, type Page } from '@playwright/test';

// Host groups (`#--- Name ---` headings in ~/.ssh/config) fold on the dashboard. Same
// Tauri boundary stub as hosts.spec.ts; the hosts arrive already grouped, as the
// backend parses them.
const HOSTS = [
  { name: 'mine', hostname: 'mine.example.com', user: 'root', port: 22, tags: [], source: 'sshConfig', hasKey: false, localForwards: [], tunnelAutostart: false, forwardAgent: false },
  { name: 'web-1', hostname: 'web-1.example.com', user: 'root', port: 22, tags: [], source: 'sshConfig', hasKey: false, localForwards: [], tunnelAutostart: false, forwardAgent: false, group: 'Production' },
  { name: 'web-2', hostname: 'web-2.example.com', user: 'root', port: 22, tags: [], source: 'sshConfig', hasKey: false, localForwards: [], tunnelAutostart: false, forwardAgent: false, group: 'Production' },
  { name: 'db-1', hostname: 'db-1.example.com', user: 'root', port: 22, tags: [], source: 'sshConfig', hasKey: false, localForwards: [], tunnelAutostart: false, forwardAgent: false, group: 'Production' },
  { name: 'pi', hostname: 'pi.example.com', user: 'root', port: 22, tags: [], source: 'sshConfig', hasKey: false, localForwards: [], tunnelAutostart: false, forwardAgent: false, group: 'Home lab' },
  { name: 'nas', hostname: 'nas.example.com', user: 'root', port: 22, tags: [], source: 'sshConfig', hasKey: false, localForwards: [], tunnelAutostart: false, forwardAgent: false, group: 'Home lab' }
];

async function boot(page: Page): Promise<void> {
  await page.addInitScript(
    ({ hosts }) => {
      let cbid = 0;
      const listeners: Record<string, number[]> = {};
      const state: { hosts: Array<Record<string, unknown>> } = { hosts: hosts.map((h) => ({ ...h })) };
      const win = window as unknown as Record<string, unknown>;

      function fire(event: string, payload: unknown): void {
        for (const id of listeners[event] ?? []) {
          const cb = win[`__cb${id}`] as ((e: unknown) => void) | undefined;
          cb?.({ event, id, payload });
        }
      }

      (win as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: Record<string, unknown>) => {
          switch (cmd) {
            case 'list_hosts':
              return Promise.resolve([...state.hosts]);
            case 'reload_hosts':
              // The real command reloads + restarts pollers, then broadcasts the list.
              setTimeout(() => fire('hosts-loaded', [...state.hosts]), 0);
              return Promise.resolve(null);
            case 'save_host': {
              // Upsert by name as a manual host; the outbound view (HostDto) omits the
              // secret fields the input carried, mirroring the backend map (§3.4).
              const h = args.input as Record<string, unknown> & { name: string; identityFile?: string };
              const view = {
                name: h.name,
                hostname: h.hostname,
                user: h.user,
                port: h.port,
                tags: (h.tags as string[]) ?? [],
                notes: h.notes,
                source: 'manual',
                hasKey: !!h.identityFile,
                localForwards: h.localForwards,
                tunnelAutostart: h.tunnelAutostart,
                forwardAgent: h.forwardAgent
              };
              const i = state.hosts.findIndex((x) => (x as { name: string }).name === view.name);
              if (i >= 0) state.hosts[i] = { ...state.hosts[i], ...view };
              else state.hosts.push(view);
              return Promise.resolve(null);
            }
            case 'delete_host':
              state.hosts = state.hosts.filter((x) => (x as { name: string }).name !== args.name);
              return Promise.resolve(null);
            case 'plugin:event|listen': {
              const { event, handler } = args as { event: string; handler: number };
              (listeners[event] ||= []).push(handler);
              return Promise.resolve(cbid);
            }
            default:
              return Promise.resolve(null);
          }
        },
        transformCallback: (cb: unknown) => {
          const id = ++cbid;
          win[`__cb${id}`] = cb;
          return id;
        }
      };
    },
    { hosts: HOSTS }
  );
  await page.goto('/');
  // The dashboard is the default screen; the seeded cards confirm the app booted.
  await expect(page.getByText('web-1', { exact: true })).toBeVisible();
}

const header = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });

test('groups list under headers in config order, ungrouped last', async ({ page }) => {
  await boot(page);
  const headers = page.locator('button[aria-expanded]:not([aria-label])');
  await expect(headers).toHaveText([/Production\s*3/, /Home lab\s*2/, /Ungrouped\s*1/]);
  await expect(page.getByText('web-2', { exact: true })).toBeVisible();
});

test('a group folds and stays folded after a reload', async ({ page }) => {
  await boot(page);
  await header(page, 'Production').click();
  await expect(header(page, 'Production')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('web-1', { exact: true })).toHaveCount(0);
  await expect(page.getByText('pi', { exact: true })).toBeVisible();
  await page.reload();
  await expect(header(page, 'Production')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('web-1', { exact: true })).toHaveCount(0);
});

test('a search opens folded groups that match, and hides the rest', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Collapse all groups' }).click();
  await expect(page.getByText('web-1', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Search hosts' }).click();
  await page.getByLabel('Search hosts').fill('web');
  await expect(page.getByText('web-1', { exact: true })).toBeVisible();
  await expect(header(page, 'Home lab')).toHaveCount(0);
  await page.getByLabel('Search hosts').fill('home lab');
  await expect(page.getByText('nas', { exact: true })).toBeVisible();
});

test('collapse all and expand all', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Collapse all groups' }).click();
  await expect(page.locator('button[aria-expanded="true"]:not([aria-label])')).toHaveCount(0);
  await page.screenshot({ path: process.env.SHOT_FOLDED ?? 'test-results/groups-folded.png' });
  await page.getByRole('button', { name: 'Expand all groups' }).click();
  await expect(page.locator('button[aria-expanded="false"]:not([aria-label])')).toHaveCount(0);
  await header(page, 'Home lab').click();
  await page.screenshot({ path: process.env.SHOT_OPEN ?? 'test-results/groups-open.png' });
});
