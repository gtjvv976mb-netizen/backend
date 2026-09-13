// Synthetic trusted authentication/ownership callbacks, real canonical engine
// and exact navigation. This is NOT wallet verification or production auth proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ChikiseumLiveService, installChikiseumLive, LIVE_PREFIX } from './chikiseum-live-service.js';
import { ChikiseumLiveEngine, LiveRejected } from './chikiseum-live-engine.js';
import { ChikiseumLiveNavigation } from './chikiseum-live-navigation.js';
import { ChikiseumProgressBook } from './chikiseum-live-progression.js';

const clone = value => structuredClone(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rejected = (promise, code) => assert.rejects(promise, error => error instanceof LiveRejected && error.code === code);
function fixture({ saved = null } = {}) {
  let now = 1000, mono = 100, authCount = 0;
  const auths = new Map(), owned = new Map();
  const lease = { valid: true, saved: clone(saved), writes: 0, closes: 0, fail: false, ambiguous: false,
    async read() { return clone(this.saved); },
    async write(_key, value) {
      if (this.fail) { this.fail = false; if (this.ambiguous) this.saved = clone(value); throw new Error('synthetic durable write fault'); }
      this.saved = clone(value); this.writes++;
    },
    async ping() { if (!this.valid) throw new Error('synthetic lease lost'); },
    async close() { this.valid = false; this.closes++; }
  };
  const authenticate = async body => {
    authCount++;
    const current = auths.get(body.wallet);
    if (!current || current.token !== body.mktToken || current.id !== body.sessionId || current.epoch !== body.sessionEpoch) return null;
    return { wallet: body.wallet, session_id: current.id, epoch: current.epoch, handle: 'Synthetic Trainer' };
  };
  const options = { authenticate, ownedAssets: async wallet => clone(owned.get(wallet) ?? []),
    leaseFactory: async () => lease, clock: () => now,
    engineFactory: () => new ChikiseumLiveEngine({ navigation: new ChikiseumLiveNavigation(),
      clock: () => now, movementClock: () => mono, sessionTTL: 60, maxAdmissions: 8, maxMatches: 4 }) };
  const service = new ChikiseumLiveService(options);
  function body(wallet, extra = {}) {
    if (!auths.has(wallet)) auths.set(wallet, { token: 'SYNTHETIC-token-' + wallet, id: 'SYNTHETIC-session-' + wallet, epoch: 1 });
    const a = auths.get(wallet);
    return { wallet, mktToken: a.token, sessionId: a.id, sessionEpoch: a.epoch, ...extra };
  }
  function add(wallet) {
    body(wallet); owned.set(wallet, [{ asset_id: 'asset-' + wallet, species: 'galador', display_name: 'Galador',
      rarity: 'legendary', eligible: true, reason: '' }]);
  }
  async function admit(wallet) { add(wallet); return service.command('session', body(wallet, { asset_id: 'asset-' + wallet })); }
  async function match() {
    await admit('walletA'); await admit('walletB');
    await service.command('queue', body('walletA'));
    const mid = (await service.command('queue', body('walletB'))).match_id;
    await service.command('ready', body('walletA', { match_id: mid }));
    await service.command('ready', body('walletB', { match_id: mid })); return mid;
  }
  // Actual canonical casts, no injected positions/HP/metrics/completions.
  async function completion(mid, beforeLastResolve = () => {}) {
    const fighter = service.engine.matches.get(mid).players[0];
    const attack = service.engine.cards.get(fighter.species + ':0');
    const rounds = Math.ceil(fighter.max_hp / (attack.mechanics.dmg[fighter.card_tier] * fighter.damage_multiplier));
    for (let i = 0; i < rounds; i++) {
      now += 6; mono += 6;
      for (const wallet of ['walletA', 'walletB']) await service.command('cast', body(wallet, {
        match_id: mid, slot: 0, request_id: `synthetic-cast-${wallet}-${i}` }));
      now += .05; mono += .05;
      if (i === rounds - 1) beforeLastResolve();
      const snap = await service.command('state', body('walletA', { match_id: mid }));
      if (snap.status === 'finished') return snap;
    }
    throw new Error('Canonical synthetic fight did not finish');
  }
  return { service, lease, options, auths, owned, body, add, admit, match, completion,
    advance: seconds => { now += seconds; mono += seconds; }, authCount: () => authCount };
}

test('HTTP gate rejects arbitrary origins, content types and client stat writes; private errors are bounded', async () => {
  const f = fixture(), app = express(); app.use(express.json({ limit: '8kb' }));
  const service = installChikiseumLive(app, f.options); await service.boot();
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + LIVE_PREFIX;
  try {
    const origin = await fetch(base + '/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(origin.status, 403); assert.equal((await origin.json()).code, 'ORIGIN_DENIED');
    const type = await fetch(base + '/roster', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(type.status, 415);
    const auth = await fetch(base + '/roster', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f.body('unknown'), mktToken: 'wrong' }) });
    assert.equal(auth.status, 401); const error = await auth.json();
    assert.deepEqual(Object.keys(error).sort(), ['code', 'error']); assert.equal(auth.headers.get('cache-control'), 'no-store');
    f.add('walletA');
    const injected = await fetch(base + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(f.body('walletA', { asset_id: 'asset-walletA', level: 30, hp: 99999 })) });
    assert.equal(injected.status, 400); assert.equal(service.engine.admissions.size, 0);
  } finally { await service.stop(); await new Promise(resolve => server.close(resolve)); }
});
test('auth is rechecked after serial wait; superseded requests cannot admit or cast', async () => {
  const f = fixture(); await f.service.boot(); f.add('walletA');
  let release; const barrier = f.service.serial(() => new Promise(resolve => { release = resolve; }));
  await sleep(0);
  const intent = f.service.command('session', f.body('walletA', { asset_id: 'asset-walletA' }));
  await sleep(0); f.auths.delete('walletA'); release(); await barrier;
  await rejected(intent, 'AUTH_REQUIRED'); assert.equal(f.service.engine.admissions.size, 0);
  await f.service.stop();
});
test('ownership changes during queue wait revoke admission before acting and cannot award XP', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('walletA');
  let release; const barrier = f.service.serial(() => new Promise(resolve => { release = resolve; })); await sleep(0);
  const intent = f.service.command('queue', f.body('walletA')); await sleep(0);
  f.owned.get('walletA')[0].eligible = false; release(); await barrier;
  await rejected(intent, 'ASSET_UNAVAILABLE'); assert.equal(f.service.engine.admissions.size, 0);
  assert.equal(f.service.book.fighter('asset-walletA').xp, 0); await f.service.stop();
});
test('foreign authenticated fighter cannot read another match; wire/checkpoint omit auth secrets', async () => {
  const f = fixture(); await f.service.boot(); const mid = await f.match(); await f.admit('walletC');
  await rejected(f.service.command('state', f.body('walletC', { match_id: mid })), 'PRIVATE_VIEW_DENIED');
  const snap = await f.service.command('state', f.body('walletA', { match_id: mid }));
  for (const key of ['identities', 'metrics', 'movement', 'cast_requests', 'move_requests']) assert.equal(Object.hasOwn(snap, key), false);
  const wire = JSON.stringify(snap), saved = JSON.stringify(f.lease.saved);
  for (const value of ['SYNTHETIC-token-', 'SYNTHETIC-session-', 'mktToken', 'sessionEpoch']) {
    assert.equal(wire.includes(value), false); assert.equal(saved.includes(value), false);
  }
  assert.equal(wire.includes('asset-walletB'), false); assert.equal(wire.includes('walletB'), false);
  await f.service.stop();
});
test('concurrent retries reserve one canonical cast and echo the caller request ID', async () => {
  const f = fixture(); await f.service.boot(); const mid = await f.match();
  const body = f.body('walletA', { match_id: mid, slot: 0, request_id: 'concurrent-identical-cast' });
  const replies = await Promise.all(Array.from({ length: 20 }, () => f.service.command('cast', clone(body))));
  assert.ok(replies.every(r => r.cast_ack === body.request_id && r.you.cast_ack === body.request_id));
  const m = f.service.engine.matches.get(mid); assert.equal(m.pending_casts.length, 1);
  assert.equal(m.cast_requests.size, 1); assert.equal(m.players[0].energy, 2);
  await rejected(f.service.command('cast', { ...body, slot: 1 }), 'INVALID_COMMAND'); await f.service.stop();
});
test('failed durable completion write leaves XP uninstalled and drain intact until retry succeeds', async () => {
  const f = fixture(); await f.service.boot(); const mid = await f.match();
  await rejected(f.completion(mid, () => { f.lease.fail = true; }), 'UNAVAILABLE');
  assert.equal(f.service.ready, false); assert.equal(f.service.book.fighter('asset-walletA').xp, 0);
  assert.equal(f.service.engine.drainCompletions().length, 1);
  await f.service.flush(true); assert.equal(f.service.book.fighter('asset-walletA').xp, 22);
  assert.equal(f.service.engine.drainCompletions().length, 0);
  await f.service.flush(true); assert.equal(f.service.book.fighter('asset-walletA').xp, 22); await f.service.stop();
});
test('ambiguous committed write plus restart awards XP exactly once, with no replayed attacks', async () => {
  const f = fixture(); await f.service.boot(); const mid = await f.match();
  await rejected(f.completion(mid, () => { f.lease.fail = true; f.lease.ambiguous = true; }), 'UNAVAILABLE');
  assert.equal(f.service.book.fighter('asset-walletA').xp, 0);
  const restarted = fixture({ saved: f.lease.saved }); assert.equal(await restarted.service.boot(), true);
  assert.equal(restarted.service.book.fighter('asset-walletA').xp, 22);
  assert.equal(restarted.service.book.fighter('asset-walletB').xp, 22);
  assert.equal(restarted.service.engine.drainCompletions().length, 0);
  assert.ok([...restarted.service.engine.matches.values()].every(m => m.pending_casts.length === 0));
  await restarted.service.flush(true); assert.equal(restarted.service.book.fighter('asset-walletA').xp, 22);
  await restarted.service.stop(); await f.service.stop();
});
test('earned level/card tier refreshes on the next battle while completed battle stats stay frozen', async () => {
  const f = fixture();
  // Trusted synthetic durable XP, not a client level claim. This is just below
  // the level8/card-tier1 threshold; the remaining XP comes from an actual fight.
  const progression = new ChikiseumProgressBook().snapshot();
  progression.assets['asset-walletA'] = { xp: 2790 }; progression.assets['asset-walletB'] = { xp: 2790 };
  f.lease.saved = { schema: 'chikiseum.live-store/v1', progression, engine: f.options.engineFactory().checkpoint() };
  assert.equal(await f.service.boot(), true); const previous = await f.match();
  const oldBattle = await f.completion(previous);
  assert.ok(oldBattle.players.every(p => p.level === 7 && p.card_tier === 0));
  assert.equal(f.service.book.fighter('asset-walletA').level, 8);
  assert.equal(f.service.book.fighter('asset-walletB').level, 8);
  await f.service.command('queue', f.body('walletA'));
  const next = await f.service.command('queue', f.body('walletB'));
  assert.notEqual(next.match_id, previous);
  const nextBattle = await f.service.command('state', f.body('walletA', { match_id: next.match_id }));
  assert.ok(nextBattle.players.every(p => p.level === 8 && p.card_tier === 1));
  assert.ok(nextBattle.players.every(p => p.max_hp > oldBattle.players[0].max_hp));
  assert.ok(f.service.engine.matches.get(previous).players.every(p => p.level === 7 && p.card_tier === 0));
  await f.service.stop();
});
test('shutdown write failure still releases the exclusive lease', async () => {
  const f = fixture(); await f.service.boot(); await f.match(); f.lease.fail = true;
  try { await f.service.stop(); } catch { /* Shutdown may report the durable fault. */ }
  assert.equal(f.lease.closes, 1); assert.equal(f.lease.valid, false);
});
test('expired engine admissions are pruned from service auth audit memory', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('walletA'); f.advance(61); f.service.start();
  try {
    await sleep(100); f.advance(1.1); await sleep(100);
    assert.equal(f.service.engine.admissions.size, 0); assert.equal(f.service.admitted.size, 0);
  }
  finally { await f.service.stop(); }
});
test('lost lease marks service unavailable instead of retaining internally ready state', async () => {
  const f = fixture(); await f.service.boot(); f.lease.valid = false; f.service.start();
  try { await sleep(120); assert.equal(f.service.isReady(), false); assert.equal(f.service.ready, false); assert.ok(f.service.health().reason); }
  finally { await f.service.stop(); }
});
test('serial capacity is bounded and rejected work cannot enlarge the queue', async () => {
  const f = fixture(); await f.service.boot(); let release;
  const jobs = [f.service.serial(() => new Promise(resolve => { release = resolve; }))]; await sleep(0);
  for (let i = 1; i < 128; i++) jobs.push(f.service.serial(async () => i));
  assert.equal(f.service.queued, 128); await rejected(f.service.serial(async () => 999), 'CAPACITY');
  assert.equal(f.service.queued, 128); release(); await Promise.all(jobs); await sleep(0);
  assert.equal(f.service.queued, 0); await f.service.stop();
});
test('unavailable/non-owner durable lease retries have a five-second minimum interval', async () => {
  const f = fixture(); let attempts = 0;
  const service = new ChikiseumLiveService({ ...f.options, leaseFactory: async () => { attempts++; return null; } });
  assert.equal(await service.boot(), false);
  for (let i = 0; i < 20; i++) assert.equal(await service.boot(), false);
  assert.equal(attempts, 1); f.advance(4.9); assert.equal(await service.boot(), false);
  assert.equal(attempts, 1); f.advance(.1); assert.equal(await service.boot(), false);
  assert.equal(attempts, 2); await service.stop();
});
test('malformed durable reward awards fail closed instead of being replayed to players', () => {
  const saved = new ChikiseumProgressBook().snapshot();
  saved.receipts.bad = { match_id: 'bad', at: 1000, reason: 'completed_battle', awards: {
    assetA: { gained_xp: -1, xp: 'not-an-integer', level: 999 } } };
  assert.throws(() => new ChikiseumProgressBook(saved));
});
test('reserved prototype keys cannot become assets, wallets or idempotency receipt IDs', () => {
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => new ChikiseumProgressBook().fighter(key));
    const summary = { match_id: key, status: 'finished', winner: 'A', started_at: 100, completed_at: 160,
      players: [{ wallet: 'walletA', asset_id: 'assetA', side: 'A', cast_count: 3, damage_dealt: 10 },
        { wallet: 'walletB', asset_id: 'assetB', side: 'B', cast_count: 3, damage_dealt: 10 }] };
    assert.throws(() => new ChikiseumProgressBook().withCompletion(summary, 161));
  }
});
