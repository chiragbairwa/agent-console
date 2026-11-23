import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyHub, type Sink } from '../src/pty';
import { Tmux } from '../src/tmux';

const hasTmux = !!Bun.which('tmux');
const socket = `ac-test-${Math.random().toString(36).slice(2, 8)}`;
const tmux = new Tmux(socket);
afterAll(async () => { await Bun.spawn(['tmux', '-L', socket, 'kill-server'], { stderr: 'ignore' }).exited; });

class Collect implements Sink {
  buf = '';
  closed = false;
  send(d: string | Uint8Array) { this.buf += typeof d === 'string' ? d : new TextDecoder().decode(d); }
  close() { this.closed = true; }
}

async function waitFor(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await Bun.sleep(30); }
  return false;
}

describe.skipIf(!hasTmux)('PtyHub', () => {
  test('streams the screen, takes input, and keeps the session after the last viewer leaves', async () => {
    await tmux.newSession('ac-p1', mkdtempSync(join(tmpdir(), 'ac-pty-')), {}, ['bash', '--norc', '--noprofile']);
    await tmux.sendText('ac-p1', 'echo READY-MARK');
    await Bun.sleep(200);
    const hub = new PtyHub(tmux);
    const a = new Collect();
    await hub.subscribe('p1', a);
    expect(await waitFor(() => a.buf.includes('READY-MARK'))).toBe(true);

    const b = new Collect();
    await hub.subscribe('p1', b);
    expect(b.buf).toContain('READY-MARK'); // late viewer gets the snapshot first

    hub.input('p1', 'echo hi-from-$((40+2))\r');
    expect(await waitFor(() => a.buf.includes('hi-from-42') && b.buf.includes('hi-from-42'))).toBe(true);

    hub.unsubscribe(a);
    hub.unsubscribe(b);
    expect(hub.active('p1')).toBe(false);
    await Bun.sleep(100);
    expect(await tmux.has('ac-p1')).toBe(true);
    hub.closeAll();
  });

  test('resize reaches the tmux client (SIGWINCH), so focus mode fills the box', async () => {
    await tmux.newSession('ac-p4', mkdtempSync(join(tmpdir(), 'ac-pty-')), {}, ['bash', '--norc', '--noprofile']);
    const hub = new PtyHub(tmux);
    const a = new Collect();
    await hub.subscribe('p4', a);
    const size = async () => (await new Response(Bun.spawn(['tmux', '-L', socket, 'display', '-p', '-t', 'ac-p4', '#{window_width}x#{window_height}']).stdout).text()).trim();
    expect(await waitFor(() => a.buf.length > 0)).toBe(true);
    hub.resize('p4', 150, 45);
    let s = '';
    const end = Date.now() + 3000;
    while (Date.now() < end && (s = await size()) !== '150x45') await Bun.sleep(50);
    expect(s).toBe('150x45');
    hub.unsubscribe(a);
    hub.closeAll();
  });

  test('I6: when the session ends, viewers are closed (so they reconnect) and the entry goes away', async () => {
    await tmux.newSession('ac-p2', mkdtempSync(join(tmpdir(), 'ac-pty-')), {}, ['bash', '--norc', '--noprofile']);
    const hub = new PtyHub(tmux);
    const a = new Collect();
    await hub.subscribe('p2', a);
    await Bun.sleep(200);
    await tmux.kill('ac-p2');
    expect(await waitFor(() => a.closed)).toBe(true);
    expect(hub.active('p2')).toBe(false);
  });

  test('I6: a viewer that leaves while its snapshot loads does not keep the attach alive', async () => {
    await tmux.newSession('ac-p3', mkdtempSync(join(tmpdir(), 'ac-pty-')), {}, ['bash', '--norc', '--noprofile']);
    const hub = new PtyHub(tmux);
    const first = new Collect();
    await hub.subscribe('p3', first);
    const late = new Collect();
    const pending = hub.subscribe('p3', late); // awaits capture
    hub.unsubscribe(late);                       // leaves before it is added
    await pending;
    hub.unsubscribe(first);
    expect(hub.active('p3')).toBe(false);
    hub.closeAll();
  });
});
