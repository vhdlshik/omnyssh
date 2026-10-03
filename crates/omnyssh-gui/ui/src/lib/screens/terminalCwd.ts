// Where a terminal's shell currently is, for drag-and-drop uploads. SSH carries no
// "current directory" of its own, so the shell has to report it: OSC 7
// (`ESC ] 7 ; file://host/path BEL`, emitted by vte.sh, zsh/fish integrations, starship…)
// is exact; failing that, the stock Debian/Ubuntu/Fedora bash prompts put
// `user@host: ~/dir` in the window title, which is good enough when it parses. A shell
// that reports neither is asked outright: `pwdProbeCommand` is typed into it, and its
// answer comes back on the private `PWD_OSC` sequence, invisible in the output.

/** The private OSC number the pwd probe answers on ("OmnY" on a phone keypad). */
export const PWD_OSC = 6669;

/** The line typed into the shell to make it report `$PWD` on `PWD_OSC`. Ctrl+U first
 *  clears whatever was half-typed at the prompt (readline keeps it for Ctrl+Y), and
 *  the leading space keeps the line out of bash/zsh history where they ignore such
 *  lines. `printf` and `$PWD` read the same in sh, bash, zsh and fish. */
export function pwdProbeCommand(): string {
  return `\x15 printf '\\033]${PWD_OSC};%s\\007' "$PWD"\r`;
}

/** The directory a probe answer carries — only an absolute path is trusted. */
export function parsePwdAnswer(data: string): string | undefined {
  const dir = data.replace(/[\r\n]+$/, '');
  return dir.startsWith('/') ? dir : undefined;
}

/** The path an OSC 7 payload (`file://host/path`) reports, or `undefined`. */
export function parseOsc7(data: string): string | undefined {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim());
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

/** The directory a `user@host: dir` / `user@host:dir` window title shows, when it is
 *  a full (`/…`) or home-relative (`~`, `~/…`) path — a bare `\W` basename can't be
 *  resolved, and any other title (a running program's) isn't a directory at all. */
export function parseTitleCwd(title: string): string | undefined {
  const match = /^(?:\([^)]*\))?[^@\s:]+@[^:\s]+:\s?(.+)$/.exec(title.trim());
  if (!match) return undefined;
  const dir = match[1].trim();
  if (dir.startsWith('/') || dir === '~' || dir.startsWith('~/')) return dir;
  return undefined;
}

/** A shell directory as an SFTP path. SFTP servers resolve relative paths against the
 *  login's home, so `~` becomes `.` and `~/x` becomes `x`. */
export function toSftpDir(dir: string): string {
  if (dir === '~') return '.';
  if (dir.startsWith('~/')) return dir.slice(2) || '.';
  return dir;
}

/** The final component of a local path, on either separator; `undefined` for a
 *  path that names no file (`/`, `.`, `..`). */
export function baseName(path: string): string | undefined {
  const name = path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop();
  if (!name || name === '.' || name === '..') return undefined;
  return name;
}

/** `name` inside the remote directory `dir`. */
export function joinRemote(dir: string, name: string): string {
  if (dir === '.' || dir === '') return name;
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** The SFTP path a name typed into the terminal's Download command points at: absolute
 *  and home-relative (`~/…`) paths as they are, anything else inside the shell's
 *  directory `dir` (itself already an SFTP path — see `toSftpDir`). */
export function resolveRemote(dir: string, input: string): string | undefined {
  const name = input.trim();
  if (!name) return undefined;
  if (name.startsWith('/')) return name;
  if (name === '~' || name.startsWith('~/')) return toSftpDir(name);
  return joinRemote(dir, name.replace(/^\.\//, ''));
}
