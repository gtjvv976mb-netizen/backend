# NFT go-live — the one-time runbook

**Who this is for:** the owner. You run this once, in order. Everything before step 5 is reversible,
and nothing in steps 1–4 can affect players, because `CHIK_NFT_MINT` stays `0` until step 5.

**What the feature is.** A player who owns a rare creature — a legendary, a Meme Dynasty chikimon, or
a mount — taps **Mint** and the server puts a real Metaplex Core NFT into *their* wallet, inside the
official collection, inheriting its 20% royalty. The player signs nothing and pays nothing; the
server's mint wallet pays the ~0.004 SOL of rent. The NFT is a **certificate over a creature that
already exists**. Minting does not create a creature, does not change any supply count, and does not
change any rarity — proven, see "What was verified" at the bottom.

**What you need before you start**

| Thing | Value |
|---|---|
| Collection | `2iyJEoY5mUnBXJ139R5mQSkfQtgzZXTP4BtnQaiGEgTN` — "Chiki Monsters Meme Dynasty" |
| Collection's master authority | the **TEAM wallet** `CmY2ZXVPVG2gbAHeVWHw7PQrAKtTcrWsq2raaWgg8YJ9` |
| Royalty | 20% (2000 bps), already on the collection, inherited by every member |
| A **new, empty** wallet for the server | you will create it in step 1 |

> **The master key never goes on the server.** Not in step 1, not ever. The server gets a *separate*
> wallet that you add to a revocable list. If that server wallet were ever stolen, the worst anyone
> could do is mint junk into the collection, and you take it away again with one command.

---

## Step 1 — Give the server a scoped minting authority

### 1a. Make the server its own wallet

Create a brand-new wallet in Phantom (or `solana-keygen new`). **Do not reuse** the team wallet, the
treasury wallet, or any wallet holding anything. Call it "Chikoria mint delegate".

Fund it with **0.2 SOL**. That is roughly 50 mints' worth of rent, and it is the entire amount at
risk. Top it up when it runs low; the server tells you (`GET /assets/nft/config` → `ready`).

Get its **secret key** in the form Render wants:

```bash
cd ~/Downloads/chiki-backend
 export PK='<paste the mint-delegate key Phantom shows you>'     # NOTE the leading space
node make_keyfile.mjs
```

The leading space keeps it out of your shell history. `make_keyfile.mjs` writes `authority.json`
(chmod 600) and prints **which wallet it is** — check that it says the new mint-delegate address and
**not** the team wallet. You need two things from this file:

* the **public** key — the address it printed. This is what you grant, and it is not secret.
* the **secret** — the contents of `authority.json`, a JSON array of 64 numbers. This is what goes
  into Render in step 2, and nowhere else.

### 1b. Grant it, from the cold team key

Now do the same conversion for the **TEAM wallet**, into a *different* file, because only the team
wallet can change the collection:

```bash
 export PK='<paste the TEAM wallet key>'
node make_keyfile.mjs                      # writes authority.json again — move it aside first
mv authority.json team-authority.json
```

Look at the collection before you touch it (this reads only, no key needed):

```bash
node grant_mint_delegate.mjs --show
```

You should see `authority  CmY2ZXVPVG…   ✓ the TEAM wallet` and `royalty  2000 bps`. If the royalty
line says anything else, **stop** and fix that first — members inherit whatever is there.

Dry run the grant, then do it:

```bash
node grant_mint_delegate.mjs --keypair ./team-authority.json --delegate <MINT_DELEGATE_PUBKEY>
node grant_mint_delegate.mjs --keypair ./team-authority.json --delegate <MINT_DELEGATE_PUBKEY> --commit
```

The first command writes nothing and prints exactly what the second will do. The second sends one
transaction and then **reads the chain back** to confirm. It refuses outright if the key you gave it
is not the collection's authority, and it refuses if you try to grant the team wallet to itself.

**What this actually does:** it puts the mint-delegate's address into the collection's
`UpdateDelegate` plugin list. A wallet on that list may create assets inside the collection. It
cannot change who owns the collection, cannot move the master authority, and cannot remove itself —
the team wallet keeps control of the list.

### 1c. Put the key files away

```bash
rm -P authority.json team-authority.json && unset PK
```

You do not need them again unless you revoke. The mint-delegate secret lives only in Render from
here on.

### How to revoke (do this any time, from the cold key)

```bash
node grant_mint_delegate.mjs --keypair ./team-authority.json --delegate <MINT_DELEGATE_PUBKEY> --revoke --commit
```

or remove every delegate at once with `--revoke-all --commit`. Revoking takes effect on the next
block. It does **not** touch a single NFT already minted — those belong to the players.

---

## Step 2 — Set the environment on Render

Add these to the backend service. **Add `CHIK_NFT_MINT` LAST** — the others are inert without it.

| Key | Value |
|---|---|
| `NFT_COLLECTION` | `2iyJEoY5mUnBXJ139R5mQSkfQtgzZXTP4BtnQaiGEgTN` |
| `NFT_MINT_DELEGATE_SECRET` | the contents of the mint delegate's `authority.json` (the `[12,34,…]` array) |
| `NFT_META_BASE` | your backend's public origin, e.g. `https://chiki-backend.onrender.com` — no trailing slash |
| `NFT_ROYALTY_BPS` | `2000` |
| `NFT_ROYALTY_WALLET` | `CmY2ZXVPVG2gbAHeVWHw7PQrAKtTcrWsq2raaWgg8YJ9` |
| `CHIK_NFT_MINT` | `1` — **last, and not until step 3 has passed on devnet** |

`NFT_MINT_DELEGATE_SECRET` is a secret and is treated as one: it is read from the environment only,
never written to the repo, never logged, and never placed in any response body. The server logs and
publishes only its **public** half.

Optional, all safe to leave unset: `NFT_IMAGE_BASE` (per-species artwork for the metadata `image`;
omitted rather than guessed if unset), `NFT_EXPLORER_BASE` (defaults to Solscan),
`NFT_PENDING_TTL_MS` (defaults to 10 minutes), `NFT_MINT_PAUSED=1` (pause new mints without turning
the feature off).

**Do not set `NFT_MINT_ORIGINS`.** It defaults to `hatched`, which is what confines minting to
creatures the server itself witnessed being born. Widening it to `legacy` or `unverified` would let
players certify creatures that were never verified — exactly what the certificate is supposed to
rule out.

**Deploy the client first, or at the same time.** An old client simply never asks about minting and
is unaffected; a new client against an old backend shows the "certification opens soon" plaque
rather than a broken button.

Once deployed, check:

```
GET https://<your-backend>/assets/nft/config
```

* `"ready": true` means a collection **and** an authority are both configured. If it is `false`,
  minting refuses politely and nothing else in the game is affected.
* `"mintAuthority"` must equal the mint-delegate's public key.
* The boot log shows one line:
  `◆ NFT minting ON — model=server-mints collection=2iyJEoY5… authority=<public key>`

---

## Step 3 — Devnet first. One creature. Do not skip this.

**This is the only step that has never been run, and it is the step that proves the design.**
Everything in this codebase is verified against a stubbed chain. What no test here can establish is
whether Solana's Core program accepts a *collection `UpdateDelegate`* as the signing authority on a
`CreateV2` that names that collection. Step 3 is that proof. If it fails, nothing is lost: no player
has seen the feature, and the fix is to grant the delegate differently, not to change the game.

1. Make a **devnet copy** of the collection with the tooling already here:
   ```bash
   node create_collection.mjs --keypair ./team-authority.json --rpc https://api.devnet.solana.com --commit
   ```
   Note the devnet collection address it prints.
2. Fund the mint delegate with devnet SOL (`solana airdrop 2 <MINT_DELEGATE_PUBKEY> --url devnet`).
3. Grant the delegate on the devnet collection:
   ```bash
   node grant_mint_delegate.mjs --keypair ./team-authority.json --collection <DEVNET_COLLECTION> \
        --delegate <MINT_DELEGATE_PUBKEY> --rpc https://api.devnet.solana.com --commit
   ```
4. Point a **staging** backend at devnet: `NETWORK=devnet`, `RPC_URL=<your devnet RPC>`,
   `NFT_COLLECTION=<DEVNET_COLLECTION>`, `CHIK_NFT_MINT=1`.
5. With a **test wallet**, mint exactly one creature in-game. Then check, on chain, all four:
   * the asset exists and its **owner is the test wallet** (not the server, not the team wallet)
   * its **collection** is the devnet collection
   * its **royalty is 20%**, inherited — the asset itself must carry **no** Royalties plugin of its
     own (an asset-level one would override the collection's and make it royalty-free on resale)
   * its **Attributes** carry `registryId / species / kind / origin / edition / born / hatcher`
6. Tap Mint again on the same creature. You must get the **same address back**, and no second asset.

Only when all six are true, set `CHIK_NFT_MINT=1` on the real backend and mint **one** real creature
of your own. Check the same four things on mainnet before telling anyone.

---

## Step 4 — Claim the collection on Magic Eden

Marketplaces index a collection only once it has members. Until your first real mint in step 3, there
is nothing for Magic Eden to see.

1. After that first mainnet mint, open Magic Eden **Creator Hub**.
2. Connect with the **TEAM wallet** `CmY2ZXVPVG2gbAHeVWHw7PQrAKtTcrWsq2raaWgg8YJ9` — the collection's
   update authority. That is what proves ownership.
3. Claim `2iyJEoY5mUnBXJ139R5mQSkfQtgzZXTP4BtnQaiGEgTN`, set the banner and description, and confirm
   the royalty reads 20% to the team wallet.

Every asset the game mints from then on lands in the claimed collection automatically.

---

## Step 5 — Rollback

| Situation | What to do | Effect |
|---|---|---|
| Something looks wrong, stop everything | `CHIK_NFT_MINT=0` on Render | every `/assets/nft/*` route answers "minting is not open" instantly; the game is byte-for-byte what it was before the feature — proven, not assumed |
| Pause new mints but keep reconciling ownership | `NFT_MINT_PAUSED=1` | no new certificates; already-minted ones keep tracking their on-chain owner |
| Take the authority away completely | `grant_mint_delegate.mjs … --revoke --commit` | the server can no longer create anything in the collection, whatever its env says |
| Suspect the server key leaked | revoke **first**, then `CHIK_NFT_MINT=0`, then make a new delegate wallet and redo step 1 | the leaked key can mint into nothing; already-minted player NFTs are untouched |

**Nothing in this list ever deletes a player's NFT.** A minted asset belongs to the player's wallet.
The only thing that retires one is a real on-chain burn by its owner, and the server records that
permanently — a burned creature stays retired across restarts and can never be re-minted or
re-counted.

---

## What was verified before this document was written

All of it against the real `server.js` booted in-process with a throwaway keypair, a dead RPC, a
memory store and a fully stubbed chain. No key, no mainnet, no devnet was touched: the only hosts any
run contacted were `127.0.0.1`.

**Attacks that were tried and refused** (`_adv_nftgo_sim.mjs`, 96 assertions, 0 failures):

* minting a creature you do not own, with no token, and with a forged token — 403, and **zero**
  creates reached the chain
* minting a normal chikimon, an avatar, an egg — 403 each
* minting a creature whose origin is `legacy`, `unverified`, `issued`, `purchased` or `traded` — 403
  each. Only a birth the server itself witnessed can be certified
* minting a creature that a **crafted save talked the server into calling "hatched"** — 403
  `no-lineage`. See "The exploit found in the second audit" below
* minting twice, four times, and three times *concurrently* — one address, one create, one
  `minted_onchain` record. Two mints of a virgin creature fired together produce exactly one asset
* reporting an address that is a real Core asset **in a different collection** — 400, refused
* reporting a Core asset owned by **someone else** — 403
* reporting a legacy Metaplex NFT, a Token-2022/fungible token, a compressed NFT, and a burnt asset
  — 400/400/400/409. None of them can become a certificate
* using **one** on-chain asset as the certificate for **two** creatures — 409
* minting a creature that was burned on chain — 409, and it is still burned after a full
  save-and-restart round trip (the census goes *down*, never back up)
* a flagged creature — 409

**Things that were proven, not argued:**

* **A certificate is not a creature.** `/world/rarity` is byte-identical across a mint (5,320 bytes,
  same numbers). The control in the same run shows the endpoint genuinely moves when a creature is
  *born* (total 19 → 20, pepe remaining 25 → 24) and moves back when one is *burned* (20 → 19) — so
  the byte-equality means something.
* **Flag off is byte-identical to what is deployed today** (`_adv_nftoff_sim.mjs`, 27 assertions).
  The current `git HEAD` server and the new one were booted side by side, both with `CHIK_NFT_MINT=0`
  and with every new NFT variable deliberately set, and their raw bytes compared: all four
  `/assets/nft/*` routes, the new `/assets/nft/meta/` path (404, identical), `/assets/mine` card keys
  (`born,id,kind,lvl,origin,sp,state` — no mint keys leak), `/assets/cert`, `/stats`, `/health`,
  `/world/rarity`, `/assets/dex`, `/leaderboard`, `/world/roster`, `/world/feed`, `/assets/summary`,
  and the save/restore round trip including a hostile blob carrying NFT fields.
* **The Metaplex SDK is genuinely lazy.** The server was booted with `@metaplex-foundation` deleted
  from `node_modules`: it starts and serves `/health` 200 both flag-off and flag-on. Only an actual
  mint needs the SDK.
* **No secret reaches any response.** With `RPC_URL` set to a canary string and `CLIENT_RPC` unset,
  twelve responses (including the mint reply and the new metadata route) carry zero bytes of the RPC
  URL, the delegate secret or the treasury secret, and `/stats.clientRpc` is `""`.
* **No delegate is no mint.** With `NFT_MINT_DELEGATE_SECRET` removed, a mint is `503 "minting is not
  configured"`, **nothing is reserved** (no address, no edition), `/assets/nft/config` reports
  `ready:false`, and `/health` is still 200.
* Regression, unchanged: 15 economy/netcode suites — `asset_audit` 26, `asset_forge` 36,
  `asset_perimeter` 55, `census` 44, `census_consolidation` 51, `critical_econ` 10, `market` 8,
  `market_griefing` 12, `econ` 16, `mmo_sync` 29, `pvp_live` 19, `party` 40, `gather_authority` 24,
  `delta_snapshot` 15, `presence_auth` 8 — **393 assertions, 0 failures**. Client: `dev_scriptcheck`
  `bad=0 checked=403`, `dev_hudfit` phone `offscreen=0 overlaps=0 small=0`, `dev_nftmint` desktop
  61/0 and phone 64/0 with 0 errors and 0 live-backend calls.

**Re-verified independently on 2026-08-05**, from scratch and on fresh ports, by a second pass that
did not trust the numbers above. Every sim above was re-run (`_adv_nftgo` 96/0, `_adv_nftoff` 27/0,
`_nft_servermint` 74/0, `_nft_realshape` 14/0, `_nft_unconfigured` 8/0, `_nft_offdiff2` 19/0,
`_nft_offdiff` 13/0, `_nft_mint` 52/0, `_av_nft_attack` 31/0) and two new ones written
(`_ax_nftmint_sim.mjs` **121/0**, `_ax_nftlaunder_sim.mjs` **27/0**). The regression subset re-ran at
the tallies printed above. `dev_scriptcheck bad=0 checked=403`; `dev_hudfit` phone
`offscreen=0 overlaps=0 small=0`. Dev and the deploy mirror are `cmp`-identical and both pass
`node --check`. No key, no mainnet and no devnet was touched: across every run log the only hosts
that appear are `127.0.0.1` and the two marketplace/explorer URLs the server puts in a reply as text,
and the string `NFT_MINT_DELEGATE_SECRET` appears exactly once — as the *name* in the fail-closed
error message, never as a value.

---

## The exploit found in the second audit — and closed

**A crafted save could put an invented creature into the official collection.**

The mint only accepts creatures whose origin is `hatched`, because that was supposed to mean "the
server watched this one be born". It did not. Two completely different pieces of code write that
same word:

* the **real** hatch — a player's egg, registered and timed by this server, is consumed and the
  creature it becomes is permanently linked back to that egg;
* an **inference** — the ledger looks at a save, sees "you said you had an egg, now you say you do
  not, and here is a new creature", and writes `hatched` on the strength of the player's own save
  file. The save is authored by the browser, and the browser is the player's to modify.

The second kind reached the mint. Attack, measured end to end (`_ax_nftlaunder_sim.mjs`, run of
2026-08-05, log `launder1.log`): a brand-new throwaway wallet pushes a save that simply *declares* it
holds a legendary egg; waits out the 12-hour incubation the server enforces; pushes a second save in
which the egg is gone and a level-50 **Galador** has appeared; syncs, and taps Mint. Result **before
the fix**: `200 OK`, `Galador #1`, a real Core asset in collection `2iyJEoY5…` at 20% royalty, with
`origin=hatched` written permanently into its on-chain Attributes. Declaring all four egg kinds at
once produced **four** certified legendaries from one free wallet in one cycle, and the same trick on
the mount path certified a **griffin** — the rarest asset in the game, capped at five. Six forged
certificates in a single run. The cost was wall-clock time and nothing else: no purchase, no roll, no
server-side event.

**The fix.** A real hatch always leaves the consumed egg's row id on the creature, and nothing a
client can reach can set that field; the ledger-adopted rows have no such link and instead carry the
ledger's own key. The mint now requires the link. After the fix the same attack answers
`403 "only a creature this server hatched from a registered egg can be certified"`, with **zero**
creates reaching the chain and nothing written on the row — while both honest routes still mint on
the first try (`Galador #1` from the server-rolled hatch, `Adalor #1` from the paid-egg hatch where
the player chose the species). 27 assertions, 0 failures.

**What this means for you as owner:** a player whose only record of a creature is their own save file
cannot certify it. That is deliberate. Nothing is taken away from them — the creature stays in their
game exactly as before — but a certificate is forever and on chain, so it is issued only where the
server holds its own evidence. The feature has never shipped, so no player loses something they
already had.

### A second defect was found and fixed in the first audit

**A reader outage could mint a second NFT for the same creature.** When the server submits a mint it
first writes down the address it is about to use, so a crash mid-flight cannot produce two. On the
retry it asked the on-chain reader "did that land?" — but it treated *"the reader says that account
does not exist"* and *"the reader could not answer"* as the same answer. If a mint really did land
and the reader was merely down for ten minutes across a restart, the server abandoned the good
address and minted a **second** asset: two certificates on one creature, one of them an orphan in the
player's wallet, and double the rent. Measured: reader down + past the timeout + a restart = **2**
creates for one creature. Now the reservation is only ever recycled when the reader has actually
**answered** that the account is not there; an outage holds it and says "still confirming". Re-measured
at **1** create, with the honest paths intact — a genuinely-failed submit still recycles (and reuses
its reserved edition number, so the series has no holes), and a slow reader catching up still promotes
the original address instead of minting again.

### Known limitations, stated plainly

* **The devnet proof in step 3 has never been run.** Whether a collection `UpdateDelegate` may sign a
  member create is the one load-bearing fact that only the chain can settle. Do step 3.
* **A creature listed for sale on the in-game board can still be minted.** The check meant to prevent
  it compares the listing's `uid` against the registry id, and the listing row does not store a `uid`
  at all — so the check never matches. Measured: listed on the board, `mintable` still `true`, mint
  `200`. This is not a way to get two creatures or two certificates; the risk is only that a player
  certifies a creature and then sells it in-game, and in-game sales do not move registry ownership
  today anyway. Worth closing when the board and the registry share an id, and not before — a
  species-level guess would falsely refuse a player who owns two of the same species.
* **`reconcileMemeOwners` still validates a new on-chain owner with a bare public-key check**, which
  accepts a marketplace escrow address as if it were a buyer. It is a separate, older path (the Meme
  Dynasty on-chain trading mode, `MEME_TRADE_TENSOR`) and the NFT mint does not feed it, but it
  should adopt the same classifier the mint path uses before that trading mode is ever switched on.
* **Minting is also gated by the material kill switch.** Setting `CHIK_MAT_ENFORCE=0` closes minting
  as a side effect. `NFT_MINT_PAUSED=1` is the lever intended for pausing mints.
