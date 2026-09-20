import test from 'node:test';
import assert from 'node:assert/strict';
import { ChikiseumLiveEngine, LiveRejected, COOLDOWNS, SPECIES_TRAITS, cardGeometry } from './chikiseum-live-engine.js';

// Pure-engine tests: trusted admissions are synthetic, never a production auth proof.
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
  let now = 1000, mono = 100, count = 0;
  const e = new ChikiseumLiveEngine({ navigation, clock: () => now, movementClock: () => mono, ...options });
  const trusted = (id, species = 'galador', level = 16) => ({ id, wallet: `wallet-${id}`, asset_id: `asset-${id}`,
    species, level, handle: `Player ${id}`, inventory_verified: true });
  e.admit(trusted('A')); e.admit(trusted('B'));
  const match = (active = true) => { e.queue('A'); const mid = e.queue('B').match_id;
    if (active) { e.ready('A', mid); e.ready('B', mid); } return mid; };
  return { e, trusted, match, advance: seconds => { now += seconds; mono += seconds; },
    cast: (mid, side = 'A', slot = 0, rid = `cast-request-${++count}`) => e.cast(side, mid, slot, rid),
    move: (mid, side, dx, dz, rid = `move-request-${++count}`) => e.move(side, mid, dx, dz, rid) };
}
const rejected = f => assert.throws(f, LiveRejected);

test('trusted owned-asset admission derives canonical stats and rejects fixture claims', () => {
  const { e, trusted } = fixture();
  for (const patch of [{ inventory_verified: false }, { level: 31 }, { level: 1.5 }, { species: 'unknown' }, { handle: '\nBAD' }]) rejected(() => e.admit({ ...trusted('C'), ...patch }));
  const s = e.admit({ ...trusted('C', 'doge', 1), hp: 99999, rarity: 'legendary', slots: [6], damage_multiplier: 999 });
  assert.equal(s.fighter.rarity, 'meme'); assert.equal(s.fighter.max_hp, 144.9);
  assert.deepEqual(s.fighter.slots, Array.from({ length: 12 }, (_, i) => i));
  assert.equal(s.level_source, 'server_earned_pvp'); assert.equal(s.currency, 'NONE');
  assert.equal(s.real_sol_enabled, false); assert.equal(s.inventory_verified, true); assert.equal(s.token, undefined);
});
test('all 41 species have bounded server-owned traits and a real favored card', () => {
  const { e, trusted } = fixture();
  assert.equal(Object.keys(SPECIES_TRAITS).length, 41);
  assert.equal(new Set(Object.values(SPECIES_TRAITS).map(t => t.name)).size, 41);
  for (const [species, trait] of Object.entries(SPECIES_TRAITS)) {
    assert.ok(e.species.get(species).some(c => c.arch === trait.signature_arch), `${species} lacks favored card`);
    for (const key of ['stride', 'focus', 'ward', 'reach']) assert.ok(trait[key] >= .9 && trait[key] <= 1.1, `${species}.${key}`);
  }
  const forged = e.admit({ ...trusted('C', 'firix'), trait: { name: 'Hacked', stride: 100, focus: 100,
    ward: 100, reach: 100, signature_effect: 'fury' } });
  assert.deepEqual(forged.fighter.trait, SPECIES_TRAITS.firix);
  assert.notEqual(forged.fighter.trait, SPECIES_TRAITS.firix);
});
test('species stride, focus, ward and reach change server-authoritative tactical outcomes', () => {
  const f = fixture(); f.e.admit(f.trusted('A', 'firix')); f.e.admit(f.trusted('B', 'forestle')); const mid = f.match();
  const m = f.e.matches.get(mid), a = m.players[0], b = m.players[1];
  assert.notEqual(a.trait.stride, b.trait.stride);
  assert.notEqual(a.trait.focus, b.trait.focus);
  assert.notEqual(a.trait.ward, b.trait.ward);
  assert.notEqual(a.trait.reach, b.trait.reach);
  const aRange = f.e.state('A', mid).you.hand[0].contact_range_m;
  const bRange = f.e.state('B', mid).you.hand[0].contact_range_m;
  assert.equal(aRange, cardGeometry(f.e.cards.get('firix:0'), a.trait).contact_range_m);
  assert.equal(bRange, cardGeometry(f.e.cards.get('forestle:0'), b.trait).contact_range_m);
  a.energy = 0; b.energy = 0; f.advance(.1); const energy = f.e.state('A', mid).players.map(p => p.energy);
  assert.ok(Math.abs(energy[0] - .1 * a.trait.focus) < 1e-9);
  assert.ok(Math.abs(energy[1] - .1 * b.trait.focus) < 1e-9);
  f.advance(.1); const ax = a.position.x, bx = b.position.x;
  f.move(mid, 'A', 1, 0); f.move(mid, 'B', -1, 0);
  assert.ok(Math.abs(a.position.x - ax - 3.8 * .2 * a.trait.stride) < 1e-9);
  assert.ok(Math.abs(bx - b.position.x - 3.8 * .2 * b.trait.stride) < 1e-9);
  a.position.x = -.75; b.position.x = .75; a.energy = 6;
  const hpBefore = b.hp, strike = f.e.cards.get('firix:0');
  f.cast(mid, 'A', 0); f.advance(.05); const impact = f.e.state('A', mid).events.find(x => x.type === 'impact');
  const expectedDamage = Math.round((strike.mechanics.dmg[a.card_tier] * a.damage_multiplier * 1.07 / b.trait.ward + Number.EPSILON) * 1000) / 1000;
  assert.equal(impact.amount, expectedDamage); assert.equal(b.hp, hpBefore - expectedDamage);
});
test('Quick card displayed range equals stride-scaled dash plus reach-scaled contact', () => {
  const { e } = fixture();
  for (const [species, expected] of [['nervousmonkey', 7.388], ['borealon', 6.6]]) {
    const geometry = cardGeometry(e.cards.get(`${species}:2`), SPECIES_TRAITS[species]);
    assert.equal(geometry.range_m, expected);
    assert.equal(geometry.range_m, Math.round((geometry.dash_range_m + geometry.contact_range_m) * 1000) / 1000);
    for (const [offset, shouldHit] of [[-.01, true], [.01, false]]) {
      const f = fixture(); f.e.admit(f.trusted('A', species)); f.e.admit(f.trusted('B', species));
      const mid = f.match(), m = f.e.matches.get(mid), distance = geometry.range_m + offset;
      m.players[0].position.x = -distance / 2; m.players[1].position.x = distance / 2;
      assert.equal(f.e.state('A', mid).you.hand[2].range_m, expected);
      f.cast(mid, 'A', 2); f.advance(.05);
      const impact = f.e.state('A', mid).events.find(x => x.type === 'impact');
      assert.equal(impact.reason === null, shouldHit, `${species} distance ${distance}`);
    }
  }
});
test('favored card procs once after real hit, not on misses or fully shielded targets', () => {
  const f = fixture(); f.e.admit(f.trusted('A', 'electrox')); f.e.admit(f.trusted('B', 'electrox')); const mid = f.match();
  const m = f.e.matches.get(mid), a = m.players[0], b = m.players[1];
  a.position.x = -.75; b.position.x = .75; b.energy = 3;
  f.cast(mid, 'A', 1, 'trait-real-hit-one'); f.advance(.05);
  let state = f.e.state('A', mid); let impact = state.events.find(x => x.type === 'impact');
  assert.equal(impact.signature_effect, 'sunder'); assert.equal(impact.signature_triggered, true);
  assert.equal(impact.signature_amount, .25);
  assert.ok(Math.abs(b.energy - (3 + .05 * b.trait.focus + .05 - .25)) < 1e-9);
  f.cast(mid, 'A', 1, 'trait-real-hit-one'); assert.ok(Math.abs(b.energy - (3 + .05 * b.trait.focus + .05 - .25)) < 1e-9);

  const shielded = fixture(); shielded.e.admit(shielded.trusted('A', 'electrox')); shielded.e.admit(shielded.trusted('B', 'electrox'));
  const sid = shielded.match(), sm = shielded.e.matches.get(sid), sp = sm.players[1];
  sm.players[0].position.x = -.75; sp.position.x = .75; sp.energy = 3;
  sp.statuses.shield = { slot: 3, source_side: 'B', amount: 100, expires_at: 1004 };
  shielded.cast(sid, 'A', 1); shielded.advance(.05); state = shielded.e.state('A', sid);
  impact = state.events.find(x => x.type === 'impact'); assert.equal(impact.amount, 0);
  assert.equal(impact.signature_triggered, undefined);
  assert.ok(Math.abs(sp.energy - (3 + .05 * sp.trait.focus + .05)) < 1e-9);

  const missed = fixture(); missed.e.admit(missed.trusted('A', 'electrox')); missed.e.admit(missed.trusted('B', 'electrox'));
  const mid2 = missed.match(); missed.e.matches.get(mid2).players[1].position.x = 20;
  missed.cast(mid2, 'A', 1); missed.advance(.05); state = missed.e.state('A', mid2);
  impact = state.events.find(x => x.type === 'impact'); assert.equal(impact.reason, 'out_of_range');
  assert.equal(impact.signature_triggered, undefined);
});
test('support signatures trigger only on favored valid cast and never exceed HP/energy caps', () => {
  const f = fixture(); f.e.admit(f.trusted('A', 'adalor')); f.e.admit(f.trusted('B', 'adalor')); const mid = f.match();
  const a = f.e.matches.get(mid).players[0]; a.hp -= 10;
  f.cast(mid, 'A', 9, 'adalor-rally-once'); f.advance(.05); const s = f.e.state('A', mid);
  assert.equal(a.hp, a.max_hp - 6);
  const cast = s.events.find(x => x.type === 'cast'); assert.equal(cast.signature_effect, 'recover');
  assert.equal(cast.signature_amount, 4);
  f.cast(mid, 'A', 9, 'adalor-rally-once'); assert.equal(a.hp, a.max_hp - 6);
  const g = fixture(); g.e.admit(g.trusted('A', 'dragonos')); g.e.admit(g.trusted('B', 'dragonos'));
  const gm = g.match(); g.e.matches.get(gm).players[0].energy = 2;
  g.cast(gm, 'A', 4); g.advance(.05); const charge = g.e.state('A', gm).events.find(x => x.type === 'cast');
  assert.equal(charge.signature_effect, 'surge'); assert.equal(charge.signature_amount, .25);
  assert.ok(g.e.matches.get(gm).players[0].energy <= 6);
});
test('one account and one asset lease; failed switch does not erase prior admission', () => {
  const { e, trusted } = fixture();
  rejected(() => e.admit({ ...trusted('C'), wallet: 'wallet-A' }));
  rejected(() => e.admit({ ...trusted('C'), asset_id: 'asset-A' }));
  rejected(() => e.admit({ ...trusted('A'), asset_id: 'asset-B' }));
  assert.equal(e.admissions.get('A').asset_id, 'asset-A');
  const mid = fixture(); mid.match(); rejected(() => mid.e.admit({ ...mid.trusted('A'), level: 17 }));
});
test('current verified admission required for every private API', () => {
  const { e, match } = fixture(); const mid = match();
  for (const f of [() => e.lobby('unknown'), () => e.queue('unknown'), () => e.state('unknown', mid),
    () => e.ready('unknown', mid), () => e.cast('unknown', mid, 0, 'request-id-one'), () => e.move('unknown', mid, 1, 0, 'request-id-one'), () => e.cancel('unknown', mid)]) rejected(f);
});
test('private views reveal only own hand and no wallets, assets, request ledgers or metrics', () => {
  const { e, match } = fixture(); const mid = match();
  const a = e.state('A', mid), b = e.state('B', mid);
  assert.equal(a.you.side, 'A'); assert.equal(b.you.side, 'B');
  assert.equal(a.you.asset_id, 'asset-A'); assert.equal(b.you.asset_id, 'asset-B');
  assert.equal(a.you.hand.length, 12); assert.equal(a.players[1].slots, undefined);
  for (const name of ['identities', 'metrics', 'cast_requests', 'move_requests', 'cooldowns', 'movement', 'seq']) assert.equal(a[name], undefined);
  assert.ok(!JSON.stringify(a).includes('wallet-')); assert.ok(!JSON.stringify(a.players).includes('asset-'));
  assert.ok(!JSON.stringify(a).includes('asset-B'));
  a.players[0].hp = 0; a.you.hand.length = 0; assert.ok(e.state('A', mid).players[0].hp > 0);
});
test('ready gate, stable full hand, no turn/commit mechanics', () => {
  const { e, match, cast, advance } = fixture(); const mid = match(false);
  rejected(() => cast(mid)); assert.equal(e.ready('A', mid).status, 'ready');
  const s = e.ready('B', mid); assert.equal(s.status, 'active'); assert.equal(s.turn, 0);
  assert.equal(s.deadline, 1180); assert.equal(s.you.committed, false); assert.equal(s.tempo, undefined);
  const hand = s.you.hand; advance(.1); assert.deepEqual(e.state('A', mid).you.hand, hand); rejected(() => e.ready('A', mid));
});
test('accepted cast reserves once, resolves only on 50ms tick, replay exact ACK', () => {
  const { e, match, cast, advance } = fixture(); const mid = match(); const hp = e.state('B', mid).players[1].hp;
  const s = cast(mid, 'A', 0, 'accepted-cast-one'); assert.equal(s.players[0].energy, 2); assert.equal(s.players[1].hp, hp);
  assert.equal(s.cast_ack, s.you.cast_ack); assert.equal(s.cast_queued, true); assert.deepEqual(s.events, []);
  assert.equal(cast(mid, 'A', 0, 'accepted-cast-one').players[0].energy, 2);
  advance(.049); assert.deepEqual(e.state('A', mid).events, []); advance(.001);
  const done = e.state('A', mid); assert.deepEqual(done.events.map(x => x.type), ['cast', 'impact']);
  assert.equal(done.players[1].hp, hp - 27.04); assert.equal(done.events[0].card_key, 'galador:0');
  assert.ok(done.events.every(x => x.confirmed && x.turn === 0 && x.request_id === undefined));
  const replay = cast(mid, 'A', 0, 'accepted-cast-one'); assert.equal(replay.cast_queued, false); assert.equal(replay.you.cast_ack, 'accepted-cast-one');
});
test('simultaneous attacks resolve both despite lethal first displayed impact', () => {
  const { e, match, cast, advance } = fixture(); const mid = match();
  e.matches.get(mid).players.forEach(p => p.hp = 20);
  cast(mid, 'B'); advance(.01); cast(mid, 'A'); advance(.04); const s = e.state('A', mid);
  assert.equal(s.status, 'finished'); assert.equal(s.winner, null); assert.deepEqual(s.players.map(p => p.hp), [0, 0]);
  assert.equal(s.events.filter(x => x.type === 'impact').length, 2); assert.equal(s.events.filter(x => x.type === 'finish').length, 1);
  e.tick(); e.tick(); assert.equal(e.drainCompletions().length, 1); assert.equal(e.drainCompletions()[0].players[0].damage_dealt, 20);
});
test('later tick cannot cast after previous lethal hit', () => {
  const { e, match, cast, advance } = fixture(); const mid = match(); e.matches.get(mid).players[1].hp = 1;
  cast(mid); advance(.051); rejected(() => cast(mid, 'B')); assert.equal(e.state('A', mid).winner, 'A');
});
test('cooldowns, energy, request reuse and finite input are authoritative', () => {
  const { e, match, cast, advance, move } = fixture(); const mid = match(); cast(mid, 'A', 0, 'reuse-command-one');
  rejected(() => cast(mid, 'A', 1)); advance(.18); cast(mid, 'A', 1); advance(.18);
  rejected(() => cast(mid, 'A', 6)); rejected(() => cast(mid, 'A', 1, 'reuse-command-one'));
  rejected(() => cast(mid, 'B', 0, 'reuse-command-one'));
  for (const slot of [NaN, Infinity, -1, 12, .5, '0']) rejected(() => e.cast('A', mid, slot, 'bad-slot-request'));
  for (const input of [NaN, Infinity, -2, 2, '1']) rejected(() => move(mid, 'A', input, 0));
  for (const rid of ['', 'short', 'x'.repeat(81), '\nrequest-id']) rejected(() => e.cast('A', mid, 0, rid));
});
test('movement is simultaneous, intent-only, monotonic-cadenced and max .2s', () => {
  const { e, match, advance, move, cast } = fixture(); const mid = match();
  rejected(() => move(mid, 'A', 1, 0)); advance(1); const first = move(mid, 'A', 1, 0, 'move-idempotent-one');
  const expectedStep = 3.8 * .2 * first.players[0].trait.stride;
  assert.equal(first.players[0].position.x, -5 + expectedStep); const replay = move(mid, 'A', 1, 0, 'move-idempotent-one');
  assert.deepEqual(replay.players[0].position, first.players[0].position); rejected(() => move(mid, 'A', -1, 0, 'move-idempotent-one'));
  cast(mid); advance(.05); move(mid, 'B', 0, 1); move(mid, 'A', 0, 1);
  assert.equal(e.state('A', mid).players[0].movement_remaining, undefined);
  advance(.2); const before = e.state('A', mid).players[0].position; const diagonal = move(mid, 'A', 1, 1);
  assert.ok(Math.abs(Math.hypot(diagonal.players[0].position.x - before.x, diagonal.players[0].position.z - before.z) - expectedStep) < 1e-9);
});
test('standard/overtime/crest fractional regen and cap6', () => {
  const { e, match, advance } = fixture(); const mid = match();
  const focus = e.state('A', mid).players[0].trait.focus;
  e.matches.get(mid).players[0].energy = 0; advance(.25); assert.equal(e.state('A', mid).players[0].energy, .25 * focus);
  e.matches.get(mid).players[0].position = { x: 0, y: 0, z: 0 }; advance(.25); assert.equal(e.state('A', mid).players[0].energy, .5 * focus + .25);
  for (let i = 0; i < 3; i++) { advance(30); e.state('A', mid); e.state('B', mid); }
  e.matches.get(mid).players[0].energy = 0; e.matches.get(mid).players[0].position = { x: -5, y: 0, z: 0 };
  advance(.2); const s = e.state('A', mid); assert.equal(s.realtime.phase, 'overtime'); assert.equal(s.players[0].energy, .3 * focus);
});
test('range misses and blocked LOS do not heal, weaken or drain energy', () => {
  for (const slot of [5, 8, 10]) {
    const { e, match, cast, advance } = fixture(); const mid = match(); const m = e.matches.get(mid); m.players[1].position.x = 20; m.players[0].hp -= 30;
    cast(mid, 'A', slot); advance(.05); const s = e.state('A', mid);
    assert.equal(s.events.find(x => x.type === 'impact').reason, 'out_of_range'); assert.equal(s.players[0].hp, m.players[0].max_hp - 30);
    assert.equal(s.events.some(x => x.type === 'heal' || x.status === 'weaken'), false);
  }
  const { e, match, cast, advance } = fixture({ navigation: { ...navigation, lineOfSight: () => false } }); const mid = match(); cast(mid); advance(.05);
  assert.equal(e.state('A', mid).events.find(x => x.type === 'impact').reason, 'blocked_line_of_sight');
});
test('guard blocks before opposing damage and expires with exact original card identity', () => {
  const { e, match, cast, advance } = fixture(); const mid = match(); cast(mid, 'A', 3); cast(mid, 'B', 0); advance(.05);
  const s = e.state('A', mid); assert.equal(s.players[0].hp, s.players[0].max_hp);
  assert.equal(s.events.find(x => x.type === 'block').slot, 3); assert.equal(s.players[0].statuses.shield.remaining_seconds, 4);
  advance(4); const end = e.state('A', mid).events.find(x => x.type === 'status_end'); assert.equal(end.slot, 3); assert.equal(end.side, 'A');
});
test('charge/rally persistent states, charge consumption, wither source identity', () => {
  const { e, match, cast, advance } = fixture(); const mid = match(); cast(mid, 'A', 4); advance(.05);
  assert.equal(e.state('A', mid).players[0].statuses.charge.remaining_seconds, 8);
  advance(.18); cast(mid, 'A', 9); advance(.05); assert.ok(e.state('A', mid).players[0].statuses.rally);
  advance(.18); cast(mid); advance(.05); assert.equal(e.state('A', mid).players[0].statuses.charge, undefined);
  e.matches.get(mid).players[1].energy = 6; advance(.18); cast(mid, 'B', 10); advance(.05);
  const weaken = e.state('A', mid).players[0].statuses.weaken; assert.equal(weaken.source_side, 'B'); assert.equal(weaken.slot, 10); assert.ok(weaken.remaining_seconds <= 6 && weaken.remaining_seconds > 5.9);
});
test('drain heals only accepted living caster; full HP gets no heal event; nova recoil survives miss', () => {
  const { e, match, cast, advance } = fixture(); const mid = match(); e.matches.get(mid).players[0].position.x = 3.4;
  cast(mid, 'A', 5); advance(.05); assert.equal(e.state('A', mid).events.some(x => x.type === 'heal'), false);
  advance(1.6); e.matches.get(mid).players[0].hp -= 40; cast(mid, 'A', 5); advance(.05);
  assert.ok(e.state('A', mid).events.some(x => x.type === 'heal' && x.amount > 0));
  advance(.2); e.matches.get(mid).players[0].energy = 6; e.matches.get(mid).players[1].position.x = 20;
  const hp = e.matches.get(mid).players[0].hp; cast(mid, 'A', 6); advance(.05); const s = e.state('A', mid);
  assert.ok(s.players[0].hp < hp); assert.ok(s.events.some(x => x.type === 'recoil'));
});
test('dual quick plans use frozen positions and show continuous dash provenance', () => {
  const { e, match, cast, advance } = fixture(); const mid = match(); cast(mid, 'A', 2); cast(mid, 'B', 2); advance(.05);
  const s = e.state('A', mid), casts = s.events.filter(x => x.type === 'cast');
  assert.equal(casts.length, 2); assert.equal(casts[0].dash_distance_m, 4.375); assert.equal(casts[1].dash_distance_m, 4.375);
  assert.equal(s.players[0].position.x, -.625); assert.equal(s.players[1].position.x, .625);
  assert.ok(casts.every(x => x.dash_duration > 0 && x.dash_from && x.dash_to));
});
test('ready timeout, cancellation, disconnect/inactivity, revocation and restart never award', () => {
  for (const kind of ['ready', 'cancel', 'revoke', 'inactive', 'shutdown']) {
    const { e, match, advance } = fixture(); const mid = match(kind !== 'ready');
    if (kind === 'ready') { advance(30); e.tick(); }
    if (kind === 'cancel') e.cancel('A', mid);
    if (kind === 'revoke') e.revoke('A');
    if (kind === 'inactive') { advance(45); e.tick(); }
    if (kind === 'shutdown') e.shutdown();
    assert.equal(e.drainCompletions().length, 0); assert.equal(e.leases.size, 0); assert.notEqual(e.matches.get(mid).status, 'active');
  }
});
test('match timeout uses HP fractions, not caller outcome; terminal completion non-destructive ack', () => {
  const { e, match, advance } = fixture(); const mid = match(); e.matches.get(mid).players[1].hp -= 20;
  for (let i = 0; i < 6; i++) { advance(30); if (i < 5) { e.state('A', mid); e.state('B', mid); } }
  const s = e.state('A', mid); assert.equal(s.winner, 'A'); assert.equal(s.status, 'finished');
  const one = e.drainCompletions(); assert.equal(one.length, 1); assert.equal(one[0].players[0].wallet, 'wallet-A');
  one[0].winner = 'B'; assert.equal(e.drainCompletions()[0].winner, 'A'); assert.equal(e.acknowledgeCompletion(mid), true); assert.equal(e.acknowledgeCompletion(mid), false);
});
test('bounded lobby/queue/challenges and expiring account/asset sessions', () => {
  const { e, trusted, advance } = fixture({ maxAdmissions: 7, sessionTTL: 60 });
  for (let i = 0; i < 5; i++) e.admit(trusted(`C${i}`)); rejected(() => e.admit(trusted('overflow')));
  for (let i = 0; i < 4; i++) e.challenge('A', `C${i}`); rejected(() => e.challenge('A', 'C4'));
  const first = e.challenge('A', 'C0').challenge_id; assert.equal(e.challenge('A', 'C0').challenge_id, first);
  assert.equal(e.lobby('C0').challenges.length, 1); advance(30); e.tick(); assert.equal(e.challenges.size, 0);
  advance(31); e.tick(); assert.equal(e.admissions.size, 0); assert.equal(e.accounts.size, 0); assert.equal(e.assets.size, 0);
});
test('challenge only target accepts; cancellation clears both invitations and queue', () => {
  const { e, trusted } = fixture(); e.admit(trusted('C')); const cid = e.challenge('A', 'B').challenge_id;
  rejected(() => e.accept('C', cid)); const mid = e.accept('B', cid).match_id; assert.equal(e.state('A', mid).status, 'ready');
  rejected(() => e.accept('B', cid)); e.cancel('A', mid); e.queue('A'); e.challenge('A', 'B'); e.cancel('A'); assert.equal(e.challenges.size, 0); assert.equal(e.queueEntries.size, 0);
});
test('checkpoint is serializable, restart cancels active but preserves normal completions', () => {
  const { e, match, cast, advance } = fixture(); const mid = match(); cast(mid);
  const checkpoint = JSON.parse(JSON.stringify(e.checkpoint())); const fresh = fixture().e; fresh.admissions.clear(); fresh.accounts.clear(); fresh.assets.clear();
  assert.equal(fresh.restore(checkpoint).cancelled_on_restart, 1); assert.equal(fresh.matches.get(mid).pending_casts.length, 0); assert.equal(fresh.drainCompletions().length, 0);
  const legacy = structuredClone(checkpoint); for (const player of legacy.matches[0].players) delete player.trait;
  const legacyEngine = fixture().e; legacyEngine.admissions.clear(); legacyEngine.accounts.clear(); legacyEngine.assets.clear();
  assert.equal(legacyEngine.restore(legacy).cancelled_on_restart, 1);
  assert.deepEqual(legacyEngine.matches.get(mid).players[0].trait, SPECIES_TRAITS.galador);
  assert.equal(legacy.matches[0].players[0].trait, undefined); // Restore never rewrites its caller's durable record.
  const completed = fixture(); const cmid = completed.match(); completed.e.matches.get(cmid).players[1].hp = 1; completed.cast(cmid); completed.advance(.05); completed.e.tick();
  const restored = fixture().e; restored.admissions.clear(); restored.accounts.clear(); restored.assets.clear(); restored.restore(JSON.parse(JSON.stringify(completed.e.checkpoint())));
  assert.equal(restored.drainCompletions().length, 1); assert.equal(restored.drainCompletions()[0].match_id, cmid);
});
test('catalogue 402 cards every archetype has explicit cooldown and exact geometry', () => {
  const { e } = fixture(); assert.equal(e.cards.size, 402);
  for (const c of e.cards.values()) { assert.ok(COOLDOWNS[c.arch] > 0); const g = cardGeometry(c);
    assert.equal(g.delivery, c.delivery); assert.equal(g.arch, c.arch); assert.ok(g.range_m >= 0 && g.range_m <= 12); }
});
test('match, event, cast and movement caches fail closed at declared bounds', () => {
  const small = fixture({ maxMatches: 1 }); small.match(); small.e.admit(small.trusted('C')); small.e.admit(small.trusted('D'));
  small.e.queue('C'); rejected(() => small.e.queue('D'));
  const f = fixture(); const mid = f.match(); const m = f.e.matches.get(mid);
  for (let i = 0; i < 4096; i++) m.cast_requests.set(`bounded-cast-${i}`, { side: 'B', slot: 0 });
  rejected(() => f.cast(mid));
  for (let i = 0; i < 16384; i++) m.move_requests.set(`bounded-move-${i}`, ['B', 0, 0]);
  f.advance(.1); rejected(() => f.move(mid, 'A', 1, 0));
  for (let i = 0; i < 1100; i++) f.e._event(m, m.players[0], 'impact', 0, { amount: 0 });
  assert.equal(m.events.length, 1024); assert.equal(m.events.at(-1).seq, 1100); assert.equal(m.events[0].seq, 77);
});
test('corrupt checkpoint cannot restore mutated stats, identities, cardinality or rewards', () => {
  const f = fixture(); f.match(); const checkpoint = JSON.parse(JSON.stringify(f.e.checkpoint()));
  for (const corrupt of [c => c.matches[0].players[0].max_hp = 99999,
    c => c.matches[0].players[0].trait.ward = 100,
    c => c.matches[0].players[0].energy = 7,
    c => c.matches[0].identities.A.wallet = '',
    c => c.matches[0].metrics.A.damage_dealt = NaN,
    c => c.matches[0].currency = 'SOL',
    c => c.matches[0].cast_requests = 'not-an-array',
    c => c.arena_sha256 = 'wrong']) {
    const altered = structuredClone(checkpoint); corrupt(altered); const fresh = fixture().e;
    fresh.admissions.clear(); fresh.accounts.clear(); fresh.assets.clear(); assert.throws(() => fresh.restoreCheckpoint(altered));
    assert.equal(fresh.matches.size, 0); assert.equal(fresh.drainCompletions().length, 0);
  }
});
test('terminal expiry and revoked admissions free bounded slots without losing unacked completion', () => {
  const f = fixture({ terminalTTL: 30 }); const mid = f.match(); f.e.matches.get(mid).players[1].hp = 1;
  f.cast(mid); f.advance(.05); f.e.tick(); assert.equal(f.e.drainCompletions().length, 1);
  f.advance(31); f.e.tick(); assert.equal(f.e.matches.size, 0); assert.equal(f.e.drainCompletions().length, 1);
  f.e.revoke('A'); assert.equal(f.e.accounts.has('wallet-A'), false); assert.equal(f.e.assets.has('asset-A'), false);
});
test('128 legal full-cache matches checkpoint below8MiB without mutating runtime replay/event state', () => {
  const f = fixture({ maxMatches: 128 });
  const castEntries = Array.from({ length: 4096 }, (_, i) => [`legal-cast-request-${i}`, { side: 'A', slot: 0 }]);
  const moveEntries = Array.from({ length: 16384 }, (_, i) => [`legal-move-request-${i}`, ['A', 0, 1]]);
  for (let i = 0; i < 128; i++) {
    const a = i === 0 ? 'A' : `CapacityA${i}`, b = i === 0 ? 'B' : `CapacityB${i}`;
    if (i) { f.e.admit(f.trusted(a)); f.e.admit(f.trusted(b)); }
    f.e.queue(a); const mid = f.e.queue(b).match_id; f.e.ready(a, mid); f.e.ready(b, mid);
    const m = f.e.matches.get(mid); m.cast_requests = new Map(castEntries); m.move_requests = new Map(moveEntries);
    m.pending_casts = [{ side: 'A', slot: 0, request_id: 'legal-cast-request-4095', resolve_at: 1000.05 }];
    for (let j = 0; j < 1024; j++) f.e._event(m, m.players[0], 'impact', 0, { amount: 0 });
  }
  const checkpoint = f.e.checkpoint(), bytes = Buffer.byteLength(JSON.stringify(checkpoint));
  assert.equal(checkpoint.matches.length, 128); assert.ok(bytes < 8 * 1024 * 1024, `${bytes} exceeds checkpoint headroom`);
  for (const m of f.e.matches.values()) { assert.equal(m.cast_requests.size, 4096); assert.equal(m.move_requests.size, 16384); assert.equal(m.events.length, 1024); assert.equal(m.pending_casts.length, 1); }
  for (const saved of checkpoint.matches) { assert.deepEqual(saved.cast_requests, []); assert.deepEqual(saved.move_requests, []); assert.deepEqual(saved.pending_casts, []); assert.equal(saved.events.length, 8); }
  const restored = fixture({ maxMatches: 128 }).e; restored.admissions.clear(); restored.accounts.clear(); restored.assets.clear();
  assert.equal(restored.restoreCheckpoint(JSON.parse(JSON.stringify(checkpoint))).cancelled_on_restart, 128);
  assert.equal(restored.drainCompletions().length, 0);
  console.log('CHIKISEUM_CHECKPOINT_CAPACITY_JSON ' + JSON.stringify({ matches: 128, runtime_cast_ids: 128 * 4096,
    runtime_move_ids: 128 * 16384, runtime_events: 128 * 1024, checkpoint_bytes: bytes, limit_bytes: 8 * 1024 * 1024,
    runtime_unchanged: true, restart_cancelled: 128, xp_completions: 0 }));
});
