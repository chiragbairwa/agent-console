import { describe, expect, test } from 'bun:test';
import { isLocal, parseSshConfig, validateHost } from '../src/hosts';

describe('hosts', () => {
  test('validateHost refuses id local', () => expect(() => validateHost({ id: 'local', name: 'x', ssh: 'a', roots: [] })).toThrow('id'));
  test('validateHost refuses a password field', () => expect(() => validateHost({ id: 'm', name: 'M', ssh: 'a', roots: [], password: 'x' })).toThrow('password'));
  test('validateHost refuses a privateKey field', () => expect(() => validateHost({ id: 'm', name: 'M', ssh: 'a', roots: [], privateKey: 'x' })).toThrow('privateKey'));
  test('validateHost refuses ssh starting with -', () => expect(() => validateHost({ id: 'm', name: 'M', ssh: '-oProxyCommand=x', roots: [] })).toThrow('ssh'));
  test('validateHost refuses jump and identityFile starting with -', () => {
    expect(() => validateHost({ id: 'm', name: 'M', ssh: 'a', roots: [], jump: '-oX=y' })).toThrow('jump');
    expect(() => validateHost({ id: 'm', name: 'M', ssh: 'a', roots: [], identityFile: '-x' })).toThrow('identityFile');
  });
  test('validateHost refuses a bad id and a bad roots value', () => {
    expect(() => validateHost({ id: 'Bad Id', name: 'M', ssh: 'a', roots: [] })).toThrow('id');
    expect(() => validateHost({ id: 'm', name: 'M', ssh: 'a', roots: [1] })).toThrow('roots');
    expect(() => validateHost({ id: 'm', name: 'M', ssh: '', roots: [] })).toThrow('ssh');
  });
  test('validateHost keeps known fields, defaults roots and drops unknown keys', () => {
    const h = validateHost({ id: 'mac-1', name: 'Mac', ssh: 'mac', port: 2222, extra: 1 });
    expect(h).toEqual({ id: 'mac-1', name: 'Mac', ssh: 'mac', port: 2222, roots: [] });
  });
  test('parseSshConfig reads alias, HostName, User, Port, IdentityFile, ProxyJump', () => {
    const r = parseSshConfig('Host macmini\n  HostName 192.168.2.182\n  User scaffplan\n  Port 2222\n  IdentityFile ~/.ssh/id_mac\nHost *\n  ServerAliveInterval 30\n');
    expect(r).toEqual([{ id: 'macmini', name: 'macmini', ssh: 'macmini', port: 2222, identityFile: '~/.ssh/id_mac', roots: [] }]);
  });
  test('parseSshConfig reads ProxyJump, splits aliases and skips patterns', () => {
    const r = parseSshConfig('# c\nHost A.b web?\n  ProxyJump=bastion\nHost !x\nHost two three\n');
    expect(r.map(x => x.id)).toEqual(['a-b', 'two', 'three']);
    expect(r[0]).toEqual({ id: 'a-b', name: 'A.b', ssh: 'A.b', jump: 'bastion', roots: [] });
  });
  test('parseSshConfig skips aliases that validateHost would refuse and dedupes by id', () => {
    const r = parseSshConfig(`Host .dot _us -dash local ${'a'.repeat(41)} ok OK\nHost ok2\n`);
    expect(r.map(x => x.id)).toEqual(['ok', 'ok2']);
    expect(r[0]!.ssh).toBe('ok');
    for (const h of r) validateHost(h);
  });
  test('validateHost refuses a colour that could inject CSS', () => {
    expect(() => validateHost({ id: 'm', name: 'M', ssh: 'a', color: 'red;background:url(x)' })).toThrow('color');
    expect(validateHost({ id: 'm', name: 'M', ssh: 'a', color: '#e0802b' }).color).toBe('#e0802b');
    expect(validateHost({ id: 'm', name: 'M', ssh: 'a', color: 'orange' }).color).toBe('orange');
  });
  test('validateHost refuses a root that does not start with / or ~', () => {
    expect(() => validateHost({ id: 'm', name: 'M', ssh: 'a', roots: ['-delete'] })).toThrow('roots');
    expect(() => validateHost({ id: 'm', name: 'M', ssh: 'a', roots: ['code'] })).toThrow('roots');
    expect(validateHost({ id: 'm', name: 'M', ssh: 'a', roots: ['/srv/code', '~/code', '~'] }).roots).toEqual(['/srv/code', '~/code', '~']);
  });
  test('validateHost refuses the id import (the route /api/hosts/import)', () => {
    expect(() => validateHost({ id: 'import', name: 'I', ssh: 'a', roots: [] })).toThrow('id');
    expect(parseSshConfig('Host import ok\n').map(x => x.id)).toEqual(['ok']);
  });
  test('isLocal', () => { expect(isLocal()).toBe(true); expect(isLocal('local')).toBe(true); expect(isLocal('mac')).toBe(false); });
});
