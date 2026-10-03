import { expect, test, type Page } from '@playwright/test';

// SFTP dual-pane vertical (tech-gui.md §3.2). e2e runs against the static SPA with
// Tauri absent, so we stub `__TAURI_INTERNALS__` at the boundary (§6.4). The stub owns
// an in-memory local + remote filesystem: `list_local_dir` returns directly, `sftp_*`
// commands fire the stamped `sftp-*` events the per-session forwarder would emit, and a
// transfer holds at a progress tick until `__completeTransfer()` fires its op-done — so
// the live progress bar is deterministically observable. Both spawn paths (a card's
// `files`, and the SFTP spawner via the host picker) are load-bearing for the stage.
const HOSTS = [
  { name: 'web-1', hostname: 'web-1.example.com', user: 'deploy', port: 22, tags: ['prod'], source: 'manual', hasKey: true, localForwards: [], tunnelAutostart: false, forwardAgent: false },
  { name: 'db-1', hostname: 'db-1.example.com', user: 'root', port: 22, tags: [], source: 'manual', hasKey: false, localForwards: [], tunnelAutostart: false, forwardAgent: false }
];

async function boot(page: Page): Promise<void> {
  await page.addInitScript(
    ({ hosts }) => {
      let cbid = 0;
      const win = window as unknown as Record<string, unknown>;
      const listeners: Record<string, number[]> = {};
      let nextSession = 0;
      let nextTransfer = 0;
      // A pending transfer holds until the test fires its op-done, so the progress bar
      // is observable mid-flight (the core is sequential — one transfer at a time).
      const completions: Array<(ok: boolean) => void> = [];

      type Entry = { name: string; path: string; size: number; isDir: boolean };
      const local: Record<string, Entry[]> = {
        '/home/user': [
          { name: 'notes.txt', path: '/home/user/notes.txt', size: 24, isDir: false },
          { name: 'work', path: '/home/user/work', size: 0, isDir: true }
        ]
      };
      const remote: Record<string, Entry[]> = {
        '/': [
          { name: 'config.yml', path: '/config.yml', size: 64, isDir: false },
          { name: 'var', path: '/var', size: 0, isDir: true }
        ]
      };

      function parentOf(p: string): string {
        const i = p.lastIndexOf('/');
        return i <= 0 ? '/' : p.slice(0, i);
      }
      function baseName(p: string): string {
        return p.slice(p.lastIndexOf('/') + 1);
      }
      function withParent(path: string, entries: Entry[]): Entry[] {
        if (path === '/') return entries;
        return [{ name: '..', path: parentOf(path), size: 0, isDir: true }, ...entries];
      }
      function addFile(fs: Record<string, Entry[]>, dir: string, name: string, isDir = false): void {
        const list = (fs[dir] ||= []);
        if (!list.some((e) => e.name === name)) {
          list.push({ name, path: dir === '/' ? `/${name}` : `${dir}/${name}`, size: isDir ? 0 : 8, isDir });
        }
      }
      function removeEntry(fs: Record<string, Entry[]>, path: string): void {
        const dir = parentOf(path);
        fs[dir] = (fs[dir] ?? []).filter((e) => e.path !== path);
      }
      // A remote mutation acks with op-done on a later tick, as the core does.
      function remoteOp(sessionId: number, change: () => void): Promise<null> {
        setTimeout(() => {
          change();
          fireEvent('sftp-op-done', { sessionId, ok: true });
        }, 0);
        return Promise.resolve(null);
      }

      function fireEvent(event: string, payload: unknown): void {
        for (const id of listeners[event] ?? []) {
          const cb = win[`__cb${id}`] as ((e: unknown) => void) | undefined;
          cb?.({ event, id, payload });
        }
      }

      // Fire the oldest still-pending transfer's op-done (deterministic completion);
      // `false` fails it instead.
      (win as { __completeTransfer?: (ok?: boolean) => void }).__completeTransfer = (ok = true) =>
        completions.shift()?.(ok);

      (win as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: Record<string, unknown>) => {
          if (cmd.startsWith('plugin:path')) return Promise.resolve('/home/user');
          switch (cmd) {
            case 'list_hosts':
              return Promise.resolve(hosts);
            case 'reload_hosts':
              return Promise.resolve(null);
            case 'list_local_dir': {
              const path = args.path as string;
              return Promise.resolve(withParent(path, local[path] ?? []));
            }
            case 'sftp_open': {
              const sid = ++nextSession;
              setTimeout(() => fireEvent('sftp-connected', { sessionId: sid, hostName: args.hostName }), 0);
              return Promise.resolve(sid);
            }
            case 'sftp_list': {
              const { sessionId, path } = args as { sessionId: number; path: string };
              setTimeout(
                () => fireEvent('sftp-dir-listed', { sessionId, path, entries: withParent(path, remote[path] ?? []) }),
                0
              );
              return Promise.resolve(null);
            }
            case 'sftp_upload': {
              const { sessionId, remote: dest } = args as { sessionId: number; remote: string };
              const tid = ++nextTransfer;
              setTimeout(() => fireEvent('transfer-progress', { sessionId, transferId: tid, done: 4, total: 8 }), 0);
              completions.push((ok) => {
                if (ok) addFile(remote, parentOf(dest), baseName(dest));
                fireEvent('sftp-op-done', ok ? { sessionId, ok } : { sessionId, ok, error: 'Disk full' });
              });
              return Promise.resolve(null);
            }
            case 'sftp_download': {
              const { sessionId, local: dest } = args as { sessionId: number; local: string };
              const tid = ++nextTransfer;
              setTimeout(() => fireEvent('transfer-progress', { sessionId, transferId: tid, done: 2, total: 8 }), 0);
              completions.push((ok) => {
                if (ok) addFile(local, parentOf(dest), baseName(dest));
                fireEvent('sftp-op-done', ok ? { sessionId, ok } : { sessionId, ok, error: 'Disk full' });
              });
              return Promise.resolve(null);
            }
            case 'sftp_close':
              return Promise.resolve(null);
            case 'sftp_mkdir': {
              const { sessionId, path } = args as { sessionId: number; path: string };
              return remoteOp(sessionId, () => addFile(remote, parentOf(path), baseName(path), true));
            }
            case 'sftp_remove_tree': {
              const { sessionId, path } = args as { sessionId: number; path: string };
              ((win.__removed ??= []) as string[]).push(path);
              return remoteOp(sessionId, () => removeEntry(remote, path));
            }
            case 'sftp_rename': {
              const { sessionId, from, to } = args as { sessionId: number; from: string; to: string };
              return remoteOp(sessionId, () => {
                removeEntry(remote, from);
                addFile(remote, parentOf(to), baseName(to));
              });
            }
            case 'local_mkdir': {
              const path = args.path as string;
              addFile(local, parentOf(path), baseName(path), true);
              return Promise.resolve(null);
            }
            case 'local_delete':
              ((win.__removed ??= []) as string[]).push(args.path as string);
              removeEntry(local, args.path as string);
              return Promise.resolve(null);
            case 'local_rename': {
              const { from, to } = args as { from: string; to: string };
              removeEntry(local, from);
              addFile(local, parentOf(to), baseName(to));
              return Promise.resolve(null);
            }
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
        },
        unregisterCallback: (id: number) => {
          delete win[`__cb${id}`];
        }
      };
    },
    { hosts: HOSTS }
  );

  await page.goto('/');
  await expect(page.getByText('2 hosts')).toBeVisible();
}

test('host-first: a card’s files opens SFTP and browses both sides', async ({ page }) => {
  await boot(page);

  // Host-first spawn — a Dashboard card's `files`, no picker (tech-gui.md §2, §3.2).
  await page.getByTitle('files on web-1').click();

  await expect(page.getByRole('button', { name: 'web-1 · sftp', exact: true })).toBeVisible();
  const localPane = page.getByRole('region', { name: 'Local' });
  const remotePane = page.getByRole('region', { name: 'web-1' });

  // Both panes list their own filesystem, from distinct commands (local direct, remote event).
  await expect(localPane.getByText('notes.txt')).toBeVisible();
  await expect(remotePane.getByText('config.yml')).toBeVisible();
});

test('round-trip: upload a local file to the remote, then download a remote file', async ({
  page
}) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();

  const localPane = page.getByRole('region', { name: 'Local' });
  const remotePane = page.getByRole('region', { name: 'web-1' });
  await expect(localPane.getByText('notes.txt')).toBeVisible();
  await expect(remotePane.getByText('config.yml')).toBeVisible();

  // Upload: mark the local file, click Upload — the live progress bar shows mid-flight.
  await localPane.getByRole('checkbox', { name: 'Mark notes.txt' }).click();
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByLabel('transfer progress')).toBeVisible();

  // Complete it: op-done drains the batch, the remote pane re-lists with the new file.
  await page.evaluate(() => (window as unknown as { __completeTransfer: () => void }).__completeTransfer());
  await expect(remotePane.getByText('notes.txt')).toBeVisible();
  await expect(page.getByLabel('transfer progress')).toHaveCount(0);

  // Download: mark a remote file, click Download, complete — the local pane re-lists it.
  await remotePane.getByRole('checkbox', { name: 'Mark config.yml' }).click();
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByLabel('transfer progress')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __completeTransfer: () => void }).__completeTransfer());
  await expect(localPane.getByText('config.yml')).toBeVisible();
});

test('an inactive tab’s modal never overlays another entity (§2 exactly-one-active)', async ({
  page
}) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  await expect(page.getByRole('region', { name: 'web-1' })).toBeVisible();
  // Return to the Dashboard (a session hides it) to open a second SFTP session.
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await page.getByTitle('files on db-1').click();
  await expect(page.getByRole('region', { name: 'db-1' })).toBeVisible();

  // Open db-1's New-folder modal. The modal scrim traps the sidebar, so the ⌘K
  // navigator is the reachable way to switch entity while a modal is open.
  await page.getByRole('button', { name: 'Folder' }).click();
  await expect(page.getByRole('dialog', { name: 'New folder' })).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('textbox').fill('web-1');
  await page.keyboard.press('Enter');

  // Activating the web-1 session must fully hide db-1's modal — never two at once.
  await expect(page.getByRole('region', { name: 'web-1' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'New folder' })).toHaveCount(0);
});

test('action-first: the SFTP spawner opens the host picker, then a live session', async ({
  page
}) => {
  await boot(page);

  await page.getByRole('button', { name: 'SFTP', exact: true }).click();
  await page.getByRole('dialog').getByText('web-1', { exact: true }).click();

  await expect(page.getByRole('button', { name: 'web-1 · sftp', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'web-1' }).getByText('config.yml')).toBeVisible();
});

test('Total Commander keys: F5 copies across, F7 makes a folder, F8 deletes, Shift+F6 renames', async ({
  page
}) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();

  const localPane = page.getByRole('region', { name: 'Local' });
  const remotePane = page.getByRole('region', { name: 'web-1' });
  const complete = () =>
    page.evaluate(() => (window as unknown as { __completeTransfer: () => void }).__completeTransfer());
  await expect(localPane.getByText('notes.txt')).toBeVisible();
  await expect(remotePane.getByText('config.yml')).toBeVisible();

  // The local pane has the keyboard; its cursor starts on `..`.
  const localCursor = localPane.locator('li[aria-current="true"]');
  await expect(localCursor).toContainText('..');
  await page.keyboard.press('ArrowDown');
  await expect(localCursor).toContainText('notes.txt');

  // F5 copies the file under the cursor into the other pane's folder.
  await page.keyboard.press('F5');
  const copy = page.getByRole('dialog', { name: 'Copy' });
  await expect(copy.getByLabel('Destination folder')).toHaveValue('/');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('transfer progress')).toBeVisible();
  await complete();
  await expect(remotePane.getByText('notes.txt')).toBeVisible();

  // F7 makes a folder on the active (local) side.
  await page.keyboard.press('F7');
  await page.getByRole('dialog', { name: 'New folder' }).getByRole('textbox').fill('logs');
  await page.keyboard.press('Enter');
  await expect(localPane.getByText('logs')).toBeVisible();

  // Tab hands the keyboard to the remote pane; F8 deletes the entry under its cursor.
  await page.keyboard.press('Tab');
  const remoteCursor = remotePane.locator('li[aria-current="true"]');
  await expect(remoteCursor).toContainText('config.yml');
  await expect(localCursor).toHaveCount(0);
  await page.keyboard.press('F8');
  await expect(page.getByRole('dialog', { name: 'Delete' })).toContainText('Delete config.yml?');
  await page.keyboard.press('Enter');
  await expect(remotePane.getByText('config.yml')).toHaveCount(0);

  // Shift+F6 renames in place.
  await page.keyboard.press('End');
  await expect(remoteCursor).toContainText('notes.txt');
  await page.keyboard.press('Shift+F6');
  const rename = page.getByRole('dialog', { name: 'Rename' }).getByRole('textbox');
  await expect(rename).toHaveValue('notes.txt');
  await rename.fill('notes.md');
  await page.keyboard.press('Enter');
  await expect(remotePane.getByText('notes.md')).toBeVisible();
});

test('F6 moves marked entries: the source goes once its copy is done', async ({ page }) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();

  const localPane = page.getByRole('region', { name: 'Local' });
  const remotePane = page.getByRole('region', { name: 'web-1' });
  await expect(remotePane.getByText('config.yml')).toBeVisible();

  // Switch to the remote pane and mark config.yml with Insert (which steps down a row).
  await page.keyboard.press('Tab');
  await page.keyboard.press('Insert');
  await expect(remotePane.getByRole('checkbox', { name: 'Mark config.yml' })).toBeChecked();
  await expect(remotePane.locator('li[aria-current="true"]')).toContainText('var');

  // The F-key bar runs the same command as the key.
  await page.getByRole('navigation', { name: 'function keys' }).getByRole('button', { name: /Move/ }).click();
  const move = page.getByRole('dialog', { name: 'Move' });
  await expect(move).toContainText('config.yml');
  await expect(move.getByLabel('Destination folder')).toHaveValue('/home/user');
  await page.keyboard.press('Enter');

  // Nothing is deleted while the copy is still running.
  await expect(page.getByLabel('transfer progress')).toBeVisible();
  await expect(remotePane.getByText('config.yml')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __completeTransfer: () => void }).__completeTransfer());

  await expect(localPane.getByText('config.yml')).toBeVisible();
  await expect(remotePane.getByText('config.yml')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __removed: string[] }).__removed)).toEqual([
    '/config.yml'
  ]);
});

test('F6 keeps the source when its copy fails', async ({ page }) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();

  const localPane = page.getByRole('region', { name: 'Local' });
  await expect(localPane.getByText('notes.txt')).toBeVisible();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('F6');
  await expect(page.getByRole('dialog', { name: 'Move' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('transfer progress')).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __completeTransfer: (ok: boolean) => void }).__completeTransfer(false)
  );

  await expect(page.getByText('Disk full')).toBeVisible();
  await expect(localPane.getByText('notes.txt')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __removed?: string[] }).__removed)).toBeUndefined();
});
