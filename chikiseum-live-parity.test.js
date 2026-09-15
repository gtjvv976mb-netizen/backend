import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ChikiseumLiveEngine } from './chikiseum-live-engine.js';
import { ChikiseumLiveNavigation } from './chikiseum-live-navigation.js';

const ORACLE = fileURLToPath(new URL('./chikiseum-live-python-oracle.py', import.meta.url));
const PRACTICE = fileURLToPath(new URL('../chikiseum_practice/', import.meta.url));

// What makes this a DIFFERENTIAL gate is that the expected values come from a separately written
// Python implementation of the same rules, not from this engine. That authority lives in a sibling
// checkout, `chikiseum_practice/`, which is not part of this repo -- so on a fresh clone this test
// dies with a bare `ModuleNotFoundError: No module named 'realtime_engine'` raised four frames deep
// inside python, which reads like a broken test rather than a missing input. Say what is wrong.
//
// This deliberately does NOT downgrade to a skip. Without the oracle there is nothing to compare
// against, and a gate that cannot be evaluated has not been passed; reporting it green would make
// every release receipt that cites this test a false receipt.
function runOracle() {
  try {
    return execFileSync('python3', [ORACLE], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  } catch (cause) {
    const detail = String(cause.stderr || '') + String(cause.message || '');
    const noPython = cause.code === 'ENOENT' || /python3.*(not found|ENOENT)/i.test(detail);
    const noOracle = !existsSync(PRACTICE) || /No module named ['"]?(realtime_engine|reference_arena|engine)/.test(detail);
    if (noPython || noOracle) {
      throw new Error(
        (noPython
          ? 'python3 is not available, so the independent Python authority cannot be run.\n'
          : 'The independent Python authority is missing, so this differential gate cannot be evaluated.\n') +
        `  needs:   ${PRACTICE}realtime_engine.py (plus engine.py, reference_arena.py)\n` +
        `  used by: ${ORACLE}\n` +
        '  why:     the 2412 expected rows must come from an implementation written independently of\n' +
        '           this engine. Generating them FROM this engine would make the test compare the\n' +
        '           engine with itself and prove nothing, so it is not an acceptable substitute.\n' +
        '  fix:     check chikiseum_practice/ out beside this repo -- it is a separate tree, not a\n' +
        '           package.json dependency -- then re-run.\n' +
        `  raw:     ${detail.trim().split('\n').slice(-3).join(' | ') || '(no output)'}`,
        { cause });
    }
    throw cause;
  }
}

test('all 402 canonical cards × 3 levels × 2 states match independent Python realtime authority', () => {
  const oracle = JSON.parse(runOracle());
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
