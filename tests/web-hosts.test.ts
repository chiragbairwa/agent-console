import { describe, expect, test } from 'bun:test';
import { hostRows, profileFromForm } from '../web/hosts';
import type { HostInfo } from '../web/hosts';

const h = (o: Partial<HostInfo> & { id: string }): HostInfo => ({ name: o.id, ssh: `${o.id}.lan`, roots: [], state: 'down', ...o });

describe('hostRows', () => {
  const hosts = [
    h({ id: 'b', name: 'Beta', group: 'Lab', labels: ['mac'] }),
    h({ id: 'c', name: 'Cora', ssh: 'cora@10.0.0.5' }),
    h({ id: 'a', name: 'Alpha', group: 'Lab', labels: ['linux'], workers: 2 }),
    h({ id: 'd', name: 'Dan', group: 'Home' }),
  ];
  test('sorts by group (empty last), then name', () => {
    expect(hostRows(hosts, '').map(r => r.id)).toEqual(['d', 'a', 'b', 'c']);
  });
  test('search hits a label, case-insensitive', () => {
    expect(hostRows(hosts, 'MAC').map(r => r.id)).toEqual(['b']);
  });
  test('search hits name, group and server', () => {
    expect(hostRows(hosts, 'home').map(r => r.id)).toEqual(['d']);
    expect(hostRows(hosts, '10.0.0.5').map(r => r.id)).toEqual(['c']);
    expect(hostRows(hosts, 'alp').map(r => r.id)).toEqual(['a']);
  });
  test('row shape', () => {
    expect(hostRows(hosts, 'alpha')[0]).toEqual({ id: 'a', name: 'Alpha', group: 'Lab', labels: ['linux'], server: 'a.lan', state: 'down', workers: 2 });
  });
});

describe('profileFromForm', () => {
  test('trims, splits labels, drops empty strings', () => {
    const p = profileFromForm({ name: ' Mac mini ', labels: 'mac, worker ,', group: '', ssh: 'mini', notes: '' });
    expect(p.name).toBe('Mac mini');
    expect(p.labels).toEqual(['mac', 'worker']);
    expect('group' in p).toBe(false);
    expect('notes' in p).toBe(false);
  });
  test('port and tunnelPort are numbers; empty port is omitted', () => {
    expect(profileFromForm({ name: 'x', port: '2222', tunnelPort: '7000' })).toMatchObject({ port: 2222, tunnelPort: 7000 });
    expect('port' in profileFromForm({ name: 'x', port: '' })).toBe(false);
  });
  test('id is given, else slug of name', () => {
    expect(profileFromForm({ name: 'Mac Mini #2' }).id).toBe('mac-mini-2');
    expect(profileFromForm({ name: 'Mac', id: 'keep' }).id).toBe('keep');
  });
  test('booleans from on/true', () => {
    expect(profileFromForm({ name: 'x', autoConnect: 'on', reconnect: 'true', warnSleep: '' })).toMatchObject({ autoConnect: true, reconnect: true, warnSleep: false });
  });
  test('roots split by newline or comma', () => {
    expect(profileFromForm({ name: 'x', roots: '~/a\n~/b, ~/c\n' }).roots).toEqual(['~/a', '~/b', '~/c']);
  });
  test('never outputs password or privateKey', () => {
    const p = profileFromForm({ name: 'x', password: 'secret', privateKey: 'k' });
    expect('password' in p).toBe(false);
    expect('privateKey' in p).toBe(false);
  });
});
