# NFT provenance plan — turning registry assets into on-chain collectibles

Status: **design + readiness map**, not implemented. This documents exactly how far the
server-authority migration has carried us toward mintable NFTs, and precisely what remains — including
the parts that require the owner's on-chain authority and cannot be done autonomously.

## Why this is now close

The whole point of Steps 3–5 was to give every egg, chikimon, mount and avatar a **server-minted
registry row** with a permanent id and an append-only provenance chain. That is the hard prerequisite
for an NFT: you cannot mint a collectible of a thing that exists only as client-authored save data or
as reversible delta-inference. After Steps 3–5, the population of registry assets is:

| Type | How it enters the registry | Origin values seen |
|---|---|---|
| egg | `/assets/egg/claim`, restitution | issued, restitution |
| chikimon | egg hatch/consume + **Step 5 `/assets/chikimon/sync`** | hatched, legacy, unverified |
| mount | egg hatch/consume + **Step 3 `/assets/mounts/sync`** | hatched, legacy, unverified |
| avatar | `/assets/scroll/redeem` | scroll |

Each row already carries everything an NFT's metadata needs:
`{ id, type, owner, born, origin, state, parent, chain[] }` + type fields (`sp`, `kind`, birth `lvl`).
`GET /assets/cert?id=…` already serves a public, checkable provenance certificate (id, type, species,
origin, state, owner, **lineage** up the parent chain, and the full append-only event `chain`). That
certificate is the natural off-chain metadata document for a mint.

## The mapping (registry asset → NFT)

- **1 registry asset = 1 NFT.** The registry `id` is the stable off-chain key; the mint records the
  on-chain address back onto the row (a new `mint` field + a `regEvent(row, "minted_onchain", {addr})`
  chain entry — append-only, consistent with how the row already logs `minted`/`transferred`/`hatched`).
- **Metadata** comes from the row + `/assets/cert`: name = species display, attributes = `{ type,
  kind, origin, born, lineage depth, birth lvl }`. The `origin` attribute is the honesty anchor — an
  `unverified` asset mints (if the owner chooses) as visibly `unverified`, never laundered to look clean.
  Image = the existing HD voxel render per species (already shipped in the web pack).
- **Collections**: one collection per `type` (Eggs, Chikimon, Mounts, Avatars) is the clean split;
  species becomes an attribute, not a separate collection.
- **Ownership reconciliation**: on-chain owner is authoritative once minted. `transferAsset()` already
  models an ownership move with validation and a chain event; post-mint, the reconcile job reads the
  on-chain owner and calls the same path so the registry `owner` tracks the chain, not the reverse.

## What is READY (no owner action)

1. Permanent per-asset ids + append-only provenance chain (Steps 3–5, shipped).
2. Public certificate endpoint (`/assets/cert`).
3. A complete, deployable-surviving asset population (registry persists through the kv store; Steps 3–5
   adopt the legacy backlog).
4. Origin honesty end-to-end, so a mint can faithfully mark provenance rather than laundering it.

## What NEEDS THE OWNER (cannot be done autonomously — hard stop)

These are the reasons this is a plan and not a shipped feature. Each needs the owner's own hands:

1. **Mint authority + signatures.** Minting is a signed on-chain transaction from a mint-authority
   keypair. Per the project's hard rule, the assistant never handles a private key or seed phrase and
   never touches the `TREASURY_SECRET` path. The owner holds mint authority and signs.
2. **Chain/standard decision.** $CHIKI is **Token-2022** (confirmed on-chain). Options to choose:
   Token-2022 NFTs (metadata pointer / metadata extension) vs **Metaplex Core** (cheaper, simpler,
   collection-native). This is an owner call with real cost/UX tradeoffs.
3. **Rent/gas funding.** Every mint costs SOL rent. Who funds it (owner treasury vs player-pays-on-mint)
   is an economic decision, not a technical one.
4. **When to mint.** Lazy (mint-on-demand when a holder asks) keeps cost proportional to interest;
   batch (mint the whole backlog) is a large upfront SOL spend. Recommend **lazy-on-request**, gated on
   `origin !== "unverified"` unless the owner wants flagged assets mintable-as-flagged.
5. **DATABASE_URL on Render.** On-chain assets referencing registry ids demand the registry survive
   every deploy — this is the point where running without a real Postgres is no longer acceptable. Owner
   provisions it on their Render account.

## Recommended sequence (when the owner is ready to start)

1. Owner provisions `DATABASE_URL` (also unblocks Step 6/7).
2. Owner chooses standard (recommend Metaplex Core) + funding model.
3. Add `mint`/`minted_onchain` to the registry row + a read-only `/assets/metadata/:id` JSON endpoint
   for the mint (assistant can build this — no keys involved).
4. Owner runs the signed mint flow (owner-held authority) for a pilot species; reconcile job tracks
   on-chain owner back into the registry via `transferAsset`.
5. Expand from the pilot once the round-trip (mint → transfer → reconcile) is proven on devnet.

## What the assistant will NOT do

Touch the treasury, hold or request any key or seed phrase, sign or broadcast an on-chain transaction,
or mint against live authority. Everything above the "NEEDS THE OWNER" line is buildable and testable
off-chain (devnet, dummy authority) and stops exactly at the signature.
