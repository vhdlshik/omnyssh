// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BAUD,
  localLabel,
  portShortName,
  quotePaths,
  rememberBaud,
  rememberedBaud
} from './localPicker';

describe('local session labels', () => {
  it('names a shell by its detected name', () => {
    expect(localLabel({ kind: 'shell', id: '/bin/zsh' }, 'zsh')).toBe('zsh');
    expect(localLabel({ kind: 'shell', id: 'pwsh' })).toBe('pwsh');
  });

  it('names a serial port by its device and speed', () => {
    expect(localLabel({ kind: 'serial', port: '/dev/ttyUSB0', baud: 115200 })).toBe(
      'ttyUSB0 · 115200'
    );
    expect(localLabel({ kind: 'serial', port: 'COM3', baud: 9600 })).toBe('COM3 · 9600');
    expect(portShortName('\\\\.\\COM12')).toBe('COM12');
  });
});

describe('the remembered serial speed', () => {
  beforeEach(() => localStorage.clear());

  it('starts at 115200', () => {
    expect(rememberedBaud([9600, 115200])).toBe(DEFAULT_BAUD);
  });

  it('comes back after being used', () => {
    rememberBaud(9600);
    expect(rememberedBaud([9600, 115200])).toBe(9600);
  });

  it('is ignored when no longer offered', () => {
    rememberBaud(1234);
    expect(rememberedBaud([9600, 115200])).toBe(115200);
  });
});

describe('dropped paths', () => {
  it('are single-quoted for Unix shells only when needed', () => {
    expect(quotePaths(['/tmp/a.txt', "/tmp/it's here"], false)).toBe(
      `/tmp/a.txt '/tmp/it'\\''s here'`
    );
  });

  it('are double-quoted for Windows shells when they hold spaces', () => {
    expect(quotePaths(['C:\\a.txt', 'C:\\My Files\\b.txt'], true)).toBe(
      'C:\\a.txt "C:\\My Files\\b.txt"'
    );
  });
});
