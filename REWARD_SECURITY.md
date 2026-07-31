# Reward-payout security — READ BEFORE DEPLOY

Quest rewards now pay **real $CHIKI (SPL)** from the reward pool. This document explains why the
old wallet was drained, the fixes in code, and the **two things only you can do** to make it
unhackable: **rotate the key** and run a **hot/cold split**.

---

## 1. Why it was drained (diagnosis)

"Drains all SOL to one address every time the wallet replenishes" is the classic signature of a
**leaked private key + a sweeper bot** — NOT a backend bug. Once a key is exposed, an attacker's bot
watches the address and sweeps every incoming lamport to their own wallet, **completely bypassing
this server**. No server code can stop that; the only cure is a new key the attacker doesn't have.

The current `/quest/claim` and `/claim` are already redirect-safe (the payout destination is always
the *earning* wallet, never a client-chosen address; the amount is always the server ledger). So the
loss came from the key, not the endpoint.

**➡ Treat the old `TREASURY_SECRET` as permanently compromised. Never reuse it.**

---

## 1b. Reward model — race to finish, ADMIN-GATED payout (first 100 winners)

The payout is a **fixed pool split among a capped number of winners**, released by **you**, not auto-sent:

- The **first `WINNER_CAP` (100) wallets** to **complete the whole 7-quest line** are recorded as
  winners, each entitled to `WINNER_REWARD` (**100,000**) $CHIKI. **Hard total = 100 × 100,000 =
  10,000,000 $CHIKI** — the pool can never pay more.
- **No $CHIKI is sent on completion.** Completing the final quest only *reserves a winner slot*. You
  review the list and **release the pool yourself** via an admin-signed batch endpoint — a human
  checkpoint before any token moves (catches obvious scripting/Sybil).
- **Winner slots are reserved ATOMICALLY in Postgres** (`reserveWinner()`): a transaction takes a
  global `pg_advisory_xact_lock`, checks `wallet` (PK) + `COUNT(*) < cap`, and inserts (`rank` UNIQUE).
  This is **cross-instance safe** — a 101st winner is impossible even if Render runs multiple instances.
  Unit-tested: 250 concurrent finishers → exactly 100 winners, unique ranks, total exactly 10,000,000.
- **Winning requires a wallet signature** (`verifyWalletSig` on the final quest) — no anonymous
  curl-to-win — plus **fail-closed eligibility**: the wallet must currently hold `QUEST_MIN_HOLD`
  $CHIKI *and* be aged in (`QUEST_MIN_HOLD_MINUTES`, anti-Sybil), enforced regardless of `VERIFY_HOLDERS`.
- **Payout is idempotent** (`_payoutOne`): each winner is paid **exactly once**. A per-wallet advisory
  lock + a 2-minute in-flight window + **on-chain signature reconciliation** (the sig is recorded
  *before* confirming) mean a confirm-timeout, a retry, or a crash **never double-pays**. Unit-tested.

### Residual risk you should know
The game is **client-authoritative** — the backend can't *prove* someone genuinely played vs. scripted
the completion calls. The wallet signature proves *ownership*, and the hold-time raises Sybil cost, but
a determined actor who owns wallets and holds `QUEST_MIN_HOLD` in each could still script the questline.
**This is exactly why payout is admin-gated:** review `GET /quest/winners` before you release funds.

### Admin runbook — releasing the pool
1. Set `ADMIN_WALLETS` (Render env) to your admin wallet address(es).
2. Fund the hot wallet with up to **10,000,000 $CHIKI** + ~0.05 SOL for fees.
3. Review winners: `GET /quest/winners?adminWallet=<W>&authMsg=<M>&authSig=<S>` (admin-signed) — shows
   rank, wallet, balance-at-win, paid status, and `poolNeededChiki`.
4. Release in small idempotent batches: `POST /quest/payout {adminWallet,authMsg,authSig, max:10}` —
   repeat until `remainingUnpaid` is 0. Pay one wallet with `{...,wallet:"<addr>"}`. Safe to re-run: it
   skips already-paid, reconciles any unconfirmed tx, and never double-sends.

## 2. What the code already enforces (defense in depth)

- **Server-authoritative rewards** — the prize is a **fixed** amount, granted **once per wallet**, only
  after the full questline is completed **in order** with a minimum real-time gap. Hard per-wallet
  ceiling = one prize (`WINNER_REWARD`). The client can't invent a balance.
- **Payout dest = the earner** — `payChiki()` sends to the wallet's own ATA. Never a client param.
- **Amount = server ledger** — never sent by the client.
- **Caps**: per-claim (`PER_CLAIM_CHIKI`), per-wallet-daily (`WALLET_DAILY_CHIKI`), pool reserve
  floor (`POOL_RESERVE_CHIKI`), min claim (`MIN_CLAIM_CHIKI`).
- **Global circuit breaker** (`BREAKER_HOURLY_CHIKI`) — total $CHIKI out across ALL wallets per
  rolling hour is capped; exceed it and every payout returns 503 until the window clears.
- **Write-before-send + per-wallet lock** — the pouch is debited *before* the transfer and a claim
  in flight blocks a second one, so a crash or double-submit can never double-pay.
- **No ATA creation** — we only pay wallets that already hold $CHIKI (guaranteed by the 500k play
  gate), so the treasury never spends rent on arbitrary addresses (a spam/grief vector).

---

## 3. What YOU must do — hot/cold split + key rotation

### a) Make a fresh HOT keypair (the server's signer)
```bash
solana-keygen new --no-bip39-passphrase -o hot.json
solana-keygen pubkey hot.json          # = the new reward-pool address
```
Set its secret as the server env var (Render → Environment), **nowhere else**:
```
TREASURY_SECRET = <contents of hot.json, the [12,34,…] array>
```
Never commit it. `.env` is already gitignored.

### b) Keep a COLD wallet (a hardware wallet / offline keypair) as the vault
- The **cold** wallet holds the BULK of the $CHIKI reward supply. Its key never touches the server.
- The **hot** wallet holds only a **small float** — enough for ~a day or two of payouts.
- Top the hot wallet up from cold **manually** (or via a separate, secured job) as it drains.
- **Result:** if the hot key ever leaks again, the most an attacker can take is the float, not the
  whole pool.

### c) Fund the hot wallet for $CHIKI payouts
Payouts are $CHIKI (SPL), so the hot wallet needs:
1. **$CHIKI tokens** — transfer the daily float of $CHIKI to the hot wallet's associated token
   account for the mint `CPYrgdAYWFQD74ZtsR8mEBWW7qnrXnegcn7gDMobpump`.
2. **A little SOL** — ~0.1 SOL for transaction fees (each payout costs ~0.000005 SOL).

### d) Optional but recommended
- Rotate the key on a schedule, and after anyone who had access leaves.
- Watch the hot wallet with an alert (e.g. a balance-drop webhook).
- Keep `BREAKER_HOURLY_CHIKI` set just above your realistic peak hourly payout.

---

## 4. New environment variables (set on Render)

| Var | Default | Meaning |
|---|---|---|
| `REWARDS_QUEST_ONLY` | `true` | Disables the old time-based SOL accrual (rewards are quest-only). |
| `CHIKI_DECIMALS` | `6` | $CHIKI SPL decimals (pump.fun = 6). |
| `WINNER_CAP` | `100` | How many wallets get paid (first N to finish the questline). |
| `WINNER_REWARD` | `100000` | $CHIKI each winner gets. `WINNER_CAP × WINNER_REWARD` = the hard total pool (10,000,000). |
| `ADMIN_WALLETS` | *(empty)* | **Required to release funds.** Comma-separated admin wallet address(es) allowed to call `/quest/payout` (admin-signed). |
| `QUEST_MIN_HOLD` | `MIN_HOLD` (500000) | Winner must currently hold ≥ this much $CHIKI (fail-closed, ignores `VERIFY_HOLDERS`). |
| `QUEST_MIN_HOLD_MINUTES` | `60` | Anti-Sybil: wallet must have been first-seen this many minutes before it can win a slot. |
| `QUEST_MIN_GAP_SEC` | `20` | Min real seconds between two quest completions (anti-bot). |

**To change the numbers** (e.g. 50 winners of 200k, or 200 winners of 50k) set `WINNER_CAP` and
`WINNER_REWARD` on Render. Fund the hot wallet with up to `WINNER_CAP × WINNER_REWARD` $CHIKI.

> The old per-claim/daily/breaker vars (`PER_CLAIM_CHIKI`, `WALLET_DAILY_CHIKI`, `BREAKER_HOURLY_CHIKI`,
> `MIN_CLAIM_CHIKI`) no longer apply — there is no user-triggered claim. Payout is the admin batch
> (`/quest/payout`), which is idempotent and paced by you.

`RPC_URL`, `CHIKI_MINT`, `DATABASE_URL`, `VERIFY_HOLDERS` are unchanged from before.

---

## 5. After deploy — smoke test (devnet or with a spare wallet)
```bash
# server refuses skips and out-of-order:
curl -s -X POST $URL/quest/complete -H 'content-type: application/json' -d '{"wallet":"<W>","questId":"s_raid"}'   # 409
curl -s -X POST $URL/quest/complete -H 'content-type: application/json' -d '{"wallet":"<W>","questId":"s_meet"}'   # ok, pouch 20
curl -s "$URL/quest/state?wallet=<W>"                                                                              # pouchChiki:20
curl -s -X POST $URL/quest/claim    -H 'content-type: application/json' -d '{"wallet":"<W>"}'                      # pays real $CHIKI
```
The claim only succeeds once the hot wallet actually holds $CHIKI + a little SOL for fees.

---

## 5. Public endpoints must never echo a server credential (2026-07)

`GET /stats` is public and unauthenticated. It served:

```js
clientRpc: (process.env.CLIENT_RPC || process.env.RPC_URL || "")
```

`CLIENT_RPC` was unset, so it fell through to **`RPC_URL`** — the same Helius key the server uses to
sign treasury payouts — and published it to anyone who called `/stats`. That is the second
credential exposure in this project after the `TREASURY_SECRET` drain.

**Fixed:** the fallback is gone. `clientRpc: (process.env.CLIENT_RPC || "")`.

The point that matters: **a browser client cannot hold a secret.** Anything shipped to the client is
public by definition, so the goal is not secrecy — it is *isolation*:

| var | key | exposure |
|---|---|---|
| `RPC_URL` | server key — signs payouts | server only, never in a response |
| `CLIENT_RPC` | restricted key, domain-locked | public **by design** |

With the fallback removed, forgetting `CLIENT_RPC` disables on-chain buys **visibly** instead of
quietly leaking the treasury's RPC credentials. Fail closed, not fail leaky.

**Rule for any new field on a public route:** if its value comes from `process.env`, it is a
credential until proven otherwise. Never `||`-chain a public field onto a private one — the
fallback is invisible in review and only shows up in production.

## 6. Snapshot delta memory must be written AFTER the cap (2026-07-31)

`worldSnapshot()` decides, per peer, whether to ship the full static half (handle/avatar/party/…) or
an abbreviated `dl: 1` row meaning *"reuse what I already told you"*. The decision is recorded in a
per-receiver `seen` map. Two ordering bugs made the server claim it had sent rows it never sent.

**(a) The 60-peer cap.** `seen[w] = sq` was written inside the scan loop, i.e. *before*
`out.slice(0, WORLD_MAX_PEERS)` threw the farthest rows away. Any peer beyond the cap was marked
sent without being sent; the moment it drifted into the 60 nearest — a crowd shifting, one player
walking off — it was shipped `dl: 1` for a wallet the client had never heard of, and Net.gd answered
with a `_dl_resync`, a whole extra full-snapshot round. Measured at **10 of 10** promoted peers.
This is **pre-existing**, not a cost of interest management: the same 10/10 reproduces on git HEAD
(`7d0673a`), before the interest radius existed. Proof: `av_capseen_prechange_sim.mjs`, run against
both builds. **Fixed** by moving the whole static-half decision into a post-cap pass; wire shape is
byte-identical (`av_wireshape_sim.mjs` diffs key order and byte count old vs new).

**(b) The wide-radius skip ran before the interest eviction.** Interest eviction deliberately clears
the receiver's `seen` entry so re-entry ships a FULL row. But `if (d > WORLD_RADIUS) continue` sat
*above* that branch, so a client that POSTs itself past 4000 units left the bubble without ever
running the eviction and kept its `vis`/`seen` entries — on the way back it was shipped an
unrenderable `dl: 1` for a rig every observer's client had already freed. One forced resync round per
observer, per teleport, **at an attacker's choosing**. **Fixed** by testing interest first
(`INTEREST_LEAVE` 320 is far inside `WORLD_RADIUS` 4000, so it subsumes the wide check when interest
is on; the wide check still guards the spectate path).

**The rule**: if a response is filtered, sorted or capped *after* a row is built, any bookkeeping
that records "I sent this" must move after the filter too. A `seen` map written optimistically is a
lie the client pays for.

Interest management itself verified adversarially (`av_interest_attack_sim.mjs`, 29/29): a peer
parked at exactly d=260 with float jitter over 1200 polls (~10 min) flaps **0** times where a plain
260 radius would flap 1200; a fast observer crosses out at x=328 and back in at x=256, exactly one
transition each, and 200 polls anywhere inside the 260–320 dead band never flap; two players in
opposite corners (d=3394) do not see each other yet both count in `online` and in `/world/roster`,
and the wide spectate route still shows them; after a dropped poll, re-entry ships a full row and the
poll after it goes abbreviated again.

## 7. The party registry — four defects found by attacking it (2026-07-31)

Parties move nothing economic (no shared loot, no shared XP, no gather change). They carry exactly
one privilege — members see each other's coordinates island-wide in the `/world/move` reply — plus a
private chat channel. Four defects were found by attacking the shipped implementation; all four are
fixed and re-proven. Sims: `_av_party_attack_sim.mjs` (54/54) and `_av_party_attack2_sim.mjs`
(34/34), both in `chiki-backend`, both booting the real server in-process.

**(a) A roster handed to whoever holds a lapsed presence slot.** `/world/move` deliberately lets an
unproven caller take an *unclaimed* presence row (a real player has a wallet id a beat before
`/verify` returns their token, and freezing them for that window is worse than the bug). ~12 s after
a trainer closes the tab their row is swept, and the slot is unclaimed again. The reply carried
`party: partyWire(wallet)` unconditionally, so a stranger who read that wallet off the public
`/world/roster` POSTed the lapsed slot and was handed the victim's group: party id, leader, every
member's handle and island-wide coordinates. Measured: `party={"id":"pty_…","leader":"godot-…",…}`
on a caller with no token, in both the main and the stale-seq reply branch. **Fixed** — the field is
now `iAmProven ? partyWire(wallet) : undefined` on both branches. The shipped client sends
`mktToken` on every move (`Net.gd:1211`), so no honest player loses it, and a net_id still stands
alone. Note this is a *roster* disclosure, not a coordinate one: `GET /world/players?x&z` is
unauthenticated and un-filtered by design, so island-wide coordinate privacy is not a property of
this server, with or without a party.

**(b) A consent bypass through a null-pid invite.** An invite records the inviter's party *at issue
time*, and `pid: null` (issued while partyless) meant "party with me, whatever that becomes" —
evaluated at redemption. So: a mole invites their own alt while partyless, gets themselves invited
into someone else's group, and the alt then redeems the *old* invite and lands in a party nobody
there ever offered it, reading its private chat. Measured: alt's pid == victim party's pid, and 1 of
1 private message leaked. **Fixed** by RETARGETING instead of wildcarding — at the moment an accept
*founds* a party, every still-open null-pid invite from that founder is rewritten to the new party
id, and the stale test becomes exact (`inv.pid !== curPid`). The honest flow the null case exists
for ("invite two friends at once, before any party exists") is preserved and asserted. Any member
may still openly invite; what is closed is a door opened *before* the inviter joined.

**(c) A kick any open invite could undo.** Every member may invite, so a trainer the leader had just
kicked walked straight back in on an invite another member had issued *before* the kick — no new
decision by anyone, the leader's action simply reversed itself. **Fixed**: a kick drops the open
invites addressed to that trainer that belong to *that* party (an unrelated group's invite to the
same person survives, and any member who genuinely wants them back may issue a fresh invite).

**(d) An invite flood that destroyed whisper history.** The invite rate cap was keyed on the
*inviter*, and the inviter is a self-asserted net_id — so an attacker rotated `wallet` and paid
nothing: **260 invites from 260 fresh ids in 419 ms, zero refused**, and because an invite is
delivered as a DM into the victim's 200-row inbox ring, it **evicted all five of their real
whispers**. **Fixed** with a bound the attacker cannot rotate around: a recipient-side cap of 5
unanswered invites per minute, refused *before* anything is written, plus a rule that an invite
evicts the oldest *invite* rather than the oldest row, so whisper history can never be spent on an
invite nobody asked for. Proven: 400 invite echoes into one inbox leave 5/5 whispers and a 200-row
ring. The window is one minute, not the 10-minute invite TTL, because declining is purely local —
a longer window would trade a flood for a targeted "you may not be invited" lockout.

**Still open, pre-existing, NOT caused by this feature** (measured in the same run, stated so it is
not mistaken for a party bug):
* `POST /world/dm` has no throttle at all — the same 260 posts from 260 fresh net_ids destroy the
  same five whispers, through a route that predates parties (already recorded by
  `_refute_dmflood.js`, 2026-07-27). The invite door is now the *only* one of the two that is bound.
* A net_id is published verbatim by `GET /world/roster` and `GET /world/chat`, so `presenceOk`'s
  "a net_id is its own secret" premise is false for anyone who reads one. With a harvested net_id a
  stranger can accept, leave and party-chat as that trainer (measured: accept ON THE VICTIM'S BEHALF
  returned 200). This is the deferred sid-auth class, not a party defect — the same id already
  puppeteers that trainer's avatar — but parties inherit it.

## 8. The 2026-07-31 server-defect sweep — what was confirmed, and what closed it

Thirty-three server defects, each reproduced first and only then fixed. Every fix is proven by an
assertion that prints the ACTUAL value; the four sims are `fix_hatching_sim.mjs` (25),
`fix_world_sim.mjs` (29), `fix_market_sim.mjs` (19) and `fix_battlequest_sim.mjs` (28) — 101
assertions, all passing, each booting `server.js` in-process on its own port with a throwaway
keypair, a dummy RPC and the memory store.

### 8a. Issuance — the client may not NAME the prize, and issuance may not be free

* **`/assets/egg/consume` offered the whole catalog.** The route took the client's chosen species and
  checked only "is that a thing this egg can produce", while its sibling `/assets/egg/hatch` filters
  the pool by `ownedSpecies`/`ownedMounts` **and** `atSupplyCap` before it rolls. Consequences,
  measured: **one wallet minted three `dragonos` from three legendary eggs**, all with clean
  `hatched` provenance, and all three passed `chikimonSaleBlocked` onto the real-$CHIKI board; and
  **five fresh wallets took all five griffins** — a 5/75 weighted Mythic roll turned into a
  deterministic pick. *Fixed:* `/consume` now offers exactly the `/hatch` pool. Re-measured: dragonos
  rows held by one wallet **1**, second horse **409**, and the griffin cap now answers
  `409 "every griffin that will ever exist has been claimed"` instead of a 503 that tells the player
  to try again later. **Residual, stated:** the route still lets an attacker *choose* among the legal
  outcomes, so a griffin can still be targeted while any remain — closing that needs the client to
  stop rolling locally (Step 4 of server authority), not another gate here.
* **The unwitnessed allowance paid for assets.** `UNWITNESSED_ALLOWANCE` (1500 per wallet per item)
  exists to forgive chests, tasks and milestones the server never saw. It also bought eggs: a wallet
  that had done nothing but `/verify` measured 1500 of every egg material — **37 free legendary eggs
  and 37 free mount eggs** — which is what made the drains above cost nothing. *Fixed:* asset
  issuance reads `ISSUE_UNWITNESSED_ALLOWANCE = 25`, chosen against the recipes (the cheapest egg
  needs 30 wood, the dearest 50 crystal, Azulon's scroll 50 wood), so it cannot fund any recipe on
  its own yet still forgives a player whose last few gathers went unwitnessed. Measured: free eggs a
  zero-gather wallet can claim **0**; an honest gatherer **200**; a player 5 short on every
  ingredient (a dropped connection) still **200**.
* **Azulon's scroll had no price at all.** `SCROLL_TRADE` had zero server mirror — 20 throwaway
  keypairs holding nothing minted **40 supply-capped avatars in 111 ms**, and ~875 wallets would
  permanently exhaust the 1750-slot scroll-reachable supply. Nothing minted can ever be reclaimed.
  *Fixed:* `SCROLL_RECIPE_MATS`/`SCROLL_RECIPE_FISH` mirror `Econ.gd SCROLL_TRADE`, charged through
  the same `ownAvailable`/`ownDebit` gate the egg claim uses, with the same fail-open-while-loading
  policy and a 5 s floor. Measured: 20 empty wallets now mint **0**; an honest barterer with the full
  230 materials is served and charged exactly once.
* **A capacity fault took the barter and said it had not.** `/assets/egg/claim` debited *before*
  `mintAsset`, so a registry-capacity 503 answering "nothing was consumed" had already taken 40
  crystal. *Fixed:* mint first, charge after. Measured delta on a 503: **0** (was −40).
* **Restitution minted capped assets from client-authored counters.** `owedEggs` reads `mmo.prog`,
  which rides in the save verbatim; a crafted push on a **wallet created seconds earlier** was
  answered `owed:["normal","legendary","meme","mount"]` and granted four registry eggs, two of them
  hatching into a capped Meme edition and a capped mount. *Fixed:* the claim is gated on
  `players.first_seen`, a clock the server writes at `/verify` and a new wallet cannot have,
  cut at the END of the 2026-07-27 wipe window. **Every genuine victim is still paid in full** —
  measured: a wallet backdated to 2026-07-20 gets all four, a wallet first seen today gets `403`.

### 8b. The world — presence must mean something

* **`/world/move` had no speed term of any kind.** No previous position, no `dt`, no distance: a
  wallet teleported between all 24 monster spawns in 10.2 s (largest accepted jump **913.9 units**)
  and claimed **24/24 kills**, taking the whole island's reward and denying it to everyone actually
  standing there. Every reach check in the file is measured against that row. *Fixed:* the row is
  **stamped**, not refused — Chikoria teleports honest players (the drowning rescue, travel points) —
  and the two routes that turn presence into value stand down for 3 s. Measured: the same sweep now
  banks **1** kill; a runner at 18 u/s and a boat at 70 u/s (the fastest legitimate thing in the
  game) are never stood down.
* **`/world/kill/report` credited sellable essence for combat it cannot see.** Measured 7,194
  units/hour on a wallet that did nothing but `/verify` and one `/world/move`. *Fixed:* the credit is
  deleted; `/world/mob/hit` (position- and generation-checked, on the shared pool) is the only
  essence credit. The telemetry tally is untouched. Measured: 12 counted reports, book delta **0**.
* **`NODE_DROP`'s allowlist was undone one line later.** `recordGather` fell back to the raw node
  kind when the drop was empty, so `essence:800:-400` — a node kind that does not exist — credited
  essence anyway. *Fixed:* no fallback, plus the claim route now refuses an unknown kind outright and
  the gather tally accepts material keys only (on the way in AND on restore, matching the flow
  tallies). Measured: three fabricated kinds all **400**, book deltas **0**, tally `null`.
* **Node ids were not canonical.** `stone:700:-400`, `stone:0700:-400` and `stone:7e2:-400` were three
  independent nodes with three cooldowns — a cheater re-mined a rock other players still saw standing.
  *Fixed:* the key is rebuilt from the numbers the reach check already parsed. Measured: 6 spellings
  of one rock → **1** drop, **1** `worldNodes` key.
* **A claim could be made anywhere.** Now bounded to the island's gatherable extent. Measured: a
  fabricated `gold:1500:1500` is **400**; a real on-island claim still lands.
* **STILL OPEN, and it is the important one: there is no NODE MANIFEST.** The server still cannot
  tell a fabricated node from a real one — the id is the only evidence and the caller writes it. The
  remaining bound is the 1800 ms pace floor, i.e. a fabricator is capped at the same ~33 claims/minute
  an honest gatherer has. It is not fixed here because a manifest **cannot be baked from source**:
  stone/crystal/berries/seashell/honey/flower placement runs Godot's seeded RNG against the island
  heightmap, and **pig and cow wander**, so no static set can ever contain them. The route is to dump
  the id set from a real client build and ship it as data, leaving livestock position-checked.
* **The weekly raid prize was a permission slip.** The server moved no value and checked nothing about
  the boss. *Fixed:* presence within 110 units of MALGROTH (RaidBoss.gd `BOSS_X`/`BOSS_Z`), the warp
  stand-down, and the server now CREDITS the 25 crystal itself and reports the amounts — so an earned
  raid crystal raises the player's bound instead of eating their own forgiveness budget.

### 8c. Real-money rails

* **Craft orders bypassed the acquisition bound in both directions.** `op:order_deliver` never checked
  `ownAvailable` and `/market/order-pay` never called `ownSold` or `ownCredit` — while `op:list`
  refuses the 1501st unit a wallet was never seen acquiring. *Fixed:* the deliver gate mirrors the
  listing gate (same 409, same fail-open policy), a **pending delivery counts as escrow** so the 48 h
  window is not a bound-evasion race, and order-pay now does the seller debit and buyer credit the
  listing rail already did. Measured: a filler with no gathering record staked **15** of 21 open
  orders (1500/99) and the rest were refused; an honest filler with 500 witnessed gold is served, and
  a declined delivery releases its escrow exactly (+99).
* **A settled order id could be posted again, and the second delivery was destroyed.** Both value
  queues dedupe on the raw order id and acked rows survive two days, so `returnOrderGoods` silently
  swallowed the second return: 50 iron left the filler's bag and never came back, with no error shown
  to either side. *Fixed:* `_soldOrders`, the order-side twin of `_soldListings`, consumed on pay,
  decline, cancel and expiry. Measured: re-post **409**, second stake **not taken**.
* **The auction house was on the soft rail while every listing was forced on-chain.** A bid of 50,000
  from a wallet with a measured balance of 0 was accepted, the hammer handed over the creature, and
  the winner re-listed it on the real rail — a forged-currency-to-real-asset converter. *Fixed:* the
  same interlock `op:buy` has. To reopen the house, give the hammer a `buy-onchain`-shaped verified
  settle and delete the gate.
* **`item` was stored verbatim on `op:list` and `op:order_post`** while `auction_post` has always
  catalog-checked. On the listing rail that string reaches a BUYER's client and is written into their
  save. *Fixed:* `listItemOk` (MAT_IDS / FFISH_SET / the new POT_IDS mirror of Econ.gd POTIONS /
  CHIKIMON_IDS). Measured: three made-up items **400**, every real item still **200**.
* **`sellerWillNet` hard-coded 0.75** — a fourth copy of a real-money constant. Now reads
  `MARKET_SELLER_SHARE`.

### 8d. Battle, Cup and quests

* **A world duel's fighter was written by the caller.** `br 100000` gave **1,200,240 maxhp against the
  honest 840** and a hand of six tier-5 cards. *Fixed:* `duelSnap` — `br` clamped to 1..50 (the range
  the shipped client sends), and `arenaSkills`/`cardTier` **dropped rather than clamped**, because no
  shipped client writes either and the engine's defaults ARE the honest experience. Measured: forged
  and honest both **840 maxhp**, every card tier **1**. Deliberately NOT routed through
  `cupSnapFromBody`, which would newly require a Legendary and a stored profile to duel at all.
* **`/pvp/challenge` trusted `from`,** so a duel could be forged between a stranger and yourself,
  occupying their match slot. *Fixed* with the claimed-slot rule `/world/move` uses: an unproven
  caller may still speak for an id nobody has proven, never for one that is.
* **`/cup/register` and `/cup/chat` were unauthenticated.** A caller with no credential seated 7
  strangers, filled an 8-seat lobby and burned their Glory — every one of them a guaranteed round-1
  forfeit, handing the attacker a clean run at a 1.00 SOL prize. **This is a both-sides fix and the
  client half must ship first** (`Chikiseum.gd _cup_register` posts `{wallet, snap}`). Landed now,
  without needing it: a live world presence is required, a credential is HONOURED if sent, and a WRONG
  one is always refused — so the client change can be verified before `CHIK_CUP_AUTH=1` turns the
  hard gate on.
* **Card tiers and deck size were gated on wall clock alone,** despite the comment saying "upgrades
  cost BR + $CHIKI" — a full 12-card tier-5 deck in ~57 idle minutes, carried faithfully into a 4.00
  SOL bracket where honest entrants resolve to 3 cards at tier 1. *Fixed:* both now take the ceiling
  BR already has, the server's own win ledger, **grandfathered the same way** (the first sighting
  snapshots the unconsumed win count, so nothing anyone holds is reduced).
* **Grandfathered veterans were jammed at Ch.15 with 83,000 real $CHIKI unreachable.** The in-order
  gate required the 42 promoted chapters as predecessors, and a pre-2026-07-24 save can never report
  one (they are `quest_soft_settled`, which is what stops a double payout). *Fixed:* the gate binds on
  the legacy 21 only. Measured: the same replay now credits **20 chapters / 91,000 $CHIKI** and stops
  only at `s_ascend`'s real 500k stake gate — and **no back-fill is needed**, because the client's own
  retry queue drains as soon as the 409 stops. A fresh wallet jumping to the final chapter is still
  **409**.
* **`_payoutOne` claimed an at-payout stake re-check that did not exist.** With `/quest/complete`
  unauthenticated, 500,000 $CHIKI of working capital cycled through ten wallets captures all ten slots
  and the whole 10,000,000 pool. *Fixed:* the check the comment described. It **SKIPS, never clears** —
  a genuine winner mid-transfer, or an RPC that cannot answer, stays on the list and is paid next run.
* **The reward header promised caps and a circuit breaker that do not exist** on the $CHIKI paths.
  Corrected to state the real controls, and that a single signed batch can move 25 x 112,030.
* **`done_mask` sits exactly on the signed-BIGINT ceiling** (all 63 chapters = 2^63−1). A 64th chapter
  would make every completion throw silently. Now a **boot assertion**, so the migration lands before
  the chapter.
* **The `already` short-circuit wrote to the DB on every repeat post.** Now a read, writing only when
  the pouch bit is genuinely missing.
* **`/quest/complete` is still unauthenticated**, and that is the standing accepted risk — the pouch is
  a review list, not a payout. A credential is now honoured if sent and a wrong one refused, so
  `CHIK_QUEST_AUTH=1` becomes a one-line flip once the client sends one.

### 8e. Env flags added (all default OFF — do not flip before the client ships)

| Flag | Turns on | Blocked on |
|---|---|---|
| `CHIK_CLAIM_TOKEN=1` | `/world/node/claim` requires a proven wallet | `Gather.gd` sending `mktToken` (body is `{wallet,id,cd}` today) |
| `CHIK_CUP_AUTH=1` | `/cup/register` + `/cup/ready` require a credential | `Chikiseum.gd _cup_register` sending `authMsg`/`authSig` |
| `CHIK_QUEST_AUTH=1` | `/quest/complete` requires a credential | `Chain.gd _drain_quests` sending it |
| `FFISH_DAILY_MAX` | (default 60) per-wallet daily fantasy-fish ceiling, scaled by the festival multiplier | — |

Flipping any of the first three **before** the matching client is in the wild refuses 100% of honest
traffic on that route. `nodeClaims.enforcing` in `/assets/summary` is the gauge for the first.

## 9. The census consolidation, attacked (2026-07-31)

`trueIssued()` (server.js) is now the single denominator behind every cap: the **deduped** union of
the registry, the legacy ledger and the paid Meme sale, reconciled per wallet per species, with
`luid` as the dedup key an adopted row carries back to the ledger entry it adopted. `issuedCount()`
and `memeIssued()` are one-line wrappers over it, so two counters can no longer drift.
Adversarial verification: **`_av_census_attack_sim.mjs` 60/60 + 1 armed finding**, alongside
`census_consolidation_sim.js` 51/51 and `census_sim.js` 44/44.

**CONFIRMED and fixed — a grandfathered owner was refused the registration of a creature they
already own.** The cap exemption was read off the ORIGIN (`legacy`/`unverified`/`restitution`), but
the ledger grades a roster `hatched`, `purchased`, `issued` or `traded` for anyone who is not a
pre-epoch veteran. So `/assets/mounts/sync` and `/assets/chikimon/sync` minting an adoption row for a
**full** species threw `SUPPLY_EXHAUSTED` — and the adoption loop's `catch { break }`, written for
the one failure that used to exist (registry capacity, "adopt what fits"), then ended the whole pass.
Measured: a wallet holding a `hatched` griffin (cap 5, world at 5) plus a gator and a boar came back
`species: []` — **the at-cap species cost it its entire stable**. Same for a `purchased` alon on a
full edition, which also lost the `tyrannos` beside it.
*Fixed, two independent halves:* (a) **adoption is not issuance** — a row carrying `luid` records a
creature the census already counts from the ledger, so the cap is not re-applied to it (`luid` is set
by the two sync routes and nowhere else; every other call site builds `fields` server-side without
it); (b) a per-species `SUPPLY_EXHAUSTED` now `continue`s, and only a capacity fault still `break`s.
Re-measured: `species: ["griffin","gator","boar"]` and `["alon","tyrannos"]`; **60 adoption calls
across 20 over-cap owners write 20 rows and add ZERO to the world count**, and issuance is still
refused afterwards.

**Grandfathering proven absolute.** With wolf at 3× its cap (30 holders against 10): issuance stops
(`SUPPLY_EXHAUSTED`), all 30 owners still hold theirs, **0** flagged, **0** downgraded, all 30 can
still register into the registry, and the count stays 30. Nothing is deleted, taken or refused except
new issuance.

**Cap bypass — every mint site is bound or exempt on purpose.** Two concurrent hatches at cap−1 yield
exactly one winner and land the world exactly on the cap (mount hatch 200/409, avatar scroll 200/409,
paid Meme reveal `alon`/409); the chokepoint refuses `hatched`, `issued`, `scroll`, `purchased` and
`traded` at cap and exempts only `legacy`, `unverified`, `restitution` and adoption. Eggs are
deliberately uncapped (an egg is not a creature; the cap binds what it becomes).

**Undercount — the dangerous direction — is closed on every source tested.** Five ledger-only griffins
with no registry row at all bind the cap; **10 dormant wallets restored straight from the database,
which have never signed in since the registry existed, are counted and refuse an 11th horse**; an
orphan `memeMinted` counter with no hatch row and no registry row anywhere counts and refuses by name.
*Known and deliberate:* `origin === "unverified"` is reported (`flagged` in `/world/rarity`) and does
not bind — a forgery must not be able to deny an honest player the last griffin. *Known and
structural:* `serializeAssetLedger` keeps at most `ASSET_LEDGER_MAX` (20000) wallets, so a world
larger than that loses the overflow from the count on the next boot (measured: 20040 → 20000).

**ARMED, not live — a transfer would break the dedup.** With the registry row moved to another wallet
(`transferAsset`), the seller's ledger still asserts the creature — a sale only reaches the ledger on
their *own* next save — so re-syncing re-adopts it and mints a fresh row: one gator became **2 → 3 →
4 → 5** over three sell+resync cycles. Direction is over-count (a denial of scarcity), not a supply
breach, and **`transferAsset` has no route caller today**, so it is unreachable from the network. The
sim scores a tripwire on that fact; the moment a transfer route lands, adoption must first refuse a
`luid` this wallet has already adopted.

## 10. The WebSocket world transport, attacked (2026-08-01)

`/ws/world` is a SECOND transport beside `/world/move` polling. It was audited adversarially across
auth, flood, drift, fallback, lifecycle and secrets. Sims (all boot the real `server.js` with a
throwaway keypair, dummy RPC and a memory store — never the live backend, never a chain):
`_av_ws_attack_sim.mjs` 51/52, `_av_ws_bounds_sim.mjs` 25/25, `_av_ws_load_sim.mjs`,
`_av_ws_load2_sim.mjs` 4/4, `_av_ws_latency_sim.mjs` 3/3, `_av_ws_secrets_probe.mjs` 7/7, plus the
Godot probe `dev_ws503.gd` 14/14 against the real client.

### 10.1 CONFIRMED DEFECT — an anonymous socket was an unbounded egress amplifier

**A POST is self-limiting; a TICK is not.** One `POST /world/move` buys exactly one snapshot, so an
attacker's egress is capped by their own upload. The tick pushed a full snapshot every 50 ms to any
socket that had ever had a move accepted, and the only thing keeping the stream alive was presence
(`WORLD_TTL_MS`, 12 s). So **one ~300-byte message bought 240 snapshots**, and nothing capped how many
sockets one source could open.

Measured out-of-process (server in one child, attacker in another, so neither number is the sim's own
CPU), against a **control** that makes the identical presence rows over HTTP and opens no socket:

| scenario | attacker upload | server egress | honest HTTP poller p95 |
|---|---|---|---|
| baseline, 0 sockets | — | — | 3.4 ms |
| **control**: 200 presence rows over HTTP, 0 sockets | 6 KB/s | 0.16 MiB/s | **3.3 ms** |
| 200 anonymous sockets, 1 msg/10 s each | 6 KB/s | **27.4 MiB/s** | **12.8 ms** |
| 400 anonymous sockets, 1 msg/10 s each | 12 KB/s | **54.6 MiB/s** | **13.4 ms** |

The control is what makes this attributable: presence-map growth costs the honest poller **nothing**
(3.4 → 3.3 ms), so every millisecond and every byte above is the socket. Amplification vs. the same
200 clients over HTTP: **x89 per inbound message** (x4651 vs. raw upload bytes). No wallet, no token
and no signature is needed at any point — `isPresenceId` accepts a fabricated `godot-…` net_id, and
an unproven caller may legitimately claim an unclaimed slot.

Two smaller resource findings in the same class: a socket that connects and **never speaks** lived
forever and, through `wsLoopSync`, pinned the 20 Hz timer that the code's own comment says exists
only "while someone is listening" (measured: one silent socket produced 29 ticks in 1.5 s); and there
was no ceiling on concurrent sockets of any kind.

**THE FIX — three bounds, none of which can cost a player anything but the optimisation.**

1. **`WS_MAX_SOCKETS`** (default 250, `CHIK_WS_MAX`, 0 = unlimited for load tests). Over the ceiling
   the upgrade is answered `503 / X-Chik-Ws: full` and destroyed — deliberately the same shape as the
   `CHIK_WS=0` kill switch's 426, because that shape is the one the client is already proven to
   survive. Deliberately **NOT a per-IP cap**: Render terminates TLS and proxies, so
   `remoteAddress` is the proxy for every player (a per-IP cap would break honest play) and
   `x-forwarded-for` is client-writable (a cap keyed on a rotatable identity is not a cap).
2. **`WS_AUTH_GRACE_MS`** (30 s, swept every 5 s on its own timer so the 30 s heartbeat — which *is*
   the liveness rule — is not shortened). A socket that never gets a move ACCEPTED is closed.
3. **`WS_MOVE_IDLE_MS`** (4 s). The push follows the client's own cadence. `Net.gd` sends every
   280 ms and kills its own socket after 600 ms of silence (`WS_SILENCE`), so 4 s is 14x the honest
   cadence and strictly more permissive than the client's own watchdog. Non-destructive: it neither
   closes the socket nor clears the wallet, and one move re-arms it.

Measured after (same machine, same run, caps disabled vs. shipped defaults):

| scenario | before | after |
|---|---|---|
| naive attacker, 200 sockets @ 1 msg/10 s | 27.3 MiB/s · p95 13.0 ms | **0.0 MiB/s · p95 3.4 ms** |
| adapted attacker, 400 sockets @ 1 msg/3.5 s | 54.6 MiB/s · p95 13.4 ms | 34.3 MiB/s · p95 13.8 ms |

**Stated residual.** At the shipped cap an attacker willing to send 34 KB/s can still pull ~34 MiB/s
and hold the honest poller's p95 near 14 ms. That is not removable: with no unspoofable identity, an
attacker can always imitate 250 real players, and 250 real players in one square cost exactly the
same. What changed is that the cost is now **bounded, explicit and operator-tunable** (it scales
linearly with `CHIK_WS_MAX`) instead of unbounded. `CHIK_WS=0` remains the instant kill switch.

**Rejected optimisation, and why.** "Skip a tick whose payload is unchanged" would collapse the
attack's egress to zero — but `Net.gd`'s `WS_SILENCE` is 0.6 s, so a still world would starve the
client's watchdog and drop every socket. The only thing keeping it alive would be the 280 ms move
ack, leaving no jitter margin. Do not ship it without changing the watchdog first.

### 10.2 CONFIRMED SAFE — the properties the design claimed

* **A socket is never more powerful than a POST on the inbound side.** A socket blasting 1000
  moves/s is capped at `WS_MSG_BURST` (39 acks measured); `POST /world/move` has **no inbound rate
  cap at all** (120/120 concurrent accepted), so the socket door is the stricter one.
* **Auth is exactly the POST's auth.** An unauthenticated socket receives nothing over ~24 ticks;
  `ping`/junk never authenticates; a move for a PROVEN wallet with no token, or a forged token, is
  403 on the socket and 403 on the POST identically, and the victim is never moved; a refused move
  de-authenticates the socket. A stranger may take an UNCLAIMED public-wallet slot (deliberate — a
  real player has a wallet id a beat before `/verify` answers), and the moment the owner proves it
  the squatter's stream dies on the next tick with the same 403.
* **`party` — the one field an unclaimed slot may not read — is gated on the tick too**, and is
  field-for-field identical to the HTTP reply's.
* **No drift.** Age-normalised, a tick payload and a real `/world/move` reply for the same receiver
  and the same world state are byte-identical (3038 B), same field set, same peer count, same online
  count. The delta memory lives on the presence row, so a `dl:1` tick and a `dl:1` poll agree.
* **Fallback and mixed fleet.** A WS client and an HTTP client see each other's moves in both
  directions with full rows; an abruptly destroyed socket does not pop the trainer out of the world
  (the TTL owns that) and the wallet resumes on HTTP immediately.
* **Secret isolation holds across the new door.** With `RPC_URL` a canary and `CLIENT_RPC` unset,
  every socket frame (ack, tick, err, pong) plus `/stats`, `/world/roster` and `/world/players` carry
  zero secret bytes and `/stats.clientRpc === ""`.
* **HTTP polling is unchanged**: 12 pre-existing netcode sims, 304 assertions, 0 failures, on the
  fixed build.

### 10.3 The headline claim, measured — CONFIRMED

End-to-end propagation latency, 60 cycles each, receiver on the **shipped** 280 ms free-running
cadence (a receiver that polls the instant the mover posts measures one RTT and nothing else — that
error made the first run report WS as 4x *slower*):

* HTTP: **p50 133 ms, p95 271 ms** · WS: **p50 30 ms, p95 52 ms** — 77% / 81% faster.
* Matches theory exactly: a 20 Hz push predicts a uniform 0–50 ms wait (p50 25, p95 47.5); a 280 ms
  poll predicts p50 140, p95 266.

### 10.4 PRE-EXISTING, do not attribute to the socket

**Two consumers of one wallet share one delta memory.** `seen` lives on the presence row, not on the
connection, so consumer #2 is told `dl:1` ("reuse the static half I already sent you") for peers it
has never been sent, and `Net.gd` answers that with a whole extra full-snapshot round
(`_dl_resync`). Proven pre-existing by the HTTP-only control in the same run: the same wallet polled
twice over plain HTTP already gets **20 of 20 rows abbreviated** on the second consumer. Two sockets
reproduce it identically (21/21). The socket changes only the PRICE — a squatter on a net_id
(net_ids are published verbatim by `GET /world/roster`) got **18 unrequested frames from one inbound
message**, where over HTTP each consumed static half costs one request.

## 11. Movement authority, attacked (2026-08-01)

Sims (all boot the real `server.js` in-process — throwaway keypair, dummy RPC, memory store, unique
port, never the live backend): `_av_phys_attack_sim.mjs` **26/26**, `_av_phys_honest_sim.mjs`
**17/17**, `_av_phys_preexist_sim.mjs` **6/6** (two child servers: the pre-change build and the
current one), `physics_authority_sim.mjs` **67/67**.

### 11.1 A per-MESSAGE allowance is not a speed limit — and it was LIVE

`/world/move` stamped a warp when `jump > WARP_MAX_UPS(110) * max(0.05, dt) + WARP_SLACK(60)`. The
`+60` is granted to every **message**, and nothing rate-limits `POST /world/move`, so the entire
stamp was bypassed by sending more of them. Hops of ≤65 u never stamp, at any rate.

Measured against the **pre-change build** (`_av_phys_preexist_sim.mjs` case 1): 19 hops of 65 u
carried a wallet **1200 units in 0.04 s** — 34,286 u/s against a fastest-legitimate-thing of 70 u/s —
with **zero warps stamped**, and `POST /world/node/claim` at the far end answered **`200 ["wood"]`**.
Sustained: 37,500 u/s over 120 hops. The stand-down that `/world/node/claim`, `/world/mob/hit` and
the raid gate all depend on simply never armed. **This predates CHIK_PHYS and shipped.**

**Fix**: the allowance is now a bank (`WARP_BANK_S = 2.5`), filled at `WARP_MAX_UPS` per second of
wall clock and spent by distance moved, carried on the presence row as `wbank` (internal — the row is
never spread onto the wire, and `STATIC_KEYS` is an explicit list so `sq` is unaffected). Same attack
on the current build: **403 "catch your breath"**. The honest control ran on **both** builds: a boat
at 70 u/s, 0 of 18 reports stood down on either.

The one-shot allowance is 275 u, **tighter** than the old rule for any gap over ~2 s (at a 10 s gap
the old rule allowed a single 1160 u jump). Stated cost: a client that loses the network for >2 s and
returns having genuinely moved >275 u has a warp stamped and loses 3 s of gathering.

### 11.2 The same mistake inside `world_physics.reconcile`, in both directions at once

`REACH_SLACK = 6.0` per claim was simultaneously too loose and too tight, and only measurement
separates the two:

* **too loose** — 120 claims of 5.5 u posted as fast as HTTP accepts them: **3203 u/s**, uncorrected.
* **too tight** — 6.0 u is *smaller than one honest report interval*. The recorded client sprints at
  30.24 u/s = 8.47 u per `MOVE_DT`, and `Net.gd` deliberately keeps two requests in flight, so a
  coalesced pair gives the second claim `dtWall ≈ 0.001` and a ceiling of 6.07 against a move of
  8.47: **18 corrections in 24 reports for a player running in a straight line**.

**Fix**: `TUNE.REACH_BANK_S = 2.5`, held in *seconds* so a mode change rescales it. After: sustained
200 u/s is held at **32.7 u/s** and 900 claims at 586 msg/s buy **0.00 u**; honest burst arrival is
**0/24**, and a 2.8 s stall flushed as ten back-to-back reports is **0/10**.

### 11.3 Four more confirmed defects

| # | Defect | Proof | Fix |
|---|---|---|---|
| 1 | `mode:"spec"` — the CREATOR free-fly (420 u/s, no collision) is admin-gated **in the client only**. A bare `godot-…` net_id put `mode:"spec"` in one input frame; `physModeOf` made it sticky and a 110 u jump in 0.3 s was accepted (366 u/s). | attack A9 | `sanitizeInput(raw, state, {allowSpec})`; `server.js` passes `isAdminWallet(wallet)` and clears a sticky `spec` on any non-admin ping. Now `action=correct`, `st.mode=foot`. |
| 2 | A granted teleport window **never lapses** — rule 1 re-armed `acceptUntil` on every claim that merely landed *inside* it. One drown rescue answered `"teleport"` on 30 of 30 honest reports over 8.5 s and accepted a **1900 u jump** nine seconds later. The same re-arm promoted `grantModeSwitch`'s deliberate 400 ms boarding window to a rolling 3 s one on its first claim. | attack A11 / A11b | Extend only on the claim that was actually *granted*. Now 10/30 inside the window, the 1900 u jump is refused, and the mode-switch window still reads 276 ms after a claim. |
| 3 | `segmentPenetration` returned 0 for any segment ≤1 u (`if (!(d > 1))`) **and never sampled its own endpoint** (`i < n`). A claim landing inside a column is *lifted* onto it by the terrain floor, so 1-unit hops walked a client up the steepest face on the island for free. | attack A12 | Sample `i <= n`, skip only `d === 0`. On the steepest 2 u rise on the island (53→60 at −294,186): **7 refusals, climbed 2.00 u of 7.00**. Costs honest play nothing — worst penetration on all 8 recorded client runs is still **0.000**. |
| 4 | A correction **freezes the base every check measures from**, so `moved` only grows and a player refused once for a reason that persists can never be accepted again — 12 consecutive corrections left a presence row stranded **235 u behind, permanently**. Every value route reads that row, so a false correction does not rubber-band a player, it takes their gathering away until they relog. | honest B9 | `TUNE.STUCK_MS 4000` → a `resync` that hands back the POSITION and withholds the PAYOUT. The move is **bounded** by `ceilSpeed × stuckSeconds` (an unbounded one measured 187 u/s sustained — the escape hatch became the exploit), gated by `RESYNC_COOLDOWN_MS 15000`, and `server.js` stamps a warp `RESYNC_HOLD_MS 16000` into the future, i.e. **longer than the cooldown**, so a client forcing resyncs on a timer never owns a moment in which a gather would settle. Verified: `403 "catch your breath"` immediately after. |

### 11.4 Honest play, measured (`_av_phys_honest_sim.mjs`, `CHIK_PHYS=1`)

**0 corrections in 200+ honest reports.** Every recorded `dev_physdump` run replayed through the real
`/world/move` at the real 280 ms cadence, as the shipped position-only fleet (**0/70**) and as a
prediction client (**0/65**): flat walk, flat sprint, hill, wall, jump, sea, mount ride, mount dash.
Plus 10% input-frame loss **0/7**, +300 ms latency **0/7**, burst arrival **0/24**, a 2.8 s stall
flushed as ten reports **0/10**, the steepest sustained climb on the island (48 u of altitude over
205 u of ground) **0/28**, the boat at 70 u/s as a relay client **0/20** and as a declaring client
**0/20**, a 30 fps phone **0/20**, a dashing Direwolf at the theoretical maximum 95.76 u/s **0/20**,
and the real 548 u drown rescue accepted with **0/15** corrections afterwards.

### 11.5 Stated residuals

* **A 175 u one-off displacement is allowed and cannot be removed.** It is exactly what a coalesced
  pair of honest reports after a network stall looks like. Measured: a wallet claiming 240 u/s and
  gathering as it goes settled **1 of 40** claims — the first — and **0** after the bank was spent.
* **A resync is one bounded reposition per 15 s with a 16 s value blackout** — movement only, zero
  economic throughput, and other players see a short teleport.
* **Vertical is not authoritative, deliberately.** A claim 900 u in the air is accepted; the server
  enforces only the floor. Value is settled by horizontal proximity, and the horizontal position
  still has to be reachable.
* **A wallet can brick its OWN input lane** by sending one frame with `seq = MAX_SAFE_INTEGER`
  (`advance` takes `Math.max`). Self-inflicted only — inputs for a proven wallet with no token are
  403 and never reach `lastInputSeq`.
* **The three mine mouths are the only place a heightfield can be wrong**, and they were measured:
  the worst 24 u traverse at any of the twelve entrance directions is **2.40 u** (crystal_mine +z)
  against `PEN_TOL 3.0` — a 0.60 u margin. Re-measure if the island is ever re-baked.
