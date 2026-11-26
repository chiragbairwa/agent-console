import { expect, test } from 'bun:test';
import { laneLayout } from '../web/lanes';

const hosts = [{ id: 'mac', name: 'Mac mini' }, { id: 'pi', name: 'Pi' }];
const W = { w: 760, h: 560 };

test('local lane comes first and holds the advisor first', () => {
  const r = laneLayout([
    { id: 'm1', host: 'mac', role: 'worker' }, { id: 'l1', role: 'worker' }, { id: 'advisor', role: 'advisor' },
  ], hosts);
  expect(r.lanes.map(l => l.host)).toEqual(['local', 'mac']);
  expect(r.lanes[0]!.name).toBe('This computer');
  const local = r.moves.filter(m => m.id === 'advisor' || m.id === 'l1');
  expect(local[0]!.id).toBe('advisor');
  const adv = r.moves.find(m => m.id === 'advisor')!, l1 = r.moves.find(m => m.id === 'l1')!;
  expect(adv.x).toBeLessThan(l1.x);
  expect(adv.x).toBe(60); expect(adv.y).toBe(100);
});

test('two mac workers land in the mac lane, in one row, 60 px apart', () => {
  const r = laneLayout([{ id: 'a', host: 'mac', role: 'worker' }, { id: 'b', host: 'mac', role: 'worker' }], hosts);
  const a = r.moves.find(m => m.id === 'a')!, b = r.moves.find(m => m.id === 'b')!;
  expect(b.y).toBe(a.y);
  expect(b.x - a.x).toBe(W.w + 60);
  const lane = r.lanes[0]!;
  expect(lane.host).toBe('mac');
  expect(a.x).toBe(lane.x + 60); expect(a.y).toBe(lane.y + 100);
  expect(lane.w).toBe(60 * 2 + 760 * 2 + 60);
});

test('a host with no workers has no lane', () => {
  const r = laneLayout([{ id: 'a', host: 'mac', role: 'worker' }], hosts);
  expect(r.lanes.map(l => l.host)).toEqual(['mac']);
});

test('lanes do not overlap', () => {
  const ws = [{ id: 'advisor', role: 'advisor' as const }, ...'abcdefg'.split('').map(id => ({ id, host: 'mac', role: 'worker' as const })),
    { id: 'p', host: 'pi', role: 'worker' as const, w: 900, h: 700 }];
  const { lanes } = laneLayout(ws, hosts);
  expect(lanes.length).toBe(3);
  for (let i = 1; i < lanes.length; i++) expect(lanes[i]!.y).toBeGreaterThanOrEqual(lanes[i - 1]!.y + lanes[i - 1]!.h + 160);
});
