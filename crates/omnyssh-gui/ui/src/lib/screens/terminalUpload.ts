// Move files between this computer and the shell's directory: uploads for files dropped
// onto a terminal (or picked with its Upload command), a download for its Download
// command. The terminal's own connection is a PTY channel with no SFTP on it, so each
// batch opens a short-lived SFTP session to the same host, sends the files one at a
// time (the core's SFTP command channel is bounded — see SftpView's outbox), and closes
// it again. Progress and op-done arrive through the ordinary `sftp-*` events, routed by
// the sftp store. Folders go whole: the core walks them.
import { sftp, type SftpSession } from '$lib/stores/sftp';
import { sftpOpen, sftpUpload, sftpDownload, sftpClose } from '$lib/ipc/commands';
import { baseName, joinRemote } from './terminalCwd';

export interface UploadStatus {
  kind: 'upload' | 'download';
  /** The file being sent now. */
  name: string;
  /** 1-based position of `name` in the batch. */
  index: number;
  count: number;
  done: number;
  total: number;
}

export interface UploadResult {
  uploaded: number;
  /** `name: reason` for each file that did not make it. */
  failures: string[];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve with the session's surfaced error once its pending ops have drained,
 *  reporting transfer progress on the way. A session that disappears resolves too. */
function settle(
  id: number,
  onProgress: (done: number, total: number) => void
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe: (() => void) | undefined;
    const check = (s: SftpSession | undefined): void => {
      if (finished) return;
      if (s?.transfer) onProgress(s.transfer.done, s.transfer.total);
      if (s && s.pending.length > 0) return;
      finished = true;
      unsubscribe?.();
      resolve(s ? s.error : 'SFTP session closed');
    };
    unsubscribe = sftp.subscribe((m) => check(m.get(id)));
    if (finished) unsubscribe();
  });
}

/** One file of a batch: its display name and the command that sends it. */
interface Job {
  name: string;
  send: (sessionId: number) => Promise<void>;
}

/** Run `jobs` one after another over a fresh SFTP session to `hostName`. */
async function runBatch(
  hostName: string,
  kind: 'upload' | 'download',
  jobs: Job[],
  onStatus: (status: UploadStatus) => void
): Promise<UploadResult> {
  const result: UploadResult = { uploaded: 0, failures: [] };
  if (jobs.length === 0) return result;

  const id = await sftpOpen(hostName);
  sftp.open(id, hostName);
  try {
    for (const [i, job] of jobs.entries()) {
      const status = { kind, name: job.name, index: i + 1, count: jobs.length };
      onStatus({ ...status, done: 0, total: 0 });
      sftp.clearError(id);
      sftp.pushOp(id, {
        kind,
        name: job.name,
        refresh: kind === 'upload' ? 'remote' : 'local'
      });
      const settled = settle(id, (done, total) => onStatus({ ...status, done, total }));
      try {
        await job.send(id);
      } catch (err) {
        // Never enqueued, so no op-done is coming: retire the op here.
        sftp.opDone(id, false, errMsg(err));
      }
      const error = await settled;
      if (error) result.failures.push(`${job.name}: ${error}`);
      else result.uploaded += 1;
    }
  } finally {
    void sftpClose(id).catch(() => {});
    sftp.remove(id);
  }
  return result;
}

/** Upload each local path (file or folder) into the remote directory `dir` on
 *  `hostName`. */
export function uploadToDir(
  hostName: string,
  dir: string,
  paths: string[],
  onStatus: (status: UploadStatus) => void
): Promise<UploadResult> {
  const jobs = paths.flatMap((path): Job[] => {
    const name = baseName(path);
    if (!name) return [];
    return [{ name, send: (id) => sftpUpload(id, path, joinRemote(dir, name)) }];
  });
  return runBatch(hostName, 'upload', jobs, onStatus);
}

/** Download the remote path `remote` (file or folder) on `hostName` to the local path
 *  `local`. */
export function downloadTo(
  hostName: string,
  remote: string,
  local: string,
  onStatus: (status: UploadStatus) => void
): Promise<UploadResult> {
  const name = baseName(remote) ?? remote;
  return runBatch(
    hostName,
    'download',
    [{ name, send: (id) => sftpDownload(id, local, remote) }],
    onStatus
  );
}

