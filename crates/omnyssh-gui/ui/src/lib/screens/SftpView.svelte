<script lang="ts">
  // A live SFTP tab (tech-gui.md §3.2). One instance per SFTP session, kept mounted for
  // the session's life — hidden, not destroyed, when another entity is active — so pane
  // state survives tab switches. Opens the session on mount, drives both panes via the
  // sftp_* commands, and reads its per-session state from the sftp store (fed by the
  // `sftp-*` events, §3.4). Local browsing uses list_local_dir (returns directly);
  // remote uses sftp_list (arrives as an event). Semantic tokens only (§5.1).
  // The keyboard follows Total Commander (see sftpKeys): a cursor per pane, Tab between
  // them, and F3 view / F5 copy / F6 move / Shift+F6 rename / F7 new folder / F8 delete
  // acting on the marked entries or the one under the cursor, on either side.
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { homeDir } from '@tauri-apps/api/path';
  import { Icon } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import SftpPane from './SftpPane.svelte';
  import type { FileEntryDto } from '$lib/bindings';
  import { sessions, type Session } from '$lib/stores/sessions';
  import {
    sftp,
    markedEntries,
    formatBytes,
    cursorEntry,
    targetEntries,
    otherSide,
    type PaneSide,
    type PendingOp
  } from '$lib/stores/sftp';
  import { lastError } from '$lib/stores/notifications';
  import { dialogs } from '$lib/stores/dialogs';
  import { fileManagerKey, FKEY_BAR, type FmCommand } from './sftpKeys';
  import {
    sftpOpen,
    sftpList,
    sftpClose,
    sftpUpload,
    sftpDownload,
    sftpMkdir,
    sftpRename,
    sftpDelete,
    sftpRemoveTree,
    sftpPreview,
    listLocalDir,
    previewLocalFile,
    localMkdir,
    localRename,
    localDelete
  } from '$lib/ipc/commands';

  let { session, active }: { session: Session; active: boolean } = $props();

  let backendId = $state<number | undefined>(undefined);
  let openError = $state<string | undefined>(undefined);
  let destroyed = false;
  let mirrored: string | undefined;

  // Queued mutations, dispatched one at a time (see the pump effect). The core's SFTP
  // command channel is bounded and drops on overflow, so a large batch fired at once
  // would silently lose commands and wedge the op-done FIFO; gating on the previous
  // op's completion keeps at most one command outstanding.
  let outbox = $state<Array<() => void>>([]);

  // A pending mkdir/rename input, in the pane `side`. Rename carries the entry renamed.
  let prompt = $state<{
    kind: 'mkdir' | 'rename';
    side: PaneSide;
    value: string;
    target?: FileEntryDto;
  } | null>(null);

  // A copy/move (F5/F6) waiting on its destination, or a delete (F8) on a yes.
  type Confirm =
    | { kind: 'copy' | 'move'; from: PaneSide; items: FileEntryDto[]; dest: string }
    | { kind: 'delete'; side: PaneSide; items: FileEntryDto[] };
  let confirm = $state<Confirm | null>(null);

  const view = $derived(backendId != null ? $sftp.get(backendId) : undefined);
  const transfer = $derived(view?.transfer);

  const localMarked = $derived(view ? markedEntries(view.local) : []);
  const remoteMarked = $derived(view ? markedEntries(view.remote) : []);
  const singleRemoteMark = $derived(remoteMarked.length === 1 ? remoteMarked[0] : undefined);

  function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function joinRemote(dir: string, name: string): string {
    return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
  }

  function joinLocal(dir: string, name: string): string {
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
    return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
  }

  function join(side: PaneSide, dir: string, name: string): string {
    return side === 'local' ? joinLocal(dir, name) : joinRemote(dir, name);
  }

  /** A typed name as a path in `dir` — or as-is when it is already absolute. */
  function resolveIn(side: PaneSide, dir: string, name: string): string {
    const absolute = name.startsWith('/') || (side === 'local' && /^[A-Za-z]:[\\/]/.test(name));
    return absolute ? name : join(side, dir, name);
  }

  async function refreshLocal(path: string): Promise<void> {
    const id = backendId;
    if (id == null) return;
    sftp.beginLoading(id, 'local');
    try {
      const entries = await listLocalDir(path);
      sftp.listing(id, 'local', path, entries);
    } catch (err) {
      sftp.paneError(id, 'local', errMsg(err));
    }
  }

  function refreshRemote(path: string): void {
    const id = backendId;
    if (id == null) return;
    sftp.beginLoading(id, 'remote');
    void sftpList(id, path).catch((err) => sftp.paneError(id, 'remote', errMsg(err)));
  }

  onMount(() => {
    void (async () => {
      let home = '/';
      try {
        home = await homeDir();
      } catch {
        home = '/';
      }
      let id: number;
      try {
        id = await sftpOpen(session.hostName);
      } catch (err) {
        sessions.setStatus(session.id, 'failed');
        openError = errMsg(err);
        lastError.set(errMsg(err));
        return;
      }
      if (destroyed) {
        void sftpClose(id).catch(() => {});
        return;
      }
      backendId = id;
      sftp.open(id, session.hostName);
      void refreshLocal(home);
      refreshRemote('/');
    })();
  });

  onDestroy(() => {
    destroyed = true;
    if (backendId != null) {
      void sftpClose(backendId).catch(() => {});
      sftp.remove(backendId);
    }
  });

  // Mirror the store connection status to the sidebar dot (the sessions store is the
  // sidebar's source of truth); only on change, to avoid churning the sessions list.
  $effect(() => {
    if (view && view.status !== mirrored) {
      mirrored = view.status;
      sessions.setStatus(session.id, view.status);
    }
  });

  // Dispatch the next queued mutation once the previous one is acked (pending empty),
  // so at most one command is outstanding and the bounded core channel never overflows.
  $effect(() => {
    if (!view || view.pending.length > 0 || outbox.length === 0) return;
    const [next, ...rest] = outbox;
    outbox = rest;
    next();
  });

  // Re-list the affected pane once every queued mutation has drained — the FS changed
  // (§3.2). Gated on an empty outbox so a batch re-lists once at the end, not per op.
  $effect(() => {
    const id = backendId;
    if (id == null || !view || view.pending.length > 0 || outbox.length > 0 || !view.refresh) return;
    const target = view.refresh;
    sftp.clearRefresh(id);
    if (target === 'local' || target === 'both') void refreshLocal(view.local.path);
    if (target === 'remote' || target === 'both') refreshRemote(view.remote.path);
  });

  function navigate(side: PaneSide, entry: FileEntryDto): void {
    if (side === 'local') void refreshLocal(entry.path);
    else refreshRemote(entry.path);
  }

  function toggleMark(side: PaneSide, path: string): void {
    if (backendId != null) sftp.toggleMark(backendId, side, path);
  }

  async function preview(side: PaneSide, entry: FileEntryDto): Promise<void> {
    const id = backendId;
    if (id == null) return;
    if (side === 'local') {
      try {
        const content = await previewLocalFile(entry.path);
        sftp.setPreview(id, { path: entry.path, content });
      } catch (err) {
        lastError.set(errMsg(err));
      }
    } else {
      void sftpPreview(id, entry.path).catch((err) => lastError.set(errMsg(err)));
    }
  }

  // If a mutating invoke itself rejects (it never does for a normal enqueue, but an IPC
  // failure could), pop its pending op so the dispatch pump does not wedge.
  function onDispatchError(id: number): (err: unknown) => void {
    return (err) => {
      lastError.set(errMsg(err));
      sftp.opDone(id, false, errMsg(err));
    };
  }

  function enqueue(...actions: Array<() => void>): void {
    if (!actions.length) return;
    // Clear the prior batch's lingering error only when starting from idle. Piling onto a
    // batch that is still draining must not wipe a failure it already recorded (that error
    // stays visible until the next fresh action — see applyOpDone).
    const draining = outbox.length > 0 || (view?.pending.length ?? 0) > 0;
    if (backendId != null && !draining) sftp.clearError(backendId);
    outbox = [...outbox, ...actions];
  }

  /** Run a local filesystem op through the same pending-op FIFO as the remote ones,
   *  so it queues behind them, re-lists its pane and surfaces its error the same way.
   *  The local commands answer directly, so this settles the op itself. */
  function runLocal(id: number, op: PendingOp, task: () => Promise<void>): void {
    sftp.pushOp(id, op);
    task().then(
      () => sftp.opDone(id, true),
      (err) => sftp.opDone(id, false, errMsg(err))
    );
  }

  /** Copy `entry` from the `from` pane into `destDir` on the other side. Folders go
   *  whole — the core walks them. */
  function transferAction(id: number, from: PaneSide, entry: FileEntryDto, destDir: string) {
    if (from === 'local') {
      return () => {
        sftp.pushOp(id, { kind: 'upload', name: entry.name, refresh: 'remote' });
        void sftpUpload(id, entry.path, joinRemote(destDir, entry.name)).catch(
          onDispatchError(id)
        );
      };
    }
    return () => {
      sftp.pushOp(id, { kind: 'download', name: entry.name, refresh: 'local' });
      void sftpDownload(id, joinLocal(destDir, entry.name), entry.path).catch(onDispatchError(id));
    };
  }

  /** Delete `entry` on `side`, folders with everything in them. With `afterCopy` (a
   *  move) it runs only when the copy queued just before it succeeded. */
  function deleteAction(id: number, side: PaneSide, entry: FileEntryDto, afterCopy = false) {
    return () => {
      if (afterCopy && !view?.lastOk) return;
      const op: PendingOp = { kind: 'delete', name: entry.name, refresh: side };
      if (side === 'local') {
        runLocal(id, op, () => localDelete(entry.path));
      } else {
        sftp.pushOp(id, op);
        void sftpRemoveTree(id, entry.path).catch(onDispatchError(id));
      }
    };
  }

  function upload(): void {
    const id = backendId;
    if (id == null || !view) return;
    const dir = view.remote.path;
    enqueue(...localMarked.map((entry) => transferAction(id, 'local', entry, dir)));
  }

  function download(): void {
    const id = backendId;
    if (id == null || !view) return;
    const dir = view.local.path;
    enqueue(...remoteMarked.map((entry) => transferAction(id, 'remote', entry, dir)));
  }

  function remove(): void {
    const id = backendId;
    if (id == null) return;
    enqueue(
      ...remoteMarked.map((entry) => () => {
        sftp.pushOp(id, { kind: 'delete', name: entry.name, refresh: 'remote' });
        void sftpDelete(id, entry.path).catch(onDispatchError(id));
      })
    );
  }

  function openPrompt(kind: 'mkdir' | 'rename', side: PaneSide = 'remote'): void {
    if (!view) return;
    if (kind === 'mkdir') {
      prompt = { kind, side, value: '' };
      return;
    }
    // The toolbar renames the single marked remote entry; the keyboard, whatever the
    // active pane's F-key commands would act on, when that is exactly one entry.
    const candidates =
      side === 'remote' && singleRemoteMark ? [singleRemoteMark] : targetEntries(view[side]);
    const entry = candidates.length === 1 ? candidates[0] : undefined;
    if (entry) prompt = { kind, side, value: entry.name, target: entry };
  }

  function submitPrompt(): void {
    const id = backendId;
    if (id == null || !view || !prompt) return;
    const value = prompt.value.trim();
    if (!value) return;
    const side = prompt.side;
    const path = resolveIn(side, view[side].path, value);
    if (prompt.kind === 'mkdir') {
      enqueue(() => {
        const op: PendingOp = { kind: 'mkdir', refresh: side };
        if (side === 'local') {
          runLocal(id, op, () => localMkdir(path));
        } else {
          sftp.pushOp(id, op);
          void sftpMkdir(id, path).catch(onDispatchError(id));
        }
      });
    } else if (prompt.target) {
      const from = prompt.target.path;
      if (from !== path) {
        enqueue(() => {
          const op: PendingOp = { kind: 'rename', refresh: side };
          if (side === 'local') {
            runLocal(id, op, () => localRename(from, path));
          } else {
            sftp.pushOp(id, op);
            void sftpRename(id, from, path).catch(onDispatchError(id));
          }
        });
      }
    }
    prompt = null;
  }

  function submitConfirm(): void {
    const id = backendId;
    if (id == null || !view || !confirm) return;
    const c = confirm;
    confirm = null;
    if (c.kind === 'delete') {
      enqueue(...c.items.map((entry) => deleteAction(id, c.side, entry)));
      return;
    }
    const dest = c.dest.trim();
    if (!dest) return;
    enqueue(
      ...c.items.flatMap((entry) =>
        c.kind === 'copy'
          ? [transferAction(id, c.from, entry, dest)]
          : [transferAction(id, c.from, entry, dest), deleteAction(id, c.from, entry, true)]
      )
    );
  }

  function describe(items: FileEntryDto[]): string {
    if (items.length === 1) return items[0].name;
    const folders = items.filter((e) => e.isDir).length;
    const files = items.length - folders;
    const parts = [];
    if (files) parts.push(files === 1 ? '1 file' : `${files} files`);
    if (folders) parts.push(folders === 1 ? '1 folder' : `${folders} folders`);
    return parts.join(' and ');
  }

  // Rows a PageUp/PageDown moves by.
  const PAGE = 10;

  /** Carry out a file-manager command on the active pane (keyboard or F-key bar). */
  function runCommand(command: FmCommand): void {
    const id = backendId;
    if (id == null || !view) return;
    const side = view.active;
    const pane = view[side];
    const entry = cursorEntry(pane);
    switch (command) {
      case 'up':
        return sftp.moveCursor(id, side, -1);
      case 'down':
        return sftp.moveCursor(id, side, 1);
      case 'pageUp':
        return sftp.moveCursor(id, side, -PAGE);
      case 'pageDown':
        return sftp.moveCursor(id, side, PAGE);
      case 'first':
        return sftp.moveCursor(id, side, 'first');
      case 'last':
        return sftp.moveCursor(id, side, 'last');
      case 'switch':
        return sftp.setActive(id, otherSide(side));
      case 'open':
        if (!entry) return;
        if (entry.isDir) navigate(side, entry);
        else void preview(side, entry);
        return;
      case 'parent': {
        const up = pane.entries.find((e) => e.name === '..');
        if (up) navigate(side, up);
        return;
      }
      case 'mark':
        if (entry && entry.name !== '..') sftp.toggleMark(id, side, entry.path);
        return sftp.moveCursor(id, side, 1);
      case 'markAll':
        return sftp.toggleMarkAll(id, side);
      case 'view':
        if (entry && !entry.isDir) void preview(side, entry);
        return;
      case 'refresh':
        if (side === 'local') void refreshLocal(pane.path);
        else refreshRemote(pane.path);
        return;
      case 'mkdir':
        return openPrompt('mkdir', side);
      case 'rename':
        return openPrompt('rename', side);
      case 'copy':
      case 'move': {
        const items = targetEntries(pane);
        if (items.length === 0) return;
        confirm = { kind: command, from: side, items, dest: view[otherSide(side)].path };
        return;
      }
      case 'delete': {
        const items = targetEntries(pane);
        if (items.length > 0) confirm = { kind: 'delete', side, items };
        return;
      }
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!active || !view || prompt || confirm || view.preview) return;
    if (get(dialogs).length > 0) return;
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t?.isContentEditable || /^(input|textarea|select)$/i.test(t?.tagName ?? '')) return;
    const onControl = !!t?.closest('button, a') && !t.closest('[data-fm-list]');
    const command = fileManagerKey(e, onControl);
    if (!command) return;
    // Also keeps the webview's own F5 (reload), F3 (find) and F7 (caret browsing) away.
    e.preventDefault();
    runCommand(command);
  }

  function closePreview(): void {
    if (backendId != null) sftp.clearPreview(backendId);
  }

  function transferPercent(done: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }

  const toolBtn =
    'inline-flex items-center gap-1 rounded-full border border-default px-2 py-1 text-xs ' +
    'font-medium text-muted transition hover:border-strong hover:bg-accent hover:text-accent-fg ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ' +
    'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ' +
    'disabled:hover:text-muted disabled:hover:border-default';
  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<svelte:window onkeydown={onKeydown} />

<!-- bg-surface fills behind the macOS traffic lights (no seam); the pt insets the
     panes below them. -->
<div class="absolute inset-0 flex flex-col bg-surface pt-[var(--titlebar-h)] {active ? '' : 'hidden'}">
  {#if openError}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
      <p class="font-medium">Could not open SFTP on {session.hostName}</p>
      <p class="max-w-md text-sm text-muted">{openError}</p>
    </div>
  {:else if !view}
    <div class="flex flex-1 items-center justify-center p-10 text-center">
      <p class="text-sm text-muted">Connecting to {session.hostName}…</p>
    </div>
  {:else}
    <div class="grid min-h-0 flex-1 grid-cols-2 divide-x divide-default">
      <SftpPane
        title="Local"
        pane={view.local}
        active={view.active === 'local'}
        onCursor={(i) => backendId != null && sftp.setCursor(backendId, 'local', i)}
        onNavigate={(e) => navigate('local', e)}
        onToggleMark={(p) => toggleMark('local', p)}
        onPreview={(e) => preview('local', e)}
      >
        {#snippet toolbar()}
          <button
            type="button"
            class={toolBtn}
            title="Upload marked entries to the remote directory"
            disabled={localMarked.length === 0}
            onclick={upload}
          >
            <Icon name="upload" size={13} />
            Upload
          </button>
          <button
            type="button"
            class={toolBtn}
            title="Refresh"
            aria-label="Refresh local"
            onclick={() => refreshLocal(view.local.path)}
          >
            <Icon name="refresh" size={13} />
          </button>
        {/snippet}
      </SftpPane>

      <SftpPane
        title={session.hostName}
        pane={view.remote}
        active={view.active === 'remote'}
        onCursor={(i) => backendId != null && sftp.setCursor(backendId, 'remote', i)}
        onNavigate={(e) => navigate('remote', e)}
        onToggleMark={(p) => toggleMark('remote', p)}
        onPreview={(e) => preview('remote', e)}
      >
        {#snippet toolbar()}
          <button
            type="button"
            class={toolBtn}
            title="Download marked entries to the local directory"
            disabled={remoteMarked.length === 0}
            onclick={download}
          >
            <Icon name="download" size={13} />
            Download
          </button>
          <button
            type="button"
            class={toolBtn}
            title="New folder"
            onclick={() => openPrompt('mkdir', 'remote')}
          >
            <Icon name="plus" size={13} />
            Folder
          </button>
          <button
            type="button"
            class={toolBtn}
            title="Rename the marked entry"
            disabled={!singleRemoteMark}
            onclick={() => openPrompt('rename', 'remote')}
          >
            <Icon name="edit" size={13} />
          </button>
          <button
            type="button"
            class={toolBtn}
            title="Delete marked entries"
            aria-label="Delete marked entries"
            disabled={remoteMarked.length === 0}
            onclick={remove}
          >
            <Icon name="trash" size={13} />
          </button>
          <button
            type="button"
            class={toolBtn}
            title="Refresh"
            aria-label="Refresh remote"
            onclick={() => refreshRemote(view.remote.path)}
          >
            <Icon name="refresh" size={13} />
          </button>
        {/snippet}
      </SftpPane>
    </div>

    <nav
      class="flex shrink-0 flex-wrap items-center gap-1 border-t border-default px-3 py-1.5"
      aria-label="function keys"
    >
      {#each FKEY_BAR as fkey (fkey.key)}
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted transition
            hover:bg-surface-inset hover:text-fg focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-focus"
          title="{fkey.label} ({fkey.key})"
          onmousedown={(e) => e.preventDefault()}
          onclick={() => runCommand(fkey.command)}
        >
          <kbd class="font-mono text-[11px] font-semibold text-fg">{fkey.key}</kbd>
          {fkey.label}
        </button>
      {/each}
      <span class="ml-auto hidden text-[11px] text-faint lg:inline">
        Tab switch pane · Ins/Space mark · Ctrl+A mark all · Ctrl+R refresh
      </span>
    </nav>

    {#if transfer}
      <div class="shrink-0 border-t border-default px-4 py-2.5" aria-label="transfer progress">
        <div class="flex items-center justify-between gap-3 text-xs text-muted">
          <span class="min-w-0 truncate">
            {transfer.kind === 'upload' ? 'Uploading' : 'Downloading'}
            <span class="font-mono text-fg">{transfer.name}</span>
          </span>
          <span class="shrink-0 tabular-nums">
            {formatBytes(transfer.done)}{transfer.total > 0
              ? ` / ${formatBytes(transfer.total)}`
              : ''}
          </span>
        </div>
        <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-inset">
          <div
            class="h-full rounded-full bg-accent transition-[width]"
            style="width: {transferPercent(transfer.done, transfer.total)}%"
          ></div>
        </div>
      </div>
    {:else if view.error}
      <div class="shrink-0 border-t border-default px-4 py-2 text-xs text-status-crit">
        {view.error}
      </div>
    {/if}
  {/if}
</div>

{#if active && prompt}
  <Modal label={prompt.kind === 'mkdir' ? 'New folder' : 'Rename'} onClose={() => (prompt = null)}>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        submitPrompt();
      }}
    >
      <header class="border-b border-default px-5 py-3.5">
        <h2 class="text-sm font-semibold">
          {prompt.kind === 'mkdir' ? 'New folder' : `Rename ${prompt.target?.name ?? ''}`}
        </h2>
      </header>
      <div class="px-5 py-4">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          bind:value={prompt.value}
          class={field}
          placeholder={prompt.kind === 'mkdir' ? 'Folder name' : 'New name'}
          aria-label={prompt.kind === 'mkdir' ? 'Folder name' : 'New name'}
        />
      </div>
      <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
        <button
          type="button"
          class="rounded-full px-4 py-2 text-sm text-muted transition hover:bg-surface-inset hover:text-fg"
          onclick={() => (prompt = null)}
        >
          Cancel
        </button>
        <button
          type="submit"
          class="rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-50"
          disabled={!prompt.value.trim()}
        >
          {prompt.kind === 'mkdir' ? 'Create' : 'Rename'}
        </button>
      </footer>
    </form>
  </Modal>
{/if}

{#if active && confirm}
  <Modal
    label={confirm.kind === 'copy' ? 'Copy' : confirm.kind === 'move' ? 'Move' : 'Delete'}
    onClose={() => (confirm = null)}
  >
    <form
      onsubmit={(e) => {
        e.preventDefault();
        submitConfirm();
      }}
    >
      <header class="border-b border-default px-5 py-3.5">
        <h2 class="text-sm font-semibold">
          {#if confirm.kind === 'delete'}
            Delete {describe(confirm.items)}?
          {:else}
            {confirm.kind === 'copy' ? 'Copy' : 'Move'} {describe(confirm.items)}
            {confirm.from === 'local' ? `to ${session.hostName}` : 'to this computer'}
          {/if}
        </h2>
      </header>
      <div class="px-5 py-4">
        {#if confirm.kind === 'delete'}
          <p class="text-sm text-muted">
            {confirm.side === 'local' ? 'From this computer' : `From ${session.hostName}`}.
            {#if confirm.items.some((e) => e.isDir)}
              Folders are deleted with everything in them.
            {/if}
            This cannot be undone.
          </p>
          <!-- svelte-ignore a11y_autofocus -->
          <button type="submit" class="sr-only" autofocus>Delete</button>
        {:else}
          <label class="block text-xs text-muted" for="fm-dest">Into folder</label>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            id="fm-dest"
            autofocus
            bind:value={confirm.dest}
            class="{field} mt-1.5 font-mono"
            aria-label="Destination folder"
          />
          {#if confirm.kind === 'move'}
            <p class="mt-2 text-xs text-faint">
              Each source is deleted once its copy has finished.
            </p>
          {/if}
        {/if}
      </div>
      <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
        <button
          type="button"
          class="rounded-full px-4 py-2 text-sm text-muted transition hover:bg-surface-inset hover:text-fg"
          onclick={() => (confirm = null)}
        >
          Cancel
        </button>
        <button
          type="submit"
          class="rounded-full px-5 py-2 text-sm font-medium transition hover:opacity-90 disabled:opacity-50
            {confirm.kind === 'delete' ? 'bg-status-crit text-accent-fg' : 'bg-accent text-accent-fg'}"
          disabled={confirm.kind !== 'delete' && !confirm.dest.trim()}
        >
          {confirm.kind === 'copy' ? 'Copy' : confirm.kind === 'move' ? 'Move' : 'Delete'}
        </button>
      </footer>
    </form>
  </Modal>
{/if}

{#if active && view?.preview}
  <Modal label="File preview" onClose={closePreview}>
    <header class="border-b border-default px-5 py-3.5">
      <h2 class="truncate font-mono text-xs text-muted" title={view.preview.path}>
        {view.preview.path}
      </h2>
    </header>
    <div class="min-h-0 flex-1 overflow-auto px-5 py-4">
      {#if view.preview.content.length === 0}
        <p class="text-sm text-faint">Empty file.</p>
      {:else}
        <pre class="select-text whitespace-pre-wrap break-words font-mono text-xs text-fg">{view.preview
            .content}</pre>
      {/if}
    </div>
    <footer class="flex justify-end border-t border-default px-5 py-3">
      <button
        type="button"
        class="rounded-full px-4 py-2 text-sm text-muted transition hover:bg-surface-inset hover:text-fg"
        onclick={closePreview}
      >
        Close
      </button>
    </footer>
  </Modal>
{/if}
