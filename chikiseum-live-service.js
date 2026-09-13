// Authenticated HTTP boundary for free, simultaneous PvP. This module cannot sign/pay SOL.
import { createHash } from 'node:crypto';
import { ChikiseumLiveEngine, LiveRejected } from './chikiseum-live-engine.js';
import { ChikiseumProgressBook } from './chikiseum-live-progression.js';
import { ChikiseumLiveNavigation } from './chikiseum-live-navigation.js';

export const LIVE_PREFIX = '/chikiseum/live/v1';
export const LIVE_KEY = 'chikiseum_live_v1';
export const ART_BINDING = Object.freeze({ art_manifest_sha256: 'c52bbc8c43bfd1a0aaa77e261259846ab20e2911627e58b0d041af322eb559ca', art_version: '02400b320307' });
const AUTH = ['wallet', 'mktToken', 'sessionId', 'sessionEpoch'];
const FIELDS = Object.freeze({ roster: [], session: ['asset_id'], lobby: [], queue: [],
  challenge: ['target'], accept: ['challenge_id'], state: ['match_id'], ready: ['match_id'],
  cast: ['match_id', 'slot', 'request_id'], move: ['match_id', 'dx', 'dz', 'request_id'], cancel: ['match_id'] });
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
    clock = now, enabled = true } = {}) {
    if ([authenticate, ownedAssets, leaseFactory, available].some(f => typeof f !== 'function')) throw new Error('Trusted live callbacks required');
    Object.assign(this, { authenticate, ownedAssets, leaseFactory, available, engineFactory, clock, enabled });
    this.engine = null; this.book = null; this.lease = null; this.bindings = null;
    this.ready = false; this.booting = false; this.closed = false; this.reason = enabled ? 'starting' : 'disabled';
    this.admitted = new Map(); this.limits = new Limits(); this.tail = Promise.resolve(); this.queued = 0;
    this.lastFlush = 0; this.lastAudit = 0; this.lastBoot = -Infinity; this.timer = null;
  }
  flags() { return { mode: 'live', currency: 'NONE', real_sol_enabled: false, inventory_verified: true }; }
  health() { return { schema: 'chikiseum.live-health/v1', ...this.flags(), ready: this.isReady(),
    reason: this.isReady() ? null : this.reason, ...(this.bindings || {}),
    progression: 'server_earned_pvp', entry_stake: 0, rewards: false }; }
  isReady() { return this.ready && !this.closed && this.available() && this.lease?.valid === true; }
  async boot() {
    if (!this.enabled || this.closed || this.ready || this.booting || !this.available() || this.clock() - this.lastBoot < 5) return false;
    this.lastBoot = this.clock();
    this.booting = true;
    try {
      await this.lease?.close?.(); this.lease = null;
      this.admitted.clear();
      this.lease = await this.leaseFactory();
      if (!this.lease || this.lease.valid !== true || typeof this.lease.read !== 'function' || typeof this.lease.write !== 'function')
        throw new Error('Exclusive durable lease unavailable');
      const saved = await this.lease.read(LIVE_KEY);
      if (saved != null && (saved.schema !== 'chikiseum.live-store/v1' || !obj(saved.progression) || !obj(saved.engine)))
        throw new Error('Invalid durable PvP state');
      this.book = new ChikiseumProgressBook(saved?.progression ?? null);
      this.engine = this.engineFactory();
      if (saved) this.engine.restore(saved.engine); // Pending matches become cancelled, never completed/awarded.
      this.bindings = { catalogue_sha256: this.engine.catalogue_sha256, arena: clone(this.engine.arena), ...ART_BINDING };
      await this.flush(true);
      this.reason = ''; this.ready = true;
      return true;
    } catch {
      this.ready = false; this.reason = 'durable_service_unavailable';
      try { await this.lease?.close?.(); } catch {}
      this.lease = null; this.engine = null; this.book = null;
      return false;
    } finally { this.booting = false; }
  }
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
    if (!force && !completions.length && this.clock() - this.lastFlush < 2) return;
    let next = this.book;
    for (const summary of completions) next = next.withCompletion(summary, this.clock()).book;
    await this.lease.write(LIVE_KEY, { schema: 'chikiseum.live-store/v1', progression: next.snapshot(), engine: this.engine.checkpoint() });
    this.book = next; this.lastFlush = this.clock();
    for (const summary of completions) this.engine.acknowledgeCompletion(summary.match_id);
  }
  start() {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => {
      if (this.queued > 1 || this.closed) return;
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
        this.engine.tick(); await this.flush();
      }).catch(() => { this.ready = false; this.reason = 'persistence_or_authority_unavailable'; });
    }, 50);
    this.timer.unref?.();
  }
  async stop() {
    this.closed = true; this.ready = false;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    await this.serial(async () => {
      try { if (this.engine && this.lease?.valid) { this.engine.shutdown(); await this.flush(true); } }
      finally { await this.lease?.close?.(); this.admitted.clear(); }
    });
  }
  async command(route, body) {
    if (!Object.hasOwn(FIELDS, route)) reject('Unknown arena route.', 'NOT_FOUND', 404);
    if (!obj(body) || Buffer.byteLength(JSON.stringify(body)) > 8192) reject('Bounded JSON object required.', 'INVALID_COMMAND', 400);
    const fields = new Set([...AUTH, ...FIELDS[route]]);
    if (Object.keys(body).some(k => !fields.has(k)) || AUTH.some(k => !Object.hasOwn(body, k)))
      reject('Only authenticated action intent is accepted.', 'INVALID_COMMAND', 400);
    if (!this.isReady()) reject('The online arena is not ready. Try again shortly.', 'UNAVAILABLE', 503);
    const auth = await this.authenticate(body);
    if (!auth || !safeId(auth.wallet) || typeof auth.session_id !== 'string') reject('Sign in again to enter the arena.', 'AUTH_REQUIRED', 401);
    if (!this.limits.allow('account:' + auth.wallet, 40, 80, this.clock())) reject('Too many commands; retry shortly.', 'RATE_LIMIT', 429);
    return this.serial(async () => {
      if (!this.isReady()) reject('The online arena is restarting.', 'UNAVAILABLE', 503);
      // Revalidate after queue wait: a newer login may have superseded this request.
      if (!(await this.authenticate(body))) reject('This sign-in was replaced. Sign in again.', 'AUTH_REQUIRED', 401);
      const rows = await this.ownedAssets(auth.wallet);
      if (!Array.isArray(rows)) reject('Owned creatures are still loading.', 'OWNERSHIP_UNAVAILABLE', 503);
      if (['session', 'queue', 'challenge', 'accept'].includes(route)) {
        // The request may itself be the first observer of a finished prior fight.
        // Resolve and persist its XP BEFORE selecting a level for the next admission.
        this.engine.tick();
        try { await this.flush(); }
        catch { this.ready = false; this.reason = 'persistence_unavailable'; reject('Battle state could not be saved. Please reconnect.', 'UNAVAILABLE', 503); }
      }
      const publicRows = rows.slice(0, 400).map(r => ({ asset_id: r.asset_id, species: r.species,
        display_name: r.display_name, rarity: r.rarity, eligible: r.eligible === true, reason: r.reason || '',
        ...this.book.fighter(r.asset_id) }));
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
      if (['queue', 'challenge', 'accept'].includes(route) && !this.engine.leases.has(id)) {
        const owned = rows.find(r => r.asset_id === admission.asset_id);
        this.engine.admit({ id, wallet: auth.wallet, asset_id: owned.asset_id, species: owned.species,
          level: this.book.fighter(owned.asset_id).level, handle: auth.handle || 'Trainer', inventory_verified: true });
      }
      let result;
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
      }
      try { await this.flush(); }
      catch { this.ready = false; this.reason = 'persistence_unavailable'; reject('Battle state could not be saved. Please reconnect.', 'UNAVAILABLE', 503); }
      const receipt = body.match_id && this.book.value.receipts[body.match_id];
      return { ...result, ...ART_BINDING, progression: this.book.fighter(admission.asset_id),
        ...(receipt ? { battle_xp: { ...receipt.awards[admission.asset_id], reason: receipt.reason } } : {}) };
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
