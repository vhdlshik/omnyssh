import { describe, expect, it } from 'vitest';
import { baseName, joinRemote, parseOsc7, parseTitleCwd, toSftpDir } from './terminalCwd';

describe('OSC 7 working directory', () => {
  it('takes the path of a file URL, with or without a host', () => {
    expect(parseOsc7('file://box/home/me/src')).toBe('/home/me/src');
    expect(parseOsc7('file:///var/log')).toBe('/var/log');
  });

  it('decodes percent-escapes', () => {
    expect(parseOsc7('file://box/home/me/My%20Files')).toBe('/home/me/My Files');
  });

  it('rejects anything that is not a file URL', () => {
    expect(parseOsc7('http://box/x')).toBeUndefined();
    expect(parseOsc7('/home/me')).toBeUndefined();
    expect(parseOsc7('file://box/%E0%A4%A')).toBeUndefined();
  });
});

describe('window-title working directory', () => {
  it('reads the Debian/Ubuntu bash title', () => {
    expect(parseTitleCwd('me@box: ~/src/app')).toBe('~/src/app');
    expect(parseTitleCwd('me@box: /etc')).toBe('/etc');
    expect(parseTitleCwd('(chroot)me@box: ~')).toBe('~');
  });

  it('reads the Fedora bash title', () => {
    expect(parseTitleCwd('me@box:~/src')).toBe('~/src');
  });

  it('ignores titles that name no resolvable directory', () => {
    expect(parseTitleCwd('vim notes.txt')).toBeUndefined();
    expect(parseTitleCwd('me@box: src')).toBeUndefined();
    expect(parseTitleCwd('me@box: ~other/x')).toBeUndefined();
    expect(parseTitleCwd('')).toBeUndefined();
  });
});

describe('SFTP paths', () => {
  it('maps home-relative directories onto the SFTP home', () => {
    expect(toSftpDir('~')).toBe('.');
    expect(toSftpDir('~/src')).toBe('src');
    expect(toSftpDir('/srv/www')).toBe('/srv/www');
  });

  it('joins a file name into a directory', () => {
    expect(joinRemote('/srv/www', 'a.txt')).toBe('/srv/www/a.txt');
    expect(joinRemote('/', 'a.txt')).toBe('/a.txt');
    expect(joinRemote('.', 'a.txt')).toBe('a.txt');
    expect(joinRemote('src', 'a.txt')).toBe('src/a.txt');
  });

  it('takes the file name of a local path on either separator', () => {
    expect(baseName('/home/me/a.txt')).toBe('a.txt');
    expect(baseName('C:\\Users\\me\\a.txt')).toBe('a.txt');
    expect(baseName('/home/me/dir/')).toBe('dir');
    expect(baseName('/')).toBeUndefined();
  });
});
