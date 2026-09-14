// Rehearsal: a clearly-labelled practice opponent. The rules it must obey are the point of these
// tests — lobby only, never the queue, and no battle XP ever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChikiseumLiveEngine, LiveRejected } from './chikiseum-live-engine.js';

const navigation = {
  binding: () => ({ reference_plan_sha256: '4f37041b6c132b542284dd22c4d1b7445ccc3c3900c3ee6a6bdc58e21eea682b',
    floor_radius_m: 24, real_sol_enabled: false, id: 'chikiseum-image-built-3d-v2' }),
  actorHome: side => ({ x: side === 'A' ? -5 : 5, y: 0, z: 0 }),
  validPosition: p => p && p.y === 0 && Math.hypot(p.x, p.z) < 23.65,
  onEmblem: p => Math.hypot(p.x, p.z) <= 2.4,
  lineOfSight: () => true,
  sweepIntent: (p, dx, dz, distance, rival) => {
    const to = { x: p.x + dx * distance, y: 0, z: p.z + dz * distance };
    if (rival && Math.hypot(to.x - rival.x, to.z - rival.z) < .7) return { position: structuredClone(p), travelled: 0, reason: 'rival' };
    return { position: to, travelled: distance, reason: null };
  }
};
function fixture(options = {}) {
  let now = 1000, mono = 100;
  const e = new ChikiseumLiveEngine({ navigation, clock: () => now, movementClock: () => mono, ...options });
  const trusted = (id, species = 'galador', level = 16) => ({ id, wallet: `wallet-${id}`, asset_id: `asset-${id}`,
    species, level, handle: `Player ${id}`, inventory_verified: true });
  e.admit(trusted('A'));
  return { e, trusted, advance: s => { now += s; mono += s; }, at: () => now };
}
const botOf = lobby => lobby.trainers.find(t => t.handle === ChikiseumLiveEngine.REHEARSAL_HANDLE);

test('the dummy is offered in the lobby, labelled, and always compatible', () => {
  const { e } = fixture();
  const bot = botOf(e.lobby('A'));
  assert.ok(bot, 'no rehearsal partner offered in the lobby');
  assert.equal(bot.handle, 'Training Dummy (AI)');
  assert.equal(bot.compatible, true, 'the dummy must mirror the challenger or it cannot be fought');
  assert.equal(bot.fighter.species, 'galador');
});

test('the dummy NEVER enters matchmaking — queueing still only finds humans', () => {
  const { e } = fixture();
  e.lobby('A');                                   // dummy now exists
  assert.ok(e.admissions.has('ai-A'));
  const q = e.queue('A');
  assert.equal(q.match_id, null, 'a queued player was paired with the AI');
  assert.equal(q.searching, true);
});

test('challenging the dummy starts the match at once and it is already ready', () => {
  const { e } = fixture();
  const bot = botOf(e.lobby('A'));
  const res = e.challenge('A', bot.trainer_id);
  assert.ok(res.match_id, 'challenging the dummy did not start a match');
  const snap = e.ready('A', res.match_id);        // only the human presses ready
  assert.equal(snap.status, 'active', 'the dummy did not hold up its end of readiness');
});

test('a rehearsal awards no XP: it records no completion at all', () => {
  const { e, advance } = fixture();
  const bot = botOf(e.lobby('A'));
  const mid = e.challenge('A', bot.trainer_id).match_id;
  e.ready('A', mid);
  for (let i = 0; i < 400 && e.matches.get(mid).status === 'active'; i++) { advance(1); e.tick(); }
  const m = e.matches.get(mid);
  assert.notEqual(m.status, 'active', 'the rehearsal never concluded');
  assert.equal(e.completions.size, 0, 'a rehearsal produced a completion — that is farmable XP');
  assert.deepEqual(e.drainCompletions(), []);
});

test('a real human match still completes and still awards XP', () => {
  // Two idle players end in a draw, and a draw has never recorded a completion — so this has to be
  // a match someone actually WINS, or it would pass while the regression it guards went unnoticed.
  const { e, trusted, advance } = fixture();
  e.admit(trusted('B'));
  e.queue('A'); const mid = e.queue('B').match_id;
  assert.ok(mid); e.ready('A', mid); e.ready('B', mid);
  let n = 0;
  for (let i = 0; i < 600 && e.matches.get(mid).status === 'active'; i++) {
    try { e.cast('A', mid, 6, `human-cast-${++n}`); } catch {}   // nova until B falls
    advance(0.5); e.tick();
  }
  const m = e.matches.get(mid);
  assert.equal(m.status, 'finished', `expected a won match, got ${m.status}`);
  assert.equal(e.completions.size, 1, 'a won human match stopped producing a completion — XP is broken');
  const done = e.drainCompletions()[0];
  assert.equal(done.players.length, 2);
  assert.ok(done.players.every(p => !String(p.wallet).startsWith('rehearsal:')));
});

test('the dummy actually fights — it casts and moves under the real rules', () => {
  const { e, advance } = fixture();
  const bot = botOf(e.lobby('A'));
  const mid = e.challenge('A', bot.trainer_id).match_id;
  e.ready('A', mid);
  const m = e.matches.get(mid);
  const self = m.players.find(p => p.trainer_id === 'ai-A');
  const start = { ...self.position };
  for (let i = 0; i < 40; i++) { advance(0.5); e.tick(); }
  assert.ok(m.metrics[self.side].cast_count > 0, 'the dummy never cast a card');
  const human = m.players.find(p => p.trainer_id === 'A');
  assert.ok(human.hp < human.max_hp, 'the dummy never actually hit anything');
  assert.notDeepEqual(self.position, start, 'the dummy never moved');
});

test('a rehearsal is never written into the durable checkpoint', () => {
  const { e } = fixture();
  const bot = botOf(e.lobby('A'));
  const mid = e.challenge('A', bot.trainer_id).match_id;
  e.ready('A', mid);
  assert.equal(e.checkpoint().matches.some(m => m.match_id === mid), false,
    'a rehearsal match was checkpointed; its opponent cannot survive a restart');
});

test('the dummy cannot outlive its owner', () => {
  const { e } = fixture();
  e.lobby('A');
  assert.ok(e.admissions.has('ai-A'));
  e.revoke('A');
  assert.equal(e.admissions.has('ai-A'), false, 'the dummy leaked after its owner was revoked');
  assert.equal(e.rehearsalIds.has('ai-A'), false);
});

test('rehearsal can be withdrawn entirely', () => {
  const { e } = fixture();
  e.rehearsal = false;
  assert.equal(botOf(e.lobby('A')), undefined, 'the dummy was offered while rehearsal was off');
  assert.equal(e.admissions.has('ai-A'), false);
});
