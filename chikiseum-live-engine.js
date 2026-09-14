/* Free-only authoritative Chikiseum. No HTTP, wallet verification or economy authority.
 * The adapter MUST authenticate every call and construct admission records from
 * owned, active registry assets plus a server-approved level policy. Never pass
 * request-body fighter records to admit(). This module is synchronous: a single
 * process owns each match/tick; adapters must not share mutable matches across workers.
 */
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

export const CATALOGUE_SHA256 = '8347a90aec5091ae174c6fef17389fa78114ec118efa7ab21cb008c7bd2cd79c';
export const RULES = Object.freeze({ schema: 'chikiseum.reference-live/v1', tick_seconds: .05,
  duration_seconds: 180, overtime_seconds: 90, standard_energy_regen_per_second: 1,
  overtime_energy_regen_per_second: 1.5, crest_energy_regen_per_second: 1,
  global_cooldown_seconds: .18, bulwark_shield_seconds: 6, inactivity_seconds: 45,
  timeout_rule: 'higher_hp_fraction_else_draw', movement_budgeted: false });
export const COOLDOWNS = Object.freeze({ strike: .65, blast: 1.2, quick: 1.5, guard: 3,
  charge: 6, drain: 1.6, nova: 4, rend: 1.1, jolt: 1.6, rally: 7, wither: 3, bulwark: 5 });
export const STATUS_SECONDS = Object.freeze({ shield: 4, charge: 8, rally: 8, weaken: 6 });
const RARITY = { normal: [1, 1], legendary: [1.08, 1.04], meme: [1.15, 1.08] };
const SELF = new Set(['guard', 'bulwark', 'charge', 'rally']);
const RANGED = new Set(['straight_bolt', 'homing_orb', 'chain_bolt', 'siphon_tether',
  'curse_spiral', 'gaze_ray', 'line_rend', 'target_drop', 'target_snap']);
const WAVES = new Set(['cone_wave', 'ground_wave', 'wide_wave', 'radial_snap', 'curse_field']);
const ACTIVE = new Set(['ready', 'active']);
const copy = x => structuredClone(x);
const round = (x, places = 3) => Math.round((x + Number.EPSILON) * 10 ** places) / 10 ** places;
const opposite = s => s === 'A' ? 'B' : 'A';
const opaque = () => randomBytes(18).toString('hex');
const safe = s => typeof s === 'string' && s.length > 0 && s.length <= 160 && !/[\x00-\x1f\x7f]/.test(s);
const freeze = obj => { if (obj && typeof obj === 'object') { Object.values(obj).forEach(freeze); Object.freeze(obj); } return obj; };
export class LiveRejected extends Error {
  constructor(message, code = 'INVALID_COMMAND', status = 400) { super(message); this.name = 'LiveRejected'; this.code = code; this.status = status; }
}
const fail = (message, code, status) => { throw new LiveRejected(message, code, status); };
const finite = (x, min, max, field) => {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) fail(`Invalid ${field}`);
  return x;
};
const integer = (x, min, max, field) => { finite(x, min, max, field); if (!Number.isInteger(x)) fail(`Invalid ${field}`); return x; };
const requestId = id => { if (!safe(id) || id.length < 8 || id.length > 80) fail('A stable request ID is required'); };

export function cardGeometry(card) {
  const { arch, delivery } = card;
  let reach;
  if (SELF.has(arch)) reach = 0;
  else if (arch === 'quick') reach = 6.9;
  else if (arch === 'nova' || RANGED.has(delivery)) reach = 12;
  else if (WAVES.has(delivery)) reach = round(Math.min(9, Math.max(2.8, card.radius * .05)));
  else reach = 1.9;
  return { range_m: reach, contact_range_m: arch === 'quick' ? 1.9 : reach,
    dash_range_m: arch === 'quick' ? 5 : 0, range_model: 'practice_delivery/v1', delivery, arch };
}

export class ChikiseumLiveEngine {
  constructor({ cataloguePath = new URL('./chikiseum-profiles.json', import.meta.url), navigation,
    clock = () => Date.now() / 1000, movementClock = () => performance.now() / 1000,
    maxAdmissions = 512, maxMatches = 128, sessionTTL = 900, terminalTTL = 300 } = {}) {
    if (!navigation || ['binding', 'actorHome', 'validPosition', 'sweepIntent', 'lineOfSight', 'onEmblem']
      .some(k => typeof navigation[k] !== 'function')) throw new Error('Exact hash-bound navigation required');
    const raw = readFileSync(cataloguePath);
    this.catalogue_sha256 = createHash('sha256').update(raw).digest('hex');
    if (this.catalogue_sha256 !== CATALOGUE_SHA256) throw new Error('Canonical catalogue hash changed');
    const parsed = JSON.parse(raw);
    if (parsed.schema !== 'chikimon.card-visual-profiles/v1' || parsed.cards?.length !== 402) throw new Error('Invalid canonical catalogue');
    this.cards = new Map(); this.species = new Map();
    for (const c of parsed.cards) {
      if (!safe(c.species) || c.key !== `${c.species}:${c.slot}` || this.cards.has(c.key) || !RARITY[c.class]
        || !Object.hasOwn(COOLDOWNS, c.arch)) throw new Error('Invalid canonical card identity');
      integer(c.slot, 0, 11, 'canonical slot'); finite(c.radius, 0, 1000, 'canonical radius');
      integer(c.mechanics?.cost, 0, 6, 'canonical energy');
      const fields = SELF.has(c.arch) ? ({ guard: ['shield'], bulwark: ['shield'], charge: ['nextmul'], rally: ['buff'] })[c.arch] : ['dmg'];
      for (const key of [...fields, ...(c.arch === 'drain' ? ['heal'] : []), ...(c.arch === 'nova' ? ['recoil'] : []), ...(c.arch === 'wither' ? ['weaken'] : [])]) {
        if (!Array.isArray(c.mechanics[key]) || c.mechanics[key].length !== 3) throw new Error('Invalid mechanics tier');
        c.mechanics[key].forEach(x => finite(x, 0, 10000, 'canonical mechanic'));
      }
      if (c.arch === 'charge') finite(c.mechanics.energy, 0, 6, 'canonical charge');
      if (c.arch === 'jolt') finite(c.mechanics.drain_e, 0, 6, 'canonical drain');
      const immutable = freeze(c); this.cards.set(c.key, immutable);
      if (!this.species.has(c.species)) this.species.set(c.species, []);
      this.species.get(c.species).push(immutable);
    }
    for (const values of this.species.values()) {
      values.sort((a, b) => a.slot - b.slot);
      if (values.some((c, i) => c.slot !== i || c.class !== values[0].class)) throw new Error('Noncontiguous canonical kit');
    }
    this.navigation = navigation;
    this.arena = freeze({ ...navigation.binding(), realtime_rules: { ...RULES,
      card_cooldowns_seconds: COOLDOWNS, status_seconds: STATUS_SECONDS } });
    if (this.arena.reference_plan_sha256 !== '4f37041b6c132b542284dd22c4d1b7445ccc3c3900c3ee6a6bdc58e21eea682b'
      || this.arena.floor_radius_m !== 24 || this.arena.real_sol_enabled !== false) throw new Error('Unsafe navigation binding');
    this.clock = clock; this.movementClock = movementClock;
    this.maxAdmissions = integer(maxAdmissions, 2, 20000, 'admission limit');
    this.maxMatches = integer(maxMatches, 1, 10000, 'match limit');
    this.sessionTTL = finite(sessionTTL, 60, 3600, 'session TTL');
    this.terminalTTL = finite(terminalTTL, 30, 3600, 'terminal TTL');
    this.admissions = new Map(); this.accounts = new Map(); this.assets = new Map();
    this.matches = new Map(); this.leases = new Map(); this.queueEntries = new Map(); this.challenges = new Map(); this.completions = new Map();
    // REHEARSAL — an explicitly-labelled practice opponent. It is offered in the lobby ONLY and is
    // never placed in the matchmaking queue, so "no AI is filling the queue" stays literally true:
    // a player who queues is still only ever paired with a human. A rehearsal match records NO
    // completion, so it awards no battle XP and cannot be farmed for levels, and it is excluded
    // from the durable checkpoint because its opponent does not survive a restart.
    this.rehearsal = true; this.rehearsalIds = new Set();
    this.closed = false; this.lastClock = -Infinity;
  }

  _now() { const n = finite(this.clock(), 0, Number.MAX_SAFE_INTEGER, 'server clock'); if (n < this.lastClock - 1e-9) fail('Server clock moved backwards', 'CLOCK_INVALID', 503); this.lastClock = n; return n; }
  _mono() { return finite(this.movementClock(), 0, Number.MAX_SAFE_INTEGER, 'movement clock'); }
  _flags() { return { mode: 'live', currency: 'NONE', real_sol_enabled: false, inventory_verified: true }; }
  _guard() { if (this.closed) fail('Live service is restarting', 'UNAVAILABLE', 503); }
  _fighter(record) {
    const kit = this.species.get(record.species);
    if (!kit) fail('Unknown canonical fighter');
    integer(record.level, 1, 30, 'server-approved fighter level');
    const [hpMul, damageMul] = RARITY[kit[0].class];
    return { asset_id: record.asset_id, species: record.species, display_name: kit[0].display_name,
      rarity: kit[0].class, level: record.level, card_tier: record.level < 8 ? 0 : record.level < 16 ? 1 : 2,
      max_hp: round((120 + 6 * record.level) * hpMul), damage_multiplier: damageMul, slots: kit.map(c => c.slot), level_source: 'server_earned_pvp' };
  }
  admit(record) {
    this._guard(); this.expire();
    if (!record || record.inventory_verified !== true || ['id', 'wallet', 'asset_id', 'handle'].some(k => !safe(record[k]))) fail('Trusted owned-asset admission required', 'ADMISSION_DENIED', 403);
    const fighter = this._fighter(record), handle = record.handle.trim().slice(0, 24);
    if (!handle) fail('Trusted handle required');
    const prior = this.admissions.get(record.id);
    const replacing = prior && (prior.wallet !== record.wallet || prior.asset_id !== record.asset_id || prior.fighter.species !== fighter.species || prior.fighter.level !== fighter.level);
    if (replacing && this.leases.has(prior.id)) fail('Cannot replace a matched fighter', 'ACCOUNT_BUSY', 409);
    const account = this.accounts.get(record.wallet), asset = this.assets.get(record.asset_id);
    if ((account && account !== record.id) || (asset && asset !== record.id)) fail('Account or asset already admitted', 'ACCOUNT_BUSY', 409);
    if (!this.admissions.has(record.id) && this.admissions.size >= this.maxAdmissions) fail('Admission capacity reached', 'CAPACITY', 503);
    if (replacing) this._removeAdmission(prior.id);
    const now = this._now();
    const admission = { id: record.id, wallet: record.wallet, asset_id: record.asset_id, handle, fighter,
      expires_at: now + this.sessionTTL, last_seen: now };
    this.admissions.set(record.id, admission); this.accounts.set(record.wallet, record.id); this.assets.set(record.asset_id, record.id);
    return { schema: 'chikiseum.live-session/v1', ...this._flags(), trainer_id: record.id,
      expires_at: admission.expires_at, fighter: copy(fighter), handle,
      catalogue_sha256: this.catalogue_sha256, arena: copy(this.arena), level_source: 'server_earned_pvp' };
  }
  static REHEARSAL_HANDLE = 'Training Dummy (AI)';
  isRehearsal(id) { return this.rehearsalIds.has(id); }
  _rehearsalMatch(m) { return m.players.some(p => this.rehearsalIds.has(p.trainer_id)); }
  // One partner per trainer, mirroring their fighter exactly. Mirroring is not flavour: compatible()
  // demands the same card tier, a level within 3 and an identical slot count, so a single shared bot
  // could never be challengeable by everyone.
  rehearsalPartner(memberId) {
    if (!this.rehearsal) return null;
    const me = this.admissions.get(memberId); if (!me) return null;
    const botId = 'ai-' + memberId, now = this._now();
    let bot = this.admissions.get(botId);
    if (bot && !this.leases.has(botId)
      && (bot.fighter.species !== me.fighter.species || bot.fighter.level !== me.fighter.level)) {
      this._removeAdmission(botId); bot = null;   // they swapped fighters — re-mirror
    }
    if (!bot) {
      if (this.admissions.size >= this.maxAdmissions) return null;
      const fighter = copy(me.fighter);
      fighter.asset_id = 'rehearsal-' + memberId;
      bot = { id: botId, wallet: 'rehearsal:' + memberId, asset_id: fighter.asset_id,
        handle: ChikiseumLiveEngine.REHEARSAL_HANDLE, fighter, expires_at: now + this.sessionTTL, last_seen: now };
      this.admissions.set(botId, bot); this.accounts.set(bot.wallet, botId); this.assets.set(bot.asset_id, botId);
      this.rehearsalIds.add(botId);
    }
    bot.last_seen = now; bot.expires_at = now + this.sessionTTL;
    return bot;
  }
  // Drives every rehearsal fighter one step. Runs through the SAME public cast/move API a human
  // uses, so the bot is bound by energy, cooldowns, the global cooldown and the movement cadence
  // exactly as a player is — it cannot do anything a player could not. Every action is best-effort:
  // a rejected cast (cooling down, no energy) must never disturb the tick for real matches.
  _driveRehearsal() {
    if (!this.rehearsal || this.rehearsalIds.size === 0) return;
    for (const botId of [...this.rehearsalIds]) {
      try {
        if (!this.admissions.has(botId)) { this.rehearsalIds.delete(botId); continue; }
        const ownerId = botId.slice(3), owner = this.admissions.get(ownerId);
        if (!this.leases.has(botId) && (!owner || owner.expires_at <= this._now())) { this._removeAdmission(botId); continue; }
        const mid = this.leases.get(botId); if (!mid) continue;
        const m = this.matches.get(mid); if (!m || m.status !== 'active') continue;
        const self = m.players.find(x => x.trainer_id === botId);
        const foe = m.players.find(x => x.trainer_id !== botId);
        if (!self || !foe || self.hp <= 0 || foe.hp <= 0) continue;
        const now = this._now();
        // Close to roughly mid-range, then hold: walking onto the opponent is not a strategy.
        const dx = foe.position.x - self.position.x, dz = foe.position.z - self.position.z;
        const gap = Math.hypot(dx, dz);
        if (gap > 4.5) { try { this.move(botId, mid, dx / gap, dz / gap, opaque()); } catch {} }
        else if (gap < 2.2) { try { this.move(botId, mid, -dx / gap, -dz / gap, opaque()); } catch {} }
        if (now < m.global_cooldowns[self.side] - 1e-9) continue;
        // Cheapest ready card that it can actually pay for, preferring one that reaches the target.
        const ready = self.slots
          .map(slot => ({ slot, card: this.cards.get(`${self.species}:${slot}`) }))
          .filter(({ slot, card }) => now >= (m.cooldowns[self.side][slot] ?? 0) - 1e-9
            && card.mechanics.cost <= self.energy + 1e-9)
          .sort((a, b) => (b.card.radius >= gap) - (a.card.radius >= gap)
            || a.card.mechanics.cost - b.card.mechanics.cost || a.slot - b.slot);
        if (ready.length) { try { this.cast(botId, mid, ready[0].slot, opaque()); } catch {} }
      } catch { /* one bot never breaks the tick for everyone else */ }
    }
  }
  _member(id) {
    this._guard(); const p = this.admissions.get(id);
    if (!p || p.expires_at <= this._now()) fail('Current verified admission required', 'ADMISSION_EXPIRED', 401);
    p.last_seen = this._now(); p.expires_at = p.last_seen + this.sessionTTL; return p;
  }
  _publicFighter(fighter) { const { slots, damage_multiplier, asset_id, ...publicData } = fighter; return copy(publicData); }
  static compatible(a, b) {
    if (a.card_tier !== b.card_tier || Math.abs(a.level - b.level) > 3 || a.slots.length !== b.slots.length) return false;
    const pa = a.max_hp * a.damage_multiplier, pb = b.max_hp * b.damage_multiplier;
    return Math.max(pa, pb) / Math.min(pa, pb) <= 1.15;
  }
  _available(p) { if (this.leases.has(p.id)) fail('Trainer already matched', 'ACCOUNT_BUSY', 409); }
  lobby(id) {
    this.expire(); const me = this._member(id); this.rehearsalPartner(id); const now = this._now();
    const peers = [...this.admissions.values()].filter(p => p.id !== id && !this.leases.has(p.id) && now - p.last_seen <= 45)
      .sort((a, b) => b.last_seen - a.last_seen || a.id.localeCompare(b.id)).slice(0, 50);
    return { schema: 'chikiseum.live-lobby/v1', ...this._flags(), match_id: this.leases.get(id) ?? null,
      trainers: peers.map(p => ({ trainer_id: p.id, handle: p.handle, fighter: this._publicFighter(p.fighter), compatible: ChikiseumLiveEngine.compatible(me.fighter, p.fighter) })),
      challenges: [...this.challenges.values()].filter(c => c.target === id).map(c => ({ id: c.id, from: c.sender, expires: c.expires })) };
  }
  queue(id) {
    this.expire(); const me = this._member(id); this._available(me);
    const peers = [...this.queueEntries].filter(([pid]) => pid !== id).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    for (const [pid] of peers) { const peer = this.admissions.get(pid); if (peer && !this.leases.has(pid) && ChikiseumLiveEngine.compatible(me.fighter, peer.fighter)) return { ...this._flags(), match_id: this._newMatch(peer, me), searching: false }; }
    this.queueEntries.set(id, this._now()); return { ...this._flags(), match_id: null, searching: true };
  }
  challenge(id, targetId) {
    this.expire(); const me = this._member(id), peer = this.admissions.get(targetId); this._available(me);
    if (!peer || peer.id === id || this._now() - peer.last_seen > 45) fail('Unknown or unavailable challenge target');
    this._available(peer); if (!ChikiseumLiveEngine.compatible(me.fighter, peer.fighter)) fail('Fighters outside matchmaking limits');
    const duplicate = [...this.challenges.values()].find(c => c.sender === id && c.target === targetId);
    if (duplicate) return { ...this._flags(), challenge_id: duplicate.id };
    if ([...this.challenges.values()].filter(c => c.sender === id).length >= 4 || this.challenges.size >= this.maxAdmissions * 4) fail('Challenge limit reached', 'RATE_LIMIT', 429);
    // The dummy has nobody to press accept for it, so challenging it starts the match at once.
    if (this.rehearsalIds.has(peer.id)) return { ...this._flags(), challenge_id: opaque(), match_id: this._newMatch(peer, me) };
    const cid = opaque(); this.challenges.set(cid, { id: cid, sender: id, target: targetId, expires: this._now() + 30 });
    return { ...this._flags(), challenge_id: cid };
  }
  accept(id, cid) {
    this.expire(); const me = this._member(id), c = this.challenges.get(cid);
    if (!c || c.target !== id) fail('Challenge expired or not owned', 'PRIVATE_VIEW_DENIED', 403);
    const peer = this.admissions.get(c.sender); if (!peer) fail('Challenger admission expired');
    return { ...this._flags(), match_id: this._newMatch(peer, me) };
  }
  _newMatch(a, b) {
    this._available(a); this._available(b);
    if (a.wallet === b.wallet || a.asset_id === b.asset_id || !ChikiseumLiveEngine.compatible(a.fighter, b.fighter)) fail('Invalid matching pair');
    if (this.matches.size >= this.maxMatches || this.completions.size >= this.maxMatches) fail('Match or completion capacity reached', 'CAPACITY', 503);
    const now = this._now(), id = opaque();
    const m = { schema: 'chikiseum.battle/v1', ...this._flags(), match_id: id, catalogue_sha256: this.catalogue_sha256,
      arena: this.arena, status: 'ready', combat_mode: 'realtime', round_number: 1, turn: 0,
      deadline: now + 30, revision: 0, movement_revision: 0, players: [], events: [], seq: 0,
      started_at: null, completed_at: null, last_updated_at: now, pending_casts: [], cast_requests: new Map(),
      cooldowns: { A: {}, B: {} }, global_cooldowns: { A: 0, B: 0 }, last_activity: { A: now, B: now },
      movement: {}, move_requests: new Map(), identities: {}, metrics: { A: { cast_count: 0, damage_dealt: 0 }, B: { cast_count: 0, damage_dealt: 0 } } };
    for (const [side, member] of [['A', a], ['B', b]]) {
      m.players.push({ ...copy(member.fighter), side, trainer_id: member.id, handle: member.handle,
        hp: member.fighter.max_hp, energy: 3, statuses: {}, ready: false, position: this.navigation.actorHome(side) });
      if (this.rehearsalIds.has(member.id)) m.players.at(-1).ready = true;   // nobody presses ready for it
      m.identities[side] = { id: member.id, wallet: member.wallet, asset_id: member.asset_id };
      this.leases.set(member.id, id); this.queueEntries.delete(member.id); this._removeChallenges(member.id);
    }
    this.matches.set(id, m); return id;
  }
  _load(id, mid) {
    const member = this._member(id);
    if (!safe(mid) || mid.length > 80) fail('Invalid match ID');
    const m = this.matches.get(mid), p = m?.players.find(x => x.trainer_id === member.id);
    if (!p) fail('Private match view denied', 'PRIVATE_VIEW_DENIED', 403);
    return [m, p];
  }
  _snapshot(m, p, now) {
    const excluded = new Set(['pending_casts', 'cast_requests', 'cooldowns', 'global_cooldowns', 'last_activity', 'movement', 'move_requests', 'seq', 'identities', 'metrics']);
    const result = Object.fromEntries(Object.entries(m).filter(([k]) => !excluded.has(k)).map(([k, v]) => [k, copy(v)]));
    result.players = m.players.map(x => {
      const { slots, damage_multiplier, asset_id, ...pub } = x, value = copy(pub);
      value.on_emblem = value.hp > 0 && this.navigation.onEmblem(value.position);
      for (const status of Object.values(value.statuses)) status.remaining_seconds = Math.max(0, status.expires_at - now);
      return value;
    });
    const clockEnd = m.completed_at ?? now;
    const elapsed = m.started_at === null ? 0 : Math.max(0, Math.min(180, clockEnd - m.started_at));
    const remaining = m.status === 'active' ? Math.max(0, 180 - elapsed) : 0;
    result.server_time = now; result.match_remaining_seconds = remaining;
    result.realtime = { elapsed, remaining, duration: 180, energy_regen_per_second: elapsed >= 90 ? 1.5 : 1,
      server_time: now, phase: elapsed >= 90 ? 'overtime' : 'standard', tick_seconds: .05, movement_budgeted: false };
    const cds = copy(m.cooldowns[p.side]), own = [...m.cast_requests].filter(([, command]) => command.side === p.side);
    result.you = { side: p.side, asset_id: p.asset_id, committed: false, hand: m.status === 'active' ? p.slots.map(slot => {
      const c = this.cards.get(`${p.species}:${slot}`); return { slot, key: c.key, name: c.card_name,
        cost: c.mechanics.cost, cooldown_seconds: COOLDOWNS[c.arch], ...cardGeometry(c) };
    }) : [], cooldowns: cds, cooldown_remaining: Object.fromEntries(Object.entries(cds).map(([s, until]) => [s, Math.max(0, until - now)])),
    global_cooldown_until: m.global_cooldowns[p.side], cast_ack: own.at(-1)?.[0] ?? null };
    return result;
  }
  state(id, mid) { this.expire(); const [m, p] = this._load(id, mid); const now = this._now(); if (m.status === 'active') m.last_activity[p.side] = now; return this._snapshot(m, p, now); }
  ready(id, mid) {
    this.expire(); const [m, p] = this._load(id, mid);
    if (m.status !== 'ready') fail('Match is not awaiting readiness');
    if (!p.ready) { p.ready = true; m.revision++; }
    if (m.players.every(x => x.ready)) {
      const now = this._now(), mono = this._mono(); Object.assign(m, { status: 'active', started_at: now,
        deadline: now + 180, last_updated_at: now, last_activity: { A: now, B: now }, movement: { A: { last_time: mono }, B: { last_time: mono } } });
    }
    return this._snapshot(m, p, this._now());
  }
  cast(id, mid, slot, rid) {
    this.expire(); const [m, p] = this._load(id, mid); integer(slot, 0, 11, 'canonical card slot'); requestId(rid);
    const old = m.cast_requests.get(rid), now = this._now();
    if (old) {
      if (old.side !== p.side || old.slot !== slot) fail('Request ID reused for a different cast');
      const snap = this._snapshot(m, p, now); snap.you.cast_ack = rid;
      return { ...snap, cast_ack: rid, cast_queued: m.pending_casts.some(x => x.request_id === rid) };
    }
    if (m.status !== 'active' || p.hp <= 0) fail('Active living fighter required');
    if (!p.slots.includes(slot)) fail('Card not in equipped canonical hand');
    if (m.cast_requests.size >= 4096) fail('Match cast command limit reached', 'RATE_LIMIT', 429);
    const c = this.cards.get(`${p.species}:${slot}`);
    if (now < m.global_cooldowns[p.side] - 1e-9 || now < (m.cooldowns[p.side][slot] ?? 0) - 1e-9) fail('Ability is cooling down', 'COOLDOWN', 409);
    if (c.mechanics.cost > p.energy + 1e-9) fail('Insufficient card energy', 'ENERGY', 409);
    p.energy = Math.max(0, p.energy - c.mechanics.cost); m.cooldowns[p.side][slot] = now + COOLDOWNS[c.arch]; m.global_cooldowns[p.side] = now + .18;
    const bucket = Math.floor((now - m.started_at + 1e-9) / .05) + 1;
    m.pending_casts.push({ side: p.side, slot, request_id: rid, resolve_at: m.started_at + bucket * .05 });
    m.cast_requests.set(rid, { side: p.side, slot }); m.last_activity[p.side] = now; m.revision++;
    const snap = this._snapshot(m, p, now); snap.you.cast_ack = rid; return { ...snap, cast_ack: rid, cast_queued: true };
  }
  move(id, mid, dx, dz, rid) {
    this.expire(); const [m, p] = this._load(id, mid); finite(dx, -1, 1, 'movement x'); finite(dz, -1, 1, 'movement z'); requestId(rid);
    const old = m.move_requests.get(rid), fingerprint = [p.side, dx, dz];
    if (old) { if (JSON.stringify(old) !== JSON.stringify(fingerprint)) fail('Request ID reused for another movement intent'); return this._snapshot(m, p, this._now()); }
    if (m.status !== 'active' || p.hp <= 0) fail('Movement requires active living fighter');
    if (m.move_requests.size >= 16384) fail('Movement command limit reached', 'RATE_LIMIT', 429);
    const mono = this._mono(), elapsed = mono - m.movement[p.side].last_time;
    if (elapsed < .05 - 1e-9) fail('Movement cadence is server limited', 'MOVE_CADENCE', 429);
    const length = Math.hypot(dx, dz), distance = 3.8 * Math.min(elapsed, .2) * Math.min(1, length);
    const target = m.players.find(x => x.side !== p.side);
    const swept = this.navigation.sweepIntent(p.position, length ? dx / length : 0, length ? dz / length : 0, distance, target.position);
    m.movement[p.side].last_time = mono;
    if (swept.travelled > 1e-9) { p.position = copy(swept.position); m.movement_revision++; }
    m.move_requests.set(rid, fingerprint); m.last_activity[p.side] = this._now();
    return { ...this._snapshot(m, p, this._now()), movement_blocked_reason: swept.reason };
  }
  _event(m, p, type, slot = null, fields = {}) {
    m.seq++;
    const event = { id: `${m.match_id}:${m.seq}`, seq: m.seq, turn: 0, side: p.side,
      species: p.species, slot, type, confirmed: true, server_time: m.last_updated_at, ...fields };
    if (type !== 'finish') {
      event.target_side ??= ['cast', 'impact'].includes(type) ? opposite(p.side) : p.side;
      event.amount ??= 0;
      if (type === 'cast' && SELF.has(this.cards.get(`${p.species}:${slot}`).arch)) event.target_side = p.side;
    }
    m.events.push(event);
    // Events are append-only with monotone seq; keep enough history for bounded reconnect.
    if (m.events.length > 1024) m.events.splice(0, m.events.length - 1024);
  }
  _endStatus(m, target, name, status) {
    const caster = m.players.find(x => x.side === status.source_side);
    this._event(m, caster, 'status_end', status.slot, { target_side: target.side, status: name });
  }
  _status(m, target, caster, name, slot, now, fields, duration = STATUS_SECONDS[name]) {
    if (target.statuses[name]) this._endStatus(m, target, name, target.statuses[name]);
    target.statuses[name] = { ...fields, slot, source_side: caster.side, expires_at: now + duration };
    this._event(m, caster, 'status_start', slot, { target_side: target.side, status: name, remaining_seconds: duration,
      expires_at: now + duration, amount: fields.amount ?? 0 });
  }
  _advance(m, until) {
    const start = m.last_updated_at; until = Math.max(start, until); const boundary = m.started_at + 90;
    const standard = Math.max(0, Math.min(until, boundary) - Math.min(start, boundary));
    const overtime = Math.max(0, until - Math.max(start, boundary)); let changed = false;
    m.last_updated_at = until;
    for (const p of m.players) {
      let regen = standard + overtime * 1.5;
      if (p.hp > 0 && this.navigation.onEmblem(p.position)) regen += until - start;
      const energy = Math.min(6, round(p.energy + regen, 9)); changed ||= energy !== p.energy; p.energy = energy;
      for (const [name, s] of Object.entries(p.statuses)) {
        if (s.expires_at <= until + 1e-9 || (name === 'shield' && s.amount <= 0)) { delete p.statuses[name]; this._endStatus(m, p, name, s); changed = true; }
      }
    }
    if (changed) m.revision++;
  }
  _resolve(m, batch, now) {
    const slots = new Map(batch.map(x => [x.side, x.slot])), before = new Map(m.players.map(p => [p.side, copy(p.position)]));
    const quick = m.players.filter(p => slots.has(p.side) && this.cards.get(`${p.species}:${slots.get(p.side)}`).arch === 'quick');
    const dash = new Map();
    for (const p of quick) {
      const origin = before.get(p.side), destination = before.get(opposite(p.side));
      const dx = destination.x - origin.x, dz = destination.z - origin.z, separation = Math.hypot(dx, dz);
      const approach = Math.min(5, Math.max(0, separation - 1.25) / (quick.length === 2 ? 2 : 1));
      const swept = this.navigation.sweepIntent(origin, separation ? dx / separation : 0, separation ? dz / separation : 0, approach, destination);
      p.position = copy(swept.position); if (swept.travelled > 1e-9) m.movement_revision++;
      dash.set(p.side, { dash_from: origin, dash_to: copy(p.position), dash_duration: Math.max(.12, swept.travelled / 10),
        dash_distance_m: swept.travelled, dash_blocked_reason: swept.reason });
    }
    const attacks = [];
    for (const p of m.players) {
      if (!slots.has(p.side)) continue;
      const slot = slots.get(p.side), c = this.cards.get(`${p.species}:${slot}`), mech = c.mechanics, tier = p.card_tier;
      const target = m.players.find(x => x.side !== p.side);
      m.metrics[p.side].cast_count++;
      this._event(m, p, 'cast', slot, { card_key: c.key, attack_origin: copy(p.position), target_position: copy(target.position), ...cardGeometry(c), ...(dash.get(p.side) ?? {}) });
      if (c.arch === 'guard' || c.arch === 'bulwark') this._status(m, p, p, 'shield', slot, now, { amount: mech.shield[tier] }, c.arch === 'bulwark' ? 6 : 4);
      else if (c.arch === 'charge') { p.energy = Math.min(6, p.energy + mech.energy); this._status(m, p, p, 'charge', slot, now, { multiplier: mech.nextmul[tier] }); }
      else if (c.arch === 'rally') this._status(m, p, p, 'rally', slot, now, { multiplier: 1 + mech.buff[tier] });
      else attacks.push({ p, target, slot, c });
    }
    const pending = attacks.map(a => {
      const { p, target, c } = a, statuses = p.statuses; let damage = c.mechanics.dmg[p.card_tier] * p.damage_multiplier;
      for (const name of ['rally', 'charge']) if (statuses[name]) damage *= statuses[name].multiplier;
      if (statuses.weaken) damage *= 1 - statuses.weaken.fraction;
      damage = round(damage);
      const separation = Math.hypot(p.position.x - target.position.x, p.position.z - target.position.z);
      let reason = separation > cardGeometry(c).contact_range_m + 1e-9 ? 'out_of_range' : null;
      if (!reason && !this.navigation.lineOfSight(p.position, target.position, .9)) reason = 'blocked_line_of_sight';
      if (reason) damage = 0;
      const shield = target.statuses.shield, blocked = shield ? Math.min(damage, shield.amount) : 0;
      if (blocked) { shield.amount -= blocked; this._event(m, target, 'block', shield.slot, { target_side: target.side, amount: blocked }); }
      return { ...a, damage: round(damage - blocked), reason, separation };
    });
    for (const { p, target, c, damage } of pending) {
      m.metrics[p.side].damage_dealt = round(m.metrics[p.side].damage_dealt + Math.min(target.hp, damage));
      target.hp = Math.max(0, round(target.hp - damage));
      if (c.arch === 'nova') p.hp = Math.max(0, p.hp - c.mechanics.recoil[p.card_tier]);
    }
    for (const { p, target, slot, c, damage, reason, separation } of pending) {
      const mech = c.mechanics, tier = p.card_tier;
      this._event(m, p, 'impact', slot, { target_side: target.side, amount: damage, reason, distance_m: separation,
        attack_origin: copy(p.position), target_position: copy(target.position), ...cardGeometry(c) });
      if (damage && c.arch === 'drain' && p.hp > 0) {
        const healed = Math.min(p.max_hp - p.hp, damage * mech.heal[tier]);
        if (healed > 0) { p.hp = round(p.hp + healed); this._event(m, p, 'heal', slot, { target_side: p.side, amount: round(healed) }); }
      }
      if (c.arch === 'nova') this._event(m, p, 'recoil', slot, { target_side: p.side, amount: mech.recoil[tier] });
      if (damage && c.arch === 'jolt') target.energy = Math.max(0, target.energy - mech.drain_e);
      if (damage && c.arch === 'wither' && target.hp > 0) this._status(m, target, p, 'weaken', slot, now, { fraction: mech.weaken[tier] });
      if (p.statuses.charge) { const old = p.statuses.charge; delete p.statuses.charge; this._endStatus(m, p, 'charge', old); }
    }
    this._advance(m, now); m.revision++;
    const living = m.players.filter(p => p.hp > 0); if (living.length < 2) this._finish(m, 'finished', living[0]?.side ?? null);
  }
  _finish(m, status, winner = null) {
    if (!ACTIVE.has(m.status)) return;
    m.completed_at = m.last_updated_at; m.pending_casts = [];
    for (const p of m.players) { for (const [name, old] of Object.entries(p.statuses)) this._endStatus(m, p, name, old); p.statuses = {}; this.leases.delete(p.trainer_id); }
    m.status = status; m.winner = winner; m.deadline = null; m.revision++;
    this._event(m, m.players[0], 'finish', null, { winner, reason: status });
    // A rehearsal records no completion at all: that is the whole of "practice awards nothing".
    // Battle levels stay server-earned against real opponents and cannot be ground out on a dummy.
    if (status === 'finished' && m.started_at !== null && !this._rehearsalMatch(m)) this.completions.set(m.match_id, {
      schema: 'chikiseum.live-completion/v1', match_id: m.match_id, status, winner,
      started_at: m.started_at, completed_at: m.completed_at, catalogue_sha256: this.catalogue_sha256,
      arena_sha256: this.arena.reference_plan_sha256, players: m.players.map(p => ({ ...m.identities[p.side],
        side: p.side, species: p.species, level: p.level, ...m.metrics[p.side] })) });
  }
  _removeChallenges(id) { for (const [cid, c] of this.challenges) if (c.sender === id || c.target === id) this.challenges.delete(cid); }
  _removeAdmission(id) {
    const p = this.admissions.get(id); if (!p) return;
    if (this.accounts.get(p.wallet) === id) this.accounts.delete(p.wallet);
    if (this.assets.get(p.asset_id) === id) this.assets.delete(p.asset_id);
    this.admissions.delete(id); this.queueEntries.delete(id); this._removeChallenges(id);
    if (this.rehearsalIds.delete(id)) return;   // it WAS the dummy; nothing further to cascade
    if (this.admissions.has('ai-' + id)) this._removeAdmission('ai-' + id);   // take its owner's dummy with it
  }
  revoke(id) {
    const mid = this.leases.get(id), m = this.matches.get(mid);
    if (m) this._finish(m, m.status === 'ready' ? 'admission_revoked' : 'forfeit', m.status === 'ready' ? null : opposite(m.players.find(p => p.trainer_id === id).side));
    this._removeAdmission(id);
    return { ...this._flags(), cancelled: true };
  }
  cancel(id, mid = null) {
    this.expire(); this._member(id);
    if (mid) { const [m, p] = this._load(id, mid); if (ACTIVE.has(m.status)) this._finish(m, m.status === 'ready' ? 'cancelled' : 'forfeit', m.status === 'ready' ? null : opposite(p.side)); }
    this.queueEntries.delete(id); this._removeChallenges(id); return { ...this._flags(), cancelled: true };
  }
  tick() { this._driveRehearsal(); this.expire(); }
  expire() {
    this._guard(); const now = this._now();
    for (const [cid, c] of this.challenges) if (c.expires <= now) this.challenges.delete(cid);
    for (const [id, created] of this.queueEntries) if (created <= now - 90) this.queueEntries.delete(id);
    for (const [mid, m] of this.matches) {
      if (!ACTIVE.has(m.status)) { if (now - m.completed_at >= this.terminalTTL) this.matches.delete(mid); continue; }
      if (m.status === 'ready') { if (m.deadline <= now) this._finish(m, 'ready_timeout'); continue; }
      const inactiveAt = Math.min(...Object.values(m.last_activity)) + 45;
      const horizon = Math.min(now, m.deadline, inactiveAt);
      const due = [...new Set(m.pending_casts.filter(c => c.resolve_at <= horizon + 1e-9).map(c => c.resolve_at))].sort((a, b) => a - b);
      for (const at of due) {
        this._advance(m, at); const batch = m.pending_casts.filter(c => Math.abs(c.resolve_at - at) < 1e-9);
        m.pending_casts = m.pending_casts.filter(c => Math.abs(c.resolve_at - at) >= 1e-9); this._resolve(m, batch, at);
        if (m.status !== 'active') break;
      }
      if (m.status !== 'active') continue;
      this._advance(m, horizon);
      if (now >= m.deadline && m.deadline <= inactiveAt) {
        const [a, b] = m.players.map(p => p.hp / p.max_hp); this._finish(m, 'finished', Math.abs(a - b) < 1e-9 ? null : a > b ? 'A' : 'B');
      } else if (now >= inactiveAt) {
        const absent = Object.entries(m.last_activity).filter(([, at]) => now >= at + 45).map(([side]) => side);
        this._finish(m, absent.length === 2 ? 'draw' : 'forfeit', absent.length === 2 ? null : opposite(absent[0]));
      }
    }
    for (const [id, p] of this.admissions) if (p.expires_at <= now) this.revoke(id);
  }
  // Trusted server-side persistence seam. Tokens are adapter-owned and absent.
  // Restart NEVER resumes queued attacks or invents a winner; old live matches
  // are cancelled before accepting fresh authenticated admissions.
  checkpoint() {
    return { schema: 'chikiseum.live-checkpoint/v1', catalogue_sha256: this.catalogue_sha256,
      arena_sha256: this.arena.reference_plan_sha256, restart_policy: 'cancel_unfinished',
      completions: [...this.completions.values()].map(copy), matches: [...this.matches.values()].filter(m => !this._rehearsalMatch(m)).map(m => {
        // No command can replay after restart without a NEW verified admission.
        // Restore cancels unfinished matches, so transient ACK/pending-cast data
        // is deliberately not durable. Do not clone huge runtime maps first.
        const durable = Object.fromEntries(Object.entries(m).filter(([k]) => !['cast_requests', 'move_requests', 'pending_casts', 'events'].includes(k)));
        return { ...copy(durable), events: copy(m.events.slice(-8)), pending_casts: [], cast_requests: [], move_requests: [] };
      }) };
  }
  restore(checkpoint) {
    if (this.matches.size || this.admissions.size) throw new Error('Restore requires an empty engine');
    if (!checkpoint || checkpoint.schema !== 'chikiseum.live-checkpoint/v1' || checkpoint.catalogue_sha256 !== this.catalogue_sha256
      || checkpoint.arena_sha256 !== this.arena.reference_plan_sha256 || !Array.isArray(checkpoint.matches) || checkpoint.matches.length > this.maxMatches
      || !Array.isArray(checkpoint.completions) || checkpoint.completions.length > this.maxMatches) throw new Error('Invalid live checkpoint');
    // Checkpoints are trusted DB records, but malformed/corrupt records fail closed.
    for (const saved of checkpoint.matches) {
      if (!safe(saved.match_id) || saved.schema !== 'chikiseum.battle/v1' || saved.mode !== 'live' || saved.currency !== 'NONE'
        || saved.real_sol_enabled !== false || saved.inventory_verified !== true || saved.combat_mode !== 'realtime'
        || saved.players?.length !== 2 || !Array.isArray(saved.events) || saved.events.length > 1024
        || !Array.isArray(saved.cast_requests) || saved.cast_requests.length > 4096 || !Array.isArray(saved.move_requests) || saved.move_requests.length > 16384 || saved.catalogue_sha256 !== this.catalogue_sha256
        || saved.arena?.reference_plan_sha256 !== this.arena.reference_plan_sha256 || !saved.identities || !saved.metrics) throw new Error('Corrupt live checkpoint match');
      if (!['ready', 'active', 'finished', 'cancelled', 'forfeit', 'draw', 'ready_timeout', 'admission_revoked', 'server_restart'].includes(saved.status)
        || !Number.isFinite(saved.last_updated_at) || !Number.isInteger(saved.seq) || saved.seq < 0
        || (saved.started_at !== null && !Number.isFinite(saved.started_at))
        || (saved.completed_at !== null && !Number.isFinite(saved.completed_at))) throw new Error('Corrupt persisted timing');
      for (const [index, p] of saved.players.entries()) {
        if (p.side !== (index === 0 ? 'A' : 'B') || !safe(p.trainer_id) || !this.species.has(p.species) || !this.navigation.validPosition(p.position)) throw new Error('Corrupt persisted fighter');
        const canonical = this._fighter(p);
        for (const key of ['max_hp', 'card_tier', 'damage_multiplier', 'rarity']) if (p[key] !== canonical[key]) throw new Error('Persisted fighter stats changed');
        if (JSON.stringify(p.slots) !== JSON.stringify(canonical.slots) || !Number.isFinite(p.hp) || p.hp < 0 || p.hp > p.max_hp
          || !Number.isFinite(p.energy) || p.energy < 0 || p.energy > 6) throw new Error('Corrupt persisted HP or energy');
        const identity = saved.identities[p.side], metric = saved.metrics[p.side];
        if (!identity || identity.id !== p.trainer_id || identity.asset_id !== p.asset_id || !safe(identity.wallet) || !safe(identity.asset_id)
          || !metric || !Number.isInteger(metric.cast_count) || metric.cast_count < 0 || metric.cast_count > 4096
          || !Number.isFinite(metric.damage_dealt) || metric.damage_dealt < 0) throw new Error('Corrupt persisted completion identity');
      }
    }
    for (const completion of checkpoint.completions) {
      if (!safe(completion.match_id) || completion.schema !== 'chikiseum.live-completion/v1' || completion.status !== 'finished'
        || completion.players?.length !== 2 || completion.catalogue_sha256 !== this.catalogue_sha256
        || completion.arena_sha256 !== this.arena.reference_plan_sha256 || !Number.isFinite(completion.started_at)
        || !Number.isFinite(completion.completed_at) || completion.completed_at < completion.started_at
        || ![null, 'A', 'B'].includes(completion.winner)) throw new Error('Corrupt live completion');
      for (const p of completion.players) if (!safe(p.id) || !safe(p.wallet) || !safe(p.asset_id)
        || !this.species.has(p.species) || !Number.isInteger(p.level) || p.level < 1 || p.level > 30
        || !Number.isInteger(p.cast_count) || p.cast_count < 0 || p.cast_count > 4096
        || !Number.isFinite(p.damage_dealt) || p.damage_dealt < 0) throw new Error('Corrupt completion metric');
    }
    for (const completion of checkpoint.completions) this.completions.set(completion.match_id, copy(completion));
    for (const saved of checkpoint.matches) {
      const m = { ...copy(saved), cast_requests: new Map(saved.cast_requests), move_requests: new Map(saved.move_requests), arena: this.arena };
      this.matches.set(m.match_id, m);
      if (ACTIVE.has(m.status)) { m.last_updated_at = this._now(); this._finish(m, 'server_restart'); }
    }
    this.expire(); return { cancelled_on_restart: [...this.matches.values()].filter(m => m.status === 'server_restart').length };
  }
  restoreCheckpoint(checkpoint) { return this.restore(checkpoint); }
  drainCompletions() { return [...this.completions.values()].map(copy); }
  acknowledgeCompletion(mid) { return this.completions.delete(mid); }
  shutdown() {
    if (this.closed) return;
    for (const m of this.matches.values()) if (ACTIVE.has(m.status)) { m.last_updated_at = this._now(); this._finish(m, 'server_restart'); }
    this.queueEntries.clear(); this.challenges.clear(); this.closed = true;
  }
  diagnostics() { return { ...this._flags(), catalogue_sha256: this.catalogue_sha256, arena_sha256: this.arena.reference_plan_sha256,
    admissions: this.admissions.size, matches: this.matches.size, active_matches: this.leases.size / 2,
    queue: this.queueEntries.size, challenges: this.challenges.size, account_leases: this.accounts.size, asset_leases: this.assets.size,
    pending_completions: this.completions.size, closed: this.closed }; }
}
