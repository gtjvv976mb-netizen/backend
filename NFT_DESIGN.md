# NFT_DESIGN.md — Chikoria Realm WNS Mint (Improved Spec, v2)

**Status:** design document only. Nothing here is implemented until the gate in §6 is walked in
order. Ships entirely behind `CHIK_NFT_MINT=0`; the user flips it deliberately.

**Provenance of this spec:** merges the original plan with (a) transferable-lesson research from
shipped blockchain games ("L1"–"L11" below) and (b) the adversarial design audit of 2026-07-31
("F1"–"F12"), whose findings were proven against the real `server.js` in-process
(`nftmint_escrow_sim.mjs` 32/32, `nftmint_registry_sim.mjs` 48/48, plus a real-Godot
`edition_probe.gd`). Every design choice cites its source. Where the audit and the original plan
conflict, the audit wins.

**Terminology.** *Registry* = the server-minted asset ledger in `server.js` (unforgeable ids,
provenance events, transfer-only ownership). *Embodiment* = the creature existing and being
playable in the game world. *Holder* = whatever the chain says currently holds the token.
Authority rule, stated once and used everywhere (F11): **the chain is authoritative for
ownership; the server is authoritative for embodiment.** A chain read never destroys registry
state — it only proposes a handover that the server applies at a safe boundary.

---

## 1) Player story — why mint (plain language, marketing-safe)

> **Your creature, provable forever.**
> The legendary you hatched is already yours in Chikoria. Minting takes it one step further: it
> becomes a collectible token in your own wallet — with its full history attached. When it
> hatched, who hatched it, its edition number, its whole story — written down where anyone can
> check it, forever.
>
> Minting is completely optional. A minted creature plays exactly the same as an unminted one —
> same stats, same odds, same everything. What you get is ownership you can hold in your own
> hands: show it off outside the game, gift it wallet-to-wallet, or trade it at the Trading Post.
> And if it ever changes hands, its story goes with it — every future owner can see it was hatched
> by you.

Rules baked into this copy, and binding on all future player-facing copy:

- **The value story is provenance and permanence, never price** (L7 — the Top Shot/Dapper ruling
  turned on marketing that fostered profit expectation; L11 — the intrinsic "truly own the thing
  you earned" story is the one that survived the cycle). No price talk, no floors, no "value," no
  roadmap-appreciation hints, no chart/rocket emoji, in any surface including the News tab and
  Dispatch. This extends the existing no-"invest" rule to tone and emoji.
- **Minting is optional and off the gameplay path** (L3 — Gods Unchained's earn-then-mint Forge;
  L8 — Parallel had to invent Echoes because NFTs gated play). Minted status never grants stats,
  odds, gathering speed, or any advantage. This is codified in §5.
- **The provenance ledger is the product** (L11): the NFT metadata and the in-game display pane
  surface the registry's provenance event history (hatched/legacy, dates, transfers).
- **We sell what exists, never what's promised** (L6 — Star Atlas/Illuvium presales). Only
  already-earned, registry-authentic assets mint. The five lore-beacon "coming soon" landmarks and
  any unreleased content are permanently out of scope for primary NFT sales.
- **Honesty clause** (F6): listing copy must state — *"provenance is permanent; in-game privileges
  are not, and can be restricted if the record is later contradicted."*
- **Copy debt to clear before launch** (F12 gate item 10, F5): `InfoBar.gd:2064` ("Avatar NFTs and
  the Meme Dynasty — display-only, and proudly so"), `PlayerPanel.gd:1313/1315` ("display only"),
  the hardcoded `"🔒 1/10"` at `PlayerPanel.gd:1428` (wrong for 7 of 10 avatars), and the dead but
  revivable `"Only 10 of each avatar will EVER exist."` at `Onboarding.gd:567` + the live comment
  at `Onboarding.gd:11`. All must be rewritten/corrected **before** `CHIK_NFT_MINT` flips, not
  after — the mint directly reverses a live promise.

---

## 2) Eligibility & gating

An asset is mintable iff **all** of the following hold, checked server-side at the mint gate:

| # | Rule | Source |
|---|---|---|
| E1 | Registry-authentic: provenance `hatched` or `legacy-verified`; `origin !== "unverified"` | original plan; F10 |
| E2 | Unflagged, and `gameStatus === "good"` at mint time (see §4.4) | original plan; F6 |
| E3 | Owned by the calling wallet **per the registry row**, `row.state === "active"`, and **not** `row.listedOffchain`, **not** listed on the in-game board, **not** `pendingHandover` | F1, F2, F4 |
| E4 | Not already minted: `row.mint` unset. A retry with the same fee signature returns `{ok:true, already:true}` (idempotent), never a second mint | original plan; F7, F12 |
| E5 | Caller is session-authenticated the same way the market is: `mktToken` bound at `/verify` (sidOwner net_id→wallet). No unauthenticated mint or reveal endpoints — this also fixes the pre-existing `/meme/hatched` hole (F9) | F9; economy-settlement hardening |
| E6 | **Rarity/achievement gate:** mintable kinds are legendary, Meme Dynasty, and mounts; normal chikimon only above a level/BR threshold (exact threshold = open decision D4) | F10 — otherwise a $CHIKI-only fee lets a player mint every drolax ever hatched |
| E7 | Supply caps enforced **at issuance/mint, never inside `transferAsset`** (a transfer is not an issuance) | F5 |
| E8 | Meme Dynasty caps: `memeIssued = memeMinted + memeRegistryCount` stays the single formula; a WNS mint of a registry-born creature must **not** write a `memeHatches` row, or the species shuts down at half cap | F5 (double-count hazard) |
| E9 | Avatar NFTs: **blocked entirely** until `AVATAR_SUPPLY` moves server-side and over-issuance is resolved. Proven state: chemist 28 issued vs advertised 5, Mystic 20/10, night 21/10, Star 24/20 — an avatar NFT minted today is an on-chain lie | F5 |
| E10 | Edition numbers are **server-issued and sequential** (`row.edition = ++issued[sp]`, persisted, refused past cap). The client-side handle-hash edition (`Profile.gd:1050-1061`) is display-only legacy: proven to collide (4/12) and to be re-rollable by renaming (chemist #1/5 in 3 tries; `handle` not in `_econ_sig`). Client reads the server number, shows "—" when absent. Never mint a client-computed edition | F5 |
| E11 | Mint refused whenever `CHIK_MAT_ENFORCE=0` — the same kill switch that makes eggs free must also close the mint gate, or free-egg mode becomes a free-NFT mode | F10 |
| E12 | The mintable set is closed: only registry assets that already exist. **No mechanic may ever let an NFT produce another mintable asset** (egg-from-NFT, fusion output, breeding) unless the input is burned in the registry first | L1 — Axie's breeding supply bomb |

The only supply promises the server actually enforces today — and therefore the only ones safe to
mint against on day one — are the Meme Dynasty caps (pepe 25, popcat 20, moodeng 20, doge 15,
chillguy 15, alon 10, total 105; `Econ.gd:482` ≡ `server.js:785`) (F5).

---

## 3) The mint transaction

**Standard: WNS (Wen New Standard, Token-2022-based).** Chosen because its transfer hook enforces
royalties at the protocol level — the exact failure of the 2022 Solana royalty wars, where every
marketplace made royalties optional (L5). Two caveats the choice carries, both binding:

- **The hook cuts both ways:** a wallet/marketplace that doesn't implement it can't transfer the
  token at all, and WNS adoption is far narrower than Metaplex. Venue support (Tensor, Magic Eden)
  is **MEDIUM confidence and must be probed, not assumed** — real devnet→mainnet list/buy/send
  flows per venue before any player-facing copy names a venue. Fallback copy: "Trading Post +
  wallet-to-wallet" only (L5; §6).
- **Royalty income is budgeted as zero** (L5). Any royalties that do arrive route to the reward
  pool wallet, not treasury revenue (F10).

**Custody and signing (F12 — verified clean in the audit):**

- The mint transaction is **assembled and signed server-side** by the treasury.
  `TREASURY_SECRET` stays in server env only — never in code, responses, or reports.
- The player signs **only** the $CHIKI fee transfer, plus paying the SOL rent for their own token
  account. Fee verification reuses the proven `verifyEggPayment` shape (signer check + pre/post
  token-balance deltas + treasury receipt, `server.js:820-841`).
- **Idempotency:** reuse `memeUsedSigs`'s claim-before-await TOCTOU pattern (`server.js:2680`):
  claim the fee signature **before the first `await`**, release only on verified failure, store
  the resulting mint address on the row, and make retries return `{ok:true, already:true}` —
  exactly the `/meme/minted` shape (`server.js:2760`). Charge-only-on-success is preserved: a
  failed mint releases the claim and the fee is not consumed (or is refunded via the same path).

**The fee is a burn, and it is a lever:**

- **Burn, not treasury revenue** (F10): every creature that trades on an external venue settles in
  SOL and skips the Trading Post's 75/20/5 seller/pool/burn split — 5% never burned, 20% never
  returned to the pool. The mint fee is the one moment the game can recapture a sink for
  externally-tradeable assets, so it burns $CHIKI, sized with that lost sink in mind (amount =
  open decision D3).
- **The fee is only a sink because minting is not a production loop** (L4 — STEPN's mint "sink"
  was actually a profit loop because each mint created a new earning asset). Chikoria's mint
  outputs zero new earning capacity — the creature already exists and grants no yield. This
  invariant is load-bearing for the whole economy and is restated in §5.
- **Server-config, not hardcoded** (L4's one good STEPN idea; L10): fee amount, eligible kinds,
  and thresholds are env/config values tunable without a deploy.

**Persistence — hard prerequisite (F7, gate item 1):**

- `restoreAssetReg` (`server.js:5422-5447`) rebuilds a fixed object literal and **silently drops**
  any field it does not name — a `mint` field is proven to vanish on the first restart while the
  `minted_onchain` event survives, leaving a live NFT pointing at nothing. `restoreAssetReg` must
  learn the field **in the same commit** that introduces it, with validation: `isPubkey(mint)`,
  one mint per row, never overwritten once set.
- Rows carrying a `mint` are **exempt from truncation**: `serializeAssetReg`'s
  `.slice(-ASSET_REG_MAX)` currently drops the *earliest* rows at capacity — i.e. the first-minted.
- `DATABASE_URL` provisioned before flip: the memory store loses the registry every deploy.
- Each mint appends `regEvent(row, "minted_onchain", {addr})` to the provenance chain, which the
  metadata/display pane surfaces (L11).

**Metadata:** immutable attributes = registry id, species, `origin` (hatched/legacy — permanent,
F6), server-issued edition, hatch date/hatcher. Mutable, served live off the cert URI =
`gameStatus` (§4.4). Collection-level royalty configured in the WNS hook, paid to the pool wallet.

---

## 4) Reconciliation rules

The original plan's one-liner — "read the holder; if it moved, transfer the creature" — is the
sharpest thing the audit broke, and it is **already live with these bugs** for the Meme Dynasty at
`server.js:889 reconcileMemeOwners` (validates with bare `isPubkey`, which accepts a Magic Eden
escrow PDA; proven to delete a seller's creature *for merely listing it*, and to enable free
duplication via list-then-cancel — F1/F1b). The registry `transferAsset` path
(`server.js:4903-4917`) has the identical hole. The replacement is below; the same rules apply to
`reconcileMemeOwners`, which must be repaired to match even if the WNS mint never ships.

**Mechanics (F11):** reconciliation runs on sign-in and on a poll. Reads use **finalized**
commitment; a grant requires the **same holder across two consecutive reads** plus a minimum
dwell (`row.holderSince`) — this closes the attacker-triggerable flash-hold window
(`/meme/mine` forces a reconcile at >60s stale, `server.js:2713`). The `dasOwner` fetch gets a
timeout and the loop is parallelized/batched so one slow RPC cannot stall all reconciliation.
`_dasUnsupported` (declared, never set — dead) is either wired as a hard-stop on DAS failure or
deleted (open decision D6). A player cannot spoof the read (`RPC_URL` is server-side — F11 pass),
and reconciliation **keeps running while minting is paused** (L10; §6).

### 4.1 Decision table — holder classification (F1, L2)

Never act on a raw `ownership.owner`. Classify first:

| Observed holder | Classification | Action |
|---|---|---|
| Same wallet as `row.owner` | No change | Refresh `holderSince`; clear `listedOffchain` **only** on this branch |
| Off-curve address (`!PublicKey.isOnCurve`) or on marketplace-program denylist | **Escrow/program — not a holder** (L2: Magic Eden v2 escrow, staking contracts) | `row.listedOffchain = true`; **owner unchanged**; in-game label "Listed on <venue>"; asset frozen in-game (§4.2). `listed` is *set* by this read, **never cleared** by it (F1b) |
| Frozen + delegated (WNS/Token-2022 delegate-and-freeze listing) | **Listed, still yours** — preferred listing shape (F1 fix 2) | Same as above: mark listed, owner unchanged |
| On-curve wallet, verified game account, ≥2 consecutive finalized reads + dwell | **Real transfer** | Queue `pendingHandover` (§4.3) via the transfer-only registry path |
| On-curve wallet, **no game account** | **Limbo/held** (L2 state 3) | Registry owner becomes the new wallet but the creature is **dormant** ("held — awaiting a verified owner"); embodies when that wallet verifies. Never auto-deleted |
| Token burned | Open decision **D5**: retire the creature (provenance event `burned`, permanent memorial in dex) vs restore to last verified owner | Until decided: dormant + flagged for manual review; **never silent deletion** |
| DAS read fails / times out | Unknown | **No state change ever** on a failed read |

**Caps count listed assets:** `memeOwnedActive` and every cap include `listed` rows, so listing can
never free a hatch slot — this is the F1b duplication exploit (list → cap frees → hatch a second →
cancel → two Meme Legendaries), closed at the counting layer.

### 4.2 Decision table — the registry as negative authority (F2)

Today the registry only ever GRANTS (`regVouchesSpecies` fallback; `if (!lrec) return ""`
grandfather at `server.js:6648`) — proven to allow a real-money cross-venue double sale twice.
Inverted: **once an asset carries a `mint`, the registry is the only authority for it.**

| In-game action on a minted asset | Allowed iff |
|---|---|
| List on Trading Post | `assetReg.get(assetId).owner === seller && !row.listedOffchain && row.state === "active" && !row.pendingHandover` |
| Listing identity | Carries the **registry id**. A listing without one is refused (also closes F6's uid-omission bypass) |
| Species-fallback vouch | **Disabled** for any species the wallet holds a minted row of |
| Sale settles | Registry row transfers atomically with settlement; on-chain and in-game boards can never both believe the seller owns it |

### 4.3 Decision table — mid-session handover (F4)

Today nothing can take an asset back (`_stamp_unit_ids` is additive-only; `_adopt_stable`'s
superset guard returns early) — a Tensor sale leaves the seller playing the creature forever. The
mint design is the thing that *requires* a taking path, so it must be **queued and boundaried,
never a live yank**:

| Situation at reconcile time | When the handover applies | Player-facing |
|---|---|---|
| Seller online, idle | Next safe boundary (seconds) | Banner "Sold on <venue> — <name> leaves your party", then departure toast |
| Seller in battle / PvP | Battle end. Battles snapshot the roster at match start, so a handover cannot desync an in-flight match | Persistent banner during battle |
| Seller mid-gather or towing an egg | After the gather completes / the egg is safe | Same banner |
| Seller offline | At next load, **before the roster is drawn** — never mid-frame | Departure notice on load |
| Buyer side | Next sign-in | "Welcome" card with the creature's provenance story |

Server marks `row.pendingHandover = {to, at}` on the qualifying read; `transferAsset` itself stays
session-blind (it gains an emitted event, but boundary logic lives in the handover queue, not in
the transfer primitive).

### 4.4 Decision table — duplicates and flags

**One-of-each-species collision (F3, L2 state 4).** Proven today: a buyer who already owns the
species gets a silent no-op client-side (`Profile.gd:1525` `if owns(sp): return`) and a silent
server-side leak — 2 registry rows, 1 playable card (`/assets/chikimon/sync` dedupes by `sp` at
`server.js:5236`), 2 edition slots burned. The buyer paid for a token that is unreachable in-game.

**Decision: option (a) — the token is the creature, not the species** (audit-recommended, adopted).
Minted assets are exempt from species-uniqueness; the one-of-each rule survives only at
hatch/roll **issuance**. Requires: `_stamp_unit_ids` keys on registry id, not species;
`/assets/chikimon/sync` stops deduping minted rows by `sp`. Chosen over (b) refuse-at-purchase
because a `can-receive` endpoint cannot bind Tensor — an external buy would still strand the token.
Belt-and-braces: the in-game Trading Post *additionally* surfaces "you already own this species"
before purchase, as information, not a block.

| Duplicate/flag situation | Rule |
|---|---|
| Buyer already owns the species (minted asset arriving) | Both embodied — the minted copy is a distinct creature keyed by registry id |
| Any asset reconciliation cannot embody, for any reason | **Never dropped on the floor**: parked as an owned-but-dormant "vault" card with a visible reason (F3) |
| Asset flagged after mint | `origin` on-chain is immutable; `/assets/cert` gains `gameStatus: "good" \| "restricted"` + reason + timestamp, served live off the cert URI (F6). In-game privileges may be restricted; the token is never confiscated |
| Ledger vs registry disagree on a **minted** asset | Registry authoritative; the per-uid ledger verdict becomes advisory (F6 — proven divergence: ledger 409'd a creature the registry vouched for, and the block was bypassable by omitting `uid`) |
| Flags at the mint gate | Flagged/`restricted` assets simply **can't mint** (E2) — flagging stays "flags, never rejects" for unminted assets per the authenticity-ledger design |

---

## 5) Economy safeguards

1. **No new token, no yield surface, no habitat prerequisite** (L9 — Genopets/Aurory complexity
   collapse). $CHIKI-only fee. Minted NFTs never stake, never earn, never gate anything.
2. **NFTs never grant gameplay power** (L8; F12 copy audit): no stats, odds, gathering, or drop
   advantages, codified as a permanent invariant so late joiners are never priced out and the
   STEPN mint-to-earn loop (L4) can never form.
3. **NFTs never create assets** (L1, E12): mint gate tokenizes existing registry assets only.
4. **Mint fee = burn** (F10), tunable server-side (L4/L10), sized against the 5%-burn/20%-pool
   sink lost to external venues; royalties → pool wallet.
5. **Rarity gate on mintables** (E6/F10) bounds registry growth on top of the existing bounds
   (`ASSET_REG_MAX = 400000`, real egg material costs).
6. **No durability/repair-style sinks imported** (non-transferable STEPN lesson): with no earnings
   stream per NFT, such sinks are pure friction with no economic function.
7. **No material hole** (F10, confirmed): chikimon stay outside `OWN_KINDS`, so external sales
   create no essence/crystal accounting gap.
8. **Meme egg reservation fix ships first** (F8, pre-existing): `/meme/hatch` reserves only
   against the 105 total while `pickMeme()` rolls later against per-character caps — proven to
   strand a paid 1,000,000-$CHIKI egg forever with no refund. Fix: roll/reserve the character at
   purchase (server-side, mystery to the client) or reserve a per-character slot atomically, plus
   a refund/reroll path for any unfillable reveal. Under the mint this bug graduates from bad to
   intolerable because caps fill faster from two doors.
9. **`/meme/hatched` authenticated, hatch ids off the public `/meme/mine`** (F9): otherwise
   forced reveals become a cap-timing weapon against `pickMeme()`.
10. **Never presell** (L6): no primary NFT sales of unreleased content, ever. Minting is a
    retention/ownership feature, not a revenue pillar; primary-sale revenue is one-time and
    front-loads expectations the game must then outrun.
11. **Regulatory posture** (L7): collectible/ownership framing only; external venues are kept
    *because* an issuer-controlled-only market is a Howey factor — the in-game Trading Post must
    not be the sole venue; no revenue-share or staking-yield shapes, ever.

---

## 6) Rollout plan

Ordered gate — each step blocks the next. Items 1–3 are the audit's own top order (silent total
loss, real-money double sale, creature deletion).

| # | Gate item | Exit criterion |
|---|---|---|
| 1 | **F7** persistence: `restoreAssetReg` carries `mint` (validated, write-once), mint rows exempt from truncation, `DATABASE_URL` provisioned | Serialize→restore round-trip sim keeps the address; restart drill on Render staging |
| 2 | **F2** registry as negative authority for minted assets; listings carry registry id | `nftmint_registry_sim.mjs` extended: both proven double-sale sequences now refuse (409) |
| 3 | **F1/F1b** holder classification (§4.1) in both `reconcileMemeOwners` and the registry path | `nftmint_escrow_sim.mjs` extended: list→reconcile keeps the creature; list-then-cancel cannot yield 2 actives |
| 4 | **F3** duplicate-species rule (§4.4 option a) implemented and published in listing copy | Sim: transfer-to-owner-of-species embodies 2 creatures; sync returns 2 cards |
| 5 | **F5** server-side `AVATAR_SUPPLY` + sequential server editions; over-issuance resolution decided (D2) | Avatar mint stays blocked (E9) until D2 resolved |
| 6 | **F4** queued handover + roster snapshot in battles | Sim: mid-battle transfer applies only at battle end; offline case applies at load |
| 7 | **F6** `gameStatus` on cert; uid-omission bypass closed | Cert shows live status; uid-less listing of minted asset refuses |
| 8 | **F8/F9** meme reservation + reveal auth (pre-existing; fix regardless of mint) | Paid egg can always reveal or refund; unauthenticated reveal 403s |
| 9 | **F10** burn fee wired, rarity gate, `CHIK_MAT_ENFORCE=0` refusal | Fee sim shows burn receipt; mint 403s with enforcement off |
| 10 | **F12** copy rewrite (InfoBar/PlayerPanel/Onboarding, §1) | Shipped in a client build before flip |
| 11 | **Devnet dry-run** of the two unproven hypotheses, explicitly labelled unverified until run: (a) Helius DAS `getAsset` returns a usable `ownership.owner` for a **WNS/Token-2022** asset at all — the entire reconcile depends on it; (b) whether Tensor's WNS flow uses escrow or delegate-and-freeze — §4.1 handles both, but which applies is unknown. Plus per-venue list/buy/wallet-send probes (L5) | Written probe results; venue names appear in player copy only for venues that passed |
| 12 | **Load/abuse sims** re-run end-to-end: escrow sim, registry sim, market fuzzer, economy sim, plus a new mint-idempotency fuzzer (double-submit, mid-mint crash, fee-sig replay) | All green with printed actual values |
| 13 | **Flip** `CHIK_NFT_MINT=1` — after the user signs off the open decisions below | — |

**The OFF switch (L10 — Gods Unchained closed and reopened the Forge; mint gates are operable
infrastructure, not immutable promises):** `CHIK_NFT_MINT=0` must be safe to flip mid-flight:

- In-flight mints resolve or refund via the charge-only-on-success path — never charge-and-drop.
- Already-minted tokens keep working: display, transfers, and **reconciliation keep running while
  minting is paused**. Pausing mint must never pause reconciliation, or paused-state trades strand
  ownership.
- All probes against this design use a throwaway keypair, memory store, and dummy RPC — never the
  live backend or any chain (standing rule).

---

## 7) Explicitly rejected alternatives

| Rejected | Why | Source |
|---|---|---|
| Breeding / NFT-creates-NFT mechanics (egg-from-NFT, fusion outputs) | Supply bomb: Axie's breeding + uncapped SLP ended in ~99% token collapse and emergency emission cuts | L1 |
| Reconciliation as written in the original plan ("if it moved, transfer") | Deletes the creature on listing (escrow PDA read as a holder), certifies programs as owners, enables list-then-cancel duplication — all proven against live code | F1/F1b, L2 |
| Trusting `isPubkey` as holder validation | Accepts off-curve escrow PDAs (proven) | F1 |
| Registry as grant-only authority with species-fallback + no-row grandfather | Enables real-money cross-venue double sales (proven twice) | F2 |
| Silent species-dedupe on receive (status quo `Profile.gd`/sync behavior) | Buyer pays for an unreachable token that burns a cap slot; silent accounting leak | F3 |
| Refuse-at-purchase (`can-receive`) as the *primary* duplicate fix | Cannot bind external venues; token still strands. Kept only as advisory UI in-game | F3 |
| Live mid-session asset yanking | Desyncs battles; no client take-back path exists; needs queued boundaries | F4 |
| Client-computed edition numbers (handle-hash) | Collides (4/12 proven) and re-rolls on rename; `handle` unsigned | F5 |
| Minting avatars at launch | Client-only `AVATAR_SUPPLY` already over-issued 4 of 10 looks (chemist 28/5 proven); the NFT would be an on-chain lie | F5 |
| Metaplex/legacy standard instead of WNS | No protocol-level royalty enforcement — the 2022 royalty wars made marketplace royalties optional everywhere | L5 |
| Budgeting royalties as revenue; promising venues before probing | Royalty income ≈ 0 historically; WNS venue support unverified (MEDIUM confidence) | L5 |
| Primary NFT sales of unreleased content (lore beacons, land-style presales) | Star Atlas/Illuvium: one-time revenue, trust debt, Howey exposure | L6, L7 |
| Price/appreciation marketing, issuer-only marketplace, revenue-share or staking yield on NFTs | The three factors that lost Dapper the Top Shot motion ($4M settlement) | L7 |
| NFT-gated gameplay or minted-stat advantages | Parallel had to invent Echoes to undo exactly this; also reverses the live "display-only: no stat advantage" promise until copy is rewritten honestly | L8, F12 |
| New token, habitat prerequisite, NFT staking layer | Genopets/Aurory complexity-and-yield collapse; single-token simplicity is a feature | L9 |
| Durability/repair/energy sinks on NFTs | STEPN's sinks taxed an earnings stream; Chikoria NFTs have none — pure friction | L4 (non-transfer) |
| Scholarship/rental layer | Arises only when gameplay is NFT-gated; Chikoria gates nothing on NFTs | L2 context |
| Hardcoded mint fee | Fee must be a tunable server-side lever | L4, L10 |
| Fee as treasury revenue | Must be a burn to replace the sink external venues drain | F10 |
| Cap enforcement inside `transferAsset` | A transfer is not an issuance; re-implementing caps there double-counts and blocks legitimate transfers | F5 |
| Immutable "flags reject the token" posture | Token permanence + mutable `gameStatus` is honest; confiscating utility on inference after selling a token is not | F6 |

---

## OPEN DECISIONS — for the user only

- **D1 — Venue promise.** If the devnet probes (gate 11) show Tensor/Magic Eden WNS support is
  weak, do we launch with "Trading Post + wallet-to-wallet" copy only, or delay for venue support?
  (Note L7: at least one external venue is legally valuable.)
- **D2 — Avatar over-issuance.** Chemist 28/5, Mystic 20/10, night 21/10, Star 24/20 already
  issued. Honor everyone and raise the advertised caps? Grandfather existing owners and freeze new
  issuance? Avatars stay unmintable (E9) until you choose.
- **D3 — Mint fee size** (in $CHIKI, burned) and the exact rarity/level threshold defaults. These
  are tuned-by-eye economy values — yours to set, server-config thereafter.
- **D4 — Normal-chikimon mint threshold.** Level/BR floor for minting normals, or legendary/meme/
  mount-only at launch?
- **D5 — Burned-token semantics.** Retire the creature permanently (provenance `burned`, dex
  memorial) or restore embodiment to the last verified owner? (§4.1 holds them dormant until you
  decide.)
- **D6 — DAS hard-stop.** Should a DAS outage hard-stop reconciliation (wire `_dasUnsupported`)
  or degrade to no-op reads? (No-op is safe by §4.1's "failed read changes nothing" rule; hard-stop
  is louder.)
- **D7 — Royalty percentage** on the WNS hook (routes to the pool wallet regardless).
- **D8 — Meme-egg F8 remedy shape.** Roll the character at purchase (server-held mystery) vs
  atomic per-character slot reservation — both close the stranded-egg bug; the first changes when
  RNG happens, which touches player-perceived fairness.
