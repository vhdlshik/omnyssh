<script lang="ts">
  // One side of the dual-pane SFTP browser (tech-gui.md §3.2): a current-path header
  // with a parent-supplied toolbar, then the entry list. Clicking a directory (or the
  // `..` row) navigates; clicking a file previews; the leading checkbox marks it for a
  // batch transfer/delete. Semantic tokens only — no colour literals (§5.1).
  // The keyboard cursor (Total Commander style) shows only in the active pane, and is
  // kept scrolled into view. Rows never take focus on click, so the view's keys keep
  // working after the mouse was used.
  import type { Snippet } from 'svelte';
  import { Icon } from '$lib/theme';
  import type { FileEntryDto } from '$lib/bindings';
  import { formatBytes, type Pane } from '$lib/stores/sftp';

  let {
    title,
    pane,
    active = false,
    onNavigate,
    onToggleMark,
    onPreview,
    onCursor,
    toolbar
  }: {
    title: string;
    pane: Pane;
    /** Whether this pane has the keyboard (draws the cursor row). */
    active?: boolean;
    onNavigate: (entry: FileEntryDto) => void;
    onToggleMark: (path: string) => void;
    onPreview: (entry: FileEntryDto) => void;
    /** A row was clicked: put the cursor on it and make this pane active. */
    onCursor?: (index: number) => void;
    toolbar?: Snippet;
  } = $props();

  let rows: HTMLLIElement[] = $state([]);

  // Keep the cursor row on screen as the keyboard moves it.
  $effect(() => {
    if (active) rows[pane.cursor]?.scrollIntoView?.({ block: 'nearest' });
  });

  /** Keep focus where it is, so a click never parks it on a row button. */
  function keepFocus(e: MouseEvent): void {
    e.preventDefault();
  }

  const rowBase =
    'flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<section aria-label={title} class="flex min-h-0 min-w-0 flex-1 flex-col">
  <header class="shrink-0 border-b px-3 py-2.5 {active ? 'border-accent' : 'border-default'}">
    <div class="flex items-center justify-between gap-2">
      <h2
        title={title}
        class="truncate text-xs font-semibold uppercase tracking-[0.14em] {active
          ? 'text-fg'
          : 'text-muted'}"
      >
        {title}
      </h2>
      <div class="flex shrink-0 items-center gap-1">
        {@render toolbar?.()}
      </div>
    </div>
    <div class="mt-1 truncate font-mono text-xs text-faint" title={pane.path}>
      {pane.path || '—'}
    </div>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5" data-fm-list>
    {#if pane.error}
      <p class="px-2 py-6 text-center text-sm text-status-crit">{pane.error}</p>
    {:else if pane.loading && pane.entries.length === 0}
      <p class="px-2 py-6 text-center text-sm text-faint">Loading…</p>
    {:else if pane.entries.length === 0}
      <p class="px-2 py-6 text-center text-sm text-faint">Empty directory</p>
    {:else}
      <ul class="space-y-0.5">
        {#each pane.entries as entry, i (i)}
          {@const isParent = entry.name === '..'}
          {@const marked = pane.marked.has(entry.path)}
          {@const atCursor = active && i === pane.cursor}
          <li
            bind:this={rows[i]}
            class="flex items-center gap-1.5 rounded {atCursor ? 'bg-surface-inset ring-1 ring-accent' : ''}"
            aria-current={atCursor ? 'true' : undefined}
          >
            {#if isParent}
              <span class="h-4 w-4 shrink-0"></span>
            {:else}
              <button
                type="button"
                role="checkbox"
                aria-checked={marked}
                aria-label="Mark {entry.name}"
                class="grid h-4 w-4 shrink-0 place-items-center rounded border transition
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus
                  {marked ? 'border-accent bg-accent text-accent-fg' : 'border-strong text-transparent'}"
                onmousedown={keepFocus}
                onclick={() => {
                  onCursor?.(i);
                  onToggleMark(entry.path);
                }}
              >
                {#if marked}<Icon name="check" size={11} />{/if}
              </button>
            {/if}
            <button
              type="button"
              class="{rowBase} hover:bg-surface-inset hover:text-fg {marked
                ? 'text-accent'
                : 'text-muted'}"
              title={entry.name}
              onmousedown={keepFocus}
              onclick={() => {
                onCursor?.(i);
                if (entry.isDir) onNavigate(entry);
                else onPreview(entry);
              }}
            >
              <Icon name={entry.isDir ? 'folder' : 'file'} size={15} />
              <span class="min-w-0 flex-1 truncate {entry.isDir ? 'font-medium text-fg' : ''}">
                {entry.name}
              </span>
              {#if !entry.isDir}
                <span class="shrink-0 tabular-nums text-xs text-faint">{formatBytes(entry.size)}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
