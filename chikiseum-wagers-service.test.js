// Wagers end to end through the service: real canonical engine, exact navigation, real fights,
// synthetic auth/ownership, and a FAKE chain reader and payout rail so no key and no network are
// involved. What is proven here is the wiring — deposits gate the match, the match decides the
// money, payouts are written-before-sent and reconciled after a crash — not wallet verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ChikiseumLiveService, installChikiseumLive, LIVE_PREFIX } from './chikiseum-live-service.js';
import { ChikiseumLiveEngine, LiveRejected } from './chikiseum-live-engine.js';
import { ChikiseumLiveNavigation } from './chikiseum-live-navigation.js';
import { memoFor, LAMPORTS_PER_SOL } from './chikiseum-wagers.js';

const clone = value => structuredClone(value);
const rejected = (promise, code) => assert.rejects(promise, error => error instanceof LiveRejected && error.code === code, `expected ${code}`);
const TREASURY = 'TreasuryPubkey1111111111111111111111111111111';
const STAKE_SOL = 0.01, STAKE = 10_000_000;
let sigCounter = 0;
// 64 base58-safe characters, distinct per call. Base58 has no '0', so digits are shifted onto 1-9A.
const nextSig = () => { sigCounter++; return ('S' + String(sigCounter).padStart(3, '1').replace(/0/g, 'A')).repeat(16); };

function fakeChain() {
  const deposits = new Map(), memos = new Map();
  return {
    deposits, memos, reads: 0, throwNext: false,
    /** Program what the chain "shows" for a signature. */
    seed(sig, { signer, lamports, memo }) { deposits.set(sig, { ok: true, signers: [signer], treasury_gain_lamports: lamports, memo }); return sig; },
    async readDeposit(sig) { this.reads++; if (this.throwNext) { this.throwNext = false; throw new Error('rpc timeout'); } return deposits.get(sig) ?? { ok: false, error: 'transaction not found' }; },
    async findByMemo({ memo }) { return memos.has(memo) ? { sig: memos.get(memo) } : null; },
  };
}
function fakeRail() {
  return {
    sent: [], mode: 'ok', statuses: new Map(), statusCalls: 0, defaultStatus: 'confirmed',
    async send({ to, lamports, memo }) {
      if (this.mode === 'throw') throw new Error('rpc down before broadcast');
      const sig = nextSig(); this.sent.push({ to, lamports, memo, sig }); return { sig, blockhash: 'bh', last_valid_block_height: 100 };
    },
    async status({ sig }) { this.statusCalls++; return this.statuses.get(sig) ?? this.defaultStatus; },
  };
}

function fixture({ saved = null, chain = fakeChain(), rail = fakeRail(), enabled = true, wagers = true, clockStart = 1000 } = {}) {
  let now = clockStart, mono = 100;
  const auths = new Map(), owned = new Map();
  const lease = { valid: true, saved: clone(saved), writes: 0, closes: 0,
    async read() { return clone(this.saved); }, async write(_key, value) { this.saved = clone(value); this.writes++; },
    async ping() { if (!this.valid) throw new Error('synthetic lease lost'); }, async close() { this.valid = false; this.closes++; } };
  const authenticate = async body => {
    const current = auths.get(body.wallet);
    if (!current || current.token !== body.mktToken || current.id !== body.sessionId || current.epoch !== body.sessionEpoch) return null;
    return { wallet: body.wallet, session_id: current.id, epoch: current.epoch, handle: 'Trainer ' + body.wallet };
  };
  const options = { authenticate, ownedAssets: async wallet => clone(owned.get(wallet) ?? []), leaseFactory: async () => lease, clock: () => now,
    engineFactory: () => new ChikiseumLiveEngine({ navigation: new ChikiseumLiveNavigation(), clock: () => now, movementClock: () => mono, sessionTTL: 60, maxAdmissions: 8, maxMatches: 4 }),
    ...(wagers ? { wagers: { chain, rail, treasury: TREASURY, enabled, limits: { retry_after: 5 }, rakeBps: 0 } } : {}) };
  // Helpers read `f.service` at call time so a test may swap in a service built by installChikiseumLive.
  const f = { service: new ChikiseumLiveService(options) };
  const service = new Proxy({}, { get: (_t, k) => { const v = f.service[k]; return typeof v === 'function' ? v.bind(f.service) : v; } });
  function body(wallet, extra = {}) {
    if (!auths.has(wallet)) auths.set(wallet, { token: 'tok-' + wallet, id: 'sess-' + wallet, epoch: 1 });
    const a = auths.get(wallet); return { wallet, mktToken: a.token, sessionId: a.id, sessionEpoch: a.epoch, ...extra };
  }
  async function admit(wallet, species = 'galador', rarity = 'legendary') {
    body(wallet); owned.set(wallet, [{ asset_id: 'asset-' + wallet, species, display_name: species, rarity, eligible: true, reason: '' }]);
    return service.command('session', body(wallet, { asset_id: 'asset-' + wallet }));
  }
  /** Post and fund a challenge as `wallet`. Returns the wager view. */
  async function postFunded(wallet, stake = STAKE_SOL) {
    const posted = await service.command('wager_post', body(wallet, { stake_sol: stake }));
    const sig = chain.seed(nextSig(), { signer: wallet, lamports: Math.round(stake * LAMPORTS_PER_SOL), memo: posted.wager.you.memo });
    return (await service.command('wager_deposit', body(wallet, { wager_id: posted.wager.id, signature: sig }))).wager;
  }
  /** Accept and fund as `wallet`. Returns the deposit response (funded/matched/match_id). */
  async function acceptFunded(wallet, wagerId) {
    const accepted = await service.command('wager_accept', body(wallet, { wager_id: wagerId }));
    const sig = chain.seed(nextSig(), { signer: wallet, lamports: accepted.wager.stake_lamports, memo: accepted.wager.you.memo });
    return service.command('wager_deposit', body(wallet, { wager_id: wagerId, signature: sig }));
  }
  /** Only `attacker` casts; the other stands still, so the attacker wins. */
  async function fight(mid, attacker, defender) {
    await service.command('ready', body(attacker, { match_id: mid })); await service.command('ready', body(defender, { match_id: mid }));
    const m = service.engine.matches.get(mid), target = m.players.find(p => p.trainer_id !== service.admitted.get(attacker).id);
    const card = service.engine.cards.get(target.species + ':0');
    const rounds = Math.ceil(target.max_hp / (card.mechanics.dmg[target.card_tier] * target.damage_multiplier)) + 2;
    for (let i = 0; i < rounds; i++) {
      now += 6; mono += 6;
      await service.command('cast', body(attacker, { match_id: mid, slot: 0, request_id: `cast-${attacker}-${i}` }));
      await service.command('state', body(defender, { match_id: mid }));   // keeps the defender "present" so this is a win, not a forfeit
      now += .05; mono += .05;
      const snap = await service.command('state', body(attacker, { match_id: mid }));
      if (snap.status === 'finished') return snap;
    }
    throw new Error('fight did not finish');
  }
  /** One tick of the service timer, by hand: engine tick, wager settlement, flush, then the pump. */
  async function cycle(times = 1) {
    for (let i = 0; i < times; i++) {
      await service.serial(async () => { service.engine.tick(); service.settleWagers(); await service.flush(); });
      await service.pump();
    }
  }
  return Object.assign(f, { lease, chain, rail, options, body, admit, postFunded, acceptFunded, fight, cycle, advance: s => { now += s; mono += s; }, now: () => now });
}

test('without a wager configuration the routes do not exist and health says so', async () => {
  const f = fixture({ wagers: false }); await f.service.boot(); await f.admit('a');
  await rejected(f.service.command('wager_board', f.body('a')), 'WAGERS_DISABLED');
  await rejected(f.service.command('wager_post', f.body('a', { stake_sol: 0.01 })), 'WAGERS_DISABLED');
  assert.deepEqual(f.service.health().wagers, { enabled: false, configured: false, real_sol_enabled: false });
  assert.equal(f.lease.saved.wagers, undefined, 'nothing about wagers is persisted');
});

test('configured but switched off: no new wagers, but the board and health still answer', async () => {
  const f = fixture({ enabled: false }); await f.service.boot(); await f.admit('a');
  await rejected(f.service.command('wager_post', f.body('a', { stake_sol: 0.01 })), 'WAGERS_DISABLED');
  const board = await f.service.command('wager_board', f.body('a'));
  assert.deepEqual(board.board, []); assert.equal(board.deposit_to, TREASURY);
  const h = f.service.health().wagers;
  assert.equal(h.enabled, false); assert.equal(h.configured, true); assert.equal(h.real_sol_enabled, false); assert.equal(h.custody, 'treasury_held');
});

test('the whole path: post, fund, accept, fund, match, fight, winner paid once, everything persisted', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice'); await f.admit('bob');
  // unfunded post: not on the board, and requires an admitted fighter with no match in progress
  const posted = await f.service.command('wager_post', f.body('alice', { stake_sol: STAKE_SOL }));
  assert.equal(posted.wager.status, 'posted'); assert.equal(posted.deposit_to, TREASURY);
  assert.equal(posted.wager.you.memo, memoFor(posted.wager.id, 'A'));
  assert.deepEqual((await f.service.command('wager_board', f.body('bob'))).board, []);
  // deposit: the chain reader is consulted, the ledger cross-checks, the wager opens
  const sig = f.chain.seed(nextSig(), { signer: 'alice', lamports: STAKE, memo: posted.wager.you.memo });
  const opened = await f.service.command('wager_deposit', f.body('alice', { wager_id: posted.wager.id, signature: sig }));
  assert.equal(opened.funded, false); assert.equal(opened.wager.status, 'open');
  assert.equal(f.chain.reads, 1);
  assert.equal(f.lease.saved.wagers.rows[0].status, 'open', 'persisted before the response');
  assert.equal(f.service.liabilitySol(), STAKE_SOL);
  const board = (await f.service.command('wager_board', f.body('bob'))).board;
  assert.equal(board.length, 1); assert.equal(board[0].challenger.wallet, 'alice'); assert.equal(board[0].challenger.fighter.species, 'galador'); assert.equal(board[0].yours, false);
  // accept + fund → the match exists immediately
  const funded = await f.acceptFunded('bob', posted.wager.id);
  assert.equal(funded.funded, true); assert.equal(funded.matched, true); assert.ok(funded.match_id);
  assert.equal(funded.wager.status, 'matched'); assert.equal(funded.wager.match_id, funded.match_id);
  assert.equal(f.service.engine.matches.get(funded.match_id).status, 'ready');
  assert.equal(f.service.liabilitySol(), 2 * STAKE_SOL);
  await rejected(f.service.command('wager_withdraw', f.body('alice', { wager_id: posted.wager.id })), 'WAGER_LOCKED');
  await rejected(f.service.command('wager_post', f.body('alice', { stake_sol: STAKE_SOL })), 'ACCOUNT_BUSY');
  // the fight is an ordinary arena match — bob wins it
  const snap = await f.fight(funded.match_id, 'bob', 'alice');
  assert.equal(snap.status, 'finished'); assert.equal(snap.winner, 'B');
  // settlement: observed on the next cycle, sent through the rail, confirmed, closed
  await f.cycle(1);
  assert.deepEqual(f.rail.sent.map(s => [s.to, s.lamports, s.memo]), [['bob', 2 * STAKE, memoFor(posted.wager.id, 'W')]]);
  await f.cycle(1);
  const mine = await f.service.command('wager_mine', f.body('bob'));
  assert.equal(mine.active, null); assert.equal(mine.recent[0].status, 'settled');
  assert.deepEqual(mine.recent[0].legs.map(l => [l.to, l.lamports, l.status, l.sig]), [['bob', 2 * STAKE, 'confirmed', f.rail.sent[0].sig]]);
  assert.equal(f.service.liabilitySol(), 0);
  assert.equal(f.lease.saved.wagers.rows[0].status, 'settled');
  // and the fight still counted for battle XP: a wagered match is a real match
  assert.ok(f.lease.saved.progression.receipts[funded.match_id], 'XP receipt exists');
  // more cycles change nothing: no second payment, ever
  await f.cycle(3);
  assert.equal(f.rail.sent.length, 1);
});

test('a draw by HP refunds both stakes, in two separate transfers', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice'); await f.admit('bob');
  const w = await f.postFunded('alice'); const funded = await f.acceptFunded('bob', w.id);
  await f.service.command('ready', f.body('alice', { match_id: funded.match_id })); await f.service.command('ready', f.body('bob', { match_id: funded.match_id }));
  // nobody attacks; both keep polling so neither is absent; the 180s clock runs out with equal HP
  for (let t = 0; t < 40; t++) { f.advance(5); await f.service.command('state', f.body('alice', { match_id: funded.match_id })); await f.service.command('state', f.body('bob', { match_id: funded.match_id })); }
  assert.equal(f.service.engine.matches.get(funded.match_id).status, 'finished');
  assert.equal(f.service.engine.matches.get(funded.match_id).winner, null);
  await f.cycle(2);
  assert.deepEqual(f.rail.sent.map(s => [s.to, s.lamports]).sort(), [['alice', STAKE], ['bob', STAKE]]);
  assert.equal(f.lease.saved.wagers.rows[0].status, 'refunded');
});

test('walking away from a wagered fight is a forfeit: the opponent is paid the pot', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice'); await f.admit('bob');
  const w = await f.postFunded('alice'); const funded = await f.acceptFunded('bob', w.id);
  await f.service.command('ready', f.body('alice', { match_id: funded.match_id })); await f.service.command('ready', f.body('bob', { match_id: funded.match_id }));
  await f.service.command('cancel', f.body('alice', { match_id: funded.match_id }));
  assert.equal(f.service.engine.matches.get(funded.match_id).status, 'forfeit');
  await f.cycle(2);
  assert.deepEqual(f.rail.sent.map(s => [s.to, s.lamports]), [['bob', 2 * STAKE]]);
});

test('a restart mid-match refunds both sides — a restart never invents a winner', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice'); await f.admit('bob');
  const w = await f.postFunded('alice'); const funded = await f.acceptFunded('bob', w.id);
  await f.service.command('ready', f.body('alice', { match_id: funded.match_id })); await f.service.command('ready', f.body('bob', { match_id: funded.match_id }));
  f.advance(10); await f.service.command('cast', f.body('alice', { match_id: funded.match_id, slot: 0, request_id: 'cast-alice-0' }));
  await f.service.serial(async () => { await f.service.flush(true); });
  // a fresh process boots from the same durable state, with the same rail
  const g = fixture({ saved: f.lease.saved, chain: f.chain, rail: f.rail, clockStart: f.now() + 5 });
  assert.equal(await g.service.boot(), true);
  assert.equal(g.service.engine.matches.get(funded.match_id).status, 'server_restart');
  assert.equal(g.lease.saved.wagers.rows[0].status, 'settling', 'the refund was decided during boot and persisted');
  await g.cycle(2);
  assert.deepEqual(g.rail.sent.map(s => [s.to, s.lamports]).sort(), [['alice', STAKE], ['bob', STAKE]]);
  assert.equal(g.lease.saved.wagers.rows[0].status, 'refunded');
});

test('crash between "sending" and the broadcast record: the memo decides, and nothing is sent twice', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice'); await f.admit('bob');
  const w = await f.postFunded('alice'); const funded = await f.acceptFunded('bob', w.id);
  await f.fight(funded.match_id, 'alice', 'bob');
  // decide the outcome and mark the leg sending, then "crash" before recording the broadcast
  await f.service.serial(async () => { f.service.engine.tick(); f.service.settleWagers(); f.service.wagers.markSending(w.id, 'W'); await f.service.flush(true); });
  assert.equal(f.lease.saved.wagers.rows[0].legs[0].status, 'sending');
  // Case 1: the transfer DID go out — the memo is on-chain. Boot must find it and never resend.
  const onChainSig = nextSig(); f.chain.memos.set(memoFor(w.id, 'W'), onChainSig);
  const g = fixture({ saved: f.lease.saved, chain: f.chain, rail: f.rail, clockStart: f.now() + 1 });
  await g.service.boot();
  assert.equal(g.lease.saved.wagers.rows[0].legs[0].status, 'sent');
  assert.equal(g.lease.saved.wagers.rows[0].legs[0].sig, onChainSig);
  await g.cycle(2);
  assert.equal(g.rail.sent.length, 0, 'the rail was never asked to send');
  assert.equal(g.lease.saved.wagers.rows[0].status, 'settled');
  // Case 2: the transfer did NOT go out. Too recent to be sure → left alone; past the grace → due, then sent exactly once.
  f.chain.memos.clear();
  const snapshotBeforeCase2 = clone(f.lease.saved);
  const h = fixture({ saved: snapshotBeforeCase2, chain: f.chain, rail: fakeRail(), clockStart: f.now() + 10 });
  await h.service.boot();
  assert.equal(h.lease.saved.wagers.rows[0].legs[0].status, 'sending', 'within the grace window it is not touched');
  await h.cycle(2);
  assert.equal(h.rail.sent.length, 0);
  const k = fixture({ saved: snapshotBeforeCase2, chain: f.chain, rail: fakeRail(), clockStart: f.now() + 200 });
  await k.service.boot();
  assert.equal(k.lease.saved.wagers.rows[0].legs[0].status, 'due');
  k.advance(10); await k.cycle(2);
  assert.deepEqual(k.rail.sent.map(s => [s.to, s.lamports]), [['alice', 2 * STAKE]]);
  assert.equal(k.lease.saved.wagers.rows[0].status, 'settled');
});

test('a rail that fails before broadcast retries; the leg is persisted as sending BEFORE each attempt', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice'); await f.admit('bob');
  const w = await f.postFunded('alice'); const funded = await f.acceptFunded('bob', w.id);
  await f.fight(funded.match_id, 'alice', 'bob');
  f.rail.mode = 'throw';
  const writesBefore = f.lease.writes;
  await f.cycle(1);
  const leg = f.lease.saved.wagers.rows[0].legs[0];
  assert.equal(leg.status, 'due'); assert.equal(leg.attempts, 1); assert.match(leg.error, /before broadcast/);
  assert.ok(f.lease.writes >= writesBefore + 2, 'one write marking sending, one recording the failure');
  f.rail.mode = 'ok'; f.advance(6); await f.cycle(2);
  assert.equal(f.rail.sent.length, 1);
  assert.equal(f.lease.saved.wagers.rows[0].status, 'settled');
});

test('an AMBIGUOUS send (timeout after broadcast) is never retried blindly: the memo search decides', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice'); await f.admit('bob');
  const w = await f.postFunded('alice'); const funded = await f.acceptFunded('bob', w.id);
  await f.fight(funded.match_id, 'alice', 'bob');
  // the rail's RPC call times out — but the transaction WAS taken and lands on-chain
  const landed = nextSig();
  f.rail.send = async ({ memo }) => { f.chain.memos.set(memo, landed); throw Object.assign(new Error('socket hang up'), { ambiguous: true }); };
  await f.cycle(1);
  let leg = f.lease.saved.wagers.rows[0].legs[0];
  // within the same pump the memo search found it and the status check confirmed it: the on-chain
  // signature is recorded, the attempt counted once, and the rail was never asked a second time
  assert.equal(leg.status, 'confirmed'); assert.equal(leg.sig, landed); assert.equal(leg.attempts, 1);
  assert.equal(f.rail.sent.length, 0);
  assert.equal(f.lease.saved.wagers.rows[0].status, 'settled');
  // and the other shape: ambiguous, and it truly never landed — held in `sending` through the grace window, then resent once
  const g = fixture(); await g.service.boot(); await g.admit('alice'); await g.admit('bob');
  const w2 = await g.postFunded('alice'); const funded2 = await g.acceptFunded('bob', w2.id);
  await g.fight(funded2.match_id, 'alice', 'bob');
  const realSend = g.rail.send.bind(g.rail);
  g.rail.send = async () => { throw Object.assign(new Error('socket hang up'), { ambiguous: true }); };
  await g.cycle(1);
  leg = g.lease.saved.wagers.rows[0].legs[0];
  assert.equal(leg.status, 'sending', 'unknown outcome: held, not failed');
  g.advance(60); await g.cycle(1);
  assert.equal(g.lease.saved.wagers.rows[0].legs[0].status, 'sending', 'still inside the grace window');
  g.rail.send = realSend;
  g.advance(100); await g.cycle(1);
  assert.equal(g.lease.saved.wagers.rows[0].legs[0].status, 'due', 'past the window and not on-chain: released for one more attempt, after its backoff');
  assert.equal(g.rail.sent.length, 0);
  g.advance(6); await g.cycle(2);
  assert.equal(g.rail.sent.length, 1, 'sent exactly once');
  assert.equal(g.lease.saved.wagers.rows[0].status, 'settled');
});

test('an expired transaction is rebuilt and resent; a confirmed one is final', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice'); await f.admit('bob');
  const w = await f.postFunded('alice'); const funded = await f.acceptFunded('bob', w.id);
  await f.fight(funded.match_id, 'alice', 'bob');
  f.rail.defaultStatus = 'expired';   // the first transaction's blockhash lapses before it lands
  await f.cycle(1);
  assert.equal(f.rail.sent.length, 1);
  assert.equal(f.lease.saved.wagers.rows[0].legs[0].status, 'due');
  assert.equal(f.lease.saved.wagers.rows[0].legs[0].sig, null, 'the dead signature is forgotten, not confirmed later by accident');
  f.rail.defaultStatus = 'confirmed';
  f.advance(6); await f.cycle(2);
  assert.equal(f.rail.sent.length, 2);
  assert.equal(f.lease.saved.wagers.rows[0].legs[0].sig, f.rail.sent[1].sig);
  assert.equal(f.lease.saved.wagers.rows[0].status, 'settled');
});

test('if the challenger leaves before the acceptor funds, pairing fails and both are refunded at once', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice'); await f.admit('bob');
  const w = await f.postFunded('alice');
  const accepted = await f.service.command('wager_accept', f.body('bob', { wager_id: w.id }));
  f.advance(61);   // alice's admission expires (sessionTTL 60); bob's is refreshed by his deposit call
  const sig = f.chain.seed(nextSig(), { signer: 'bob', lamports: STAKE, memo: accepted.wager.you.memo });
  const out = await f.service.command('wager_deposit', f.body('bob', { wager_id: w.id, signature: sig }));
  assert.equal(out.funded, true); assert.equal(out.matched, false); assert.equal(out.refunding, true);
  assert.equal(out.wager.status, 'settling');
  await f.cycle(2);
  assert.deepEqual(f.rail.sent.map(s => [s.to, s.lamports]).sort(), [['alice', STAKE], ['bob', STAKE]]);
});

test('accepting is refused when the challenger is away or the fighters are incompatible; the board is honest', async () => {
  const f = fixture(); await f.service.boot();
  await f.admit('alice', 'pepe', 'meme');        // meme kit: power 1.15 × 1.08
  await f.admit('bob', 'firix', 'normal');       // normal kit: power 1 × 1 — ratio 1.24, outside the 1.15 matchmaking band
  await f.admit('carol', 'galador', 'legendary'); // legendary: ratio 1.11 against meme — inside the band
  const w = await f.postFunded('alice');
  await rejected(f.service.command('wager_accept', f.body('bob', { wager_id: w.id })), 'INCOMPATIBLE');
  assert.equal(f.lease.saved.wagers.rows[0].status, 'open', 'a refused accept leaves it on the board');
  // away: every admission expires; carol re-selects her fighter, alice does not — the wager stays funded
  f.advance(61); await f.admit('carol', 'galador', 'legendary');
  await rejected(f.service.command('wager_accept', f.body('carol', { wager_id: w.id })), 'CHALLENGER_AWAY');
  assert.equal(f.lease.saved.wagers.rows[0].status, 'open');
  // she comes back, re-admits, and the wager — still hers, still funded — can be accepted
  await f.admit('alice', 'pepe', 'meme');
  const ok = await f.service.command('wager_accept', f.body('carol', { wager_id: w.id }));
  assert.equal(ok.wager.status, 'accepting');
});

test('deposit verification failures are reported precisely and change nothing', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice');
  const posted = await f.service.command('wager_post', f.body('alice', { stake_sol: STAKE_SOL }));
  const id = posted.wager.id;
  const wrongMemo = f.chain.seed(nextSig(), { signer: 'alice', lamports: STAKE, memo: memoFor(id, 'B') });
  await rejected(f.service.command('wager_deposit', f.body('alice', { wager_id: id, signature: wrongMemo })), 'DEPOSIT_WRONG_MEMO');
  const wrongSigner = f.chain.seed(nextSig(), { signer: 'mallory', lamports: STAKE, memo: memoFor(id, 'A') });
  await rejected(f.service.command('wager_deposit', f.body('alice', { wager_id: id, signature: wrongSigner })), 'DEPOSIT_WRONG_SIGNER');
  const short = f.chain.seed(nextSig(), { signer: 'alice', lamports: STAKE - 1, memo: memoFor(id, 'A') });
  await rejected(f.service.command('wager_deposit', f.body('alice', { wager_id: id, signature: short })), 'DEPOSIT_SHORT');
  await rejected(f.service.command('wager_deposit', f.body('alice', { wager_id: id, signature: nextSig() })), 'DEPOSIT_UNVERIFIED');
  f.chain.throwNext = true;
  await rejected(f.service.command('wager_deposit', f.body('alice', { wager_id: id, signature: nextSig() })), 'DEPOSIT_UNVERIFIED');
  await rejected(f.service.command('wager_deposit', f.body('alice', { wager_id: id, signature: 'x'.repeat(200) })), 'INVALID_COMMAND');
  assert.equal(f.lease.saved.wagers.rows[0].status, 'posted');
  assert.equal(f.service.liabilitySol(), 0);
  const good = f.chain.seed(nextSig(), { signer: 'alice', lamports: STAKE, memo: memoFor(id, 'A') });
  assert.equal((await f.service.command('wager_deposit', f.body('alice', { wager_id: id, signature: good }))).wager.status, 'open');
});

test('stake_sol is validated at the boundary and converted to exact lamports', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice');
  for (const bad of ['0.01', -1, 0, NaN, Infinity, null]) await rejected(f.service.command('wager_post', f.body('alice', { stake_sol: bad })), 'INVALID_COMMAND');
  await rejected(f.service.command('wager_post', f.body('alice', { stake_sol: 0.0001 })), 'STAKE_TOO_SMALL');
  await rejected(f.service.command('wager_post', f.body('alice', { stake_sol: 1 })), 'STAKE_TOO_LARGE');
  const w = await f.service.command('wager_post', f.body('alice', { stake_sol: 0.012345 }));
  assert.equal(w.wager.stake_lamports, 12_345_000);
});

test('switching wagers off strands nothing: a wager already funded still settles and pays', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice'); await f.admit('bob');
  const w = await f.postFunded('alice'); const funded = await f.acceptFunded('bob', w.id);
  await f.service.serial(async () => { await f.service.flush(true); });
  const g = fixture({ saved: f.lease.saved, chain: f.chain, rail: f.rail, enabled: false, clockStart: f.now() + 1 });
  await g.service.boot(); await g.admit('alice'); await g.admit('bob');
  await rejected(g.service.command('wager_post', g.body('alice', { stake_sol: STAKE_SOL })), 'WAGERS_DISABLED');
  // the old match was cancelled by the restart, so this one is a refund — money moves even with the switch off
  await g.cycle(2);
  assert.deepEqual(g.rail.sent.map(s => [s.to, s.lamports]).sort(), [['alice', STAKE], ['bob', STAKE]]);
  assert.equal(g.service.health().wagers.enabled, false);
  assert.equal(g.service.health().wagers.real_sol_enabled, false, 'off and nothing held: honestly off');
});

test('a saved ledger with no wager configuration fails the boot closed rather than forgetting held money', async () => {
  const f = fixture(); await f.service.boot(); await f.admit('alice');
  await f.postFunded('alice');
  const g = fixture({ saved: f.lease.saved, wagers: false });
  assert.equal(await g.service.boot(), false);
  assert.equal(g.service.reason, 'durable_service_unavailable');
});

test('HTTP: the operator route needs the admin signature, lists stuck legs, and can resolve one', async () => {
  const chain = fakeChain(), rail = fakeRail(); rail.mode = 'throw';
  const f = fixture({ chain, rail }); f.options.wagers.limits = { retry_after: 0, max_attempts: 1 }; f.options.wagers.adminOk = async (body, action) => body.adminWallet === 'Admin' && body.authSig === 'valid' && action === 'chikiseum_wager_admin';
  const app = express(); app.use(express.json({ limit: '8kb' }));
  const service = installChikiseumLive(app, f.options); await service.boot();
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + LIVE_PREFIX;
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  try {
    // drive a wager to a stuck payout through the real HTTP surface
    f.service = service; await f.admit('alice'); await f.admit('bob');
    const w = await f.postFunded('alice'); const funded = await f.acceptFunded('bob', w.id);
    await f.fight(funded.match_id, 'alice', 'bob');
    await service.serial(async () => { service.engine.tick(); service.settleWagers(); await service.flush(true); });
    await service.pump();
    assert.equal(service.wagers.stuckLegs().length, 1);
    assert.equal((await fetch(base + '/health').then(r => r.json())).wagers.stuck_legs, 1);
    assert.equal((await post('/wager_admin', { action: 'stuck' })).status, 401);
    assert.equal((await post('/wager_admin', { action: 'stuck', adminWallet: 'Admin', authSig: 'forged' })).status, 401);
    const stuck = await post('/wager_admin', { action: 'stuck', adminWallet: 'Admin', authSig: 'valid' });
    assert.equal(stuck.status, 200); assert.equal(stuck.data.stuck[0].to, 'alice'); assert.equal(stuck.data.stuck[0].lamports, 2 * STAKE);
    const resolved = await post('/wager_admin', { action: 'resolve', adminWallet: 'Admin', authSig: 'valid', wager_id: w.id, leg_id: 'W', sig: nextSig() });
    assert.equal(resolved.status, 200); assert.equal(resolved.data.wager.status, 'settled');
    assert.equal(service.liabilitySol(), 0);
    assert.equal((await post('/wager_admin', { action: 'resolve', adminWallet: 'Admin', authSig: 'valid', wager_id: w.id, leg_id: 'W', sig: nextSig() })).status, 409);
  } finally { await service.stop(); server.close(); }
});
