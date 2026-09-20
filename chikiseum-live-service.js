// Authenticated HTTP boundary for free, simultaneous PvP. This module cannot sign/pay SOL.
//
// SOL wagers are an OPTIONAL side-ledger (chikiseum-wagers.js) keyed by match id. When configured,
// this module verifies deposits through an injected chain reader and sends payouts through an
// injected rail; it never holds a key. The engine stays free — a wagered match is an ordinary
// match whose outcome the ledger reads afterwards.
import { createHash } from 'node:crypto';
import { ChikiseumLiveEngine, LiveRejected, SPECIES_TRAITS } from './chikiseum-live-engine.js';
import { ChikiseumProgressBook } from './chikiseum-live-progression.js';
import { ChikiseumLiveNavigation } from './chikiseum-live-navigation.js';
import { ChikiseumWagerLedger, WagerRejected, LAMPORTS_PER_SOL } from './chikiseum-wagers.js';

export const LIVE_PREFIX = '/chikiseum/live/v1';
export const LIVE_KEY = 'chikiseum_live_v1';
export const ART_BINDING = Object.freeze({ art_manifest_sha256: 'c52bbc8c43bfd1a0aaa77e261259846ab20e2911627e58b0d041af322eb559ca', art_version: '02400b320307' });
const AUTH = ['wallet', 'mktToken', 'sessionId', 'sessionEpoch'];
const FIELDS = Object.freeze({ roster: [], session: ['asset_id'], lobby: [], queue: [],
  challenge: ['target'], accept: ['challenge_id'], state: ['match_id'], ready: ['match_id'],
  cast: ['match_id', 'slot', 'request_id'], move: ['match_id', 'dx', 'dz', 'request_id'], cancel: ['match_id'],
  // Wagers. Every one of these requires an admitted fighter, like queue/challenge.
  wager_board: [], wager_mine: [], wager_post: ['stake_sol'], wager_accept: ['wager_id'],
  wager_withdraw: ['wager_id'], wager_deposit: ['wager_id', 'signature'] });
const WAGER_ROUTES = new Set(['wager_board', 'wager_mine', 'wager_post', 'wager_accept', 'wager_withdraw', 'wager_deposit']);
// How long a `sending` leg found on boot is left alone before it is treated as never broadcast:
// longer than any blockhash can stay valid, so a transaction we cannot see can no longer land.
const SENDING_GRACE = 150;
const reject = (message, code, status) => { throw new LiveRejected(message, code, status); };
const clone = value => structuredClone(value);
const now = () => Date.now() / 1000;
const obj = x => x && typeof x === 'object' && !Array.isArray(x);
const safeId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(x);

class Limits {
  constructor() { this.rows = new Map(); }
  allow(key, rate, burst, t) {
    let row = this.rows.get(key);
    if (!row) {
      if (this.rows.size >= 10000) {
        for (const [k, r] of this.rows) if (t - r.at > 120) this.rows.delete(k);
        if (this.rows.size >= 10000) return false;
      }
      row = { at: t, tokens: burst }; this.rows.set(key, row);
    }
    row.tokens = Math.min(burst, row.tokens + Math.max(0, t - row.at) * rate); row.at = t;
    if (row.tokens < 1) return false;
    row.tokens--; return true;
  }
}

export class ChikiseumLiveService {
  constructor({ authenticate, ownedAssets, leaseFactory, available = () => true,
    engineFactory = () => new ChikiseumLiveEngine({ navigation: new ChikiseumLiveNavigation(), maxAdmissions: 256, maxMatches: 128 }),
    clock = now, enabled = true, wagers = null } = {}) {
    if ([authenticate, ownedAssets, leaseFactory, available].some(f => typeof f !== 'function')) throw new Error('Trusted live callbacks required');
    Object.assign(this, { authenticate, ownedAssets, leaseFactory, available, engineFactory, clock, enabled });
    this.engine = null; this.book = null; this.lease = null; this.bindings = null;
    this.ready = false; this.booting = false; this.closed = false; this.reason = enabled ? 'starting' : 'disabled';
    this.admitted = new Map(); this.limits = new Limits(); this.tail = Promise.resolve(); this.queued = 0;
    this.lastFlush = 0; this.lastAudit = 0; this.lastBoot = -Infinity; this.timer = null;
    // Wager configuration is optional. Without it there is no ledger, no routes, no money.
    this.wagerConfig = null; this.wagers = null; this.pumping = false; this.lastPump = 0; this.claimedLegs = new Set();
    if (wagers) {
      const { chain, rail, treasury, enabled: wagersEnabled = false, limits = {}, rakeBps = 0 } = wagers;
      if (!chain || typeof chain.readDeposit !== 'function' || typeof chain.findByMemo !== 'function') throw new Error('Wager chain reader required');
      if (!rail || typeof rail.send !== 'function' || typeof rail.status !== 'function') throw new Error('Wager payout rail required');
      if (!safeId(treasury) && !(typeof treasury === 'string' && treasury.length >= 32)) throw new Error('Wager treasury address required');
      this.wagerConfig = { chain, rail, treasury, enabled: wagersEnabled === true, limits, rakeBps };
    }
  }
  flags() { return { mode: 'live', currency: 'NONE', real_sol_enabled: false, inventory_verified: true }; }
  wagerFlags() {
    if (!this.wagerConfig) return { wagers: { enabled: false, configured: false, real_sol_enabled: false } };
    const l = this.wagers?.limits ?? this.wagerConfig.limits;
    const counts = this.wagers?.counts() ?? {};
    return { wagers: { enabled: this.wagerConfig.enabled, configured: true, real_sol_enabled: this.wagerConfig.enabled || this.liabilityLamports() > 0,
      custody: 'treasury_held', treasury: this.wagerConfig.treasury, rake_bps: this.wagerConfig.rakeBps,
      min_stake_sol: (l?.min_lamports ?? 0) / LAMPORTS_PER_SOL, max_stake_sol: (l?.max_lamports ?? 0) / LAMPORTS_PER_SOL,
      wallet_daily_sol: (l?.wallet_daily_lamports ?? 0) / LAMPORTS_PER_SOL,
      open: counts.open ?? 0, accepting: counts.accepting ?? 0, matched: counts.matched ?? 0, settling: counts.settling ?? 0,
      stuck_legs: this.wagers?.stuckLegs().length ?? 0, liability_sol: this.liabilitySol(), memo_prefix: 'chikiseum-wager' } };
  }
  health() { return { schema: 'chikiseum.live-health/v1', ...this.flags(), ready: this.isReady(),
    reason: this.isReady() ? null : this.reason, ...(this.bindings || {}),
    progression: 'server_earned_pvp', entry_stake: 0, rewards: false, ...this.wagerFlags() }; }
  isReady() { return this.ready && !this.closed && this.available() && this.lease?.valid === true; }
  liabilityLamports() { return this.wagers?.liabilityLamports() ?? 0; }
  liabilitySol() { return this.liabilityLamports() / LAMPORTS_PER_SOL; }
  async boot() {
    if (!this.enabled || this.closed || this.ready || this.booting || !this.available() || this.clock() - this.lastBoot < 5) return false;
    this.lastBoot = this.clock();
    this.booting = true;
    try {
      await this.lease?.close?.(); this.lease = null;
      this.admitted.clear(); this.claimedLegs.clear();
      this.lease = await this.leaseFactory();
      if (!this.lease || this.lease.valid !== true || typeof this.lease.read !== 'function' || typeof this.lease.write !== 'function')
        throw new Error('Exclusive durable lease unavailable');
      const saved = await this.lease.read(LIVE_KEY);
      if (saved != null && (saved.schema !== 'chikiseum.live-store/v1' || !obj(saved.progression) || !obj(saved.engine)))
        throw new Error('Invalid durable PvP state');
      this.book = new ChikiseumProgressBook(saved?.progression ?? null);
      this.engine = this.engineFactory();
      if (this.rehearsalEnabled === false) this.engine.rehearsal = false;
      if (saved) this.engine.restore(saved.engine); // Pending matches become cancelled, never completed/awarded.
      // The ledger is restored whenever it exists in durable state, even if wagers are now switched
      // off: money already held must still be settled or refunded. A saved ledger with no
      // configuration at all is a deployment mistake and fails closed rather than stranding funds.
      if (saved?.wagers != null && !this.wagerConfig) throw new Error('Wager ledger present but wagers are not configured');
      this.wagers = this.wagerConfig
        ? ChikiseumWagerLedger.restore(saved?.wagers ?? null, { clock: this.clock, limits: this.wagerConfig.limits, rakeBps: this.wagerConfig.rakeBps })
        : null;
      this.bindings = { catalogue_sha256: this.engine.catalogue_sha256, arena: clone(this.engine.arena), ...ART_BINDING };
      if (this.wagers) { this.wagers.observe(mid => this.engine.matches.get(mid) ?? null); await this.reconcileUnresolved(); }
      await this.flush(true);
      this.reason = ''; this.ready = true;
      return true;
    } catch {
      this.ready = false; this.reason = 'durable_service_unavailable';
      try { await this.lease?.close?.(); } catch {}
      this.lease = null; this.engine = null; this.book = null; this.wagers = null;
      return false;
    } finally { this.booting = false; }
  }
  // A leg left in `sending` — by a previous process, or by a send whose outcome was ambiguous —
  // may or may not have reached the chain. Look for its memo among the treasury's recent
  // transactions (the chain adapter proves the candidate was signed by the treasury and paid the
  // right wallet); found means sent, not found after the grace period means it never went out.
  // Never resend on a guess. Reads happen outside the serial queue; the caller applies inside it.
  async findUnresolved() {
    const decisions = [];
    for (const leg of this.wagers.unresolvedLegs()) {
      if (this.claimedLegs.has(leg.wager_id + '/' + leg.leg_id)) continue;   // a send in progress right now
      let found = null;
      try { found = await this.wagerConfig.chain.findByMemo({ memo: leg.memo, to: leg.to, lamports: leg.lamports }); } catch { continue; }
      if (found) decisions.push([leg, found]);
      else if (this.clock() - (leg.sending_at ?? 0) >= SENDING_GRACE) decisions.push([leg, null]);
    }
    return decisions;
  }
  applyUnresolved(decisions) {
    for (const [leg, found] of decisions) {
      try { this.wagers.reconcile(leg.wager_id, leg.leg_id, found); } catch { /* state moved on; the next pass re-reads */ }
    }
  }
  async reconcileUnresolved() { this.applyUnresolved(await this.findUnresolved()); }
  serial(fn) {
    if (this.queued >= 128) return Promise.reject(new LiveRejected('Arena is busy; retry shortly.', 'CAPACITY', 503));
    this.queued++;
    const run = this.tail.then(fn);
    this.tail = run.catch(() => {}).finally(() => { this.queued--; });
    return run;
  }
  async flush(force = false) {
    if (!this.engine || !this.book || !this.lease?.valid) throw new Error('PvP persistence unavailable');
    const completions = this.engine.drainCompletions();
    const wagersDirty = this.wagers?.dirty === true;
    if (!force && !completions.length && !wagersDirty && this.clock() - this.lastFlush < 2) return;
    let next = this.book;
    for (const summary of completions) next = next.withCompletion(summary, this.clock()).book;
    await this.lease.write(LIVE_KEY, { schema: 'chikiseum.live-store/v1', progression: next.snapshot(), engine: this.engine.checkpoint(),
      ...(this.wagers ? { wagers: this.wagers.snapshot() } : {}) });
    this.book = next; this.lastFlush = this.clock();
    if (this.wagers) this.wagers.dirty = false;
    for (const summary of completions) this.engine.acknowledgeCompletion(summary.match_id);
  }
  start() {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => {
      if (this.closed) return;
      // The payout pump runs OUTSIDE the serial queue: a chain round-trip must never stall the
      // 50ms tick for everyone fighting. It re-enters the queue only to record what happened.
      if (this.wagers && this.isReady() && this.clock() - this.lastPump >= 1) { this.lastPump = this.clock(); void this.pump(); }
      if (this.queued > 1) return;
      void this.serial(async () => {
        if (!this.isReady()) {
          if (this.ready) { this.ready = false; this.reason = 'lease_or_authority_unavailable'; }
          await this.boot(); return;
        }
        if (this.clock() - this.lastAudit >= 1) {
          this.lastAudit = this.clock();
          await this.lease.ping?.();
          // A player who disconnects cannot keep a sold/revoked fighter active until their next POST.
          for (const [wallet, admission] of this.admitted) {
            if (!this.engine.admissions.has(admission.id)) { this.admitted.delete(wallet); continue; }
            const auth = await this.authenticate(admission.auth);
            const owned = auth && await this.ownedAssets(wallet);
            if (!auth || !owned?.some(r => r.asset_id === admission.asset_id && r.eligible === true)) {
              this.engine.revoke(admission.id); this.admitted.delete(wallet);
            }
          }
        }
        this.engine.tick(); this.settleWagers(); await this.flush();
      }).catch(() => { this.ready = false; this.reason = 'persistence_or_authority_unavailable'; });
    }, 50);
    this.timer.unref?.();
  }
  /** Expiries and outcomes. Runs inside the serial queue, right after the engine tick. */
  settleWagers() {
    if (!this.wagers) return;
    this.wagers.tick();
    this.wagers.observe(mid => this.engine.matches.get(mid) ?? null);
  }
  /**
   * Send due payout legs and confirm sent ones. Each leg is marked `sending` and PERSISTED before
   * the rail is asked to broadcast; the result is persisted again afterwards. A crash in between
   * leaves a `sending` leg for reconcileUnresolved() — never a double payment.
   */
  async pump() {
    if (this.pumping || !this.wagers || !this.wagerConfig) return;
    this.pumping = true;
    try {
      const { rail } = this.wagerConfig;
      const due = await this.serial(async () => {
        if (!this.isReady()) return [];
        const legs = this.wagers.dueLegs().slice(0, 5);
        for (const l of legs) { this.wagers.markSending(l.wager_id, l.leg_id); this.claimedLegs.add(l.wager_id + '/' + l.leg_id); }
        if (legs.length) await this.flush(true);
        return legs;
      }).catch(() => []);
      for (const l of due) {
        let result = null, error = null;
        try { result = await rail.send({ to: l.to, lamports: l.lamports, memo: l.memo }); }
        catch (e) { error = e; }
        await this.serial(async () => {
          this.claimedLegs.delete(l.wager_id + '/' + l.leg_id);
          if (!this.isReady()) return;
          if (result && result.sig) this.wagers.recordBroadcast(l.wager_id, l.leg_id, result);
          // An ambiguous failure (timeout after the RPC may have taken it) is NOT recorded as a
          // failure: the leg stays `sending` and the memo search below decides what happened.
          else if (!error?.ambiguous) this.wagers.recordSendError(l.wager_id, l.leg_id, error ?? new Error('rail returned no signature'));
          await this.flush(true);
        }).catch(() => {});
      }
      const decisions = await this.findUnresolved();
      if (decisions.length) await this.serial(async () => { if (!this.isReady()) return; this.applyUnresolved(decisions); await this.flush(true); }).catch(() => {});
      for (const l of this.wagers.sentLegs().slice(0, 10)) {
        let status = 'pending';
        try { status = await rail.status(l); } catch { status = 'pending'; }
        if (status === 'pending') continue;
        await this.serial(async () => { if (!this.isReady()) return; this.wagers.recordStatus(l.wager_id, l.leg_id, status); await this.flush(true); }).catch(() => {});
      }
    } finally { this.pumping = false; }
  }
  async stop() {
    this.closed = true; this.ready = false;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    await this.serial(async () => {
      try { if (this.engine && this.lease?.valid) { this.engine.shutdown(); this.settleWagers(); await this.flush(true); } }
      finally { await this.lease?.close?.(); this.admitted.clear(); }
    });
  }
  async command(route, body) {
    if (!Object.hasOwn(FIELDS, route)) reject('Unknown arena route.', 'NOT_FOUND', 404);
    if (WAGER_ROUTES.has(route) && !this.wagerConfig) reject('Wagers are not available in this arena.', 'WAGERS_DISABLED', 404);
    if (!obj(body) || Buffer.byteLength(JSON.stringify(body)) > 8192) reject('Bounded JSON object required.', 'INVALID_COMMAND', 400);
    const fields = new Set([...AUTH, ...FIELDS[route]]);
    if (Object.keys(body).some(k => !fields.has(k)) || AUTH.some(k => !Object.hasOwn(body, k)))
      reject('Only authenticated action intent is accepted.', 'INVALID_COMMAND', 400);
    if (!this.isReady()) reject('The online arena is not ready. Try again shortly.', 'UNAVAILABLE', 503);
    const auth = await this.authenticate(body);
    if (!auth || !safeId(auth.wallet) || typeof auth.session_id !== 'string') reject('Sign in again to enter the arena.', 'AUTH_REQUIRED', 401);
    if (!this.limits.allow('account:' + auth.wallet, 40, 80, this.clock())) reject('Too many commands; retry shortly.', 'RATE_LIMIT', 429);
    // A deposit check is a chain round-trip. Do it BEFORE taking the serial queue so it never
    // stalls the tick, and cap it hard: one wallet may not turn the arena into an RPC proxy.
    let verified = null;
    if (route === 'wager_deposit') {
      // Format first, then the limiter: a malformed request costs nothing, only a chain read does.
      if (typeof body.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(body.signature)) reject('A transaction signature is required.', 'INVALID_COMMAND', 400);
      if (!this.limits.allow('deposit:' + auth.wallet, 0.1, 6, this.clock())) reject('Too many deposit checks; retry shortly.', 'RATE_LIMIT', 429);
      try { verified = await this.wagerConfig.chain.readDeposit(body.signature); }
      catch { verified = { ok: false, error: 'The deposit could not be read from the chain right now. Retry shortly.' }; }
    }
    return this.serial(async () => {
      if (!this.isReady()) reject('The online arena is restarting.', 'UNAVAILABLE', 503);
      // Revalidate after queue wait: a newer login may have superseded this request.
      if (!(await this.authenticate(body))) reject('This sign-in was replaced. Sign in again.', 'AUTH_REQUIRED', 401);
      const rows = await this.ownedAssets(auth.wallet);
      if (!Array.isArray(rows)) reject('Owned creatures are still loading.', 'OWNERSHIP_UNAVAILABLE', 503);
      if (['session', 'queue', 'challenge', 'accept', 'wager_post', 'wager_accept', 'wager_deposit'].includes(route)) {
        // The request may itself be the first observer of a finished prior fight.
        // Resolve and persist its XP BEFORE selecting a level for the next admission.
        this.engine.tick(); this.settleWagers();
        try { await this.flush(); }
        catch { this.ready = false; this.reason = 'persistence_unavailable'; reject('Battle state could not be saved. Please reconnect.', 'UNAVAILABLE', 503); }
      }
      const publicRows = rows.slice(0, 400).map(r => ({ asset_id: r.asset_id, species: r.species,
        display_name: r.display_name, rarity: r.rarity, eligible: r.eligible === true, reason: r.reason || '',
        ...this.book.fighter(r.asset_id), trait: Object.hasOwn(SPECIES_TRAITS, r.species) ? clone(SPECIES_TRAITS[r.species]) : null }));
      if (route === 'roster') return { schema: 'chikiseum.live-roster/v1', ...this.flags(), ...this.bindings, fighters: publicRows };
      const prior = this.admitted.get(auth.wallet);
      const id = createHash('sha256').update(auth.wallet + '\0' + auth.session_id + '\0' + auth.epoch).digest('hex').slice(0, 36);
      let retiredMatch = null;
      if (prior && prior.id !== id) retiredMatch = this.engine.leases.get(prior.id) ?? null;
      if (prior && prior.id !== id) { this.engine.revoke(prior.id); this.admitted.delete(auth.wallet); }
      if (route === 'session') {
        const row = rows.find(r => r.asset_id === body.asset_id && r.eligible === true);
        if (!row) reject('Select an active Chikimon you own.', 'ASSET_UNAVAILABLE', 403);
        const level = this.book.fighter(row.asset_id).level;
        const result = this.engine.admit({ id, wallet: auth.wallet, asset_id: row.asset_id,
          species: row.species, level, handle: auth.handle || 'Trainer', inventory_verified: true });
        this.admitted.set(auth.wallet, { id, asset_id: row.asset_id, auth: Object.fromEntries(AUTH.map(k => [k, body[k]])) });
        await this.flush();
        return { ...result, ...this.bindings, progression: this.book.fighter(row.asset_id),
          prior_admission_retired: !!prior && prior.id !== id, retired_match_id: retiredMatch };
      }
      const admission = this.admitted.get(auth.wallet);
      if (!admission || admission.id !== id) reject('Choose your fighter again.', 'ADMISSION_REQUIRED', 409);
      if (!rows.some(r => r.asset_id === admission.asset_id && r.eligible === true)) {
        this.engine.revoke(id); this.admitted.delete(auth.wallet);
        reject('This fighter is no longer available to this wallet.', 'ASSET_UNAVAILABLE', 403);
      }
      // XP is installed only after a durable completion. Refresh before matchmaking,
      // never in the middle of a fight, so the next match uses the newly earned level.
      if (['queue', 'challenge', 'accept', 'wager_post', 'wager_accept', 'wager_deposit'].includes(route) && !this.engine.leases.has(id)) {
        const owned = rows.find(r => r.asset_id === admission.asset_id);
        this.engine.admit({ id, wallet: auth.wallet, asset_id: owned.asset_id, species: owned.species,
          level: this.book.fighter(owned.asset_id).level, handle: auth.handle || 'Trainer', inventory_verified: true });
      }
      let result;
      try {
        switch (route) {
          case 'lobby': result = this.engine.lobby(id); break;
          case 'queue': result = this.engine.queue(id); break;
          case 'challenge': result = this.engine.challenge(id, body.target); break;
          case 'accept': result = this.engine.accept(id, body.challenge_id); break;
          case 'state': result = this.engine.state(id, body.match_id); break;
          case 'ready': result = this.engine.ready(id, body.match_id); break;
          case 'move': result = this.engine.move(id, body.match_id, body.dx, body.dz, body.request_id); break;
          case 'cast': result = this.engine.cast(id, body.match_id, body.slot, body.request_id); break;
          case 'cancel': result = this.engine.cancel(id, body.match_id ?? null); break;
          default: result = this.wagerCommand(route, body, auth, id, admission, verified); break;
        }
      } catch (error) {
        if (error instanceof WagerRejected) reject(error.message, error.code, error.status);
        throw error;
      }
      if (route === 'wager_deposit' && result?.funded === true) result = this.pairWager(result.wager_id, auth.wallet);
      try { await this.flush(); }
      catch { this.ready = false; this.reason = 'persistence_unavailable'; reject('Battle state could not be saved. Please reconnect.', 'UNAVAILABLE', 503); }
      const receipt = body.match_id && this.book.value.receipts[body.match_id];
      return { ...result, ...ART_BINDING, progression: this.book.fighter(admission.asset_id),
        ...(receipt ? { battle_xp: { ...receipt.awards[admission.asset_id], reason: receipt.reason } } : {}) };
    });
  }
  wagerCommand(route, body, auth, trainerId, admission, verified = null) {
    const ledger = this.wagers, me = this.engine.admissions.get(trainerId);
    const party = me ? { wallet: auth.wallet, trainer_id: trainerId, asset_id: admission.asset_id, handle: me.handle, fighter: me.fighter } : null;
    const flags = { ...this.flags(), ...this.wagerFlags() };
    switch (route) {
      case 'wager_board': return { schema: 'chikiseum.wager-board/v1', ...flags, deposit_to: this.wagerConfig.treasury, board: ledger.board({ viewer: auth.wallet }) };
      case 'wager_mine': return { schema: 'chikiseum.wager-mine/v1', ...flags, deposit_to: this.wagerConfig.treasury, ...ledger.forWallet(auth.wallet) };
      case 'wager_post': {
        if (!this.wagerConfig.enabled) reject('Wagers are switched off right now.', 'WAGERS_DISABLED', 503);
        if (this.engine.leases.has(trainerId)) reject('Finish your current match first.', 'ACCOUNT_BUSY', 409);
        const sol = body.stake_sol;
        if (typeof sol !== 'number' || !Number.isFinite(sol) || sol <= 0) reject('stake_sol must be a positive number.', 'INVALID_COMMAND', 400);
        const lamports = Math.round(sol * LAMPORTS_PER_SOL);
        const wager = ledger.post({ party, stake_lamports: lamports });
        return { schema: 'chikiseum.wager/v1', ...flags, deposit_to: this.wagerConfig.treasury, wager };
      }
      case 'wager_accept': {
        if (!this.wagerConfig.enabled) reject('Wagers are switched off right now.', 'WAGERS_DISABLED', 503);
        if (this.engine.leases.has(trainerId)) reject('Finish your current match first.', 'ACCOUNT_BUSY', 409);
        const row = ledger.rows.get(body.wager_id);
        const challenger = row && this.engine.admissions.get(row.sides.A.trainer_id);
        if (row && row.status === 'open' && !challenger) reject('The challenger has left the arena.', 'CHALLENGER_AWAY', 409);
        const compatible = !!(row && challenger && me && ChikiseumLiveEngine.compatible(me.fighter, challenger.fighter));
        const wager = ledger.accept({ id: body.wager_id, party, compatible });
        return { schema: 'chikiseum.wager/v1', ...flags, deposit_to: this.wagerConfig.treasury, wager };
      }
      case 'wager_withdraw': return { schema: 'chikiseum.wager/v1', ...flags, wager: ledger.withdraw({ id: body.wager_id, wallet: auth.wallet }) };
      case 'wager_deposit': {
        // `verified` was read from the chain before the serial queue; see command().
        const { funded, view } = ledger.applyDeposit({ id: body.wager_id, wallet: auth.wallet, sig: body.signature, verified });
        return { schema: 'chikiseum.wager/v1', ...flags, funded, wager_id: body.wager_id, wager: view };
      }
    }
    reject('Unknown arena route.', 'NOT_FOUND', 404);
  }
  /** Both sides funded: create the match now, or refund both now. Nothing lingers in between. */
  pairWager(wagerId, wallet) {
    const row = this.wagers.rows.get(wagerId);
    let matchId = null, error = null;
    try { matchId = this.engine.pair(row.sides.A.trainer_id, row.sides.B.trainer_id).match_id; }
    catch (e) { error = e; }
    if (matchId) { const wager = this.wagers.bind({ id: wagerId, match_id: matchId }); return { schema: 'chikiseum.wager/v1', ...this.flags(), ...this.wagerFlags(), funded: true, matched: true, match_id: matchId, wager: this.wagers.view(wager.id, wallet) }; }
    this.wagers.abort({ id: wagerId, why: 'pairing_failed:' + String(error?.code || error?.message || 'unknown').slice(0, 40) });
    return { schema: 'chikiseum.wager/v1', ...this.flags(), ...this.wagerFlags(), funded: true, matched: false, match_id: null,
      refunding: true, reason: 'Your opponent is no longer available; both stakes are being refunded.', wager: this.wagers.view(wagerId, wallet) };
  }
  /** Operator actions on stuck payout legs. Authentication is the caller's (server.js admin signature). */
  adminWagers(action, { wager_id, leg_id, sig, operator }) {
    if (!this.wagers) reject('Wagers are not configured.', 'WAGERS_DISABLED', 404);
    return this.serial(async () => {
      if (!this.isReady()) reject('The online arena is restarting.', 'UNAVAILABLE', 503);
      try {
        if (action === 'stuck') return { stuck: this.wagers.stuckLegs(), liability_sol: this.liabilitySol() };
        if (action === 'resolve') this.wagers.resolveStuck(wager_id, leg_id, { sig, operator });
        else if (action === 'retry') this.wagers.retryStuck(wager_id, leg_id, { operator });
        else reject('Unknown admin action.', 'NOT_FOUND', 404);
      } catch (error) { if (error instanceof WagerRejected) reject(error.message, error.code, error.status); throw error; }
      await this.flush(true);
      return { ok: true, wager: this.wagers.view(wager_id) };
    });
  }
}
export function installChikiseumLive(app, options) {
  const service = new ChikiseumLiveService(options);
  const origins = new Set(['https://chikimonsters.com', 'https://www.chikimonsters.com', 'https://gtjvv976mb-netizen.github.io']);
  app.use(LIVE_PREFIX, (req, res, next) => {
    res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return res.status(403).json({ code: 'ORIGIN_DENIED', error: 'Untrusted game origin.' });
    // Do not trust arbitrary X-Forwarded-For. Per-account caps are separate from this upstream cap.
    const remote = req.socket.remoteAddress || 'unknown';
    if (!service.limits.allow('upstream:' + remote, 2500, 5000, service.clock()))
      return res.status(429).json({ code: 'RATE_LIMIT', error: 'Arena is busy; retry shortly.' });
    next();
  });
  app.get(LIVE_PREFIX + '/health', (_req, res) => { const data = service.health(); res.status(data.ready ? 200 : 503).json(data); });
  // Operator route for stuck payouts. `adminOk(body, action)` is the server's own admin-signature check.
  if (typeof options?.wagers?.adminOk === 'function') app.post(LIVE_PREFIX + '/wager_admin', async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ code: 'INVALID_COMMAND', error: 'JSON required.' });
    const body = req.body || {};
    if (!(await options.wagers.adminOk(body, 'chikiseum_wager_admin'))) return res.status(401).json({ code: 'AUTH_REQUIRED', error: 'admin signature required (action:chikiseum_wager_admin + fresh nonce)' });
    try { res.json(await service.adminWagers(body.action, { wager_id: body.wager_id, leg_id: body.leg_id, sig: body.sig, operator: body.adminWallet })); }
    catch (error) {
      if (error instanceof LiveRejected) return res.status(error.status).json({ code: error.code, error: error.message });
      res.status(503).json({ code: 'UNAVAILABLE', error: 'The online arena is temporarily unavailable.' });
    }
  });
  app.post(LIVE_PREFIX + '/:route', async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ code: 'INVALID_COMMAND', error: 'JSON required.' });
    try { res.json(await service.command(req.params.route, req.body)); }
    catch (error) {
      if (error instanceof LiveRejected) return res.status(error.status).json({ code: error.code, error: error.message });
      res.status(503).json({ code: 'UNAVAILABLE', error: 'The online arena is temporarily unavailable.' });
    }
  });
  return service;
}
