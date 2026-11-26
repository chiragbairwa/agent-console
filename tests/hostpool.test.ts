import { expect, test } from 'bun:test';
import { BACKOFF_MS, HostPool, TmuxPool } from '../src/hostpool';
import { Tmux } from '../src/tmux';
import { FakeRunner } from './fakes';
import type { Host } from '../src/types';

const h = (id: string, extra: Partial<Host> = {}): Host => ({ id, name: id, ssh: id, roots: [], ...extra });
const tick = () => new Promise(r => setTimeout(r, 0));

/** A sleep that records waits and lets the test release each one. */
function gate() {
  const waits: number[] = []; const rel: (() => void)[] = [];
  return { waits, sleep: (ms: number) => new Promise<void>(r => { waits.push(ms); rel.push(r); }), release: async () => { rel.shift()?.(); await tick(); } };
}
const failing = () => new FakeRunner().on(['ssh', '-M'], { code: 255, err: 'boom' });

test('link() throws for an unknown id', () => {
  expect(() => new HostPool([], { consolePort: 1, sockDir: '/tmp/x' }).link('nope')).toThrow('unknown host nope');
});
test('re-emits state with the host id', async () => {
  const f = failing();
  const p = new HostPool([h('a')], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn: f.spawn });
  const ids: string[] = [];
  p.addEventListener('state', e => ids.push((e as CustomEvent).detail.id));
  await p.link('a').connect();
  expect(ids).toEqual(['a', 'a']);
});
test('reconnect: retries after 2000, then 5000 ms', async () => {
  const g = gate();
  const p = new HostPool([h('a', { reconnect: true })], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn: failing().spawn, sleep: g.sleep });
  await p.link('a').connect();
  await tick();
  expect(g.waits).toEqual([2000]);
  await g.release();
  expect(g.waits).toEqual([2000, 5000]);
  expect(BACKOFF_MS.slice(0, 2)).toEqual([2000, 5000]);
});
test('reconnect resets the backoff after a successful up', async () => {
  const g = gate();
  const f = failing();
  const p = new HostPool([h('a', { reconnect: true })], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn: f.spawn, sleep: g.sleep });
  await p.link('a').connect(); await tick();
  await g.release(); // 5000 queued
  const ok = new FakeRunner().on(['ssh', '-S', '--'], { out: 'ok\n' });
  (p.link('a') as any).spawn = ok.spawn;
  await g.release();
  expect(p.link('a').state).toBe('up');
  (p.link('a') as any).spawn = f.spawn;
  (p.link('a') as any).set('error');
  await tick();
  expect(g.waits[g.waits.length - 1]).toBe(2000);
});
test('no reconnect loop when reconnect is not true', async () => {
  const g = gate();
  const p = new HostPool([h('a')], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn: failing().spawn, sleep: g.sleep });
  await p.link('a').connect(); await tick();
  expect(g.waits).toEqual([]);
});
test('reconnect stops after disconnect()', async () => {
  const g = gate();
  const f = failing();
  const p = new HostPool([h('a', { reconnect: true })], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn: f.spawn, sleep: g.sleep });
  await p.link('a').connect(); await tick();
  await p.link('a').disconnect();
  await g.release(); await tick();
  expect(g.waits).toEqual([2000]);
  expect(f.cmds.filter(c => c.includes('-M')).length).toBe(1);
});
test('set() disconnects a removed host and adds a new one', async () => {
  const f = new FakeRunner();
  const p = new HostPool([h('a'), h('b')], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn: f.spawn });
  const a = p.link('a');
  p.set([h('b'), h('c')]);
  await tick();
  expect(a.wantDown).toBe(true);
  expect(a.state).toBe('down');
  expect(f.cmds.some(c => c.includes('exit'))).toBe(true);
  expect(p.all().map(l => l.host.id)).toEqual(['b', 'c']);
});
test('connectAuto connects only autoConnect hosts', async () => {
  const f = new FakeRunner().on(['ssh', '-S', '--'], { out: 'ok\n' });
  const p = new HostPool([h('a', { autoConnect: true }), h('b')], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn: f.spawn });
  await p.connectAuto();
  expect(p.link('a').state).toBe('up');
  expect(p.link('b').state).toBe('down');
});
test('set() with a changed profile hands the reconnect loop to the new link', async () => {
  const g = gate();
  const f = failing();
  const p = new HostPool([h('a', { reconnect: true })], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn: f.spawn, sleep: g.sleep });
  await p.link('a').connect(); await tick();
  expect(g.waits).toEqual([2000]);
  p.set([h('a', { reconnect: true, ssh: 'a2' })]);
  await tick();
  const before = f.cmds.filter(c => c.includes('-M')).length;
  await p.link('a').connect(); await tick();
  expect(f.cmds.filter(c => c.includes('-M')).length).toBe(before + 1);
  expect(g.waits).toEqual([2000, 2000]);
  await g.release(); await g.release(); await tick();
  expect(f.cmds.filter(c => c.includes('-M')).length).toBeGreaterThan(before + 1);
});

test('TmuxPool.of() and of("local") return the local Tmux; of("mac") the remote one', () => {
  const local = new Tmux('s');
  const tp = new TmuxPool(local, new HostPool([h('mac')], { consolePort: 1, sockDir: '/tmp/ac-hp' }));
  expect(tp.of()).toBe(local);
  expect(tp.of('local')).toBe(local);
  const r = tp.of('mac');
  expect(r).not.toBe(local);
  expect(tp.of('mac')).toBe(r);
  expect(r.attachArgs('x')[0]).toBe('ssh');
  expect(() => tp.of('nope')).toThrow('unknown host nope');
});

test('a lost master (failed watch check) starts the reconnect loop', async () => {
  const g = gate();
  let fire: (() => void) | undefined;
  let checkCode = 0;
  const spawn = async (cmd: string[]) => {
    if (cmd.includes('-O') && cmd.includes('check')) return { out: '', err: '', code: checkCode };
    return { out: cmd.includes('--') ? 'ok\n' : '', err: '', code: 0 };
  };
  const p = new HostPool([h('a', { reconnect: true })], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn, sleep: g.sleep, every: fn => { fire = fn; return () => { fire = undefined; }; } });
  await p.link('a').connect();
  expect(p.link('a').state).toBe('up');
  checkCode = 255;
  fire!(); await tick();
  expect(p.link('a').state).toBe('error');
  expect(g.waits).toEqual([2000]);
});

const upRunner = () => new FakeRunner().on(['ssh', '-S', '--'], { out: 'ok\n' });
test('set(): a colour or notes change keeps the up link and updates the profile in place', async () => {
  const f = upRunner();
  const p = new HostPool([h('a')], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn: f.spawn, every: () => () => {} });
  await p.link('a').connect();
  const l = p.link('a'); const n = f.cmds.length;
  const ids: unknown[] = [];
  p.addEventListener('state', e => ids.push((e as CustomEvent).detail));
  await p.set([h('a', { color: '#ff0000', notes: 'n', name: 'Renamed' })]);
  expect(p.link('a')).toBe(l);
  expect(l.state).toBe('up');
  expect(l.host).toMatchObject({ color: '#ff0000', notes: 'n', name: 'Renamed' });
  expect(f.cmds.length).toBe(n);
  expect(ids).toEqual([{ id: 'a', profile: true }]);
});
test('set(): an ssh change replaces an up link and connects the new one', async () => {
  const f = upRunner();
  const p = new HostPool([h('a')], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn: f.spawn, every: () => () => {} });
  await p.link('a').connect();
  const old = p.link('a');
  await p.set([h('a', { ssh: 'a2' })]);
  expect(p.link('a')).not.toBe(old);
  expect(old.state).toBe('down');
  expect(p.link('a').state).toBe('up');
  expect(f.cmds.filter(c => c.includes('-M')).at(-1)!.at(-1)).toBe('a2');
});
test('set(): a port change of a down link without autoConnect does not connect', async () => {
  const f = upRunner();
  const p = new HostPool([h('a')], { consolePort: 1, sockDir: '/tmp/ac-hp', spawn: f.spawn });
  await p.set([h('a', { port: 2222 })]);
  expect(p.link('a').state).toBe('down');
  expect(f.cmds.some(c => c.includes('-M'))).toBe(false);
});
