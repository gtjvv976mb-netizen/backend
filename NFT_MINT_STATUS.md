# NFT Mint — Status & Go-Live Guide

_Last updated 2026-08-04. Backend `server.js`, dev copy == deploy mirror byte-for-byte
(`cmp` IDENTICAL, md5 `ca6ecab4d22391cdcc019da911173340`). Feature ships **behind a flag that
defaults OFF** — with the flag off the server behaves exactly as it did before this work._

---

## 1. What this is, in plain terms

Players will be able to turn a **rare creature they already earned in-game** into a real
**Solana NFT** they hold in their own wallet — a permanent, on-chain certificate of ownership and
provenance for that specific creature.

**What a player will be able to do (once the flag is flipped and the client UI ships):**

- Open a rare creature they own and choose **"Mint as NFT."**
- Minting is **FREE** — no $CHIKI is spent or burned. The player pays only the tiny Solana network
  rent/gas for their own token account (or the treasury covers it — the owner decides that at setup).
- The creature keeps its **edition number** (e.g. "Dragonos #3") — a serial the **server** assigns,
  the same for everyone, never re-rolled by the client.
- The NFT carries the creature's real provenance: species, birth date, who hatched it, origin, and
  its full event history. This is the "certificate" a buyer can trust.
- On any **secondary sale**, a **15% royalty** is collected on-chain and routed to the game's
  **pool wallet** (funds the reward economy, not the treasury).
- If a player ever **burns** the NFT, the creature is **permanently retired** — it becomes a
  memorial entry in the dex. It is not deleted, and it is not handed back to anyone.

**What a player will NOT be able to do (by design, this increment):**

- Mint a **normal** chikimon, an **egg**, or an **avatar**. Only rare tiers are mintable.
- Mint a creature they didn't personally hatch (imported/legacy/adopted creatures are excluded —
  see §3, E1).
- Mint the same creature twice (the second attempt just returns the original NFT).

**What is NOT built yet (the two things standing between "code done" and "players can do it"):**

1. **The client wallet-signing UI.** The backend prepares an unsigned mint intent; the player's
   wallet must sign and submit the actual on-chain transaction. That button/flow lives in the Godot
   client and **has not been built**. Until it ships, there is no way for a player to mint.
2. **The actual on-chain go-live.** No collection exists on-chain yet, the mint flag is OFF, and
   nothing has ever touched a real chain (not even devnet). See §4 and §5.

---

## 2. The four decisions the owner locked (2026-08-04) and how they shaped the build

| Decision | Lock | How it shaped the code |
|---|---|---|
| **Mint fee** | **FREE** — network gas only, no $CHIKI burn | There is no payment step. Because there's no fee signature to dedupe against, the anti-double-mint key is the **creature's own registry id** (one NFT per creature, written **once, never overwritten**). With no fee to gate abuse, **the rarity gate is the sole abuse defense** — so it was built to be airtight (§3). |
| **What is mintable** | **Rare tiers only** — legendaries, Meme Dynasty chikimon, and mounts. No normals, no avatars | The mint route hard-refuses anything else. No level/power threshold was needed — normals simply aren't eligible. Avatar minting stays blocked. |
| **Burn semantics** | **Retire permanently** | A burned NFT flips the registry record to `state: "burned"` and logs a `burned` provenance event. **The record is kept forever** (a dex memorial); the creature goes dormant and is never restored to anyone. |
| **Royalty** | **15%**, routed to the **pool wallet** on every secondary sale | Hardcoded as `sellerFeeBasisPoints: 1500` in the collection/royalty config, destination = the pool wallet (`NFT_ROYALTY_WALLET`, defaulting to the existing `TEAM_WALLET` pool). The owner chose 15% deliberately — higher than typical. |

### Fail-safe defaults chosen for the still-open technical questions

- **D6 — on-chain read (DAS) outage: WIRED AS A HARD-STOP.** If the on-chain ownership reader
  returns a structurally broken/unsupported response, the reconciliation loop **stops entirely and
  changes nothing**, and flags the affected records for manual review. A bad read can never strip a
  holder. (Stricter than "a failed read changes nothing.")
- **D8 — meme-egg strand bug: fix deferred, remedy chosen.** The correct shape (roll & reserve the
  character server-side at purchase time, revealed later) is documented; the existing pre-mint
  meme-egg strand bug is **independent of this feature** and left for its own increment.
- **E1 — who can mint: server-witnessed births only.** Only creatures the **server itself hatched**
  (`origin === "hatched"`) are mintable. Legacy, unverified, purchased, traded, and adopted
  creatures are **excluded** — minting them would launder exactly the unproven ownership the NFT is
  supposed to certify. This is exposed as a config set (`NFT_MINT_ORIGINS`, default `hatched`) so
  the owner can widen it later without a code change.

### Owner-only, not code

- **D1 — where NFTs are sold/promoted (Tensor / Magic Eden / in-game).** This is a marketing and
  listing-venue decision, **not a code decision**. The build names no marketplace; go-live copy
  should say only "Trading Post + wallet-to-wallet" until a venue is chosen and probed.

---

## 3. The rarity gate (why it's airtight under free mint)

Because mint is free, this gate is the **only** thing preventing abuse. Every check runs
**server-side**, in order, on `POST /assets/nft/mint`:

1. The creature exists in the registry.
2. The **registry says this wallet owns it** (the registry is the sole authority — not the client).
3. It is **active** (not consumed, void, or already burned).
4. It is **not an avatar**.
5. Its kind is a **rare tier**: a mount, or a **legendary** / **Meme Dynasty** chikimon.
6. Its origin is a **server-witnessed birth** (`hatched`).
7. Its game-status is **good** (a flagged creature can't mint).
8. It is **not currently listed** off-chain or mid-handover.
9. It has **no existing mint** — if it does, the same original NFT is returned (idempotent).

No supply-cap re-check happens here **on purpose**: minting **issues no new creature** — it only
certifies one that already passed the population cap when it was born. Re-checking a cap on a
non-issuance path is a known double-count hazard and was deliberately avoided. The gate is airtight
because it can only ever mint **an existing, server-witnessed, registry-owned, rare-tier creature** —
minting cannot manufacture scarcity.

---

## 4. What remains UNVERIFIED

Everything below was tested **only in simulation** — throwaway keys, a dead RPC address, a stubbed
on-chain reader, and an in-memory store. **Nothing has ever touched a real chain.**

- **No real chain, not even devnet or mainnet-beta.** The mint transaction assembly, the WNS
  royalty hook, and the Token-2022 program calls have never been exercised against a live cluster.
- **No treasury / no collection.** No on-chain collection exists; no mint authority is configured.
- **No real wallet.** The player wallet-signing flow is untested end-to-end because the client UI
  doesn't exist yet.
- **DAS ownership read shape unproven on-chain.** The reconciler assumes the on-chain reader returns
  a usable owner field for a WNS/Token-2022 asset. That must be confirmed against a real devnet
  asset before the flag is flipped (deferred gate 11).
- **Royalty enforcement is on-chain, not server-enforced.** The 15% is collected by the WNS transfer
  hook on-chain. The mint route currently records the player-supplied mint address after a format
  check only — it does **not yet verify the token belongs to the official collection**. Until the
  collection bootstrap lands **and** the mint route verifies collection membership, an out-of-
  collection token could be recorded that would evade the pool royalty on resale. Close this before
  or with go-live.
- **The existing live meme-owner reconciler was left untouched** (still uses the weaker validation)
  to keep the live-money path byte-identical while the flag is off. It must adopt the new
  classifier **before** the flag is flipped.
- **`DATABASE_URL` must be provisioned before go-live.** The in-memory store loses the registry on
  every deploy, which would orphan live NFTs.

---

## 5. Owner go-live steps — what ONLY the owner can do, in order

These steps require the treasury / mint authority and cannot be done by the build. **Do them in
this order.**

1. **Provision `DATABASE_URL`** on the backend so the registry persists across deploys. (Ops
   precondition — without it, live NFTs orphan on the next restart.)
2. **Ship the client build with the mint UI first.** The wallet-signing button/flow must be live in
   the player client **before** the flag is flipped — otherwise the server offers a mint no player
   can complete. (Client-before-flag, same rule as every prior authority flip.)
3. **One-time WNS collection / creator setup (owner-only, holds the authority).** Create the WNS
   collection group, set its update authority, and configure the **15% royalty → pool wallet** hook
   and creators. This is the single authority-holding act and the owner's deliberate go-live moment.
   No private key ever goes in a repo, the client, a response, or chat.
4. **Set the collection env vars:** `NFT_COLLECTION` (the collection address) and, if the pool
   wallet differs from the default, `NFT_ROYALTY_WALLET`. Confirm `NFT_ROYALTY_BPS=1500`.
5. **Add the collection-membership check** to the mint route (verify the recorded token is in
   `NFT_COLLECTION`) and **swap the live meme reconciler onto the new classifier** — the two
   pre-flip code items in §4.
6. **Devnet dry-run.** Confirm the on-chain reader returns a usable owner for a real WNS/Token-2022
   asset (gate 11). Confirm a real wallet can sign and submit the prepared mint intent.
7. **Flip the flag LAST:** set `CHIK_NFT_MINT=1`. This is the final step, after 1–6 are proven.
   Keep `NFT_MINT_PAUSED=0`. (Pausing new mints later never pauses reconciliation.)

**Fail-safe env defaults already in place** (all OFF/safe until the owner sets them):
`CHIK_NFT_MINT=0` (master, OFF), `NFT_MINT_PAUSED=0`, `NFT_MINT_ORIGINS=hatched`,
`NFT_ROYALTY_BPS=1500`, `NFT_ROYALTY_WALLET`→pool (`TEAM_WALLET`), `NFT_COLLECTION` unset,
`NFT_HOLDER_DENYLIST` empty.

---

## 6. Regression — fresh run, 2026-08-04

Every sim boots the real `server.js` in-process with a throwaway keypair, a dead RPC address,
holder-verify off, a unique port, and no database — **on-chain reads/writes are simulated; no live
cluster, no real transaction.**

| Sim | Result |
|---|---|
| `rarity_truth_sim` | **PASS** — breaches = 0, memeMax = 25 (caps enforced) |
| `census_sim` | **PASS** — 44 / 44 |
| `census_consolidation_sim` | **PASS** — 51 / 51 |
| `meme_cap_sim` | **PASS** — 19 / 19 |
| `asset_forge_sim` | **PASS** — 36 / 36 |
| `egg_hatch_authority_sim` | **PASS** — 15 / 15 |
| `_nft_mint_sim` (new, flag ON) | **PASS** — 42 / 42 |
| `_nft_offdiff_sim` (new, flag OFF == HEAD) | **PASS** — 13 / 13 |
| `_av_nft_attack_sim` (new, adversarial) | **PASS** — 31 / 31 |
| `asset_registry_sim` | pre-existing fixture failure (see below) |
| `chikimon_forge_sim` | 48 / 51 — 3 pre-existing fixture failures (see below) |
| `mount_forge_sim` | pre-existing fixture failures (see below) |

**The three failures are pre-existing test-harness staleness, not defects — bisected and proven.**
Each was re-run against the pre-NFT baseline (`git show HEAD:server.js`, md5
`7046f9254d54d0f363bb9557646681d9`, no NFT code) and the failing assertions came out **byte-for-byte
identical**:

- `asset_registry_sim` — "claiming mints an egg (undefined…)": identical on HEAD (stale egg-claim
  fixture).
- `chikimon_forge_sim` — the 3 jellox duplicate-row assertions: identical on HEAD (48 pass / 3 fail
  both).
- `mount_forge_sim` — grandfathered-wolf-legacy + mount-egg-claim (409): identical on HEAD.

The NFT build introduced **zero new failures**. The only behavioral change vs HEAD is gated behind
`CHIK_NFT_MINT` (default OFF); with the flag off the `_nft_offdiff_sim` confirms the server is
byte-identical to HEAD (13/13). Dev `server.js` == deploy mirror `server.js` (`cmp` IDENTICAL,
md5 `ca6ecab4d22391cdcc019da911173340`), `node --check` clean on both.
