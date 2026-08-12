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

---

## 12. Adversarial re-verification: the one-die fishing roll and STAGE 3 actions (2026-08-01)

Everything in this section was re-run from scratch on fresh ports against the real `server.js`
(throwaway keypair, memory store, dead RPC, no `DATABASE_URL`) and, where the claim is about what a
player *sees*, against the real Godot client. Nothing touched the live backend or any chain.

| Sim / probe | Result |
|---|---|
| `stage3_actions_sim.mjs` (ports 44131-44135) | 41 / 0 |
| `fish_onedie_sim.js` (port 44317) | 17 / 0 |
| `_rv_fish_attack_sim.mjs` (port 44401) | 17 / 0, 6 findings |
| `_rv_actions_attack_sim.mjs` (port 44411) | 34 / 0, **honest refusals = 0**, 4 findings |
| `_rv_physwarp_attack_sim.mjs` (ports 44421/44422) | 6 / 0 |
| `_rv_secrets_probe.mjs` (port 44431) | 17 / 0 |
| `dev_rvfishw.gd` — WINDOWED, real Player vs a local server on 44319 | 17 / 0 |
| `dev_fishonedie.gd` (headless) / `dev_scriptcheck` | 21 / 0 · `bad=0 checked=389` |
| Regression: gather_authority 24, fish_report 13, kill_report 12, skeptic_mobpool 28, mmo_sync 29, world_share 24 + v2 14, pvp_live 19, econ 16, delta_snapshot 15, presence_auth 8, interest_radius 16, party 40, physics_authority 67, av_phys_honest 17, av_phys_attack 26, market fuzzer 8, critical_econ 10, world_tick 66, mount_sync 26, terrain_parity 405/405 | all 0 fail |

### 12.1 Confirmed defect and its fix — the trainer-level gate was the client's alone

**The rod decides what is HOOKED; the trainer level decides what is LANDED.** `Player.gd`'s strike
handler snaps the line the instant a legend above `Econ.FFISH_LEVEL` (golden 5, koi 10, eel 15,
rainbow 20) is struck: the player is toasted *"the Golden Chikifish SNAPPED the line — reach Trainer
Lv 5 to land it"*, banks nothing, and the fish is gone. The server knew nothing about it — it had
already run `ownCredit(wallet, "ffish", legend, 1)` and `worldFeedPush("ffish", …)`.

*Failure scenario, measured (`_rv_fish_attack_sim.mjs` case C2):* a wallet posting
`{tier:3, rod:10, lvl:1}` was rolled `golden_chikifish`; the world chronicle published a row reading
`golden_chikifish` for it, and the acquisition book gained a fantasy fish. On a real client that same
cast shows the player the line snapping. **The chronicle announced a catch the player watched get
away, and `FFISH_AUTHORITY` would one day have enforced an entitlement the player's save never had.**

**Fix** (`server.js`, `FFISH_LEVEL` + the gate immediately after `rollFantasyCatch`): a rolled legend
the caller's own asserted level cannot land is dropped before the daily ceiling, before `ownCredit`
and before `worldFeedPush`. The cast still counts as an ordinary fish.

`lvl` is client-asserted, and that is safe **because this gate can only ever subtract**. A caller who
inflates it, or omits it, gets exactly the answer they got before — so it adds no attack surface and
can refuse nothing a liar could not already have taken. An absent `lvl` means "no assertion", not
"level 0", so no already-shipped client changes shape.

*Proof after the fix:* server-side, a lvl-1 wallet took 60 tier-3/rod-10 casts under a ×10 festival
for **0 legends and 0 chronicle rows**, with the new `outlevelled` counter reading **23** — the
server did roll them and then withheld them, so the pass is not vacuous. A `lvl:20` angler is
unaffected (legend on cast 1, chronicle row matching the reply), and a client sending **no** `lvl`
key is ungated exactly as before. End to end (`dev_rvfishw.gd`, real Player, real local server): a
Lv 1 trainer with a Lv 10 rod at a Legendary-Depths spot under a ×10 festival cast **16** times for
**0 legend verdicts, 0 snaps and 0 new chronicle rows**, while the Lv 20 session in the same run
landed 2 legends whose chronicle rows matched exactly what was displayed.

### 12.2 Answers to the four fishing questions

* **Can a client still show itself a legend the server did not roll?** Yes, and *today it does not
  matter less than it sounds*. With `FFISH_AUTHORITY` off — the deployed state — `OWN_KINDS` is
  `{mat}`, so the market listing bound skips `ffish` entirely: a wallet the server rolled **zero**
  Rainbow Fish for listed 5 of them, `200`, on the board (`_rv_fish_attack_sim.mjs` D1). The one-die
  change makes the *book* true; it does not yet make the book *binding*. What it does already bind is
  the **chronicle**: declaring a fish on the market pushes no feed row, and only a server roll can.
* **Can the bite-time report be spammed to buy extra rolls?** The 800 ms floor binds the ROLL, not
  the request: 200 concurrent casts were all accepted HTTP-200 in 56 ms and exactly **1** counted.
  Spaced casts buy **4,333 rolls/hour/wallet** at an asserted tier 3 / rod 10. The real bound is
  `FFISH_DAILY_MAX` (60/day, scaled by the festival multiplier): over the cap, 12 casts minted
  **0** legends and pushed **0** chronicle rows.
* **Does a dropped reply lose a catch or award two?** Neither, but the two sides can disagree.
  `ownCredit` and `worldFeedPush` both run *before* `res.json`, and there is no ack, no idempotency
  key and no retraction route — so a lost reply is a **silent credit** (measured: `ownAvailable`
  0 → 1 with the reply discarded). It cannot lose a catch (`Net.fish_verdict` answers `know=false`
  and the client plays its local die — proven end to end: wire down, species `frostgill`, bank
  8 → 9). It cannot award two, because one report is one roll. A *retried* body 810 ms later **is** a
  whole new roll; the shipped client never retries.
* **Is the chronicle row always the species the player was shown?** After 12.1, in every case except
  one, yes. The remaining case is stated below.

### 12.3 Stated residuals — fishing

* **The chronicle is written at the BITE, not at the landing.** `Player.gd` reports on the
  cast → bite transition so the verdict is back before the strike judges the species. Every way a
  bite can still fail afterwards — the 1.8–2.8 s strike window expiring, the line snapping at
  tension ≥ 99, six seconds of not reeling — leaves a chronicle row and an `ffish` credit for a fish
  that got away. Closing it needs a client-sent *landed* confirmation (safe for the same reason
  `lvl` is: it can only subtract), which is a client change and therefore a later release.
* **The chronicle is floodable by unauthenticated net_ids, and this is PRE-EXISTING** (the same
  `worldFeedPush` line is in the pre-STAGE-3 baseline). 24 fabricated `godot-…` ids — no wallet, no
  signature, no token — wrote **8 of the 8** feed rows. `ownCredit` skips net_ids so there is no
  economic gain; it is display griefing of an 8-row ring, and it lets an attacker put any handle
  next to any legend.
* **The live fleet cannot roll a legend at all, so `FFISH_AUTHORITY` must stay OFF until a client
  ships.** Independently re-confirmed from the artifact: the shipped `Net.gdc`, extracted from a
  byte-identical rebuild of `realm/index.pck.[0-8].bin` (Jul 31 18:45) and zstd-decompressed,
  contains the literals `/world/fish/report`, `wallet` and `mktToken` but **no `tier`, no `lvl`, no
  `legend`, no `counted`**. So every live report posts `{wallet, mktToken}`, `rod` clamps to 0 —
  below golden's unlock of 2 — and nothing is ever rolled.

### 12.4 STAGE 3 (`CHIK_ACTIONS`) attacked, and what the flag actually binds

Refusals, all measured with the flag ON: out of reach `403` at 14.6 u against `CLAIM_RADIUS` 14
(13.9 u still granted); no presence `403`; mid-teleport `403 "catch your breath"` with the identical
claim landing after the hold; the five malformed ids `stone:abc:-260`, `../../etc/passwd`,
`stone:9000:-260`, `unicorn:120:-260` and `""` all `400` with four *distinct* reasons; an 8-way race
on one crystal `wins=1 taken=7`, **one item total**; an 8-way race on a 3-load tree `3` grants and
**3** items — one per claim, never a bonus; a replay `taken=true drop=undefined`; a decimal id
refused rather than re-keyed. Fishing and kill reports for a wallet you cannot prove are `403`, and
a forged market token is `403`.

**The tool gate is a consistency check, not an authorisation, and the code now says so.** Because a
tool-less body must pass forever (every shipped client sends none), a cheater deletes one key:
`tool:"axe"` on a rock is `403 needs="pickaxe"`, and the **identical claim with no `tool` field is
`200` immediately after**. It also binds neither TIER nor OWNERSHIP — a wallet that has never
crafted anything claims `tool:"pickaxe", toolLvl:10` and is granted, because gear lives in the
client-authored save. Do not cite it as an anti-cheat control.

**Claiming for another wallet is still open and `CHIK_ACTIONS` does not touch it** (pre-existing,
gated behind `CHIK_CLAIM_TOKEN`, which is OFF because `Gather.gd` sends no token). Measured: a
tokenless stranger claims in a victim's name → `200`, and the victim's very next honest claim →
`429 "too fast"`. The attacker gains nothing (`recordGather` credits the victim); it is
denial-of-gathering, not theft.

**The new water bound is a small CPU amplifier, stated not fixed.** A *refused* cast costs 169
`surfaceHeight` lookups (the lattice returns on the first hit, so a bone-dry inland stance is the
worst case), the check sits BEFORE the 800 ms count floor, and `/world/fish/report` has no inbound
rate cap. Measured: 300 concurrent dry casts refused in 131 ms, 0.033 ms of heightfield work each —
the same order as parsing the request body.

### 12.5 Honest play with `CHIK_ACTIONS=1`: the number is ZERO

A 20-node gathering session across all nine node kinds at the client's own 2 s cadence, sending the
tool field an honest client *would* send: **20/20 granted**. A 14-cast fishing session from a shore
stance derived from the server's own heightfield: **14/14 counted, 0 refusals**. A mob fight standing
on the monster: 6 strikes, **0 refused**, killed. Total honest refusals: **0**.

The water bound was then swept exhaustively rather than sampled. Every point on the island with water
within `FISH_SPOT_RANGE` (24, `Player.gd`) — i.e. every stance from which an honest angler could
reach a school, since `Fish.gd` places all 44 schools in water — was tested against `waterNear`:
**60,963 stances, 0 refused**. The bound is not vacuous: 958 of 958 deep-inland stances are refused.
The direction is also safe by construction — the server calls anything below `SEA = 6.0` water while
the client's own water surface is at `water_level = 4.0`, so the server's notion of water is strictly
the more permissive of the two.

### 12.6 Both flags OFF is byte-identical to today, re-proven

`server_stage3_baseline.mjs` was regenerated from the deploy mirror's `HEAD:server.js` (the last
committed server = everything except this pass) and diffed: the working tree differs by exactly
**4 replaced lines and 111 insertions**, and nothing else. Three child servers — baseline,
flag-unset and `CHIK_ACTIONS=0` — driven through the same 20-step transcript are **byte-identical**
at 1,914 bytes after normalising only wall-clock keys. The equivalence is not vacuous: the baseline's
own transcript shows the tool field ignored and a teleported cast not held.

The one change that ships **outside** the flag is the warp-bank guard
`(_claims || !PHYS_ON)`, and it was attacked on its own terms
(`_rv_physwarp_attack_sim.mjs`). A coordinate-less ping does reset `_wbank` to the full
`WARP_BANK_S`, so 40 alternating rounds of "claim +270 u, then refill for free" claimed
x = 10,921 — but `physApply`'s reconcile is the stricter gate and the server's answer stayed
**x = 121.0**, a 10,800 u gap, with a correction on all 40 and `403 "catch your breath"` on the
gather at both ends. The honest half of the same guard holds: a pure-input `CHIK_PHYS` client
gathers **8/8** with **0** holds. With `CHIK_PHYS` off the branch condition is unchanged — a
coordinate-less body is still measured as a jump to the origin and still stamps a warp.

### 12.7 Key discipline

With `RPC_URL` set to a canary and `CLIENT_RPC` unset, all fifteen responses these changes can reach
— `/world/fish/report` (granted and refused), `/world/node/claim` (granted and wrong-tool),
`/world/mob/hit`, `/world/kill/report`, `/world/move`, `/world/feed`, `/world/event`, `/stats`,
`/world/roster`, `/world/players`, `/assets/summary` keyed and unkeyed, `/health` — carry **zero**
secret bytes, and `/stats.clientRpc` is `""`: it fails closed, with no fallback to `RPC_URL` and no
rpc-shaped key carrying it under another name.

## 13. The WS latency work (permessage-deflate + tick dedupe), attacked (2026-08-01)

Both flags default OFF and flag-off is byte-identical to `git show HEAD:server.js`
(`_av_lw_rerun.mjs a`, 9/9: same key order, same payload, same tick frame count 17/17, 0 frames
suppressed, `WS_MAX_SOCKETS` 250 and `WS_TICK_HZ` 20 asserted unchanged). Regression on the fixed
build: **449 assertions, 0 failures** across ws_transport 78, world_tick 66, physics_authority 67,
mobile_desktop_sync 45, party 40, mmo_sync 29, mount_sync 26, world_share 24, pvp_live 19,
interest_radius 16, delta_snapshot 15, world_share_v2 14, critical_econ 10.

### 13.1 DEFECT FIXED — a configured extension could refuse an upgrade that is accepted today

`ws` 7.5.11 (`websocket-server.js:242-251`) only parses `Sec-WebSocket-Extensions` when the server
was configured with `perMessageDeflate`; if the parse or the accept throws it answers
`abortHandshake(socket, 400)` — the **whole upgrade**, not just the extension. And
`serverNoContextTakeover: false` means "refuse any offer that asks for no-context-takeover", which
is a legal RFC 7692 offer an intermediary may add.

Measured side by side, flags-off vs flags-on (`_av_lw_attack_sim.mjs` section D): four headers that
answer **101 today** answered **400** with `CHIK_WS_DEFLATE=1` — `server_max_window_bits=99`, a
duplicated parameter, an unknown parameter, and `permessage-deflate; server_no_context_takeover`.
A refused upgrade is survivable (the client falls back to polling) but it is silent, and if
Cloudflare ever rewrote the offer the flag would disable the socket for the whole fleet.

Fixed with `deflateOfferSafe(req)`: an ALLOW-LIST screen in the upgrade handler. Anything outside
the shape `ws` is certain to accept goes to the **plain** server — today's behaviour exactly. After
the fix all eight offers answer 101 on both builds, the real browser offer
(`permessage-deflate; client_max_window_bits`) still negotiates compression, and
`server_no_context_takeover` degrades to a plain socket rather than to no socket.

### 13.2 The DoS numbers were measured against an attacker that COOPERATES

`latency_wins_sim.mjs` PHASE D gives the attacker two choices it would never make: it offers
permessage-deflate (`sock(url, !!env.CHIK_WS_DEFLATE)`) and parks 250 sockets on fixed coordinates.
`_av_lw_dos_sim.mjs` runs both profiles in one process, same rig, same 250 sockets, same 3.5 s
cadence. An adversary declines the extension (one constructor option) and staggers the same cadence
so one peer moves every 14 ms:

| | cooperative | HOSTILE |
|---|---|---|
| today | 29.5 MiB/s x3542 | 33.97 MiB/s x3653 |
| deflate | 1.34 MiB/s x161 | **33.95 MiB/s x3655 — zero effect** |
| dedupe | 0.86 MiB/s x103 | 23.93 MiB/s x2573 |
| both | 0.04 MiB/s x5 | **23.98 MiB/s x2576** |

So the real reduction under attack is ~30%, not 99.9%; deflate contributes nothing (the attacker's
`negotiated` is 0); and dedupe **costs** CPU when it cannot suppress (43% → 49% of a core at 250
sockets). **Neither flag buys headroom to raise `WS_MAX_SOCKETS`.** The bound that holds an
attacker is still `WS_MAX_SOCKETS` + `WS_MOVE_IDLE_MS`. This is now written into the code comment
above `WS_DEDUPE_ON`.

### 13.3 The flip's own verification instrument was unreachable — now an admin gauge

The deploy plan says "after flipping, read `_wsStatsForTest().deflate.negotiated`" to learn whether
Cloudflare forwards the extension **accept**. `_wsStatsForTest` is exported but **no route serves
it**. Added `wsTransport` to `GET /assets/summary` (already `cupAdminOk`-gated, 403 unkeyed),
integers and booleans only: `{deflate, deflateMax, negotiated, dedupe, dupSkips, dupBytes, sockets,
max, refused, frames, bytes, hz}`. Canary sweep unchanged: zero secret bytes across `/stats`,
`/health`, `/world/roster`, `/world/players`, `/assets/summary` keyed **and** unkeyed, `/world/feed`,
`/leaderboard` and every socket frame; `/stats.clientRpc === ""`.

### 13.4 Measured, not fixed

* **The deployed fleet takes the COMPRESSING path, and the desktop probe never exercised it.**
  `chikimonsters-repo-FIXED/realm/index.js` creates the socket with `new WebSocket(url, ...)` — the
  browser API, which always offers `permessage-deflate; client_max_window_bits`. `dev_wstransport.gd`
  proves desktop Godot, which offers nothing. A browser-shaped client driven against the real server
  reconstructs an **identical** world view to a plain client at **3,647 B vs 37,908 B (90.4% less)**.
* **Compression is deniable by an attacker.** 3 sockets that merely *offer* the extension fill a
  `CHIK_WS_DEFLATE_MAX` of 3; the honest client arriving next still connects and still receives
  frames, but plain. Cost is the optimisation, never the session.
* **Dedupe is disabled for 90 s by any monster death.** `mobSnapshot` emits
  `back: MOB_RESPAWN_MS - (now - deadAt)` for a dead mob and `now` is re-read every tick, so every
  socket's frame differs. Measured on a real kill (darkeet, spawn 0, 2×120 dmg): the same still
  world went **49 → 0 dupSkips** in a 3 s window. The "78% saved in a still square" figure holds
  only while all 24 spawns are alive.
* **Backpressure holds; the number is 1.2 MiB per stalled reader, not 256 KiB.** 60 sockets paused
  at the OS level while still sending moves: RSS plateaus (last-8-second slope 0.47 MiB/s off /
  0.12 MiB/s on), 1174 KiB/socket off and 1328 KiB/socket on — `WS_BACKPRESSURE` caps *application*
  buffering at 256 KiB, the rest is the kernel send buffer. Honest sockets are untouched (frame gap
  p95 52.6 → 52.7 ms off, 53.0 → 54.9 ms on). Extrapolated to `WS_MAX_SOCKETS` 250 that is
  **287 MiB (off) / 324 MiB (on)** of RSS — deflate adds 13%, and on a 512 MiB instance it is worth
  knowing before the ceiling is raised.
* **`WS_MSG_BURST` does not bound decompression.** The 40/s counter lives in the message handler,
  which only runs after `ws` has already inflated the frame, and `ws` 7.5.11's `zlibLimiter` is
  MODULE-scoped (`permessage-deflate.js:23,64-69`) so inbound inflate shares a 10-slot queue with
  every socket's outbound compression. 117,000 inbound 15 KiB-inflating frames from 40 compressing
  sockets (≈487 msg/s per socket against a 40/s app cap) moved an honest socket's frame gap p95
  **52.7 → 52.9 ms**, max 63 ms, tick 18.8 Hz, CPU 73%. Not a practical amplifier — stated as a
  residual, not fixed.
* **A 6 MiB compressed-inbound bomb is refused** and RSS moves 124.2 → 124.3 MiB (`maxPayload` is
  enforced on the inflated size).

### 13.5 The honest-play verdict: the flags are a BANDWIDTH change, not a latency change

Propagation A/B/A, free-running 280 ms receiver, both actors inside `INTEREST_ENTER`, 60 cycles at
three occupancies (`_av_lw_honest_sim.mjs`, 12/12):

| peers | HTTP poll p50/p95 | WS p50/p95 | flags delta p50 | A-to-A noise |
|---|---|---|---|---|
| 0 | 139.6 / 257.9 ms | 26.0 / 52.5 ms | −0.23 ms | 0.83 ms |
| 12 | 149.9 / 273.3 ms | 24.2 / 47.9 ms | −0.53 ms | 1.09 ms |
| 40 | 142.5 / 267.4 ms | 25.2 / 51.5 ms | +1.92 ms | 2.00 ms |

The latency win is the **socket**, which already shipped. The two new flags move propagation by less
than the A-to-A noise at every occupancy — they buy bytes (90.4% for a browser, 72.4% for a
non-offering client in a slow-updating world), not milliseconds.

## 14. The Island's Chronicle, attacked (2026-08-01)

The owner's requirement for the chronicle pop-up was one sentence: **"DO NOT ERASE THE HISTORY."**
Raising `WORLD_FEED_MAX` 8 → 400 and persisting the ring to the kv store made that history real —
and, unchanged in every other respect, made it **destroyable by anyone on the internet**.

Sims (real `server.js` in-process, throwaway keypair, memory store, dead RPC, unique port):
`chron_attack_sim.mjs` 46/46, `chron_secrets_probe.mjs` 16/16, A/B against the deployed HEAD
(`chron_ab_child.mjs`). Godot (windowed, real Main.tscn): `dev_chronattack.gd` 19/19 desktop and
19/19 `CHIK_FORCEPHONE=1`, `dev_chronicles.gd` 33/33 desktop + 39/39 phone, `dev_scriptcheck` bad=0.

### 14.1 CONFIRMED, CRITICAL — a stranger erased the whole island's history in 12.3 seconds

`presenceOk` lets a private `godot-…` net_id stand alone (presence is not identity, and for an
avatar that is right). `worldFeedPush` inherited that: **900 fabricated ids, no wallet, no
signature, no token, nothing bought**, POSTed `/world/move` and then `/world/fish/report` at the
route's own 800 ms floor. The server rolled their legends for them.

| | before the flood | after 11,700 requests / 12.3 s |
|---|---|---|
| genuine moments retained | 12 | **0** |
| attacker rows | 0 | **400 / 400** |
| after a save→wipe→restore restart | the history | **the flood** |

Pre-retention the identical flood cost 8 rows of a ticker that died on reload. Retention is exactly
what turned a cosmetic nuisance into the permanent destruction of the feature, **including in the
database**. The attacker also chose the name on every headline.

**Fixed with three bounds, in order of force** (`server.js`, note at `WORLD_FEED_MAX`):

1. **A proven wallet, or nothing.** `worldFeedPush` refuses any author that is not a pubkey — and a
   pubkey reached `presenceOk` only by proving the market token. A durable, shared, persisted world
   record is value, and value settles against a wallet. Measured: the same flood now rolls 423
   legends and writes **0 rows**; all 12 genuine moments survive. It is also the rule `ownCredit`
   already applied — a net_id catch is credited to nobody either, so the two now agree.
2. **No author may evict another.** At `WORLD_FEED_PER_AUTHOR` (24, ≤6% of the ring) an author
   replaces their *own* oldest row. Measured: one wallet pushing 200 rows holds 24 and evicts none
   of the 12.
3. **Fair trim.** When the ring is genuinely full the row dropped belongs to whoever holds the most
   (ties → oldest). Measured: 12 one-row authors survived 500 rows of noise from 30 loud authors,
   12/12 — an oldest-first trim leaves 0.

There is deliberately **no per-author rate limit**. A 4 s floor was written and then removed: with
the share cap it protects nothing, and it *does* drop a real moment when an angler lands two legends
inside the window. Refusing to record something that happened is the one failure this feature cannot
have, so the bound is a share, not a rate. (`back-to-back legends 0 ms apart both chronicle`.)

### 14.2 CONFIRMED — the restored blob was not re-validated

`restoreWorldFeed` pushed whatever the kv store returned straight into `worldFeed`, against the rule
`restoreWorldNodes` already follows. `sanitizeFeedRows` now re-imposes shape, types, `stripTags`, the
20/32 string clamps and the ring bound on the way IN. The clock matters most: a row with a
far-future `t` is served to every client, advances every client's `fs` cursor past every real row
and **silences the chronicle for the whole fleet**. Measured: 7 hostile entries (null, number,
string, array, empty kind, `id:"../../etc"` with 5,000/9,000-char fields and `t:9e18`) → 1 row out.

### 14.3 CONFIRMED — the public GET became a 33 KB unauthenticated amplifier

Serving the whole ring by default took a 505 B endpoint to **33,761 B**; one client pulled
**569 req/s = 18.3 MiB/s of egress** with no wallet and no rate limit, on a host that has already had
a bandwidth incident. The default page is now `WORLD_FEED_PUBLIC_PAGE` = 60 rows (5,433 B at full
retention, 6.6× smaller); the full backlog is still available, it just has to be asked for
(`?limit=400`). Rows never carry the author wallet — `feedWire` strips `w`, which exists only to key
the fairness bounds.

### 14.4 CONFIRMED (client) — a stranger's name was BBCODE, and retention made it stored

`Minimap._feed_line` interpolated the wire's `h` into a bbcode string rendered through
`Econ.rt_set_bb`, whose own docstring says never to feed it player text. The server strips only
`<` and `>`, so `[font_size=99]` or `[url=…]` in a handle rendered as markup in every player's HUD.
Harmless while the pill was a 4-line ticker that died on reload; with the chronicle retained,
persisted and **re-seeded from the save**, it becomes a stored injection that replays on every boot
and rides the cloud profile. Escaped at the one place player text meets our markup
(`_feed_bb_safe`); the pop-up's rows were already plain `Label`s and were safe. Measured: the pill
now shows the literal `[font_size=99]X`.

### 14.5 CONFIRMED (client) — four ways the retained history could still be lost

* **A crafted save was unbounded.** `_chron_hydrate` read `d["chronicle"]` with no row cap and no
  string clamp; 5,000 rows × 4,000-char fields loaded whole, then built one `Control` per row in the
  pop-up. Now clamped to `CHRON_CAP` and to the wire's own 20/32 limits. Measured: 5,000 → 300 rows,
  longest handle 20.
* **One poisoned stamp silenced the feed forever.** `_feed_fs` was advanced from saved timestamps
  with no ceiling and is itself persisted, so `t = 4e15` would freeze the cursor past every future
  row *across reloads*. Now refused (`_chron_stamp_ok`, local now + 1 day). Measured: fs stays 0 and
  the next real moment still arrives.
* **The dedupe key dropped distinct events.** `k|h|t` collides for two different moments that share
  a kind, a name and a millisecond; the second was silently gone. `d` is now in the key, in both
  `Net._chron_key` and `Minimap.push_world_feed`. Measured: 2 retained where 1 was.
* **A flood evicted the player's own history.** The client trimmed oldest-first at 300, so 300 rows
  from one loud source erased everything. `_chron_evict_idx` drops the oldest row of the
  most-represented handle and never the local player's while anyone else's remain. Measured: a
  600-row flood left all 12 other trainers' moments and all 3 of the player's own.

### 14.6 CONFIRMED (client) — the history could 413 the whole cloud save away

`/profile` refuses a profile whose JSON exceeds 65,000 bytes, and that refusal loses the **whole**
save, not the rider that overflowed. A full 200-row chronicle is 22.6 KB of a veteran's budget.
`Profile.export_server` now trims the chronicle *in the export only* until it fits `CLOUD_JSON_MAX`
(60,000) and drops it entirely if the profile is over the line on its own; the chronicle is
signature-neutral (`_econ_sig` never reads it), so nothing is invalidated and the local history keeps
all 200 rows. Measured: a 45 KB profile that would have been ~67,622 B exports at 58,637 B with 100
of 200 rows kept; a 62 KB profile drops the key and **returns** (the first draft of the trim loop
could not reduce below one row and hung a probe — a proportional step that rounds to zero never
terminates).

### 14.7 What did NOT change, proven by A/B against the deployed server

Two child servers (deployed `git HEAD` vs patched), one fixed transcript, one proven wallet: the
move reply — the only feed path any shipped client reads — is **identical at every step** (empty
`fs=0`, a 3-row backlog delta, a caught-up cursor with the `feed` key absent, a one-row delta, row
keys `d,h,k,t`, 8-row window, 649 B at full retention). The single wire delta anywhere is an `id`
key added to `GET /world/feed`, which **no production client calls** (grep of every `.gd`: only dev
probes). Key discipline re-swept across `/world/feed` (default, `?limit=400`, `?since`, garbage,
negative and huge limits), `/world/move`, `/stats`, `/health`, `/world/roster`, `/world/event`: zero
canary bytes, `/stats.clientRpc === ""`, no stack traces on malformed queries.

### 14.8 Stated residuals

* **The chronicle is still a bounded shared log, so it is still floodable by someone willing to pay
  for identities.** With `VERIFY_HOLDERS=false` (today's devnet setting) a keypair is free, so ~17
  verified wallets can still fill 400 slots. What changed is that every row is now attributable to a
  pubkey (bannable), no single identity can evict anyone, and the zero-cost anonymous version is
  gone. Turning `VERIFY_HOLDERS` on is what makes the remaining cost real.
* **A wallet-less client no longer chronicles.** `Net._presence_id()` falls back to a `godot-…`
  net_id when no wallet is connected; that player's server-rolled legend is still shown and banked
  locally but does not enter the island's record. This is what `dev_fishonedie_w.gd` measures, and
  both fish probes now encode the rule instead of the old assumption.
* **Pre-existing and NOT introduced here** (proven by running the same probe against the deployed
  HEAD server): `dev_rvfishw.gd` fails 4/4 the same way on both servers (festival not reaching the
  client, verdict-by-strike-time 0/24, no legends rolled, the snap branch), and `dev_fishonedie_w`
  fails the festival case on both. On desktop `dev_hudfit HUDFIT_MODE=pop` reports 2 overlaps — the
  **minimap's own 152×152 map Button** against the catalog's category tabs, which predates this
  work. The chronicle pill was fixed: it now drops its input filter while a foreign pop is open
  (desktop `small` 13 → 12, phone 0 overlaps / 0 offscreen in every mode).

## 15. Multi-database roster recovery — the kv blob shapes are a data-destruction class

`roster_merge.mjs` (dev-only, gitignored, never deployed) merges an arbitrary number of frozen
Postgres databases into the live one. Adversarially re-attacked 2026-08-04 on a local
`initdb` cluster whose fixtures are written in the shapes the REAL `server.js` `serialize*`
functions emit, and then read back through the REAL `restore*` functions. Five defects were
confirmed by measurement and fixed. All of them shared one root cause.

**The class: a kv blob whose serialise/restore contract is not read from the code that owns it.**
Three of the five defects were shape mismatches, and each of them would have destroyed live data
while every profile-level proof still reported "0 reductions". They fail SILENTLY: `restore*`
validates its input and returns 0 rather than throwing.

* `asset_ledger` is `{ w: [[wallet, rec], …], buys, gather, spent, gained, raid }` —
  `restoreAssetLedger` returns 0 unless `Array.isArray(v.w)`. Reading `blob.rows` instead produced
  **0 records from a 3-record blob**, and writing `{rows: […]}` would have wiped every wallet's
  unit/mount/avatar/egg provenance, the `held` flags, the material flow counters **and the weekly
  raid claim gate** (`raid`), which on its own hands the whole playerbase a fresh weekly claim.
* `own_book` is `[[wallet, rec], …]` — `restoreOwnBook` returns 0 unless `Array.isArray(v)`.
  Treating it as an object produced `{}`, which would have wiped every wallet's selling entitlement
  (`open/cred/sold/used`) and the Step-7 matSave grandfather baseline (`base/baseSrc`). The bucket
  keys are `kind:item` (`mat:wood`), not `kind|item`.
* `market_sold_ids` is `[{id, ts}, …]` — the boot path reads `e.id`. Taking the ENTRY as the id
  built `'{"id":"L-SOLD-1","ts":…}'`, so the double-sale guard never matched a single listing and
  every already-settled listing would have been resurrected into the recovered profile.

**Census: a registry id is per-process, so "restore what the wallet already owns" can mint supply.**
`mintAssetId` is `type[0] + Date.now() + seq + 6 random bytes`, so the SAME creature adopted in two
databases always carries two different ids. Deduping the registry on id alone left both rows, and
`buildCensus` counts registry rows individually (`g.R++`) with only a *Set* of `luid`s — measured
**census 2 for one griffin** (`registry=2 ledger=1 deduped=1`), i.e. a second rarity-cap slot
consumed by restoring a player's own property. Fixed by deduping on the creature
(`owner|type|sp|luid`, falling back to `id` where no `luid` exists), keeping the oldest `born`, and
never laundering a `consumed` state or an `unverified` origin away. The same rule was needed in the
ledger: `rec.units` is keyed on a **uid, which is a per-save counter**, so two databases that
recorded one creature under different uids unioned to two ledger units — also measured as census 2.

**Eggs.** The union key rounded `started` to the second, so one egg stored as `…000.4` and `…000.6`
became **two** eggs — and an egg hatches into a capped creature. Now clustered within 5 s, taking
the MAX count any single database holds rather than a union.

**The pre-epoch opening balance is destroyed by a correct recovery, and that has to be said out
loud.** `ownSnapshotOpening` grants a wallet its one-time material selling entitlement only when
`prev._serverSavedAt < OWN_EPOCH_MS` (2026-07-31). The merge MUST stamp `_serverSavedAt = writeAt`
or `apply_server` will not adopt the restored blob at all (`take = srv_at_ms > mine_ms + 1000`), so
the evidence is necessarily lost: **407 of 407 recovered wallets went pre-epoch → post-epoch**, and
would never again be able to sell the hoard they hold. The tool now reports the count every run and
can write the opening itself (`--restore-opening`, `min(mats, OWN_OPEN_CAP)` under the server's own
`openSrc` once-marker) — opt-in, because it grants selling rights.

**Verified after the fixes**, on a local cluster only, 100+ assertions with no failures: dry run
leaves all three databases checksum-identical; 42 992 field comparisons over 482 wallets with 0
reductions; live-only wallets byte-identical; counters MAX never SUM; the live census equals the
fixture's own ground truth exactly (**0 over-counted, 0 under-counted species**); prefix/case/
whitespace/unicode-look-alike wallet pairs never merge and a `'; DROP TABLE players; --` handle
travels as data; a mid-run save and a first-ever INSERT both survive; SIGKILL mid-commit leaves the
database byte-identical and a re-run completes; a second `--commit` is a true no-op; and a merged
profile loaded through the REAL server round-trips (GET → POST → GET) with assets, seal, and glory
intact.

## 16. The NFT mint gate — an origin STRING is not provenance (2026-08-05)

`CHIK_NFT_MINT` lets a player put a real Metaplex Core NFT into their own wallet, inside the official
collection `2iyJEoY5mUnBXJ139R5mQSkfQtgzZXTP4BtnQaiGEgTN`, signed by a scoped collection
`UpdateDelegate` the server holds (never the cold master key, never `TREASURY_SECRET`). A certificate
is permanent and public, so the gate that decides *who may be certified* is the whole security
surface of the feature.

### The exploit: laundering a crafted save into the official collection

`nftEligibility` accepted `origin === "hatched"` on the strength of a comment that read "server-
witnessed births ONLY". **Two unrelated writers produce that same seven-character string:**

| writer | what it means | shape it leaves |
|---|---|---|
| `mintAsset(…, "hatched", row.id)` — `/assets/egg/hatch` (server.js:6690/6704), `/assets/egg/consume` (:6781) | a **real** birth: a server-minted, server-timed egg row was consumed into this creature | `parent` = the egg's row id, no `luid` |
| `auditAssets` (:7799) `else if (!eggGlut && eggsHatchable >= newUnits)` | a **delta inference** over the client-authored `mmo.eggs` array of a save the client signs itself | no `parent`; laundered into the registry by `/assets/chikimon/sync` (:6903) and `/assets/mounts/sync` (:6839), which set `luid` |

The second reached the mint. Measured end to end (`_ax_nftlaunder_sim.mjs`, log `launder1.log`): a
throwaway wallet pushes a save *declaring* a legendary egg, waits out `EGG_HOURS.legendary` (12 h),
pushes a second save where the egg is gone and a level-50 galador has appeared, calls
`/assets/chikimon/sync`, then `/assets/nft/mint` → **`200 OK`, `Galador #1`,
`5h4yqToyL8bzPhA9jNLcjnRQdkrM7UreumdJ311xuKWq`**, a Core asset in the official collection at 20%
royalty with `origin=hatched` written into its on-chain Attributes plugin. Declaring all four egg
kinds at once (`EGG_KINDS_MAX = 4`) certified **four** legendaries from one free wallet in one cycle;
the same trick on the mount path certified a **griffin** (cap 5, the rarest asset in the game). Six
forged certificates in a single run. Cost: wall-clock only.

### The fix

`parent` is only ever `mintAsset`'s 5th argument and only the three hatch call sites pass it; no
client-reachable route can set it, and `restoreAssetReg` carries it across restarts. `luid` is its
mirror image — only the two sync routes set it (see the comment at server.js:6483). `nftEligibility`
now fails **closed** on both:

```js
if (!row.parent || row.luid) return { code: "no-lineage", status: 403,
  error: "only a creature this server hatched from a registered egg can be certified" };
// and, when the egg row is still present, it must be an egg that hatched into THIS creature
```

Refusal is `403 no-lineage` and is served through `/assets/mine` (`mintable:false`, `mintWhy`) so the
client never re-implements a rule. **Nothing is taken from anyone**: the creature is untouched in the
player's game, only the certificate is withheld, and the feature has never shipped.

### The lesson

**A provenance FIELD is only as good as the narrowest thing that writes it.** Before trusting an
enum value as a security predicate, enumerate *every* writer of that value — here `grep -n
'"hatched"' server.js` finds five call sites and only three of them are witnesses. Prefer a structural
witness that no client-reachable route can produce (`parent`, a foreign key to a row the server
minted) over a label any inference can spell.

### Verified

`_ax_nftlaunder_sim.mjs` **27/0** — the attack refused with **0** creates reaching the chain on the
unit path, the 4-at-once path and the mount path, *and* both honest routes still mint first try
(`Galador #1` from the server-rolled hatch, `Adalor #1` from the paid-egg hatch where the player
chose the species). `_ax_nftmint_sim.mjs` **121/0** — not-owner / no-token / forged-token, normal /
avatar / egg / `legacy` / `unverified`, double mint, 5-way concurrent mint, foreign-collection Core
asset, Token-2022, legacy `V1_NFT`, burnt asset, someone else's asset, a certificate already bound to
another creature, burned-stays-burned across a hostile restore blob, `/world/rarity` + `/assets/dex`
+ `/assets/census` byte-identical across a mint, and a secret sweep of 59 response bodies (0 bytes of
the RPC URL, the delegate secret or the treasury secret; `/stats.clientRpc === ""`). Flag OFF stays
byte-identical to `git HEAD:server.js` (`_adv_nftoff_sim` 27/0, `_nft_offdiff` 13/0,
`_nft_offdiff2` 19/0). Regression subset unchanged; `_av_census_attack_sim.mjs` 58/2 is
**pre-existing** — bisected, `git HEAD:server.js` produces the identical two failures.

## 17. An ERROR MESSAGE is a credential channel — the owner-run signer tool (2026-08-13)

Section 5 says a public endpoint must never echo a server credential. This is the same class one step
further out: **a local tool the owner runs by hand leaked the signing key to the terminal**, and it did
so through the one surface nobody audits — the text of a caught exception.

`chiki-backend/update_collection_uri.mjs` (a one-shot tool that repoints the Core collection's
metadata URI) read a keypair from a path the owner passes, and on a parse failure printed
`  ${e.message}`. Neither decoder on that path throws a generic error:

    base58.serialize("<88-char export with one bad character>")
      -> Error: Expected a string of base 58, got [<THE ENTIRE 88-CHARACTER KEY>]
    JSON.parse("[2,113,114,X115,...]")
      -> SyntaxError: Unexpected token 'X', ..."3,104,105,X106,107,1"... is not valid JSON
         (a ~20-character window of the LEADING bytes of the secret scalar)

Both landed on stderr two lines above the sentence *"The file's contents were NOT printed"*. The
near-miss case is the dangerous one: a one-character-corrupted 88-char key, seen on a terminal, a
screen share or pasted into a support chat, is brute-forceable in roughly 5,000 tries.

**Five leak paths were proven with synthetic sentinel keys** (no real key ever used; all inputs
deleted afterwards; RPC pointed at `127.0.0.1:9`, never mainnet):

| # | input | what was printed |
|---|---|---|
| 1 | 88-char base58 with one non-base58 char | the whole key |
| 2 | a valid export wrapped in quotes | the whole key + quotes |
| 3 | JSON array with a stray char early / late | a 15-20 char window of the leading / trailing bytes |
| 4 | the key pasted **as** `--keypair`'s value, or in `CHIKI_SIGNER_KEYPAIR` | the whole key, via `keypair file not found: ${KEYPATH}` |
| 5 | any RPC error on a non-mainnet run | the RPC URL — i.e. the Helius api-key — via `network : ${onMainnet ? "MAINNET" : RPC}` |

Path 4 is foreseeable rather than exotic: the tool's own help says "a Phantom base58 export is also
accepted", so pasting the export where a filename belongs is a normal misreading. Path 5 is the
third occurrence of the section-5 class.

### The rules that came out of it

1. **Never bind the exception in a key-parsing block.** `catch { keyFail = CATEGORY }` — with no `e`
   in scope there is nothing to interpolate by accident. Failures map to a fixed sentence ("the file
   is not valid base58", "…not valid JSON", "…is not 64 bytes"). A byte COUNT is safe; nothing else
   derived from the input is.
2. **Report the failure OUTSIDE the block.** `process.exit()` does not run `finally`, so `die()` from
   inside the catch skipped the `secret.fill(0)` scrub on the only path that needed it.
3. **Shape-check every argv value that is echoed.** A path contains a slash or is short; a Solana
   address is 32-44 base58 chars; a key export is 87-88. Anything that fails its shape is refused
   *without being quoted back*, because a key one flag out of place (`--collection`, `--uri`, `--rpc`)
   prints just as readily as one in the right flag.
4. **Never print the RPC endpoint, on any cluster.** Print a label (`MAINNET`, `devnet (endpoint not
   printed)`). Helius carries the key in the query string, QuickNode in the path.
5. **One redactor guards everything else.** `safe()` strips control bytes, the exact RPC string, any
   URL, comma-separated byte runs and any 64+ character unbroken token, and it is the only way an
   error reaches a console. `uncaughtException` / `unhandledRejection` handlers print one redacted
   line and no stack — in Node 24 a post-`await` top-level throw goes to `uncaughtException`.

### Verified

38 cases across three probes, **0 leaking**, against the patched file
(md5 `030889020d9743213f25a780098af770`). Detection was not substring matching — that under-reports,
because `JSON.parse` echoes a window from the middle of the file — but the **longest common substring
between the input file and the captured stdout+stderr**, flagged at 10 characters. Post-fix the worst
common run across every malformed case is 2 characters. The safety properties held throughout: no
`writeFile`/`appendFile`/`createWriteStream`/`execSync`/`spawn` anywhere (grep 0), `secret` confined
to one lexical block and zeroed in `finally`, no default keypair path or `~/.config` search, dry run
still the default, exactly one `sendAndConfirm` directly under the `if (!COMMIT) { … exit(0) }` gate,
simulation still `sigVerify:false`, and the `--check-url` preflight still refuses a 404, a non-JSON
body, a missing `image` and a dead image (proven against a local stub, never the live backend).
