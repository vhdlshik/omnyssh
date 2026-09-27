// Upload files dropped onto a terminal into the shell's directory. The terminal's own
// connection is a PTY channel with no SFTP on it, so a drop opens a short-lived SFTP
// session to the same host, sends the files one at a time (the core's SFTP command
// channel is bounded — see SftpView's outbox), and closes it again. Progress and
// op-done arrive through the ordinary `sftp-*` events, routed by the sftp store.
import { sftp, type SftpSession } from '$lib/stores/sftp';
import { sftpOpen, sftpUpload, sftpClose } from '$lib/ipc/commands';
import { baseName, joinRemote } from './terminalCwd';

export interface UploadStatus {
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

/** Upload each local path into the remote directory `dir` on `hostName`. */
export async function uploadToDir(
  hostName: string,
  dir: string,
  paths: string[],
  onStatus: (status: UploadStatus) => void
): Promise<UploadResult> {
  const files = paths.flatMap((path) => {
    const name = baseName(path);
    return name ? [{ path, name }] : [];
  });
  const result: UploadResult = { uploaded: 0, failures: [] };
  if (files.length === 0) return result;

  const id = await sftpOpen(hostName);
  sftp.open(id, hostName);
  try {
    for (const [i, file] of files.entries()) {
      const status = { name: file.name, index: i + 1, count: files.length };
      onStatus({ ...status, done: 0, total: 0 });
      sftp.clearError(id);
      sftp.pushOp(id, { kind: 'upload', name: file.name, refresh: 'remote' });
      const settled = settle(id, (done, total) => onStatus({ ...status, done, total }));
      try {
        await sftpUpload(id, file.path, joinRemote(dir, file.name));
      } catch (err) {
        // Never enqueued, so no op-done is coming: retire the op here.
        sftp.opDone(id, false, errMsg(err));
      }
      const error = await settled;
      if (error) result.failures.push(`${file.name}: ${error}`);
      else result.uploaded += 1;
    }
  } finally {
    void sftpClose(id).catch(() => {});
    sftp.remove(id);
  }
  return result;
}

