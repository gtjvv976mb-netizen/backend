// The chain adapters against a fake Connection. What matters here is that nothing the adapters
// return can be produced by a player: signer flags, balance deltas and memo placement are read
// from the transaction the RPC returns, and a forged memo never passes as a payout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { makeWagerChain, makeWagerRail, classifySendError, memosOf, wagerMemoOf, lamportDelta, MEMO_PROGRAM_IDS } from './chikiseum-wager-chain.js';
import { memoFor } from './chikiseum-wagers.js';

const treasury = Keypair.generate(), TREASURY = treasury.publicKey.toBase58();
const alice = Keypair.generate().publicKey.toBase58(), mallory = Keypair.generate().publicKey.toBase58();
const SIG = 'S1' .repeat(32);
const memoIx = text => ({ program: 'spl-memo', programId: new PublicKey(MEMO_PROGRAM_IDS[0]), parsed: text });

/** A parsed transaction as the RPC would return it: accounts with signer flags, balances before and after. */
function parsedTx({ signer, transfers = [], memos = [], err = null, innerMemos = [] }) {
  const accounts = new Map();
  const touch = (k, signerFlag = false) => { if (!accounts.has(k)) accounts.set(k, { pubkey: new PublicKey(k), signer: false, pre: 1_000_000_000, post: 1_000_000_000 }); if (signerFlag) accounts.get(k).signer = true; };
  touch(signer, true);
  for (const [from, to, lamports] of transfers) { touch(from); touch(to); accounts.get(from).post -= lamports; accounts.get(to).post += lamports; }
  accounts.get(signer).post -= 5000;   // fee
  const keys = [...accounts.values()];
  return { slot: 123, meta: { err, preBalances: keys.map(k => k.pre), postBalances: keys.map(k => k.post), innerInstructions: innerMemos.length ? [{ index: 0, instructions: innerMemos.map(memoIx) }] : [] },
    transaction: { message: { accountKeys: keys.map(k => ({ pubkey: k.pubkey, signer: k.signer, writable: true })), instructions: memos.map(memoIx) } } };
}
function fakeConn() {
  return { txs: new Map(), sigs: [], statuses: new Map(), height: 50, sendError: null, sentRaw: [],
    async getParsedTransaction(sig) { if (this.txs.get(sig) === 'throw') throw new Error('rpc'); return this.txs.get(sig) ?? null; },
    async getSignaturesForAddress() { return this.sigs; },
    async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }; },   // any 32 bytes, base58
    async sendRawTransaction(raw) { if (this.sendError) throw this.sendError; this.sentRaw.push(raw); return 'Sent' + 'x'.repeat(60); },
    async getSignatureStatuses([sig]) { return { value: [this.statuses.get(sig) ?? null] }; },
    async getBlockHeight() { return this.height; } };
}

test('readDeposit reports exactly what the chain shows: signers, treasury gain, the wager memo', async () => {
  const conn = fakeConn(), chain = makeWagerChain({ conn, treasuryPubkey: TREASURY });
  const memo = memoFor('wager1', 'A');
  conn.txs.set(SIG, parsedTx({ signer: alice, transfers: [[alice, TREASURY, 10_000_000]], memos: [memo] }));
  const r = await chain.readDeposit(SIG);
  assert.deepEqual(r, { ok: true, signers: [alice], treasury_gain_lamports: 10_000_000, memo, slot: 123 });
});

test('readDeposit: not found, failed on-chain, and RPC errors are distinct and never ok', async () => {
  const conn = fakeConn(), chain = makeWagerChain({ conn, treasuryPubkey: TREASURY });
  assert.equal((await chain.readDeposit(SIG)).ok, false);
  assert.match((await chain.readDeposit(SIG)).error, /not found yet/);
  conn.txs.set(SIG, parsedTx({ signer: alice, transfers: [[alice, TREASURY, 10_000_000]], memos: [memoFor('w', 'A')], err: { InstructionError: [0, 'Custom'] } }));
  assert.match((await chain.readDeposit(SIG)).error, /failed on-chain/);
  conn.txs.set(SIG, 'throw');
  assert.match((await chain.readDeposit(SIG)).error, /Retry shortly/);
});

test('a deposit that only mentions the treasury without paying it reads as zero gain; a memo in the wrong place still counts, two memos do not', async () => {
  const conn = fakeConn(), chain = makeWagerChain({ conn, treasuryPubkey: TREASURY });
  conn.txs.set(SIG, parsedTx({ signer: alice, transfers: [[alice, mallory, 10_000_000]], memos: [memoFor('w', 'A')] }));
  assert.equal((await chain.readDeposit(SIG)).treasury_gain_lamports, 0);
  conn.txs.set(SIG, parsedTx({ signer: alice, transfers: [[alice, TREASURY, 10_000_000]], innerMemos: [memoFor('w', 'A')] }));
  assert.equal((await chain.readDeposit(SIG)).memo, memoFor('w', 'A'), 'an inner-instruction memo is still the transaction\'s memo');
  conn.txs.set(SIG, parsedTx({ signer: alice, transfers: [[alice, TREASURY, 10_000_000]], memos: [memoFor('w', 'A'), memoFor('w2', 'A')] }));
  assert.equal((await chain.readDeposit(SIG)).memo, null, 'a transaction naming two wagers funds neither');
  conn.txs.set(SIG, parsedTx({ signer: alice, transfers: [[alice, TREASURY, 10_000_000]], memos: ['hello', memoFor('w', 'A')] }));
  assert.equal((await chain.readDeposit(SIG)).memo, memoFor('w', 'A'), 'unrelated memos are ignored');
});

test('findByMemo proves a payout: the memo alone is not enough, the treasury must have signed and the payee must have been paid', async () => {
  const conn = fakeConn(), chain = makeWagerChain({ conn, treasuryPubkey: TREASURY });
  const memo = memoFor('wager1', 'W'), want = { memo, to: alice, lamports: 20_000_000 };
  // 1. Mallory sends the treasury dust carrying the payout memo, hoping the reconciler marks alice as paid.
  conn.sigs = [{ signature: 'Forged' + 'x'.repeat(58), memo: `[${memo.length}] ${memo}`, err: null }];
  conn.txs.set(conn.sigs[0].signature, parsedTx({ signer: mallory, transfers: [[mallory, TREASURY, 1]], memos: [memo] }));
  assert.equal(await chain.findByMemo(want), null, 'a memo the treasury did not sign is not a payout');
  // 2. The treasury signed, but paid someone else / too little.
  conn.sigs.push({ signature: 'Wrong' + 'x'.repeat(59), memo: `[${memo.length}] ${memo}`, err: null });
  conn.txs.set(conn.sigs[1].signature, parsedTx({ signer: TREASURY, transfers: [[TREASURY, mallory, 20_000_000]], memos: [memo] }));
  assert.equal(await chain.findByMemo(want), null);
  conn.sigs.push({ signature: 'Short' + 'x'.repeat(59), memo: `[${memo.length}] ${memo}`, err: null });
  conn.txs.set(conn.sigs[2].signature, parsedTx({ signer: TREASURY, transfers: [[TREASURY, alice, 19_999_999]], memos: [memo] }));
  assert.equal(await chain.findByMemo(want), null);
  // 3. A failed transaction with the right memo does not count either.
  conn.sigs.push({ signature: 'Failed' + 'x'.repeat(58), memo: `[${memo.length}] ${memo}`, err: { some: 'error' } });
  assert.equal(await chain.findByMemo(want), null);
  // 4. The real one.
  conn.sigs.push({ signature: 'Real' + 'x'.repeat(60), memo: `[${memo.length}] ${memo}`, err: null });
  conn.txs.set(conn.sigs[4].signature, parsedTx({ signer: TREASURY, transfers: [[TREASURY, alice, 20_000_000]], memos: [memo] }));
  assert.deepEqual(await chain.findByMemo(want), { sig: conn.sigs[4].signature });
  // 5. A different leg's memo on the same wager is not this leg.
  assert.equal(await chain.findByMemo({ memo: memoFor('wager1', 'RA'), to: alice, lamports: 10_000_000 }), null);
});

test('the rail signs a transfer plus memo with the treasury and reports the blockhash window', async () => {
  const conn = fakeConn(), rail = makeWagerRail({ conn, treasury });
  const r = await rail.send({ to: alice, lamports: 20_000_000, memo: memoFor('wager1', 'W') });
  assert.match(r.sig, /^Sent/); assert.equal(r.last_valid_block_height, 100); assert.equal(conn.sentRaw.length, 1);
  assert.ok(conn.sentRaw[0].length > 100, 'a serialized, signed transaction was broadcast');
});

test('the rail refuses a bad payee or amount before anything is built, as a not-broadcast error', async () => {
  const conn = fakeConn(), rail = makeWagerRail({ conn, treasury });
  for (const bad of [{ to: 'not-a-pubkey', lamports: 1 }, { to: alice, lamports: 0 }, { to: alice, lamports: 1.5 }]) {
    await assert.rejects(rail.send({ ...bad, memo: 'm' }), e => classifySendError(e) === 'not_broadcast' && !e.ambiguous);
  }
  assert.equal(conn.sentRaw.length, 0);
});

test('send failures are classified: preflight/blockhash rejections are safe to retry, timeouts are ambiguous', async () => {
  assert.equal(classifySendError(Object.assign(new Error('Transaction simulation failed: insufficient funds'), { name: 'SendTransactionError' })), 'not_broadcast');
  assert.equal(classifySendError(new Error('failed to send transaction: Blockhash not found')), 'not_broadcast');
  assert.equal(classifySendError(new Error('Transaction simulation failed: Error processing Instruction 0')), 'not_broadcast');
  assert.equal(classifySendError(new Error('fetch failed')), 'ambiguous');
  assert.equal(classifySendError(new Error('The operation was aborted due to timeout')), 'ambiguous');
  assert.equal(classifySendError(new Error('502 Bad Gateway')), 'ambiguous');
  const conn = fakeConn(), rail = makeWagerRail({ conn, treasury });
  conn.sendError = new Error('socket hang up');
  await assert.rejects(rail.send({ to: alice, lamports: 1000, memo: 'm' }), e => e.ambiguous === true);
  conn.sendError = Object.assign(new Error('Transaction simulation failed'), { name: 'SendTransactionError', logs: [] });
  await assert.rejects(rail.send({ to: alice, lamports: 1000, memo: 'm' }), e => e.ambiguous === false);
});

test('status: confirmed and finalized are confirmed; processed is pending; an on-chain error is failed; a lapsed blockhash is expired', async () => {
  const conn = fakeConn(), rail = makeWagerRail({ conn, treasury });
  const leg = { sig: SIG, last_valid_block_height: 100 };
  conn.statuses.set(SIG, { err: null, confirmationStatus: 'confirmed' }); assert.equal(await rail.status(leg), 'confirmed');
  conn.statuses.set(SIG, { err: null, confirmationStatus: 'finalized' }); assert.equal(await rail.status(leg), 'confirmed');
  conn.statuses.set(SIG, { err: null, confirmationStatus: 'processed' }); assert.equal(await rail.status(leg), 'pending');
  conn.statuses.set(SIG, { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }); assert.equal(await rail.status(leg), 'failed');
  conn.statuses.delete(SIG);
  conn.height = 100; assert.equal(await rail.status(leg), 'pending', 'still inside the window');
  conn.height = 101; assert.equal(await rail.status(leg), 'expired');
  assert.equal(await rail.status({ sig: SIG, last_valid_block_height: null }), 'pending', 'no window known: never declare it dead');
});

test('helpers: memosOf, wagerMemoOf and lamportDelta on odd shapes never throw', () => {
  assert.deepEqual(memosOf(null), []); assert.equal(wagerMemoOf({}), null); assert.equal(lamportDelta(undefined, alice), 0);
  assert.equal(lamportDelta({ transaction: { message: { accountKeys: [alice] } }, meta: { preBalances: [5], postBalances: [9] } }, alice), 4, 'bare string keys are handled too');
});

test('rail.send refuses a payee nobody can spend from, before anything is signed or sent', async () => {
  const conn = fakeConn(), rail = makeWagerRail({ conn, treasury });
  // Off the Ed25519 curve: the shape of an app-native account address. No key for it can exist.
  let offCurve = null;
  for (let i = 0; i < 64 && !offCurve; i++) {
    const bytes = Keypair.generate().publicKey.toBytes(); bytes[31] ^= 0x40 | i;
    if (!PublicKey.isOnCurve(bytes)) offCurve = new PublicKey(bytes).toBase58();
  }
  assert.ok(offCurve, 'found an off-curve address to test with');
  for (const to of [offCurve, '11111111111111111111111111111111']) {
    await assert.rejects(rail.send({ to, lamports: 1000, memo: 'm' }), e => classifySendError(e) === 'not_broadcast' && !e.ambiguous && /unpayable/.test(e.message));
  }
  assert.equal(conn.sentRaw.length, 0, 'nothing reached the RPC');
  // The caller's own rule is honoured too, on top of the built-in ones.
  const strict = makeWagerRail({ conn, treasury, unpayable: a => a === mallory });
  await assert.rejects(strict.send({ to: mallory, lamports: 1000, memo: 'm' }), /unpayable/);
  const ok = await strict.send({ to: alice, lamports: 1000, memo: 'm' });
  assert.match(ok.sig, /^Sent/);
  assert.throws(() => makeWagerRail({ conn, treasury, unpayable: 'yes' }), /predicate/);
});
