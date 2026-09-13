import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ChikiseumLiveEngine } from './chikiseum-live-engine.js';
import { ChikiseumLiveNavigation } from './chikiseum-live-navigation.js';

test('all 402 canonical cards × 3 levels × 2 states match independent Python realtime authority', () => {
  const oracle = JSON.parse(execFileSync('python3', [fileURLToPath(new URL('./chikiseum-live-python-oracle.py', import.meta.url))],
    { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }));
  let now = 1000;
  const e = new ChikiseumLiveEngine({ navigation: new ChikiseumLiveNavigation(), clock: () => now, movementClock: () => 100 + now - 1000 });
  const near = (actual, expected, path) => {
    if (typeof expected === 'number') assert.ok(Math.abs(actual - expected) <= 1e-8, `${path}: ${actual} != ${expected}`);
    else if (Array.isArray(expected)) { assert.equal(actual.length, expected.length, path); expected.forEach((v, i) => near(actual[i], v, `${path}[${i}]`)); }
    else if (expected && typeof expected === 'object') { assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path); for (const key of Object.keys(expected)) near(actual[key], expected[key], `${path}.${key}`); }
    else assert.equal(actual, expected, path);
  };
  for (const row of oracle) {
    now = 1000; e.matches.clear(); e.leases.clear(); e.admissions.clear(); e.accounts.clear(); e.assets.clear(); e.completions.clear(); e.lastClock = -Infinity;
    const c = e.cards.get(row.key);
    for (const side of ['A', 'B']) e.admit({ id: side, wallet: `trusted-${side}`, asset_id: `owned-${side}`, species: c.species,
      level: row.level, handle: side, inventory_verified: true });
    e.queue('A'); const mid = e.queue('B').match_id; e.ready('A', mid); e.ready('B', mid); const m = e.matches.get(mid);
    for (const p of m.players) { p.position = { x: p.side === 'A' ? -.75 : .75, y: 0, z: 0 }; p.energy = 6; p.hp -= 30; }
    if (row.variant !== 'base') {
      m.players[0].statuses = { charge: { slot: 4, source_side: 'A', multiplier: 1.35, expires_at: 1008 },
        rally: { slot: 9, source_side: 'A', multiplier: 1.25, expires_at: 1008 }, weaken: { slot: 10, source_side: 'B', fraction: .2, expires_at: 1006 } };
      m.players[1].statuses = { shield: { slot: 3, source_side: 'B', amount: 10, expires_at: 1004 } };
    }
    e.cast('A', mid, c.slot, 'oracle-cast-one'); now += .05; const s = e.state('A', mid);
    const actual = { key: row.key, level: row.level, variant: row.variant,
      players: s.players.map(p => Object.fromEntries(['hp', 'energy', 'position', 'statuses'].map(k => [k, p[k]]))),
      events: s.events.map(event => Object.fromEntries(Object.entries(event).filter(([k]) => !['id', 'seq', 'server_time'].includes(k)))),
      status: s.status, winner: s.winner ?? null };
    near(actual, row, `${row.key}/level${row.level}/${row.variant}`);
  }
  assert.equal(oracle.length, 2412);
});
