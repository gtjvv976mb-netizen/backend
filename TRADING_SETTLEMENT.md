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
   sync. Each recorded sale splits the price **three ways** (`_credit_sale` in Market.gd):
   **75% → the seller's purse**, **20% → the reward pool** (`ledger.pooled`), **5% burned**
   (`ledger.burned`). Shows the "SOLD!" toast, then acks with `{op:"sales_ack", ids:[…]}` so
   a sale can never be credited twice — and a lost response never loses the proceeds (queued
   until acked). NOTE: soft-rail pool/burn are bookkeeping sinks (no real tokens move); only
   Rail B moves real $CHIKI to the real pool + a real burn.

Notes:
- A sale flagged `onchain` is NOT soft-credited (the seller was already paid real $CHIKI on
  chain) — the client only shows a toast + advances the quest, no double pay.
- Self-buys and replayed buy ops produce **no** sale record (server-side guards).
- Sales queue survives restarts (kv), expires after 7 days, capped 50/seller.
- The deployed backend previously had **no** `/market/*` routes at all (the shared book
  silently fell back to per-client NPC mode). This commit adds them.

## Rail B — real on-chain $CHIKI (server half BUILT + flagged off)

Buyer signs ONE real $CHIKI transaction that splits the price **three ways** — 75% to the
seller, 20% to the reward-pool (treasury) wallet, 5% burned — and the server only VERIFIES
it on-chain and releases the item. Funds flow buyer→seller/pool directly; the game never
custodies money and never signs on the buyer's behalf.

### DONE (this commit) — the safe, verified server half
- `POST /market/buy-onchain {buyer, txSig, listingId}` — gated by `MARKET_ONCHAIN=1` (else 503).
  Verifies with `txMarketSplit(sig, buyer, sellerWallet, price)` (pre/post token-balance deltas of
  the $CHIKI mint): confirmed ∧ **buyer paid ≥ 100%** ∧ **seller received ≥ 75%** ∧ **reward pool
  received ≥ 20%** (0.5% rounding tolerance; the missing 5% left circulation = burned). Balance-
  delta based, so instruction/memo shape can't spoof it. Replay guard (`_usedTxSigs`, a sig
  settles ≤ 1 listing), self-buy block, unknown-listing 404, seller-not-on-chain-payable 409. On
  success: removes the listing, records the sale (`sellerNet`, `poolTax`) for the seller, returns
  the released item. It NEVER sends money.
- `getStats()` exposes `marketOnchain` (flag), `marketSplit {seller:0.75, pool:0.20, burn:0.05}`,
  and `rewardPool` (the treasury pubkey the buyer must pay the 20% to).
- Tested: flag-off → 503; bad buyer → 400; unknown listing → 404; replay → 409. (A real mainnet
  tx is required to exercise the positive split path.)

### TODO before enabling (the client half — needs a real Phantom + mainnet test)
1. **Bundle Solana libs in the realm shell** (`web_shell.html`): a self-contained
   `@solana/web3.js` + `@solana/spl-token` UMD (CSP blocks CDNs — vendor the file into
   `realm/`). ~150 KB; affects bundle size.
2. **JS bridge** `window.__chikiBuy(seller, pool, price, decimals)` builds ONE transaction with
   THREE instructions and returns the signed sig (or an error string):
   - `createTransferCheckedInstruction(buyerATA, MINT, sellerATA, buyer, round(price*0.75)*10**dec, dec)`;
   - `createTransferCheckedInstruction(buyerATA, MINT, poolATA,   buyer, round(price*0.20)*10**dec, dec)`;
   - `createBurnCheckedInstruction(buyerATA, MINT, buyer, round(price*0.05)*10**dec, dec)`  ← real supply burn;
   - create any missing ATA (seller/pool) first (payer = buyer, ~0.002 SOL rent each);
   - `phantom.signAndSendTransaction(tx)`.
3. **Market.gd** on-chain buy path: only when `Chain` reports `marketOnchain` true → call the
   bridge with `rewardPool` + `marketSplit` from `/stats`, poll for the sig, `POST
   /market/buy-onchain`; on 200 grant the released goods; on any failure fall back to a clear
   error (never grant without a verified transfer). The soft-rail `onchain` sale flag makes the
   seller's client skip the soft credit (no double pay).
4. **Mainnet test checklist**: two real wallets; list → buy with a real signed split tx → confirm
   the seller's on-chain balance rose by ~75%, the reward pool by ~20%, the mint supply fell by
   ~5%, the listing cleared, the item released once, and a replayed sig is rejected. Test the
   seller/pool-has-no-ATA path (rent paid by buyer). Only then set `MARKET_ONCHAIN=1`.

Until step 4 passes, the game keeps using **Rail A** (in-game $CHIKI, same 75/20/5 split applied
as bookkeeping, no signature) — the safe default. `MARKET_ONCHAIN` stays unset.

⚠️ Rail B moves REAL money. It must stay flagged OFF until the mainnet two-wallet test above
passes with a real Phantom wallet — that test cannot be run headless/in CI.
