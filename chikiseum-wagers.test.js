// The ledger decides who is owed what. These tests are adversarial on purpose: every path that
// could pay twice, pay the wrong person, credit a deposit that is not what it claims, or strand a
// stake, is exercised here with a fake clock and no chain at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChikiseumWagerLedger, WagerRejected, memoFor, LAMPORTS_PER_SOL } from './chikiseum-wagers.js';

const SOL = LAMPORTS_PER_SOL;
const STAKE = 10_000_000;   // 0.01 SOL
const SIG = n => String(n).padStart(2, '0').replace(/0/g, 'A').repeat(32).slice(0, 64);   // 64 base58 chars, distinct per n
const rejects = (fn, code) => assert.throws(fn, e => e instanceof WagerRejected && e.code === code, `expected ${code}`);
function fighter(level = 1) { return { species: 'galador', display_name: 'Galador', rarity: 'legendary', level, card_tier: 0 }; }
function party(w, level = 1) { return { wallet: w, trainer_id: 'trainer-' + w, asset_id: 'asset-' + w, handle: 'T ' + w, fighter: fighter(level) }; }
function fixture({ rakeBps = 0, limits = {} } = {}) {
  let now = 1_000_000, n = 0;
  const ledger = new ChikiseumWagerLedger({ clock: () => now, rakeBps, limits, idFactory: () => 'wager' + (++n) });
  const deposit = (wallet, side, id, lamports = STAKE, extra = {}) => ({ ok: true, signers: [wallet], treasury_gain_lamports: lamports, memo: memoFor(id, side), ...extra });
  const open = (a = 'alice') => { const w = ledger.post({ party: party(a), stake_lamports: STAKE }); ledger.applyDeposit({ id: w.id, wallet: a, sig: SIG(++n * 7), verified: deposit(a, 'A', w.id) }); return w.id; };
  const funded = (a = 'alice', b = 'bob') => { const id = open(a); ledger.accept({ id, party: party(b), compatible: true }); const r = ledger.applyDeposit({ id, wallet: b, sig: SIG(++n * 7), verified: deposit(b, 'B', id) }); assert.equal(r.funded, true); return id; };
  const matched = (a, b) => { const id = funded(a, b); ledger.bind({ id, match_id: 'match-' + id }); return id; };
  return { ledger, deposit, open, funded, matched, advance: s => { now += s; }, now: () => now };
}

// ---------------------------------------------------------------- posting

test('a posted wager is not on the board until the challenger has funded it', () => {
  const f = fixture();
  const w = f.ledger.post({ party: party('alice'), stake_lamports: STAKE });
  assert.equal(w.status, 'posted');
  assert.equal(w.you.deposit_required, true);
  assert.equal(w.you.memo, memoFor(w.id, 'A'));
  assert.deepEqual(f.ledger.board(), [], 'unfunded bait never reaches the board');
  f.ledger.applyDeposit({ id: w.id, wallet: 'alice', sig: SIG(1), verified: f.deposit('alice', 'A', w.id) });
  assert.equal(f.ledger.board().length, 1);
  assert.equal(f.ledger.board()[0].challenger.funded, true);
});

test('stake bounds, micro-SOL granularity and one wager per wallet', () => {
  const f = fixture();
  rejects(() => f.ledger.post({ party: party('a'), stake_lamports: 999_000 }), 'STAKE_TOO_SMALL');
  rejects(() => f.ledger.post({ party: party('a'), stake_lamports: 999_999 }), 'INVALID_COMMAND');      // not whole micro-SOL
  rejects(() => f.ledger.post({ party: party('a'), stake_lamports: 50_000_001 }), 'INVALID_COMMAND');   // not whole micro-SOL
  rejects(() => f.ledger.post({ party: party('a'), stake_lamports: 60_000_000 }), 'STAKE_TOO_LARGE');
  rejects(() => f.ledger.post({ party: party('a'), stake_lamports: 1.5 }), 'INVALID_COMMAND');
  rejects(() => f.ledger.post({ party: party('a'), stake_lamports: -STAKE }), 'INVALID_COMMAND');
  f.ledger.post({ party: party('a'), stake_lamports: STAKE });
  rejects(() => f.ledger.post({ party: party('a'), stake_lamports: STAKE }), 'WAGER_BUSY');
});

test('the per-wallet daily cap counts stakes posted AND accepted, and resets the next UTC day', () => {
  const f = fixture({ limits: { wallet_daily_lamports: 25_000_000 } });
  const id1 = f.open('alice');                                   // alice 0.01
  f.ledger.withdraw({ id: id1, wallet: 'alice' });               // refund — still counts toward the day: it was risked
  const id2 = f.open('alice');                                   // alice 0.02
  f.ledger.withdraw({ id: id2, wallet: 'alice' });
  rejects(() => f.ledger.post({ party: party('alice'), stake_lamports: STAKE }), 'DAILY_LIMIT');   // 0.03 > 0.025
  const id3 = f.open('carol');
  rejects(() => f.ledger.accept({ id: id3, party: party('alice'), compatible: true }), 'DAILY_LIMIT');
  f.advance(86_400);
  assert.equal(f.ledger.post({ party: party('alice'), stake_lamports: STAKE }).status, 'posted');
});

test('an unfunded post expires with nothing owed; a withdrawn one is void', () => {
  const f = fixture({ limits: { post_ttl: 60 } });
  const a = f.ledger.post({ party: party('alice'), stake_lamports: STAKE });
  const b = f.ledger.post({ party: party('bob'), stake_lamports: STAKE });
  f.ledger.withdraw({ id: b.id, wallet: 'bob' });
  assert.equal(f.ledger.view(b.id).status, 'void');
  f.advance(61); f.ledger.tick();
  assert.equal(f.ledger.view(a.id).status, 'expired');
  assert.equal(f.ledger.liabilityLamports(), 0);
  assert.equal(f.ledger.view(a.id).legs.length, 0, 'no refund leg for money that never arrived');
});

// ---------------------------------------------------------------- deposits

test('a deposit is credited only if the signer, memo and amount all match this wager and side', () => {
  const f = fixture();
  const w = f.ledger.post({ party: party('alice'), stake_lamports: STAKE });
  const good = f.deposit('alice', 'A', w.id);
  rejects(() => f.ledger.applyDeposit({ id: w.id, wallet: 'alice', sig: SIG(1), verified: { ...good, signers: ['mallory'] } }), 'DEPOSIT_WRONG_SIGNER');
  rejects(() => f.ledger.applyDeposit({ id: w.id, wallet: 'alice', sig: SIG(1), verified: { ...good, memo: memoFor(w.id, 'B') } }), 'DEPOSIT_WRONG_MEMO');
  rejects(() => f.ledger.applyDeposit({ id: w.id, wallet: 'alice', sig: SIG(1), verified: { ...good, memo: memoFor('wager999', 'A') } }), 'DEPOSIT_WRONG_MEMO');
  rejects(() => f.ledger.applyDeposit({ id: w.id, wallet: 'alice', sig: SIG(1), verified: { ...good, treasury_gain_lamports: STAKE - 1 } }), 'DEPOSIT_SHORT');
  rejects(() => f.ledger.applyDeposit({ id: w.id, wallet: 'alice', sig: SIG(1), verified: { ok: false, error: 'not found' } }), 'DEPOSIT_UNVERIFIED');
  rejects(() => f.ledger.applyDeposit({ id: w.id, wallet: 'alice', sig: SIG(1), verified: null }), 'DEPOSIT_UNVERIFIED');
  rejects(() => f.ledger.applyDeposit({ id: w.id, wallet: 'alice', sig: 'not-a-signature', verified: good }), 'INVALID_COMMAND');
  rejects(() => f.ledger.applyDeposit({ id: w.id, wallet: 'bob', sig: SIG(1), verified: good }), 'PRIVATE_VIEW_DENIED');
  assert.equal(f.ledger.view(w.id).status, 'posted', 'every refusal left the wager untouched');
  assert.equal(f.ledger.liabilityLamports(), 0);
  f.ledger.applyDeposit({ id: w.id, wallet: 'alice', sig: SIG(1), verified: good });
  assert.equal(f.ledger.view(w.id).status, 'open');
  assert.equal(f.ledger.liabilityLamports(), STAKE);
});

test('a deposit signature can be used exactly once, across all wagers', () => {
  const f = fixture();
  const a = f.ledger.post({ party: party('alice'), stake_lamports: STAKE });
  f.ledger.applyDeposit({ id: a.id, wallet: 'alice', sig: SIG(1), verified: f.deposit('alice', 'A', a.id) });
  rejects(() => f.ledger.applyDeposit({ id: a.id, wallet: 'alice', sig: SIG(1), verified: f.deposit('alice', 'A', a.id) }), 'DEPOSIT_REPLAYED');
  f.ledger.withdraw({ id: a.id, wallet: 'alice' });
  const b = f.ledger.post({ party: party('bob'), stake_lamports: STAKE });
  // even a forged "verified" record that names the new wager cannot reuse an old signature
  rejects(() => f.ledger.applyDeposit({ id: b.id, wallet: 'bob', sig: SIG(1), verified: f.deposit('bob', 'A', b.id) }), 'DEPOSIT_REPLAYED');
});

test('a deposit in the wrong phase is refused: nobody can pay into an open, matched or settled wager', () => {
  const f = fixture();
  const id = f.open('alice');
  rejects(() => f.ledger.applyDeposit({ id, wallet: 'alice', sig: SIG(2), verified: f.deposit('alice', 'A', id) }), 'DEPOSIT_NOT_EXPECTED');
  f.ledger.accept({ id, party: party('bob'), compatible: true });
  rejects(() => f.ledger.applyDeposit({ id, wallet: 'alice', sig: SIG(3), verified: f.deposit('alice', 'A', id) }), 'DEPOSIT_NOT_EXPECTED');
  f.ledger.applyDeposit({ id, wallet: 'bob', sig: SIG(4), verified: f.deposit('bob', 'B', id) });
  rejects(() => f.ledger.applyDeposit({ id, wallet: 'bob', sig: SIG(5), verified: f.deposit('bob', 'B', id) }), 'DEPOSIT_NOT_EXPECTED');
});

test('an overpayment is credited as the stake and the excess is refunded automatically', () => {
  const f = fixture();
  const w = f.ledger.post({ party: party('alice'), stake_lamports: STAKE });
  f.ledger.applyDeposit({ id: w.id, wallet: 'alice', sig: SIG(1), verified: f.deposit('alice', 'A', w.id, STAKE + 250_000) });
  const v = f.ledger.view(w.id);
  assert.equal(v.status, 'open');
  assert.deepEqual(v.legs.map(l => [l.id, l.reason, l.lamports, l.to]), [['OA', 'overpay', 250_000, 'alice']]);
  assert.equal(f.ledger.liabilityLamports(), STAKE + 250_000, 'the excess is a liability until it is confirmed back');
});

// ---------------------------------------------------------------- accepting

test('accepting requires an open wager, a different wallet, and a compatible fighter', () => {
  const f = fixture();
  const id = f.open('alice');
  rejects(() => f.ledger.accept({ id, party: party('alice'), compatible: true }), 'INVALID_COMMAND');
  rejects(() => f.ledger.accept({ id, party: party('bob'), compatible: false }), 'INCOMPATIBLE');
  rejects(() => f.ledger.accept({ id: 'nope', party: party('bob'), compatible: true }), 'NOT_FOUND');
  f.ledger.accept({ id, party: party('bob'), compatible: true });
  rejects(() => f.ledger.accept({ id, party: party('carol'), compatible: true }), 'WAGER_NOT_OPEN');
  assert.deepEqual(f.ledger.board(), [], 'a locked wager leaves the board');
});

test('an acceptor who does not fund in time is dropped and the wager returns to the board', () => {
  const f = fixture({ limits: { accept_ttl: 30 } });
  const id = f.open('alice');
  f.ledger.accept({ id, party: party('bob'), compatible: true });
  f.advance(31); f.ledger.tick();
  const v = f.ledger.view(id);
  assert.equal(v.status, 'open'); assert.equal(v.sides.B, null);
  assert.equal(f.ledger.board().length, 1);
  assert.equal(f.ledger._activeFor('bob'), null, 'bob is free to wager elsewhere');
});

test('an acceptor can back out before funding; the challenger can cancel and is refunded', () => {
  const f = fixture();
  const id = f.open('alice');
  f.ledger.accept({ id, party: party('bob'), compatible: true });
  f.ledger.withdraw({ id, wallet: 'bob' });
  assert.equal(f.ledger.view(id).status, 'open');
  f.ledger.accept({ id, party: party('carol'), compatible: true });
  f.ledger.withdraw({ id, wallet: 'alice' });
  const v = f.ledger.view(id);
  assert.equal(v.status, 'settling');
  assert.deepEqual(v.legs.map(l => [l.id, l.to, l.lamports]), [['RA', 'alice', STAKE]], 'carol never paid, so only alice is refunded');
});

test('a funded challenge nobody accepts is refunded when it expires', () => {
  const f = fixture({ limits: { open_ttl: 100 } });
  const id = f.open('alice');
  f.advance(101); f.ledger.tick();
  const v = f.ledger.view(id);
  assert.equal(v.status, 'settling');
  assert.deepEqual(v.legs.map(l => [l.id, l.to, l.lamports, l.reason]), [['RA', 'alice', STAKE, 'refund']]);
});

// ---------------------------------------------------------------- outcomes

test('a wager whose refund is still in flight does not lock the wallet out of a new one; a live one does', () => {
  const f = fixture();
  const id = f.open('alice');
  f.ledger.withdraw({ id, wallet: 'alice' });                     // settling: refund leg due
  assert.equal(f.ledger.forWallet('alice').active, null);
  assert.equal(f.ledger.forWallet('alice').pending[0].id, id);
  const next = f.ledger.post({ party: party('alice'), stake_lamports: STAKE });
  assert.equal(next.status, 'posted');
  rejects(() => f.ledger.post({ party: party('alice'), stake_lamports: STAKE }), 'WAGER_BUSY');
});

test('a decided match pays the winner the whole pot; the loser gets nothing; liability goes to zero once confirmed', () => {
  const f = fixture();
  const id = f.matched('alice', 'bob');
  assert.equal(f.ledger.liabilityLamports(), 2 * STAKE);
  f.ledger.observe(() => ({ status: 'finished', winner: 'B' }));
  const v = f.ledger.view(id);
  assert.equal(v.status, 'settling');
  assert.deepEqual(v.legs.map(l => [l.id, l.to, l.lamports, l.reason]), [['W', 'bob', 2 * STAKE, 'win']]);
  assert.equal(f.ledger.liabilityLamports(), 2 * STAKE, 'still owed until the transfer is confirmed');
  f.ledger.markSending(id, 'W'); f.ledger.recordBroadcast(id, 'W', { sig: SIG(9) }); f.ledger.recordStatus(id, 'W', 'confirmed');
  assert.equal(f.ledger.view(id).status, 'settled');
  assert.equal(f.ledger.liabilityLamports(), 0);
});

test('rake comes off the pot exactly once and is never owed to anyone', () => {
  const f = fixture({ rakeBps: 250 });   // 2.5%
  const id = f.matched('alice', 'bob');
  f.ledger.observe(() => ({ status: 'forfeit', winner: 'A' }));
  const v = f.ledger.view(id);
  const rake = Math.floor(2 * STAKE * 250 / 10_000);
  assert.deepEqual(v.legs.map(l => [l.to, l.lamports]), [['alice', 2 * STAKE - rake]]);
  assert.equal(f.ledger.liabilityLamports(), 2 * STAKE - rake);
  f.ledger.markSending(id, 'W'); f.ledger.recordBroadcast(id, 'W', { sig: SIG(9) }); f.ledger.recordStatus(id, 'W', 'confirmed');
  assert.equal(f.ledger.liabilityLamports(), 0);
});

test('every non-decisive ending refunds both stakes in full', () => {
  for (const m of [{ status: 'finished', winner: null }, { status: 'draw', winner: null }, { status: 'cancelled', winner: null },
    { status: 'ready_timeout', winner: null }, { status: 'admission_revoked', winner: null }, { status: 'server_restart', winner: null }, null]) {
    const f = fixture();
    const id = f.matched('alice', 'bob');
    f.ledger.observe(() => m);
    const v = f.ledger.view(id);
    assert.equal(v.status, 'settling', JSON.stringify(m));
    assert.deepEqual(v.legs.map(l => [l.id, l.to, l.lamports]).sort(), [['RA', 'alice', STAKE], ['RB', 'bob', STAKE]], JSON.stringify(m));
    assert.equal(v.outcome.winner, null);
  }
});

test('a forfeit or finished match with an impossible winner value is a refund, never a payout on a guess', () => {
  const f = fixture();
  const id = f.matched('alice', 'bob');
  f.ledger.observe(() => ({ status: 'finished', winner: 'C' }));
  assert.deepEqual(f.ledger.view(id).legs.map(l => l.reason), ['refund', 'refund']);
});

test('observing the same outcome repeatedly, or a changed outcome later, never adds a second payment', () => {
  const f = fixture();
  const id = f.matched('alice', 'bob');
  f.ledger.observe(() => ({ status: 'finished', winner: 'A' }));
  f.ledger.observe(() => ({ status: 'finished', winner: 'A' }));
  f.ledger.observe(() => ({ status: 'finished', winner: 'B' }));   // an engine that changed its mind is ignored: the wager is no longer `matched`
  f.ledger.observe(() => null);
  const v = f.ledger.view(id);
  assert.equal(v.legs.length, 1);
  assert.equal(v.legs[0].to, 'alice');
  assert.equal(v.outcome.winner, 'A');
});

test('an active match is left alone; only a terminal status settles', () => {
  const f = fixture();
  const id = f.matched('alice', 'bob');
  f.ledger.observe(() => ({ status: 'ready', winner: null }));
  f.ledger.observe(() => ({ status: 'active', winner: null }));
  assert.equal(f.ledger.view(id).status, 'matched');
  rejects(() => f.ledger.withdraw({ id, wallet: 'alice' }), 'WAGER_LOCKED');
});

test('pairing failure after both deposits refunds both, and the wager cannot be bound afterwards', () => {
  const f = fixture();
  const id = f.funded('alice', 'bob');
  f.ledger.abort({ id, why: 'pairing_failed' });
  assert.deepEqual(f.ledger.view(id).legs.map(l => l.to).sort(), ['alice', 'bob']);
  rejects(() => f.ledger.bind({ id, match_id: 'm' }), 'WAGER_NOT_FUNDED');
});

// ---------------------------------------------------------------- payout rail

test('the rail state machine: due → sending → sent → confirmed, with write-before-send enforced by state', () => {
  const f = fixture();
  const id = f.matched('alice', 'bob');
  f.ledger.observe(() => ({ status: 'finished', winner: 'A' }));
  rejects(() => f.ledger.recordBroadcast(id, 'W', { sig: SIG(1) }), 'LEG_STATE');   // cannot record a send that was never marked
  assert.equal(f.ledger.dueLegs().length, 1);
  f.ledger.markSending(id, 'W');
  assert.equal(f.ledger.dueLegs().length, 0);
  assert.equal(f.ledger.unresolvedLegs().length, 1);
  rejects(() => f.ledger.markSending(id, 'W'), 'LEG_STATE');
  f.ledger.recordBroadcast(id, 'W', { sig: SIG(1), blockhash: 'bh', last_valid_block_height: 100 });
  assert.equal(f.ledger.unresolvedLegs().length, 0);
  assert.deepEqual(f.ledger.sentLegs().map(l => l.sig), [SIG(1)]);
  f.ledger.recordStatus(id, 'W', 'pending');
  assert.equal(f.ledger.view(id).status, 'settling');
  f.ledger.recordStatus(id, 'W', 'confirmed');
  assert.equal(f.ledger.view(id).status, 'settled');
  rejects(() => f.ledger.recordStatus(id, 'W', 'confirmed'), 'LEG_STATE');
});

test('a send that fails before broadcast retries with backoff, and becomes stuck after max attempts', () => {
  const f = fixture({ limits: { max_attempts: 3, retry_after: 10 } });
  const id = f.matched('alice', 'bob');
  f.ledger.observe(() => ({ status: 'finished', winner: 'A' }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(f.ledger.dueLegs().length, 1, `attempt ${attempt} is due`);
    f.ledger.markSending(id, 'W'); f.ledger.recordSendError(id, 'W', new Error('rpc down'));
    if (attempt < 3) {
      assert.equal(f.ledger.dueLegs().length, 0, 'backoff holds it');
      f.advance(10 * attempt + 1);
    }
  }
  assert.equal(f.ledger.dueLegs().length, 0);
  assert.equal(f.ledger.stuckLegs().length, 1);
  assert.equal(f.ledger.view(id).status, 'settling', 'a stuck payout is still owed');
  assert.equal(f.ledger.liabilityLamports(), 2 * STAKE);
});

test('an expired or on-chain-failed transaction is safe to rebuild; a confirmed one is final', () => {
  const f = fixture();
  const id = f.matched('alice', 'bob');
  f.ledger.observe(() => ({ status: 'finished', winner: 'A' }));
  f.ledger.markSending(id, 'W'); f.ledger.recordBroadcast(id, 'W', { sig: SIG(1) }); f.ledger.recordStatus(id, 'W', 'expired');
  let leg = f.ledger.view(id).legs[0];
  assert.equal(leg.status, 'due'); assert.equal(leg.sig, null);
  f.advance(100);
  f.ledger.markSending(id, 'W'); f.ledger.recordBroadcast(id, 'W', { sig: SIG(2) }); f.ledger.recordStatus(id, 'W', 'failed');
  f.advance(100);
  f.ledger.markSending(id, 'W'); f.ledger.recordBroadcast(id, 'W', { sig: SIG(3) }); f.ledger.recordStatus(id, 'W', 'confirmed');
  leg = f.ledger.view(id).legs[0];
  assert.equal(leg.status, 'confirmed'); assert.equal(leg.sig, SIG(3));
  assert.equal(f.ledger.view(id).status, 'settled');
});

test('boot reconciliation: a sending leg found by memo becomes sent; one not found becomes due again', () => {
  const f = fixture();
  const a = f.matched('alice', 'bob'); f.ledger.observe(() => ({ status: 'finished', winner: 'A' })); f.ledger.markSending(a, 'W');
  const b = f.matched('carol', 'dave'); f.ledger.observe(() => ({ status: 'finished', winner: 'B' })); f.ledger.markSending(b, 'W');
  assert.equal(f.ledger.unresolvedLegs().length, 2);
  assert.equal(f.ledger.reconcile(a, 'W', { sig: SIG(5) }), 'sent');
  assert.equal(f.ledger.reconcile(b, 'W', null), 'due');
  assert.deepEqual(f.ledger.sentLegs().map(l => [l.wager_id, l.sig]), [[a, SIG(5)]]);
  assert.deepEqual(f.ledger.dueLegs(), [], 'the lost attempt still counts and earns a backoff');
  f.advance(21);
  assert.deepEqual(f.ledger.dueLegs().map(l => l.wager_id), [b]);
  assert.equal(f.ledger.view(b).legs[0].attempts, 1);
});

test('an operator can resolve a stuck leg by hand or release it for retry; both are recorded', () => {
  const f = fixture({ limits: { max_attempts: 1 } });
  const id = f.matched('alice', 'bob');
  f.ledger.observe(() => ({ status: 'finished', winner: 'A' }));
  f.ledger.markSending(id, 'W'); f.ledger.recordSendError(id, 'W', 'boom');
  assert.equal(f.ledger.stuckLegs().length, 1);
  rejects(() => f.ledger.resolveStuck(id, 'W', { sig: 'nope', operator: 'admin' }), 'INVALID_COMMAND');
  f.ledger.retryStuck(id, 'W', { operator: 'AdminWallet' });
  assert.equal(f.ledger.dueLegs().length, 1);
  f.ledger.markSending(id, 'W'); f.ledger.recordSendError(id, 'W', 'boom again');
  f.ledger.resolveStuck(id, 'W', { sig: SIG(8), operator: 'AdminWallet' });
  const v = f.ledger.view(id);
  assert.equal(v.status, 'settled'); assert.equal(v.legs[0].sig, SIG(8));
  assert.equal(f.ledger.liabilityLamports(), 0);
});

// ---------------------------------------------------------------- persistence

test('snapshot/restore round-trips every state, and the restored ledger continues exactly', () => {
  const f = fixture({ rakeBps: 100 });
  f.ledger.post({ party: party('p1'), stake_lamports: STAKE });                          // posted
  f.open('p2');                                                                          // open
  const acc = f.open('p3'); f.ledger.accept({ id: acc, party: party('p4'), compatible: true }); // accepting
  const m = f.matched('p5', 'p6');                                                       // matched
  const s = f.matched('p7', 'p8'); f.ledger.observe(id => id === 'match-' + s ? { status: 'finished', winner: 'A' } : { status: 'active' });
  f.ledger.markSending(s, 'W');                                                          // settling with a sending leg
  const liability = f.ledger.liabilityLamports();
  const snap = structuredClone(f.ledger.snapshot());
  const restored = ChikiseumWagerLedger.restore(snap, { clock: f.now, rakeBps: 100 });
  assert.deepEqual(restored.snapshot(), snap);
  assert.equal(restored.liabilityLamports(), liability);
  assert.equal(restored.dirty, false);
  assert.deepEqual(restored.counts(), { posted: 1, open: 1, accepting: 1, funded: 0, matched: 1, settling: 1, settled: 0, refunded: 0, expired: 0, void: 0 });
  // continues: the matched one finishes, the sending one reconciles
  restored.observe(id => id === 'match-' + m ? { status: 'finished', winner: 'B' } : { status: 'active' });
  assert.equal(restored.view(m).legs[0].to, 'p6');
  restored.reconcile(s, 'W', { sig: SIG(3) });
  assert.equal(restored.view(s).legs[0].status, 'sent');
  assert.equal(ChikiseumWagerLedger.restore(null, { clock: f.now }).rows.size, 0);
});

test('a corrupt snapshot fails closed instead of loading a ledger that could pay wrong', () => {
  const f = fixture();
  const id = f.matched('alice', 'bob'); f.ledger.observe(() => ({ status: 'finished', winner: 'A' }));
  const good = f.ledger.snapshot();
  const mutate = fn => { const s = structuredClone(good); fn(s); return s; };
  const bad = [
    mutate(s => { s.schema = 'other'; }),
    mutate(s => { s.rows[0].status = 'paid'; }),
    mutate(s => { s.rows[0].stake_lamports = -1; }),
    mutate(s => { s.rows[0].sides.A = null; }),
    mutate(s => { s.rows[0].sides.B.deposit = null; }),                                  // matched without both deposits
    mutate(s => { s.rows[0].legs[0].memo = 'chikiseum-wager:other:W'; }),               // leg memo not bound to its wager
    mutate(s => { s.rows[0].legs[0].status = 'confirmed'; s.rows[0].legs[0].lamports = 10 * STAKE; }),   // paid more than held
    mutate(s => { s.rows[0].legs[0].reason = 'bonus'; }),
    mutate(s => { s.used_sigs.push(['bad sig', id]); }),
    mutate(s => { s.rows.push(structuredClone(s.rows[0])); }),                            // duplicate id
  ];
  for (const [i, snap] of bad.entries()) assert.throws(() => ChikiseumWagerLedger.restore(snap, { clock: f.now }), `corruption ${i} must be refused`);
});

test('terminal rows are pruned after the retention window; money-holding rows never are', () => {
  const f = fixture({ limits: { prune_after: 100 } });
  const done = f.matched('alice', 'bob'); f.ledger.observe(() => ({ status: 'finished', winner: 'A' }));
  f.ledger.markSending(done, 'W'); f.ledger.recordBroadcast(done, 'W', { sig: SIG(1) }); f.ledger.recordStatus(done, 'W', 'confirmed');
  const stuckId = f.matched('carol', 'dave');
  f.advance(1000); f.ledger.tick();
  assert.equal(f.ledger.rows.has(done), false);
  assert.equal(f.ledger.rows.has(stuckId), true);
  assert.equal(f.ledger.usedSigs.size, 2, 'the pruned wager\'s deposit signatures went with it; the live one\'s stay');
});

test('views never leak one side\'s deposit instructions to the other', () => {
  const f = fixture();
  const id = f.open('alice'); f.ledger.accept({ id, party: party('bob'), compatible: true });
  const asAlice = f.ledger.view(id, 'alice'), asBob = f.ledger.view(id, 'bob'), asNobody = f.ledger.view(id, 'zed');
  assert.equal(asAlice.you.side, 'A'); assert.equal(asAlice.you.deposit_required, false);
  assert.equal(asBob.you.side, 'B'); assert.equal(asBob.you.deposit_required, true); assert.equal(asBob.you.memo, memoFor(id, 'B'));
  assert.equal(asNobody.you, undefined);
  assert.equal(asNobody.sides.A.wallet, 'alice', 'who is in it is public, like a leaderboard');
  assert.equal(f.ledger.forWallet('bob').active.id, id);
  assert.equal(f.ledger.forWallet('zed').active, null);
});

test('stakes and pots are reported in both lamports and SOL, exactly', () => {
  const f = fixture();
  const w = f.ledger.post({ party: party('alice'), stake_lamports: 12_345_000 });
  assert.equal(w.stake_sol, 0.012345); assert.equal(w.pot_lamports, 24_690_000); assert.equal(w.stake_lamports / SOL, w.stake_sol);
});
