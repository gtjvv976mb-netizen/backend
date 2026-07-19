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

## Rail B — real on-chain $CHIKI (designed, not yet enabled)

Exactly as intuited: a real-token trade **requires the buyer to sign an SPL transfer**
for the exact amount to the seller's wallet. The game never touches keys; the server
never holds funds — it only verifies and releases the item.

1. Listing records the **seller's wallet address** (signed-in sellers only).
2. Buyer presses Buy → client asks Phantom to sign+send one SPL token transfer:
   `buyer ATA → seller ATA, amount = price, mint = $CHIKI`. (Needs `@solana/web3.js`
   served locally with the realm bundle to build the transaction.)
3. Client posts the tx signature to `POST /market/settle {listingId, txSig}`.
4. Server marks the listing **pending**, fetches the tx via RPC, and verifies:
   confirmed ∧ token = $CHIKI mint ∧ destination = seller's ATA ∧ amount ≥ price
   ∧ source owner = the buyer's signed-in wallet ∧ txSig never used before (replay guard).
5. On success the server releases the item to the buyer and records the sale for the
   seller (goods state must be server-authoritative first — see CHEATPROOF_BACKEND_SPEC).
6. Timeouts/failed verification → listing returns to the book, nothing moves.

Prerequisites before enabling Rail B: server-authoritative inventories (otherwise a
hacked client can dupe the escrowed goods), a Postgres-backed listing store, and rate
limits on `/market/settle` RPC lookups. Until then Rail A is the correct, honest rail:
soft-currency trades, real burns, zero custody risk.
