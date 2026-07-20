# Trading Post — how player-to-player payment settles

## The question
When player B buys player A's listing, how does the $CHIKI actually move from B to A?

## Rail A — in-game $CHIKI (LIVE, implemented)

The Trading Post trades **in-game $CHIKI** (the game purse — the balance seeded from and
capped by your verified wallet hold). No on-chain funds move, so **no transaction
signature is needed** — and the "sign-in is never a transaction" promise stays intact.

Settlement flow:

1. **List** — seller's client escrows the goods locally (items leave their bag) and posts
   the listing to `POST /market/op {op:"list"}`. The server holds the shared book.
2. **Buy** — buyer's client checks their purse, deducts the price locally, grants the
   goods, and posts `{op:"buy"}`. The server removes the listing **and records the sale**
   under the seller's id (`marketSales[sellerSid]`), kv-persisted.
3. **Settle** — the seller's client polls `GET /market/sales?sid=…` on its normal market
   sync. Each recorded sale credits the seller's purse with `price × 0.95`
   (**5% market fee burns** — a real token sink), shows the "SOLD!" toast, then acks with
   `{op:"sales_ack", ids:[…]}` so a sale can never be credited twice — and a lost
   response never loses the proceeds (they stay queued until acked).

Notes:
- Self-buys and replayed buy ops produce **no** sale record (server-side guards).
- Sales queue survives restarts (kv), expires after 7 days, capped 50/seller.
- The deployed backend previously had **no** `/market/*` routes at all (the shared book
  silently fell back to per-client NPC mode). This commit adds them.

## Rail B — real on-chain $CHIKI (server half BUILT + flagged off)

Buyer signs a real $CHIKI SPL transfer straight to the seller's wallet; the server only
VERIFIES it on-chain and releases the item. Funds flow buyer→seller directly — the game
never custodies money.

### DONE (this commit) — the safe, verified server half
- `POST /market/buy-onchain {buyer, txSig, listingId}` — gated by `MARKET_ONCHAIN=1` (else 503).
  Verifies with `txTransfer(sig, buyer, sellerWallet, price)` (pre/post token-balance deltas of
  the $CHIKI mint, same proven method as the quest-reward `txPaid`): confirmed ∧ seller received
  ≥ price ∧ buyer paid ≥ price. Replay guard (`_usedTxSigs`, a sig settles ≤ 1 listing), self-buy
  block, unknown-listing 404. On success: removes the listing, records the sale for the seller,
  returns the released item. It NEVER sends money.
- `getStats().marketOnchain` exposes the flag so the client knows whether to offer on-chain buys.
- Tested: flag-off → 503; bad buyer → 400; unknown listing → 404; replay → 409. (A real
  mainnet tx is required to exercise the positive path.)

### TODO before enabling (the client half — needs a real Phantom + mainnet test)
1. **Bundle Solana libs in the realm shell** (`web_shell.html`): a self-contained
   `@solana/web3.js` + `@solana/spl-token` UMD (CSP blocks CDNs — vendor the file into
   `realm/`). ~150 KB; affects bundle size.
2. **JS bridge** `window.__chikiPay(sellerPubkey, amount)`:
   - `getAssociatedTokenAddress(MINT, buyer)` and `(MINT, seller)`;
   - if the seller's ATA doesn't exist, prepend `createAssociatedTokenAccountInstruction`
     (payer = buyer, ~0.002 SOL rent);
   - `createTransferCheckedInstruction(buyerATA, MINT, sellerATA, buyer, amount*10**decimals, decimals)`;
   - `phantom.signAndSendTransaction(tx)` → return the signature (or an error string).
3. **Market.gd** on-chain buy path: only when `Chain` reports `marketOnchain` true → call the
   bridge, poll for the sig, `POST /market/buy-onchain`; on 200 grant the released goods; on any
   failure fall back to a clear error (never grant without a verified transfer).
4. **Mainnet test checklist**: two real wallets; list → buy with a real signed transfer →
   confirm the seller's on-chain balance rose by the price, the listing cleared, the item
   released once, and a replayed sig is rejected. Test the seller-has-no-ATA path (rent paid by
   buyer). Only then set `MARKET_ONCHAIN=1` on the server.

Until step 4 passes, the game keeps using **Rail A** (in-game $CHIKI, 5% burn, no signature) —
the safe default. `MARKET_ONCHAIN` stays unset.
