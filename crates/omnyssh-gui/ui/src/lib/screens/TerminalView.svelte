<script lang="ts">
  // A live terminal tab (tech-gui.md §3.1). One instance per terminal session, kept
  // mounted for the session's whole life — hidden, not destroyed, when another entity
  // is active — so scrollback and the byte stream survive tab switches. Raw output
  // arrives on a per-session channel (§3.3/§3.6); keystrokes/resizes go back over the
  // terminal commands. Subscribes to the theme store and re-themes live (§5.1).
  import '@xterm/xterm/css/xterm.css';
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import type { Terminal } from '@xterm/xterm';
  import type { FitAddon } from '@xterm/addon-fit';
  import { Channel } from '@tauri-apps/api/core';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { downloadDir, join as joinLocalPath } from '@tauri-apps/api/path';
  import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
  import Modal from '$lib/components/Modal.svelte';
  import { Icon } from '$lib/theme';
  import { theme } from '$lib/stores/theme';
  import { xtermTheme } from '$lib/theme/terminalTheme';
  import { sessions, type Session } from '$lib/stores/sessions';
  import { closeSession } from '$lib/stores/navigation';
  import { terminalDidExit } from '$lib/ipc/router';
  import { lastError } from '$lib/stores/notifications';
  import { dialogs } from '$lib/stores/dialogs';
  import {
    terminalOpen,
    terminalWrite,
    terminalResize,
    terminalClose,
    terminalPaste
  } from '$lib/ipc/commands';
  import { shouldFadeTop } from './terminalFade';
  import { chunkBytes, fileShortcut, isCopyShortcut, layoutFallback } from './terminalInput';
  import {
    PWD_OSC,
    baseName,
    parseOsc7,
    parsePwdAnswer,
    parseTitleCwd,
    pwdProbeCommand,
    resolveRemote,
    toSftpDir
  } from './terminalCwd';
  import { downloadTo, uploadToDir, type UploadStatus } from './terminalUpload';
  import { formatBytes } from '$lib/stores/sftp';
  import { isMac } from '$lib/platform';
  import type { TerminalBytes } from '$lib/bindings';

  let { session, active }: { session: Session; active: boolean } = $props();

  // The Nerd Font families come after the generic `monospace`, not merely after the
  // named system ones: the named list is macOS/Windows-only, so on a Linux desktop a
  // patched font ahead of the generic would become the terminal's Latin face and size
  // its cell from itself. Per-character fallback continues past a generic family, so the
  // Private Use Area glyphs (starship, powerlevel10k, eza --icons) still reach the tail.
  // Within the tail, the single-width variants come first — Nerd Fonts v3 ships icons at
  // double width in the bare family and one cell wide in its `Mono` twin.
  const MONO =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace, ' +
    '"Symbols Nerd Font Mono", "Symbols Nerd Font", "MesloLGS NF", ' +
    '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", ' +
    '"Hack Nerd Font Mono", "Hack Nerd Font", ' +
    '"FiraCode Nerd Font Mono", "FiraCode Nerd Font"';
  // One encoder for the keystroke hot path instead of one per input event.
  const ENCODER = new TextEncoder();

  // A large paste arrives as one onData; sending it as a single number[] would freeze
  // the UI thread (§9). Split into bounded chunks and await each so paint yields between
  // them; a serialization chain keeps all input strictly in order across events.
  let writeChain: Promise<void> = Promise.resolve();
  function sendInput(bytes: Uint8Array): void {
    if (termId == null || bytes.length === 0) return;
    writeChain = writeChain.then(async () => {
      for (const chunk of chunkBytes(bytes)) {
        if (destroyed || termId == null) return;
        try {
          await terminalWrite(termId, Array.from(chunk));
        } catch {
          // Stop this input on a write failure rather than sending a gapped stream.
          return;
        }
      }
    });
  }

  let root: HTMLDivElement;
  let container: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let termId: number | undefined;
  let destroyed = false;
  let connected = false;
  let ready = $state(false);
  let themeUnsub: (() => void) | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let stopDragDrop: (() => void) | undefined;

  // The shell's directory as it last reported it (see terminalCwd): OSC 7 when the
  // shell emits it, else the `user@host: dir` window title. Unknown means the drop
  // asks the shell (`probeDir`), and home if it can't.
  let titleDir = $state<string | undefined>(undefined);
  let osc7Dir = $state<string | undefined>(undefined);
  const shellDir = $derived(osc7Dir ?? titleDir);

  // How long a pwd probe waits for the shell's answer before settling for home.
  const PROBE_TIMEOUT_MS = 2000;
  let pwdWaiter: ((dir: string | undefined) => void) | undefined;

  /** Ask the shell for its directory by typing the probe line (it shows in the
   *  terminal). Skipped while a full-screen program (vim, less, htop) holds the
   *  alternate screen — the line would land in it rather than at a prompt. */
  function probeDir(): Promise<string | undefined> {
    if (!term || termId == null || term.buffer.active.type === 'alternate') {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(undefined), PROBE_TIMEOUT_MS);
      function settle(dir: string | undefined): void {
        clearTimeout(timer);
        if (pwdWaiter === settle) pwdWaiter = undefined;
        resolve(dir);
      }
      pwdWaiter = settle;
      sendInput(ENCODER.encode(pwdProbeCommand()));
    });
  }

  // Files dragged over / dropped onto this terminal go to `shellDir` over SFTP.
  let dragOver = $state(false);
  let upload = $state<UploadStatus | null>(null);
  let notice = $state<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let uploadChain: Promise<void> = Promise.resolve();

  /** Whether a drag-drop position (physical px, webview-relative) is over this tab. */
  function overTerminal(position: { x: number; y: number }): boolean {
    if (!active || !root) return false;
    const scale = window.devicePixelRatio || 1;
    const x = position.x / scale;
    const y = position.y / scale;
    const r = root.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function showNotice(message: string): void {
    if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    notice = message;
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined;
      notice = null;
    }, 4000);
  }

  /** The Upload command (button or Ctrl+Shift+U): pick local files, send them to the
   *  shell's directory exactly as a drop would. */
  async function pickUpload(): Promise<void> {
    if (termId == null) return;
    try {
      const picked = await openFileDialog({ multiple: true, title: 'Upload to the shell’s folder' });
      const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
      if (paths.length > 0 && !destroyed) uploadDropped(paths);
    } catch (err) {
      lastError.set(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The Download command's prompt: a name (or path) relative to the shell's directory.
  let downloadPrompt = $state<{ value: string } | null>(null);

  /** The Download command (button or Ctrl+Shift+D). A one-line selection — a name
   *  picked out of `ls` — is offered as the file to fetch. */
  function openDownload(): void {
    if (termId == null) return;
    const selected = term?.hasSelection() ? term.getSelection().trim() : '';
    downloadPrompt = { value: selected.includes('\n') ? '' : selected };
  }

  function submitDownload(): void {
    const input = downloadPrompt?.value.trim();
    downloadPrompt = null;
    if (!input) return;
    const known = shellDir;
    uploadChain = uploadChain.then(async () => {
      if (destroyed) return;
      try {
        const dir = known ?? (await probeDir()) ?? '~';
        const remote = resolveRemote(toSftpDir(dir), input);
        if (!remote || destroyed) return;
        const name = baseName(remote) ?? 'download';
        let defaultPath: string | undefined;
        try {
          defaultPath = await joinLocalPath(await downloadDir(), name);
        } catch {
          defaultPath = name;
        }
        const local = await saveFileDialog({ title: `Save ${name}`, defaultPath });
        if (!local || destroyed) return;
        const result = await downloadTo(session.hostName, remote, local, (s) => {
          if (!destroyed) upload = s;
        });
        if (result.failures.length > 0) {
          lastError.set(`Download of ${remote} failed — ${result.failures.join('; ')}`);
        } else {
          showNotice(`Downloaded ${name} to ${local}`);
        }
      } catch (err) {
        lastError.set(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        upload = null;
      }
    });
  }

  /** Queue an upload of `paths` into the shell's current directory. Drops run one
   *  after another, so the progress pill always describes a single batch. */
  function uploadDropped(paths: string[]): void {
    const known = shellDir;
    uploadChain = uploadChain.then(async () => {
      if (destroyed) return;
      try {
        const dir = known ?? (await probeDir()) ?? '~';
        if (destroyed) return;
        const result = await uploadToDir(session.hostName, toSftpDir(dir), paths, (s) => {
          if (!destroyed) upload = s;
        });
        if (result.failures.length > 0) {
          lastError.set(`Upload to ${dir} failed — ${result.failures.join('; ')}`);
        }
        if (result.uploaded > 0) {
          const what = result.uploaded === 1 ? '1 file' : `${result.uploaded} files`;
          showNotice(`Uploaded ${what} to ${dir}`);
        }
      } catch (err) {
        lastError.set(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        upload = null;
      }
    });
  }
  let fitScheduled = false;
  // The top-edge fade dissolves scrolled output into the top edge, but never the live
  // prompt: after `clear`/Ctrl+L the cursor homes to the top, so the fade must lift
  // there (see terminalFade). Recomputed after every write too, since those resets
  // move the viewport without firing onScroll.
  let scrolled = $state(false);
  function syncScrolled(): void {
    const buf = term?.buffer.active;
    scrolled = !!buf && shouldFadeTop(buf.viewportY, buf.baseY, buf.cursorY);
  }

  /** Fit the terminal to its container and tell the backend, but only while visible —
   *  a hidden (display:none) container measures 0, so it refits when shown instead. */
  function safeFit(): void {
    if (!term || !fitAddon || !active) return;
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    if (termId != null) void terminalResize(termId, term.cols, term.rows).catch(() => {});
  }

  function scheduleFit(): void {
    if (fitScheduled) return;
    fitScheduled = true;
    requestAnimationFrame(() => {
      fitScheduled = false;
      safeFit();
    });
  }

  onMount(() => {
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit')
      ]);
      if (destroyed) return;

      term = new Terminal({
        fontFamily: MONO,
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);
      term.onScroll(syncScrolled);
      // Track the shell's directory for drag-and-drop uploads. Neither handler
      // consumes the sequence, so xterm's own title handling still runs.
      term.parser.registerOscHandler(7, (data) => {
        const dir = parseOsc7(data);
        if (dir) osc7Dir = dir;
        return false;
      });
      // The pwd probe's answer: consumed, so it never reaches the screen.
      term.parser.registerOscHandler(PWD_OSC, (data) => {
        pwdWaiter?.(parsePwdAnswer(data));
        return true;
      });
      term.onTitleChange((title) => {
        // A title that names no directory (a running program's) keeps the last one.
        const dir = parseTitleCwd(title);
        if (dir) titleDir = dir;
      });
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === 'leave') {
            dragOver = false;
          } else if (p.type === 'drop') {
            dragOver = false;
            if (p.paths.length > 0 && termId != null && overTerminal(p.position)) {
              uploadDropped(p.paths);
            }
          } else {
            dragOver = termId != null && overTerminal(p.position);
          }
        })
        .then((unlisten) => {
          if (destroyed) unlisten();
          else stopDragDrop = unlisten;
        })
        .catch(() => {});

      // The #1 theme-regression guard (§5.1): push the matching xterm theme to this
      // terminal — including already-open ones — whenever the store flips. Its
      // synchronous first call (pre-paint) also sets the initial theme.
      themeUnsub = theme.subscribe((t) => {
        if (term) term.options.theme = xtermTheme(t);
      });

      // Route raw output into xterm. The channel is typed `number[]`, but the raw path
      // actually delivers an `ArrayBuffer` (§3.3); `Uint8Array` wraps either.
      const channel = new Channel<TerminalBytes>();
      channel.onmessage = (msg) => {
        if (!term) return;
        if (!connected) {
          connected = true;
          sessions.setStatus(session.id, 'connected');
        }
        term.write(new Uint8Array(msg as unknown as ArrayBuffer), syncScrolled);
      };

      // Fit before opening so the remote PTY starts at the visible size.
      safeFit();
      const id = await terminalOpen(session.hostName, term.cols || 80, term.rows || 24, channel);
      if (destroyed) {
        void terminalClose(id).catch(() => {});
        return;
      }
      termId = id;
      sessions.setTermId(session.id, id);
      // The remote may have already exited before this id was recorded (fast-fail
      // connect race): terminal-exited couldn't match the tab, so close it now.
      if (terminalDidExit(id)) {
        closeSession(session.id);
        return;
      }

      // Copy takes Ctrl+Shift+C whether or not anything is selected, so the chord never
      // reaches the shell. Returning false only keeps xterm out of it; the default is
      // ours to stop. The write happens inside the keydown, which WebKit requires.
      term.attachCustomKeyEventHandler((e) => {
        const fileCommand = fileShortcut(e, isMac);
        if (fileCommand) {
          e.preventDefault();
          if (fileCommand === 'upload') void pickUpload();
          else openDownload();
          return false;
        }
        if (isCopyShortcut(e, isMac)) {
          e.preventDefault();
          if (term?.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection()).catch((err) => {
              lastError.set(`Copy failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          return false;
        }
        // Under a non-Latin layout WebKitGTK names no key; the physical one stands in.
        const fallback = layoutFallback(e);
        if (!fallback) return true;
        // As xterm does with a key it handles: nothing else acts on it.
        e.preventDefault();
        e.stopPropagation();
        if (fallback.kind === 'control') {
          term?.input(fallback.data);
        } else {
          terminalPaste().catch((err) => {
            lastError.set(`Paste failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        return false;
      });
      // Text keystrokes/paste are UTF-8; onBinary carries raw 8-bit sequences
      // (e.g. legacy mouse reporting) that must go byte-for-byte, not re-encoded.
      term.onData((data) => sendInput(ENCODER.encode(data)));
      term.onBinary((data) => sendInput(Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff)));

      resizeObserver = new ResizeObserver(() => scheduleFit());
      resizeObserver.observe(container);

      ready = true;
      if (active && get(dialogs).length === 0) term.focus();
    })().catch((err) => {
      // `terminal_open` itself failed (e.g. the session could not be spawned): no
      // PtyExited follows, so mark the tab failed here instead of leaving it hung.
      lastError.set(err instanceof Error ? err.message : String(err));
      sessions.setStatus(session.id, 'failed');
    });
  });

  onDestroy(() => {
    destroyed = true;
    themeUnsub?.();
    resizeObserver?.disconnect();
    stopDragDrop?.();
    if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    // Idempotent: a remote-exit teardown already dropped this id backend-side (§3.4).
    if (termId != null) void terminalClose(termId).catch(() => {});
    term?.dispose();
    // Null it so a byte still in flight (destroyed-before-open race) can't write to
    // a disposed terminal — the channel callback's `if (!term)` guard then bails.
    term = undefined;
  });

  // Becoming visible: a hidden container measured 0, so refit and take focus.
  // An open dialog keeps the keyboard (keystrokes meant for a key passphrase must
  // never reach the shell); the terminal takes it back once the last one closes.
  $effect(() => {
    if (active && ready) {
      const free = $dialogs.length === 0;
      requestAnimationFrame(() => {
        safeFit();
        if (free) term?.focus();
        syncScrolled();
      });
    }
  });
</script>

<!-- bg-surface fills behind the macOS traffic lights (no seam). Text selection stays
     disabled app-wide (app.css); the terminal is the one selectable surface, handled
     by xterm's own selection (not CSS). -->
<div bind:this={root} class="group absolute inset-0 overflow-hidden bg-surface {active ? '' : 'hidden'}">
  <!-- Inset via this wrapper, not the xterm host: padding on the element xterm mounts
       into makes FitAddon over-size, sliding the last row under the status bar. The top
       inset clears the macOS traffic-light strip; the bottom gap clears the footer. -->
  <div class="h-full w-full" style="padding: max(var(--titlebar-h), 0.75rem) 0.5rem 1rem;">
    <div bind:this={container} class="h-full w-full" class:term-fade={scrolled}></div>
  </div>

  {#if ready}
    <!-- Faint while the pointer is over the terminal, solid over the buttons themselves:
         discoverable without sitting on top of the output. A click leaves the keyboard
         with the shell. -->
    <div
      class="absolute right-4 z-10 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-60 hover:!opacity-100"
      style="top: max(var(--titlebar-h), 0.75rem);"
      role="toolbar"
      aria-label="file transfer"
    >
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-full border border-default bg-surface-raised px-2 py-1 text-xs text-muted shadow transition hover:text-fg"
        title="Upload files to the shell’s folder ({isMac ? '⌘⇧U' : 'Ctrl+Shift+U'})"
        onmousedown={(e) => e.preventDefault()}
        onclick={() => void pickUpload()}
      >
        <Icon name="upload" size={13} />
        Upload
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-full border border-default bg-surface-raised px-2 py-1 text-xs text-muted shadow transition hover:text-fg"
        title="Download a file from the shell’s folder ({isMac ? '⌘⇧D' : 'Ctrl+Shift+D'})"
        onmousedown={(e) => e.preventDefault()}
        onclick={openDownload}
      >
        <Icon name="download" size={13} />
        Download
      </button>
    </div>
  {/if}

  {#if dragOver}
    <div
      class="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10"
      style="top: max(var(--titlebar-h), 0.75rem);"
    >
      <p class="rounded-md bg-surface-raised px-3 py-1.5 text-sm text-muted shadow">
        Drop to upload to
        {#if shellDir}
          <span class="font-mono text-fg">{shellDir}</span>
        {:else}
          the shell's current folder
        {/if}
      </p>
    </div>
  {/if}

  {#if upload || notice}
    <div
      class="pointer-events-none absolute bottom-6 right-6 z-10 w-72 rounded-md bg-surface-raised px-3 py-2 text-xs text-muted shadow"
      role="status"
      aria-label="upload progress"
    >
      {#if upload}
        <div class="flex items-center justify-between gap-3">
          <span class="min-w-0 truncate">
            {upload.kind === 'download' ? 'Downloading' : 'Uploading'}
            <span class="font-mono text-fg">{upload.name}</span>
            {#if upload.count > 1}({upload.index}/{upload.count}){/if}
          </span>
          {#if upload.total > 0}
            <span class="shrink-0 tabular-nums">
              {formatBytes(upload.done)} / {formatBytes(upload.total)}
            </span>
          {/if}
        </div>
        <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-inset">
          <div
            class="h-full rounded-full bg-accent transition-[width]"
            style="width: {upload.total > 0
              ? Math.min(100, Math.round((upload.done / upload.total) * 100))
              : 0}%"
          ></div>
        </div>
      {:else}
        <span class="block truncate">{notice}</span>
      {/if}
    </div>
  {/if}
</div>

{#if active && downloadPrompt}
  <Modal label="Download" onClose={() => (downloadPrompt = null)}>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        submitDownload();
      }}
    >
      <header class="border-b border-default px-5 py-3.5">
        <h2 class="text-sm font-semibold">Download from {session.hostName}</h2>
      </header>
      <div class="px-5 py-4">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          bind:value={downloadPrompt.value}
          class="w-full rounded-lg bg-surface-inset px-3 py-2 font-mono text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-focus"
          placeholder="file name or path"
          aria-label="Remote file"
        />
        <p class="mt-2 text-xs text-faint">
          Relative to
          {#if shellDir}<span class="font-mono">{shellDir}</span>{:else}the shell’s current folder{/if}.
          Folders download whole.
        </p>
      </div>
      <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
        <button
          type="button"
          class="rounded-full px-4 py-2 text-sm text-muted transition hover:bg-surface-inset hover:text-fg"
          onclick={() => (downloadPrompt = null)}
        >
          Cancel
        </button>
        <button
          type="submit"
          class="rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-50"
          disabled={!downloadPrompt.value.trim()}
        >
          Download
        </button>
      </footer>
    </form>
  </Modal>
{/if}

<style>
  /* Scrolled output dissolves into the top edge instead of hard-clipping (on only while
     scrolled, so the first line stays crisp). black/transparent are mask alphas. */
  .term-fade {
    -webkit-mask-image: linear-gradient(to bottom, transparent, black 2.25rem);
    mask-image: linear-gradient(to bottom, transparent, black 2.25rem);
  }
</style>
