<script lang="ts">
  // Picker for a terminal on this machine: one of the shells the backend detected, or a
  // serial port at a chosen speed. It hands back the target and the tab label; the
  // caller spawns the session. Semantic tokens only (§5.1).
  import { onMount } from 'svelte';
  import Modal from '$lib/components/Modal.svelte';
  import Select from '$lib/components/Select.svelte';
  import { Button, Icon } from '$lib/theme';
  import type { LocalTargetDto, LocalTargetsDto } from '$lib/bindings';
  import { localTargets } from '$lib/ipc/commands';
  import { isWindows } from '$lib/platform';
  import { localLabel, rememberBaud, rememberedBaud } from './localPicker';

  let {
    onPick,
    onCancel
  }: { onPick: (target: LocalTargetDto, label: string) => void; onCancel: () => void } =
    $props();

  let targets = $state<LocalTargetsDto | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let baud = $state('115200');
  let otherPort = $state('');

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      targets = await localTargets();
      baud = String(rememberedBaud(targets.baudRates));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function openSerial(port: string): void {
    const target: LocalTargetDto = { kind: 'serial', port: port.trim(), baud: Number(baud) };
    if (!target.port) return;
    rememberBaud(target.baud);
    onPick(target, localLabel(target));
  }

  const row =
    'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ' +
    'hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<Modal label="Local terminal" onClose={onCancel}>
  <header class="flex items-center justify-between border-b border-default px-5 py-3.5">
    <h2 class="text-sm font-semibold">Local terminal</h2>
    <Button variant="icon" title="Look again" onclick={load} disabled={loading}>
      <Icon name="refresh" size={16} />
    </Button>
  </header>

  <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4">
    {#if error}
      <p class="px-2 text-sm text-status-crit">{error}</p>
    {:else if !targets}
      <p class="px-2 text-sm text-muted">Looking for shells and serial ports…</p>
    {:else}
      <section>
        <h3 class="mb-1.5 px-3 text-xs font-semibold uppercase tracking-wide text-faint">Shells</h3>
        {#if targets.shells.length === 0}
          <p class="px-3 text-sm text-muted">No shells found.</p>
        {/if}
        <ul class="space-y-0.5">
          {#each targets.shells as shell (shell.id)}
            <li>
              <button
                type="button"
                class={row}
                onclick={() => onPick({ kind: 'shell', id: shell.id }, shell.name)}
              >
                <Icon name="monitor" size={16} />
                <span class="shrink-0 text-fg">{shell.name}</span>
                <span class="min-w-0 flex-1 truncate text-right font-mono text-xs text-faint">
                  {shell.detail}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </section>

      <section>
        <div class="mb-1.5 flex items-center justify-between gap-3 px-3">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-faint">Serial ports</h3>
          <label class="flex items-center gap-2 text-xs text-muted">
            Speed
            <span class="w-32">
              <Select bind:value={baud} class="{field} py-1 tabular-nums">
                {#each targets.baudRates as rate (rate)}
                  <option value={String(rate)}>{rate}</option>
                {/each}
              </Select>
            </span>
          </label>
        </div>
        {#if targets.serialPorts.length === 0}
          <p class="px-3 text-sm text-muted">No serial ports found.</p>
        {/if}
        <ul class="space-y-0.5">
          {#each targets.serialPorts as port (port.name)}
            <li>
              <button type="button" class={row} onclick={() => openSerial(port.name)}>
                <Icon name="plug" size={16} />
                <span class="shrink-0 font-mono text-fg">{port.name}</span>
                <span class="min-w-0 flex-1 truncate text-right text-xs text-faint">
                  {port.detail}
                </span>
              </button>
            </li>
          {/each}
        </ul>
        <form
          class="mt-2 flex gap-2 px-3"
          onsubmit={(e) => {
            e.preventDefault();
            openSerial(otherPort);
          }}
        >
          <input
            bind:value={otherPort}
            class="{field} font-mono"
            placeholder={isWindows ? 'COM7' : '/dev/ttyS0'}
            aria-label="Another serial port"
          />
          <Button variant="ghost" type="submit" disabled={!otherPort.trim()}>Open</Button>
        </form>
      </section>
    {/if}
  </div>

  <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
    <Button variant="ghost" onclick={onCancel}>Cancel</Button>
  </footer>
</Modal>
