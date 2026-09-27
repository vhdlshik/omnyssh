// Where a terminal's shell currently is, for drag-and-drop uploads. SSH carries no
// "current directory" of its own, so the shell has to report it: OSC 7
// (`ESC ] 7 ; file://host/path BEL`, emitted by vte.sh, zsh/fish integrations, starship…)
// is exact; failing that, the stock Debian/Ubuntu/Fedora bash prompts put
// `user@host: ~/dir` in the window title, which is good enough when it parses.

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
