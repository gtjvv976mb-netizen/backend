// The two Solana adapters the wager ledger is wired to. Both are built around an injected
// Connection so they can be exercised against a fake; the ledger never sees either directly.
//
//   chain.readDeposit(sig)                 what a player's deposit transaction actually did
//   chain.findByMemo({memo, to, lamports}) is a payout we may have sent already on-chain?
//   rail.send({to, lamports, memo})        broadcast one payout, signed by the treasury
//   rail.status(leg)                       confirmed / pending / expired / failed
//
// Everything a caller could lie about is cross-checked against the chain's own record: who
// signed, how many lamports moved, and to whom. The memo alone proves nothing.
import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { MEMO_PREFIX } from './chikiseum-wagers.js';

export const MEMO_PROGRAM_IDS = Object.freeze(['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo']);
const MEMO_PROGRAM = new PublicKey(MEMO_PROGRAM_IDS[0]);
const keyOf = k => (k && typeof k === 'object' && 'pubkey' in k) ? (k.pubkey?.toBase58?.() ?? String(k.pubkey)) : (k?.toBase58?.() ?? String(k));

/** Every memo string carried by a parsed transaction, outermost instructions first, then inner ones. */
export function memosOf(tx) {
  const out = [];
  const take = ix => {
    if (!ix) return;
    const pid = ix.programId?.toBase58?.() ?? String(ix.programId ?? '');
    if (ix.program === 'spl-memo' || MEMO_PROGRAM_IDS.includes(pid)) { if (typeof ix.parsed === 'string') out.push(ix.parsed); }
  };
  for (const ix of tx?.transaction?.message?.instructions ?? []) take(ix);
  for (const inner of tx?.meta?.innerInstructions ?? []) for (const ix of inner.instructions ?? []) take(ix);
  return out;
}
/** The one memo that names a wager, if the transaction carries exactly one such memo. */
export function wagerMemoOf(tx) {
  const ours = memosOf(tx).filter(m => m.startsWith(MEMO_PREFIX + ':'));
  return ours.length === 1 ? ours[0] : null;   // two wager memos in one transaction is nobody's honest deposit
}
/** Lamports gained (or lost, negative) by `pubkey` in a parsed transaction. */
export function lamportDelta(tx, pubkey) {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  const i = keys.findIndex(k => keyOf(k) === pubkey);
  if (i < 0) return 0;
  const pre = tx.meta?.preBalances?.[i], post = tx.meta?.postBalances?.[i];
  return Number.isFinite(pre) && Number.isFinite(post) ? post - pre : 0;
}
export function signersOf(tx) {
  return (tx?.transaction?.message?.accountKeys ?? []).filter(k => k && typeof k === 'object' && k.signer === true).map(keyOf);
}

export function makeWagerChain({ conn, treasuryPubkey, lookback = 200 }) {
  if (!conn || typeof conn.getParsedTransaction !== 'function' || typeof conn.getSignaturesForAddress !== 'function') throw new Error('Connection required');
  const treasury = String(treasuryPubkey);
  const fetchTx = sig => conn.getParsedTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  return {
    async readDeposit(sig) {
      let tx;
      try { tx = await fetchTx(sig); }
      catch { return { ok: false, error: 'The deposit could not be read from the chain right now. Retry shortly.' }; }
      if (!tx || !tx.meta) return { ok: false, error: 'Deposit not found yet — wait a moment and retry.' };
      if (tx.meta.err) return { ok: false, error: 'The deposit transaction failed on-chain.' };
      return { ok: true, signers: signersOf(tx), treasury_gain_lamports: lamportDelta(tx, treasury), memo: wagerMemoOf(tx), slot: tx.slot ?? null };
    },
    /**
     * Did the treasury already send this exact payout? Looks through the treasury's recent
     * signatures for the memo, then PROVES the candidate: signed by the treasury, and the payee
     * gained at least the leg's lamports. A player can put any memo on any transaction; they
     * cannot sign as the treasury.
     */
    async findByMemo({ memo, to, lamports }) {
      const list = await conn.getSignaturesForAddress(new PublicKey(treasury), { limit: lookback }, 'confirmed');
      for (const entry of list ?? []) {
        if (entry.err) continue;
        const text = typeof entry.memo === 'string' ? entry.memo.replace(/^\[\d+\]\s*/, '') : '';
        if (text !== memo) continue;
        let tx; try { tx = await fetchTx(entry.signature); } catch { continue; }
        if (!tx || tx.meta?.err) continue;
        if (!signersOf(tx).includes(treasury)) continue;                      // not ours: a memo anyone could write
        if (to && lamportDelta(tx, to) < lamports) continue;                   // ours, but not this payment
        return { sig: entry.signature };
      }
      return null;
    },
  };
}

/**
 * Classify a send failure. A preflight/simulation rejection or a bad blockhash means the RPC
 * refused it and nothing was broadcast — safe to retry. Anything else (timeout, socket reset,
 * 5xx) is AMBIGUOUS: the transaction may be in flight. The pump leaves those in `sending`
 * for memo reconciliation rather than resending on a guess.
 */
export function classifySendError(error) {
  const msg = String(error?.message || error || '');
  const notBroadcast = error?.name === 'SendTransactionError' || Array.isArray(error?.logs)
    || /simulation failed|preflight|Blockhash not found|block height exceeded|insufficient (funds|lamports)|invalid (transaction|signature)|Transaction too large/i.test(msg);
  return notBroadcast ? 'not_broadcast' : 'ambiguous';
}

export function makeWagerRail({ conn, treasury, unpayable = null }) {
  if (!conn || typeof conn.sendRawTransaction !== 'function' || typeof conn.getLatestBlockhash !== 'function') throw new Error('Connection required');
  if (!treasury || !treasury.publicKey || typeof treasury.secretKey === 'undefined') throw new Error('Treasury keypair required');
  if (unpayable !== null && typeof unpayable !== 'function') throw new Error('unpayable must be a predicate');
  const refuse = msg => Object.assign(new Error(msg), { name: 'SendTransactionError' });
  return {
    async send({ to, lamports, memo }) {
      if (!Number.isSafeInteger(lamports) || lamports <= 0) throw refuse('invalid lamports');
      let dest; try { dest = new PublicKey(to); } catch { throw refuse('invalid payee'); }
      // THIS IS THE LOWEST LEVEL THAT BROADCASTS, so the "nobody can spend from there" rule lives
      // here and not only in the callers. An app-native account's address is off the curve — no
      // key for it can exist — and the system program is where a blank payee field ends up. SOL
      // sent to either is gone. The ledger and routes refuse these earlier; this is the check that
      // holds when one of them is wrong.
      if (!PublicKey.isOnCurve(dest.toBytes())) throw refuse('unpayable payee: off-curve address');
      if (dest.equals(SystemProgram.programId)) throw refuse('unpayable payee: system program');
      if (unpayable && unpayable(dest.toBase58())) throw refuse('unpayable payee');
      // Anything up to and including signing cannot have broadcast. Only sendRawTransaction can.
      let raw, blockhash, lastValidBlockHeight;
      try {
        ({ blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed'));
        const tx = new Transaction({ feePayer: treasury.publicKey, blockhash, lastValidBlockHeight });
        tx.add(SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: dest, lamports }));
        tx.add(new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM, data: Buffer.from(memo, 'utf8') }));
        tx.sign(treasury);
        raw = tx.serialize();
      } catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { name: 'SendTransactionError' }); }
      try {
        const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
        return { sig, blockhash, last_valid_block_height: lastValidBlockHeight };
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        error.ambiguous = classifySendError(error) === 'ambiguous';
        throw error;
      }
    },
    async status({ sig, last_valid_block_height }) {
      const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const s = value?.[0];
      if (s) {
        if (s.err) return 'failed';
        return (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') ? 'confirmed' : 'pending';
      }
      if (Number.isFinite(last_valid_block_height)) {
        const height = await conn.getBlockHeight('confirmed');
        if (height > last_valid_block_height) return 'expired';
      }
      return 'pending';
    },
  };
}
