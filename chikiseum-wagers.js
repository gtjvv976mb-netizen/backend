// Chikiseum SOL wagers — the LEDGER. Pure state, no I/O, no signing, no network.
//
// Two players stake the same amount of SOL on one live arena match. Custody is server-held: both
// stakes are transferred INTO the treasury wallet before the match is created, and the treasury
// pays the winner (or refunds both) afterwards. This module decides what is owed to whom and when;
// the service around it does the reading of deposits and the sending of payouts, and reports back
// through the record* methods. Every amount is an integer number of lamports.
//
// Lifecycle of one wager:
//
//   posted     challenger created it; waiting for THEIR deposit. Not on the board. Expires unpaid.
//   open       challenger's deposit verified on-chain. On the board. Expires with a refund.
//   accepting  an acceptor has locked it; waiting for THEIR deposit. Falls back to open if unpaid.
//   funded     both deposits verified. Transient: the service pairs the two fighters at once,
//              and either binds the match (matched) or aborts (refund both).
//   matched    the arena match exists. The outcome comes from the engine's terminal match status.
//   settling   the outcome is known; payout legs are being sent and confirmed.
//   settled / refunded   every leg confirmed on-chain. Terminal.
//   expired / void       never funded; nothing is owed. Terminal.
//
// Outcomes: a finished match with a winner, or a forfeit, pays the winner the pot minus rake.
// Everything else — a draw by HP, a double absence, a cancel before the fight, a ready timeout, an
// admission revoked mid-lobby, a restart — refunds both stakes in full. An abandoned fight is a
// forfeit and pays the opponent: with money on the line, walking away cannot be free.
//
// Payout legs are written to durable state as `sending` BEFORE anything is broadcast, so a crash
// can never lose track of a payment that might have gone out; a leg found in `sending` on boot is
// reconciled by the memo it carries, never blindly resent. A leg that keeps failing becomes `stuck`
// and waits for an operator — a stuck payout is recoverable, a double payout is not.

export const WAGER_SCHEMA = 'chikiseum.wagers/v1';
export const MEMO_PREFIX = 'chikiseum-wager';
export const LAMPORTS_PER_SOL = 1_000_000_000;
const UNIT = 1_000;                     // stakes are whole micro-SOL (0.000001 SOL); no dust stakes
const DAY = 86_400;

const NON_TERMINAL = new Set(['posted', 'open', 'accepting', 'funded', 'matched', 'settling']);
const LIVE = new Set(['posted', 'open', 'accepting', 'funded', 'matched']);   // undecided: blocks the wallet from a second wager
const HOLDING = new Set(['open', 'accepting', 'funded', 'matched', 'settling']);   // treasury holds money for these
const TERMINAL = new Set(['settled', 'refunded', 'expired', 'void']);
const LEG_OPEN = new Set(['due', 'sending', 'sent', 'stuck']);
const REFUND_STATUSES = new Set(['draw', 'cancelled', 'ready_timeout', 'admission_revoked', 'server_restart']);

const copy = x => structuredClone(x);
const safe = s => typeof s === 'string' && s.length > 0 && s.length <= 160 && !/[\x00-\x1f\x7f]/.test(s);
const isSig = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(s);
const lamportsOk = n => Number.isSafeInteger(n) && n >= 0;
const short = w => (typeof w === 'string' && w.length > 12) ? w.slice(0, 4) + '…' + w.slice(-4) : String(w);
const dayOf = now => Math.floor(now / DAY);

export class WagerRejected extends Error {
  constructor(message, code = 'INVALID_COMMAND', status = 400) { super(message); this.name = 'WagerRejected'; this.code = code; this.status = status; }
}
const fail = (message, code = 'INVALID_COMMAND', status = 400) => { throw new WagerRejected(message, code, status); };

export const DEFAULT_LIMITS = Object.freeze({
  min_lamports: 1_000_000,             // 0.001 SOL
  max_lamports: 50_000_000,            // 0.05 SOL — deliberately low while custody is server-held
  wallet_daily_lamports: 250_000_000,  // 0.25 SOL of stakes per wallet per UTC day
  max_rows: 2_000,                     // non-terminal rows the ledger will hold at once
  board_size: 50,
  post_ttl: 600,                       // seconds to fund your own challenge
  open_ttl: 1_800,                     // seconds a funded challenge stays on the board
  accept_ttl: 300,                     // seconds an acceptor has to fund
  max_attempts: 5,                     // payout sends before a leg is stuck
  retry_after: 20,                     // seconds between payout attempts
  prune_after: 7 * DAY,                // terminal rows are dropped after this
});

export function memoFor(id, leg) { return `${MEMO_PREFIX}:${id}:${leg}`; }

export class ChikiseumWagerLedger {
  constructor({ clock, limits = {}, rakeBps = 0, idFactory } = {}) {
    if (typeof clock !== 'function') throw new Error('Ledger clock required');
    this.clock = clock;
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
    for (const k of ['min_lamports', 'max_lamports', 'wallet_daily_lamports']) if (!lamportsOk(this.limits[k])) throw new Error('Invalid wager limit ' + k);
    if (this.limits.min_lamports < UNIT || this.limits.max_lamports < this.limits.min_lamports) throw new Error('Invalid stake bounds');
    if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > 2_000) throw new Error('Rake must be 0..2000 bps');
    this.rakeBps = rakeBps;
    this.idFactory = idFactory ?? (() => 'w' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10));
    this.rows = new Map();       // id -> wager
    this.usedSigs = new Map();   // deposit signature -> wager id
    this.daily = new Map();      // wallet -> { day, lamports }
    this.dirty = false;
  }

  // ---------------------------------------------------------------- helpers
  _now() { const n = this.clock(); if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error('Ledger clock invalid'); return n; }
  _touch(w, now) { w.updated_at = now; this.dirty = true; }
  _log(w, now, why) { w.history.push({ at: now, status: w.status, why }); if (w.history.length > 24) w.history.splice(0, w.history.length - 24); }
  _set(w, status, now, why) { w.status = status; this._log(w, now, why); this._touch(w, now); }
  _row(id) { if (!safe(id)) fail('Invalid wager ID'); const w = this.rows.get(id); if (!w) fail('Unknown wager', 'NOT_FOUND', 404); return w; }
  _sideOf(w, wallet) { if (w.sides.A?.wallet === wallet) return 'A'; if (w.sides.B?.wallet === wallet) return 'B'; return null; }
  // A wager whose outcome is decided (settling) no longer blocks the wallet: its money's fate is
  // fixed and the daily cap bounds exposure. A stuck payout must never lock a player out for days.
  _activeFor(wallet) { for (const w of this.rows.values()) if (LIVE.has(w.status) && this._sideOf(w, wallet)) return w; return null; }
  _spentToday(wallet, now) { const d = this.daily.get(wallet); return d && d.day === dayOf(now) ? d.lamports : 0; }
  _spend(wallet, lamports, now) {
    const day = dayOf(now), d = this.daily.get(wallet);
    this.daily.set(wallet, { day, lamports: (d && d.day === day ? d.lamports : 0) + lamports });
  }
  _checkStake(lamports) {
    if (!lamportsOk(lamports) || lamports % UNIT !== 0) fail('Stake must be a whole number of micro-SOL');
    if (lamports < this.limits.min_lamports) fail(`Minimum stake is ${this.limits.min_lamports / LAMPORTS_PER_SOL} SOL`, 'STAKE_TOO_SMALL');
    if (lamports > this.limits.max_lamports) fail(`Maximum stake is ${this.limits.max_lamports / LAMPORTS_PER_SOL} SOL`, 'STAKE_TOO_LARGE');
  }
  _checkParty(wallet, lamports, now) {
    if (this._activeFor(wallet)) fail('You already have a wager in progress', 'WAGER_BUSY', 409);
    if (this._spentToday(wallet, now) + lamports > this.limits.wallet_daily_lamports)
      fail(`Daily wager limit is ${this.limits.wallet_daily_lamports / LAMPORTS_PER_SOL} SOL`, 'DAILY_LIMIT', 429);
  }
  _party(p) {
    if (!p || !safe(p.wallet) || !safe(p.trainer_id) || !safe(p.asset_id) || !p.fighter || !safe(p.fighter.species)) fail('Trusted admitted fighter required', 'ADMISSION_REQUIRED', 409);
    const f = p.fighter;
    return { wallet: p.wallet, trainer_id: p.trainer_id, asset_id: p.asset_id, handle: safe(p.handle) ? p.handle.slice(0, 24) : 'Trainer',
      fighter: { species: f.species, display_name: safe(f.display_name) ? f.display_name : f.species, rarity: safe(f.rarity) ? f.rarity : 'unknown',
        level: Number.isInteger(f.level) ? f.level : 1, card_tier: Number.isInteger(f.card_tier) ? f.card_tier : 0 }, deposit: null };
  }
  _leg(w, id, to, lamports, reason, now) {
    if (w.legs.some(l => l.id === id)) return;   // legs are keyed; a second decision never adds a second payment
    if (!lamportsOk(lamports) || lamports === 0) return;
    w.legs.push({ id, to, lamports, reason, memo: memoFor(w.id, id), status: 'due', attempts: 0, sig: null,
      blockhash: null, last_valid_block_height: null, created_at: now, sending_at: null, sent_at: null, confirmed_at: null, error: null, next_attempt_at: now });
    this._touch(w, now);
  }
  _refundBoth(w, now, why) {
    for (const side of ['A', 'B']) { const s = w.sides[side]; if (s?.deposit) this._leg(w, 'R' + side, s.wallet, w.stake_lamports, 'refund', now); }
    w.outcome = w.outcome ?? { status: why, winner: null, at: now };
    this._set(w, 'settling', now, why); this._settleIfDone(w, now);
  }
  _settleIfDone(w, now) {
    if (w.status !== 'settling') return;
    if (w.legs.some(l => LEG_OPEN.has(l.status))) return;
    this._set(w, w.legs.some(l => l.reason === 'win') ? 'settled' : 'refunded', now, 'all legs confirmed');
  }

  // ------------------------------------------------------------- commands
  /** Challenger creates a wager. It is not on the board until their deposit is verified. */
  post({ party, stake_lamports }) {
    const now = this._now(); const p = this._party(party);
    this._checkStake(stake_lamports); this._checkParty(p.wallet, stake_lamports, now);
    if ([...this.rows.values()].filter(w => NON_TERMINAL.has(w.status)).length >= this.limits.max_rows) fail('Wager capacity reached', 'CAPACITY', 503);
    let id = this.idFactory(); if (!safe(id) || this.rows.has(id)) id = this.idFactory(); if (!safe(id) || this.rows.has(id)) fail('Wager ID collision', 'UNAVAILABLE', 503);
    const w = { schema: WAGER_SCHEMA, id, status: 'posted', stake_lamports, rake_bps: this.rakeBps, rake_taken: 0,
      created_at: now, updated_at: now, post_deadline: now + this.limits.post_ttl, open_deadline: null, accept_deadline: null,
      sides: { A: p, B: null }, match_id: null, outcome: null, legs: [], history: [] };
    this.rows.set(id, w); this._spend(p.wallet, stake_lamports, now); this._log(w, now, 'posted'); this.dirty = true;
    return this.view(w, p.wallet);
  }
  /** Funded challenges waiting for an opponent — what the in-game pill lists. */
  board({ viewer = null } = {}) {
    const now = this._now();
    return [...this.rows.values()].filter(w => w.status === 'open')
      .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id)).slice(0, this.limits.board_size)
      .map(w => ({ id: w.id, stake_lamports: w.stake_lamports, stake_sol: w.stake_lamports / LAMPORTS_PER_SOL, rake_bps: w.rake_bps,
        expires_in: Math.max(0, Math.round(w.open_deadline - now)), challenger: this._publicSide(w.sides.A), yours: w.sides.A.wallet === viewer }));
  }
  /** Acceptor locks an open wager. `compatible` is the engine's verdict on the two fighters, decided by the caller. */
  accept({ id, party, compatible }) {
    const now = this._now(); const w = this._row(id); const p = this._party(party);
    if (w.status !== 'open') fail('This wager is no longer open', 'WAGER_NOT_OPEN', 409);
    if (w.sides.A.wallet === p.wallet) fail('You cannot accept your own wager');
    if (compatible !== true) fail('Your fighter is outside this wager\'s matchmaking limits', 'INCOMPATIBLE', 409);
    this._checkParty(p.wallet, w.stake_lamports, now);
    w.sides.B = p; w.accept_deadline = now + this.limits.accept_ttl; this._spend(p.wallet, w.stake_lamports, now);
    this._set(w, 'accepting', now, 'accepted by ' + short(p.wallet));
    return this.view(w, p.wallet);
  }
  /** Back out. What that means depends on where the wager is and who is asking. */
  withdraw({ id, wallet }) {
    const now = this._now(); const w = this._row(id); const side = this._sideOf(w, wallet);
    if (!side) fail('Not your wager', 'PRIVATE_VIEW_DENIED', 403);
    if (w.status === 'posted' && side === 'A') { this._set(w, 'void', now, 'withdrawn before funding'); return this.view(w, wallet); }
    if (w.status === 'open' && side === 'A') { this._refundBoth(w, now, 'cancelled'); return this.view(w, wallet); }
    if (w.status === 'accepting' && side === 'A') { this._refundBoth(w, now, 'cancelled'); return this.view(w, wallet); }
    if (w.status === 'accepting' && side === 'B') {
      w.sides.B = null; w.accept_deadline = null; this._set(w, 'open', now, 'acceptor backed out');
      return this.view(w, wallet);
    }
    fail('This wager can no longer be withdrawn — the match decides it', 'WAGER_LOCKED', 409);
  }
  /**
   * Credit a verified on-chain deposit. `verified` is what the chain reader saw for `sig`:
   *   { ok, error, signers: [wallet...], treasury_gain_lamports, memo }
   * The ledger trusts NOTHING about it except what it can cross-check: the signer must be this
   * wallet, the memo must name this wager and side, and the treasury must have gained the stake.
   */
  applyDeposit({ id, wallet, sig, verified }) {
    const now = this._now(); const w = this._row(id); const side = this._sideOf(w, wallet);
    if (!side) fail('Not your wager', 'PRIVATE_VIEW_DENIED', 403);
    if (!isSig(sig)) fail('A transaction signature is required');
    // Replay is checked before phase: "already credited" is the truer answer than "not expected".
    const prior = this.usedSigs.get(sig);
    if (prior) fail(prior === id ? 'This deposit is already credited' : 'This transaction was already used', 'DEPOSIT_REPLAYED', 409);
    if (!(w.status === 'posted' && side === 'A') && !(w.status === 'accepting' && side === 'B')) fail('This wager is not waiting for your deposit', 'DEPOSIT_NOT_EXPECTED', 409);
    if (!verified || verified.ok !== true) fail(verified?.error || 'Deposit could not be verified on-chain', 'DEPOSIT_UNVERIFIED', 402);
    if (!Array.isArray(verified.signers) || !verified.signers.includes(wallet)) fail('The deposit was not signed by your wallet', 'DEPOSIT_WRONG_SIGNER', 402);
    if (verified.memo !== memoFor(id, side)) fail(`The deposit must carry the memo "${memoFor(id, side)}"`, 'DEPOSIT_WRONG_MEMO', 402);
    const gain = verified.treasury_gain_lamports;
    if (!lamportsOk(gain) || gain < w.stake_lamports) fail(`The deposit must move exactly ${w.stake_lamports / LAMPORTS_PER_SOL} SOL to the treasury`, 'DEPOSIT_SHORT', 402);
    this.usedSigs.set(sig, id);
    w.sides[side].deposit = { sig, lamports: gain, at: now };
    if (gain > w.stake_lamports) this._leg(w, 'O' + side, wallet, gain - w.stake_lamports, 'overpay', now);   // excess goes straight back
    if (side === 'A') { w.open_deadline = now + this.limits.open_ttl; w.post_deadline = null; this._set(w, 'open', now, 'challenger funded'); }
    else { w.accept_deadline = null; this._set(w, 'funded', now, 'acceptor funded'); }
    return { funded: w.status === 'funded', view: this.view(w, wallet) };
  }
  /** The service created the arena match for a funded wager. */
  bind({ id, match_id }) {
    const now = this._now(); const w = this._row(id);
    if (w.status !== 'funded') fail('Wager is not awaiting a match', 'WAGER_NOT_FUNDED', 409);
    if (!safe(match_id)) fail('Invalid match ID');
    w.match_id = match_id; this._set(w, 'matched', now, 'match ' + match_id);
    return this.view(w, w.sides.A.wallet);
  }
  /** The service could not create the match (someone left, or is no longer compatible). Both get their stake back. */
  abort({ id, why = 'pairing_failed' }) {
    const now = this._now(); const w = this._row(id);
    if (w.status !== 'funded') fail('Wager is not awaiting a match', 'WAGER_NOT_FUNDED', 409);
    this._refundBoth(w, now, why);
  }

  // --------------------------------------------------------------- clockwork
  /** Expiries. Called every service tick. */
  tick() {
    const now = this._now();
    for (const w of this.rows.values()) {
      if (w.status === 'posted' && w.post_deadline <= now) this._set(w, 'expired', now, 'never funded');
      else if (w.status === 'accepting' && w.accept_deadline <= now) { w.sides.B = null; w.accept_deadline = null; this._set(w, 'open', now, 'acceptor did not fund in time'); }
      else if (w.status === 'open' && w.open_deadline <= now) this._refundBoth(w, now, 'expired_unmatched');
      else if (TERMINAL.has(w.status) && now - w.updated_at > this.limits.prune_after) { this.rows.delete(w.id); this.dirty = true; }
    }
    for (const [wallet, d] of this.daily) if (d.day < dayOf(now) - 1) { this.daily.delete(wallet); this.dirty = true; }
    for (const [sig, id] of this.usedSigs) if (!this.rows.has(id)) { this.usedSigs.delete(sig); this.dirty = true; }
  }
  /**
   * Read outcomes off the engine. `lookup(match_id)` returns the engine's match record (status,
   * winner) or null if the engine no longer has it. An unknown outcome is a refund, never a guess.
   */
  observe(lookup) {
    const now = this._now();
    for (const w of this.rows.values()) {
      if (w.status !== 'matched') continue;
      const m = lookup(w.match_id);
      if (!m) { this._refundBoth(w, now, 'match_lost'); continue; }
      if (m.status === 'ready' || m.status === 'active') continue;
      const decided = (m.status === 'finished' || m.status === 'forfeit') && (m.winner === 'A' || m.winner === 'B');
      if (decided) {
        const winner = w.sides[m.winner];
        const pot = w.stake_lamports * 2, rake = Math.floor(pot * w.rake_bps / 10_000);
        w.rake_taken = rake; w.outcome = { status: m.status, winner: m.winner, at: now };
        this._leg(w, 'W', winner.wallet, pot - rake, 'win', now);
        this._set(w, 'settling', now, `${m.status}: ${m.winner} wins`); this._settleIfDone(w, now);
      } else if (m.status === 'finished' || REFUND_STATUSES.has(m.status)) {
        this._refundBoth(w, now, m.status === 'finished' ? 'draw' : m.status);
      } else {
        this._refundBoth(w, now, 'unknown_outcome:' + String(m.status).slice(0, 32));
      }
    }
  }

  // --------------------------------------------------------- payout rail
  /** Legs the pump should send now: due (or retriable) and past their backoff. */
  dueLegs() {
    const now = this._now(), out = [];
    for (const w of this.rows.values()) if (w.status === 'settling') for (const l of w.legs)
      if (l.status === 'due' && l.next_attempt_at <= now) out.push({ wager_id: w.id, leg_id: l.id, to: l.to, lamports: l.lamports, memo: l.memo, attempts: l.attempts });
    return out;
  }
  /** Legs in `sending` — a send may or may not have gone out. Boot must reconcile these by memo. */
  unresolvedLegs() {
    const out = [];
    for (const w of this.rows.values()) for (const l of w.legs) if (l.status === 'sending') out.push({ wager_id: w.id, leg_id: l.id, memo: l.memo, sending_at: l.sending_at, to: l.to, lamports: l.lamports });
    return out;
  }
  sentLegs() {
    const out = [];
    for (const w of this.rows.values()) for (const l of w.legs) if (l.status === 'sent') out.push({ wager_id: w.id, leg_id: l.id, sig: l.sig, blockhash: l.blockhash, last_valid_block_height: l.last_valid_block_height });
    return out;
  }
  stuckLegs() {
    const out = [];
    for (const w of this.rows.values()) for (const l of w.legs) if (l.status === 'stuck') out.push({ wager_id: w.id, leg_id: l.id, to: l.to, lamports: l.lamports, memo: l.memo, attempts: l.attempts, error: l.error, sig: l.sig });
    return out;
  }
  _legOf(wid, lid) { const w = this._row(wid); const l = w.legs.find(x => x.id === lid); if (!l) fail('Unknown payout leg', 'NOT_FOUND', 404); return [w, l]; }
  /** MUST be persisted before the send is attempted. */
  markSending(wid, lid) {
    const now = this._now(); const [w, l] = this._legOf(wid, lid);
    if (l.status !== 'due') fail('Leg is not due', 'LEG_STATE', 409);
    l.status = 'sending'; l.sending_at = now; l.attempts++; l.error = null; this._touch(w, now);
  }
  recordBroadcast(wid, lid, { sig, blockhash = null, last_valid_block_height = null }) {
    const now = this._now(); const [w, l] = this._legOf(wid, lid);
    if (l.status !== 'sending') fail('Leg was not being sent', 'LEG_STATE', 409);
    if (!isSig(sig)) fail('Broadcast signature required');
    l.status = 'sent'; l.sig = sig; l.blockhash = blockhash; l.last_valid_block_height = last_valid_block_height; l.sent_at = now; this._touch(w, now);
  }
  /** The send threw BEFORE anything was broadcast (RPC down, bad blockhash fetch). Safe to retry. */
  recordSendError(wid, lid, error) {
    const now = this._now(); const [w, l] = this._legOf(wid, lid);
    if (l.status !== 'sending') fail('Leg was not being sent', 'LEG_STATE', 409);
    l.error = String(error?.message || error || 'send failed').slice(0, 200);
    this._retryOrStick(l, now); this._touch(w, now);
  }
  /** Confirmation result for a sent leg. */
  recordStatus(wid, lid, status) {
    const now = this._now(); const [w, l] = this._legOf(wid, lid);
    if (l.status !== 'sent') fail('Leg was not awaiting confirmation', 'LEG_STATE', 409);
    if (status === 'confirmed') { l.status = 'confirmed'; l.confirmed_at = now; this._touch(w, now); this._settleIfDone(w, now); return; }
    if (status === 'pending') return;
    // expired: the blockhash lapsed and the transaction can never land. failed: it landed and errored,
    // so nothing moved. Both mean no transfer happened; a fresh transaction is safe.
    if (status === 'expired' || status === 'failed') { l.error = status; l.sig = null; l.blockhash = null; l.last_valid_block_height = null; this._retryOrStick(l, now); this._touch(w, now); return; }
    fail('Unknown payout status');
  }
  /** Boot-time reconciliation of a `sending` leg: the memo was found on-chain (→ sent) or definitively not (→ due). */
  reconcile(wid, lid, found) {
    const now = this._now(); const [w, l] = this._legOf(wid, lid);
    if (l.status !== 'sending') fail('Leg is not unresolved', 'LEG_STATE', 409);
    if (found && isSig(found.sig)) { l.status = 'sent'; l.sig = found.sig; l.sent_at = now; this._touch(w, now); return 'sent'; }
    l.error = 'not found after restart'; this._retryOrStick(l, now); this._touch(w, now); return l.status;
  }
  /** An operator confirmed a stuck leg by hand (they paid it, or verified the payment on the explorer). */
  resolveStuck(wid, lid, { sig, operator }) {
    const now = this._now(); const [w, l] = this._legOf(wid, lid);
    if (l.status !== 'stuck') fail('Leg is not stuck', 'LEG_STATE', 409);
    if (!isSig(sig) || !safe(operator)) fail('Signature and operator required');
    l.status = 'confirmed'; l.sig = sig; l.confirmed_at = now; l.error = 'resolved by ' + operator.slice(0, 64); this._touch(w, now); this._settleIfDone(w, now);
  }
  /** An operator releases a stuck leg for another automatic attempt after fixing the cause. */
  retryStuck(wid, lid, { operator }) {
    const now = this._now(); const [w, l] = this._legOf(wid, lid);
    if (l.status !== 'stuck') fail('Leg is not stuck', 'LEG_STATE', 409);
    if (!safe(operator)) fail('Operator required');
    l.status = 'due'; l.attempts = 0; l.next_attempt_at = now; l.error = 'retry released by ' + operator.slice(0, 64); this._touch(w, now);
  }
  _retryOrStick(l, now) {
    if (l.attempts >= this.limits.max_attempts) { l.status = 'stuck'; return; }
    l.status = 'due'; l.next_attempt_at = now + this.limits.retry_after * l.attempts;
  }

  // ---------------------------------------------------------- accounting
  /** Lamports the treasury is holding for players: everything in minus everything out minus rake. */
  liabilityLamports() {
    let owed = 0;
    for (const w of this.rows.values()) {
      if (!HOLDING.has(w.status)) continue;
      for (const side of ['A', 'B']) owed += w.sides[side]?.deposit?.lamports ?? 0;
      for (const l of w.legs) if (l.status === 'confirmed') owed -= l.lamports;
      owed -= w.rake_taken;
    }
    return Math.max(0, owed);
  }
  liabilitySol() { return this.liabilityLamports() / LAMPORTS_PER_SOL; }
  counts() {
    const c = { posted: 0, open: 0, accepting: 0, funded: 0, matched: 0, settling: 0, settled: 0, refunded: 0, expired: 0, void: 0 };
    for (const w of this.rows.values()) c[w.status] = (c[w.status] ?? 0) + 1;
    return c;
  }

  // --------------------------------------------------------------- views
  _publicSide(s) { return s ? { wallet: s.wallet, handle: s.handle, fighter: copy(s.fighter), funded: !!s.deposit } : null; }
  view(w, viewer = null) {
    if (typeof w === 'string') w = this._row(w);
    const now = this._now(), mine = this._sideOf(w, viewer);
    const out = { schema: WAGER_SCHEMA, id: w.id, status: w.status, stake_lamports: w.stake_lamports, stake_sol: w.stake_lamports / LAMPORTS_PER_SOL,
      pot_lamports: w.stake_lamports * 2, rake_bps: w.rake_bps, created_at: w.created_at, updated_at: w.updated_at, match_id: w.match_id, outcome: copy(w.outcome),
      expires_in: w.status === 'posted' ? Math.max(0, Math.round(w.post_deadline - now)) : w.status === 'open' ? Math.max(0, Math.round(w.open_deadline - now))
        : w.status === 'accepting' ? Math.max(0, Math.round(w.accept_deadline - now)) : null,
      sides: { A: this._publicSide(w.sides.A), B: this._publicSide(w.sides.B) },
      legs: w.legs.map(l => ({ id: l.id, to: l.to, lamports: l.lamports, sol: l.lamports / LAMPORTS_PER_SOL, reason: l.reason, status: l.status, sig: l.sig, attempts: l.attempts })) };
    if (mine) {
      const s = w.sides[mine];
      out.you = { side: mine, deposit: s.deposit ? copy(s.deposit) : null,
        deposit_required: (w.status === 'posted' && mine === 'A') || (w.status === 'accepting' && mine === 'B'),
        deposit_lamports: w.stake_lamports, memo: memoFor(w.id, mine) };
    }
    return out;
  }
  /** The wallet's live wager if any, wagers whose payout is still in flight, and recent finished ones. */
  forWallet(wallet) {
    const active = this._activeFor(wallet);
    const mine = [...this.rows.values()].filter(w => this._sideOf(w, wallet)).sort((a, b) => b.updated_at - a.updated_at);
    return { active: active ? this.view(active, wallet) : null,
      pending: mine.filter(w => w.status === 'settling').slice(0, 10).map(w => this.view(w, wallet)),
      recent: mine.filter(w => TERMINAL.has(w.status)).slice(0, 10).map(w => this.view(w, wallet)) };
  }

  // --------------------------------------------------------- persistence
  snapshot() {
    return { schema: WAGER_SCHEMA, rake_bps: this.rakeBps, rows: [...this.rows.values()].map(copy),
      used_sigs: [...this.usedSigs.entries()], daily: [...this.daily.entries()] };
  }
  static restore(saved, options) {
    const ledger = new ChikiseumWagerLedger(options);
    if (saved == null) return ledger;
    if (saved.schema !== WAGER_SCHEMA || !Array.isArray(saved.rows) || !Array.isArray(saved.used_sigs) || !Array.isArray(saved.daily)) throw new Error('Invalid wager ledger');
    if (saved.rows.length > ledger.limits.max_rows * 4) throw new Error('Wager ledger too large');
    for (const raw of saved.rows) {
      const w = copy(raw);
      if (w.schema !== WAGER_SCHEMA || !safe(w.id) || ledger.rows.has(w.id) || !(NON_TERMINAL.has(w.status) || TERMINAL.has(w.status))
        || !lamportsOk(w.stake_lamports) || !Number.isInteger(w.rake_bps) || w.rake_bps < 0 || !lamportsOk(w.rake_taken)
        || !Number.isFinite(w.created_at) || !Number.isFinite(w.updated_at) || !w.sides || !w.sides.A || !Array.isArray(w.legs) || !Array.isArray(w.history)
        || w.legs.length > 8) throw new Error('Corrupt wager row');
      for (const side of ['A', 'B']) {
        const s = w.sides[side]; if (s == null) { if (side === 'A') throw new Error('Corrupt wager row'); continue; }
        if (!safe(s.wallet) || !safe(s.trainer_id) || !safe(s.asset_id) || !s.fighter || !safe(s.fighter.species)) throw new Error('Corrupt wager party');
        if (s.deposit != null && (!isSig(s.deposit.sig) || !lamportsOk(s.deposit.lamports) || s.deposit.lamports < w.stake_lamports)) throw new Error('Corrupt wager deposit');
      }
      if (w.status === 'open' && !w.sides.A.deposit) throw new Error('Open wager without a deposit');
      if ((w.status === 'funded' || w.status === 'matched') && !(w.sides.A.deposit && w.sides.B?.deposit)) throw new Error('Funded wager without both deposits');
      for (const l of w.legs) {
        if (!safe(l.id) || !safe(l.to) || !lamportsOk(l.lamports) || l.lamports === 0 || !['win', 'refund', 'overpay'].includes(l.reason)
          || !['due', 'sending', 'sent', 'confirmed', 'stuck'].includes(l.status) || l.memo !== memoFor(w.id, l.id)
          || !Number.isInteger(l.attempts) || l.attempts < 0 || (l.sig != null && !isSig(l.sig)) || ((l.status === 'sent' || l.status === 'confirmed') && !isSig(l.sig) && !/^resolved by /.test(l.error || '')))
          throw new Error('Corrupt payout leg');
      }
      // Nothing may ever be owed or paid beyond what was deposited: every leg, in any state, plus
      // the rake, must fit inside what the two sides actually put in.
      const promised = w.legs.reduce((s, l) => s + l.lamports, 0);
      const held = (w.sides.A.deposit?.lamports ?? 0) + (w.sides.B?.deposit?.lamports ?? 0);
      if (promised + w.rake_taken > held) throw new Error('Wager promises more than it held');
      ledger.rows.set(w.id, w);
    }
    for (const [sig, id] of saved.used_sigs) { if (!isSig(sig) || !safe(id)) throw new Error('Corrupt deposit index'); ledger.usedSigs.set(sig, id); }
    for (const [wallet, d] of saved.daily) { if (!safe(wallet) || !Number.isInteger(d?.day) || !lamportsOk(d?.lamports)) throw new Error('Corrupt daily index'); ledger.daily.set(wallet, { day: d.day, lamports: d.lamports }); }
    ledger.dirty = false;
    return ledger;
  }
}
