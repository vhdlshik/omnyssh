import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { sftp } from '$lib/stores/sftp';

// Stand in for the backend: each upload "completes" on the next tick through the same
// store calls the event router makes for `transfer-progress` / `sftp-op-done`.
const uploads: Array<{ local: string; remote: string }> = [];
const downloads: Array<{ local: string; remote: string }> = [];
let failName: string | undefined;
const closed: number[] = [];

vi.mock('$lib/ipc/commands', () => ({
  sftpOpen: vi.fn(async () => 7),
  sftpClose: vi.fn(async (id: number) => {
    closed.push(id);
  }),
  sftpUpload: vi.fn(async (id: number, local: string, remote: string) => {
    uploads.push({ local, remote });
    setTimeout(() => {
      sftp.progress(id, { sessionId: id, transferId: 1, done: 5, total: 10 } as never);
      if (failName && local.endsWith(failName)) sftp.opDone(id, false, 'Permission denied');
      else sftp.opDone(id, true);
    }, 0);
  }),
  sftpDownload: vi.fn(async (id: number, local: string, remote: string) => {
    downloads.push({ local, remote });
    setTimeout(() => {
      sftp.progress(id, { sessionId: id, transferId: 2, done: 3, total: 9 } as never);
      if (failName && remote.endsWith(failName)) sftp.opDone(id, false, 'No such file');
      else sftp.opDone(id, true);
    }, 0);
  })
}));

const { uploadToDir, downloadTo } = await import('./terminalUpload');

describe('uploading files dropped on a terminal', () => {
  beforeEach(() => {
    uploads.length = 0;
    downloads.length = 0;
    closed.length = 0;
    failName = undefined;
  });

  it('sends each file into the directory, one at a time, then closes the session', async () => {
    const statuses: string[] = [];
    const result = await uploadToDir('box', '/srv/www', ['/tmp/a.txt', 'C:\\x\\b.bin'], (s) =>
      statuses.push(`${s.index}/${s.count} ${s.name} ${s.done}/${s.total}`)
    );
    expect(uploads).toEqual([
      { local: '/tmp/a.txt', remote: '/srv/www/a.txt' },
      { local: 'C:\\x\\b.bin', remote: '/srv/www/b.bin' }
    ]);
    expect(result).toEqual({ uploaded: 2, failures: [] });
    expect(statuses).toContain('1/2 a.txt 5/10');
    expect(statuses).toContain('2/2 b.bin 0/0');
    expect(closed).toEqual([7]);
    expect(get(sftp).has(7)).toBe(false);
  });

  it('reports a failed file without masking the ones that made it', async () => {
    failName = 'a.txt';
    const result = await uploadToDir('box', '.', ['/tmp/a.txt', '/tmp/b.txt'], () => {});
    expect(uploads.map((u) => u.remote)).toEqual(['a.txt', 'b.txt']);
    expect(result).toEqual({ uploaded: 1, failures: ['a.txt: Permission denied'] });
  });

  it('opens nothing when no dropped path names a file', async () => {
    const result = await uploadToDir('box', '/', ['/'], () => {});
    expect(result).toEqual({ uploaded: 0, failures: [] });
    expect(closed).toEqual([]);
  });
});

describe('downloading from a terminal', () => {
  beforeEach(() => {
    downloads.length = 0;
    closed.length = 0;
    failName = undefined;
  });

  it('fetches the remote path to the chosen local path, then closes the session', async () => {
    const statuses: string[] = [];
    const result = await downloadTo('box', '/srv/www/site', '/home/me/Downloads/site', (s) =>
      statuses.push(`${s.kind} ${s.name} ${s.done}/${s.total}`)
    );
    expect(downloads).toEqual([{ local: '/home/me/Downloads/site', remote: '/srv/www/site' }]);
    expect(result).toEqual({ uploaded: 1, failures: [] });
    expect(statuses).toContain('download site 3/9');
    expect(closed).toEqual([7]);
  });

  it('reports a failure by name', async () => {
    failName = 'gone.txt';
    const result = await downloadTo('box', 'gone.txt', '/tmp/gone.txt', () => {});
    expect(result).toEqual({ uploaded: 0, failures: ['gone.txt: No such file'] });
  });
});
