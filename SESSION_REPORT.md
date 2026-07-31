# Session report — 2026-08-01

Written for you to read cold, after being away. Plain language. Where a number appears, it is a
number something actually printed today, not an estimate.

**Nothing was committed. Nothing was pushed. The live backend was never contacted and no chain
transaction was ever built or sent.** Every measurement below comes from a copy of the real
`server.js` booted inside a throwaway process on a local port, with a disposable keypair, an
in-memory store and a dead RPC address.

---

## 1. The short version

Three pieces of work landed, plus an independent re-run of everything:

1. **Fishing now has one die instead of two.** The server decides what you caught, and the client
   shows you that decision. Before today the two sides rolled separately and usually disagreed.
2. **The world can now adjudicate actions** (gathers, casts, monster strikes) against its own idea
   of where you are — built, proven, and **shipped switched OFF** behind `CHIK_ACTIONS`.
3. **An adversarial pass attacked both** and found one real defect (below), which is fixed.

**None of it is live yet.** The backend changes are on disk and in the deploy mirror, uncommitted.
The client changes are on disk in `ChikoriaSmooth` — the web build in `chikimonsters-repo-FIXED/realm/`
is still the Jul 31 18:45 build and does **not** contain them. Players see no change until you build
and deploy.

---

## 2. What now works that did not before — in player terms

### Your catch and the world's chronicle finally agree
When you hooked a Crystal Koi, your screen said "Crystal Koi" because *your copy of the game* rolled
that. Meanwhile the server rolled its own, separate die, and it is the server's roll that the world
chronicle announces and the acquisition book records. At Koi odds (1 in 500 at base) the two rolls
essentially never matched — so the normal outcome was: **you were shown a legendary fish and the world
said nothing.** That is also why the live chronicle showed `count:0` fantasy-fish rows during the ×4
festival.

Now: the moment a fish *bites*, the client asks the server for the verdict; the server rolls once;
the client displays that roll. The strike window (1.8–2.8 s, longer with a better rod) plus the whole
reel duel cover the round trip. If the answer does not arrive in time, you keep your local roll and
still bank a fish — **a slow network can never cost you a catch.**

### A fish you cannot land is no longer announced as yours
The rod decides what can be *hooked*; your trainer level decides what can be *landed*. If a Golden
Chikifish takes the line at Trainer Lv 1, the game snaps the line and you bank nothing — but the
server had already credited it and announced it in the world chronicle. So the chronicle published a
catch the player watched get away. The server now honours the same level rule.

### An honest player on the future physics client will not be locked out of gathering
Only relevant when `CHIK_PHYS` is switched on (it is off), but it would have been ugly: a client that
sends only inputs and no coordinates was being measured against the map origin, which looked like a
teleport on *every* message, which stood the player down from *every* gather, permanently. Fixed.

### Nothing changed for anyone playing right now
Every backend addition is behind a flag that ships off, or is a pass-through when the flag is off.
This was not asserted — it was measured: a fixed 20-step transcript against a pre-change server and
against the patched server with the flag unset came back **byte-identical, 1,914 bytes**, with only
wall-clock fields normalised.

---

## 3. Every defect fixed, and what could have gone wrong

**1. Fishing rolled two dice (client + server).**
*Consequence if left:* the chronicle stays silent for real catches, or announces fish nobody saw;
and the day `FFISH_AUTHORITY` is switched on, the acquisition book — which only knows about the
*server's* rolls — would refuse to let players sell or trade the fish their own game showed them.
*Fixed by:* reporting at the bite, and displaying the server's answer
(`Player._report_cast` / `_strike_species` / `_adopt_server_catch` / `catch_decision`, `Net.fish_verdict`).

**2. The trainer-level gate lived only in the client.**
*Consequence if left:* a Lv 1 player's chronicle row read "caught a Golden Chikifish" for a fish that
snapped the line, and the book gained a credit their save never had. Measured before the fix:
`{tier:3, rod:10, lvl:1}` → rolled `golden_chikifish` → chronicle row + 1 credit.
*Fixed by:* `FFISH_LEVEL` on the server, applied right after the roll and before the daily ceiling,
credit and chronicle. The level is client-asserted, which is safe **because the rule only ever
subtracts** — inflating it or omitting it returns exactly the old answer, so it adds no attack
surface, and no already-deployed client changes shape. After the fix: 60 tier-3 / rod-10 casts under
a ×10 festival at Lv 1 → **0 legends, 0 chronicle rows**, with the new `outlevelled` counter at 23
(the server rolled them and withheld them, so the pass is not vacuous). Lv 20 unaffected.

**3. A coordinate-less movement message was measured against the origin.**
*Consequence if left:* with `CHIK_PHYS` on, an honest input-only client is warp-flagged on every ping
and can never gather again. *Fixed by:* only banking a "jump" when the body actually claims a
position; physics reconciliation still flags implausible claims. Guarded on `PHYS_ON`, so the
deployed relay fleet is unchanged.

**4. The "flag-off is byte-identical" evidence had not actually been produced.**
The baseline fixture `server_stage3_baseline.mjs` did not exist when that phase was first reported,
so it could not have run. Regenerated from the mirror's committed `HEAD:server.js`; that phase now
genuinely passes (byte-identical at 1,914 B across baseline / flag-unset / `CHIK_ACTIONS=0`).

**5. A client probe was still guarding the old fishing shape** (`dev_clientauth.gd`).
It asserted the report call sits inside `_land_catch`; the call moved to the bite. The guard has been
re-pointed at the new call site so it still guards the same guarantee (the cast IS reported, and it
carries spot tier, rod tier and trainer level). **18 ok / 2 FAIL → 21 ok / 0 FAIL.**

---

## 4. Deliberately NOT done, and why

* **`FFISH_AUTHORITY` was not switched on.** The shipped web build cannot send the fields it needs.
  Proven two ways: the pck in `realm/` is dated **Jul 31 18:45** while the client fix is dated
  **Aug 1 03:31**; and pulling `Net.gdc` out of that pck shows its text table contains
  `/world/fish/report`, `wallet`, `mktToken` but **no** `tier` / `rod` / `lvl` / `legend` / `counted`.
  Flipping it today would refuse essentially every honest legendary catch and egg claim.
* **`CHIK_ACTIONS` ships off.** It is safe on honest-play grounds (measured: **0 refusals** across a
  20-node gather sweep, 14 shore casts and a 6-strike monster fight), but it buys little until a
  client sends a `tool` field, and its tool check is a *consistency* check, not an anti-cheat
  control: a tool-less claim must pass forever, so deleting one key defeats it. Your call whether to
  turn it on; the position, water and warp adjudication in it are real.
* **`CHIK_CLAIM_TOKEN` stays off.** Turning it on without a client that sends claim tokens would
  break gathering for everyone. The consequence of leaving it off is unchanged and known: a stranger
  can claim a node *as* your wallet and make your next claim bounce — denial of gathering, not theft.
* **Tool tier and ownership are still unchecked.** A wallet that never crafted anything can claim
  `tool:"pickaxe", toolLvl:10`. Closing that needs server-owned gear; gear currently lives in the
  client-authored save. Out of scope for a flag.
* **The "report at the bite" residual was left open.** Because the cast is reported when the fish
  bites, a player who then misses the strike window, snaps the line or walks away still produces a
  chronicle row. Closing it needs the client to send a "landed" confirmation and the server to hold
  the announcement until it arrives — a second round trip and a new failure mode. That is a design
  decision, so it is yours.
* **No credit acknowledgement / idempotency key on the fishing report.** The credit and the chronicle
  push both happen *before* the reply is written, so a reply lost on the wire is a silent credit
  (measured: available count 0 → 1 with the reply discarded). It cannot lose a catch and cannot pay
  twice for one report. Fixing it properly is a protocol change.
* **106 legacy client probes were not re-run.** They are old visual/UI probes (drill aim, chat
  overlap, brightness, shop screenshots…) that need a window and touch nothing this session changed.
  Every probe that exercises fishing, gathering, claims, tools, physics or the network layer *was*
  re-run — see §7.
* **Pre-existing sim failures were left alone.** Nine backend sims and eleven scratchpad sims fail
  today exactly as they failed before this session; each was proven pre-existing by re-running it
  against the committed `HEAD:server.js` (§7). They are findings from earlier audits, not new damage.

---

## 5. What remains UNVERIFIED — read this section

* **Nothing has been deployed or built.** No web export was produced today. The fishing fix reaches
  players only after a new client build ships. **Deploy the client with or before the backend**, and
  do not consider `FFISH_AUTHORITY` until the new build is confirmed live in the wild.
* **No real browser was involved.** Everything client-side ran in the desktop Godot editor build.
  The WASM export, the browser's networking and the service worker are untested against these
  changes.
* **Real-world latency is untested, and this is the biggest one.** The design assumes the server's
  verdict comes back inside the strike window. Locally that was 10/10 and 12/12 verdicts in time —
  on a loopback. Render cold starts have previously measured **4.9–5.1 s** to first byte. On a cold
  instance the verdict will miss the window and the client falls back to its own roll: you would be
  shown a fish that never enters the chronicle — the old bug, in its milder form. Nobody has measured
  this against the live host.
* **No live players.** No test involved two real clients on the real server. Everything multiplayer
  was simulated locally.
* **I do not know what your Render environment variables actually say.** Section 6 lists what the
  *code* defaults to. If something was set in the Render dashboard, the code default is not the truth
  — please check the dashboard before trusting §6.
* **I cannot confirm the deployed backend equals the mirror's `HEAD`.** You push; I never do.
* **Anything needing your credentials was not attempted**: no admin key, no treasury key, no wallet,
  no Phantom session, no push, no deploy.
* **The WS-vs-HTTP latency claim is unproven here.** `_av_ws_load_sim` measures **0** WebSocket
  cycles in section C on *both* the current and the pre-session server, so its three failures there
  are pre-existing and the "WebSockets beat polling" number is not reproduced in this environment.
* **Phone-shaped UI was not re-checked.** Six probes need `CHIK_FORCEPHONE=1` and report that.
* **The one-die change is verified for the fishing path only.** Nothing was done to prove that other
  systems that ride on the same save/report machinery are unaffected beyond the suite in §7.

---

## 6. Feature flags as shipped (code defaults in `server.js`)

| Flag | As shipped | What flipping it on would do |
|---|---|---|
| `CHIK_ACTIONS` | **OFF** | Server adjudicates gathers, casts and strikes against its own position; wrong-tool claims refused when a tool is named; teleported casts held; casts with no water nearby refused. Honest refusals measured 0. Off = every reply byte-identical to today. |
| `FFISH_AUTHORITY` | **OFF** | Would make the acquisition book *binding* for fantasy fish (market listings, egg barter). **Do not flip until a client that sends `tier`/`rod`/`lvl` is live** — today it would refuse nearly every honest legendary. |
| `CHIK_CLAIM_TOKEN` | **OFF** | Requires a signed token on node claims; closes claim-as-someone-else. Needs a client that sends the token first, or gathering breaks. |
| `CHIK_PHYS` | **OFF** | Server simulates movement and corrects clients. The warp fix in §3.3 only matters here. |
| `CHIK_WS` | **ON** unless set to `0` | WebSocket world transport. |
| `CHIK_WORLD_TICK` | **ON** unless set to `0` | Server-owned monster pool. |
| `CHIK_MAT_ENFORCE` | **ON** unless set to `0` | Server-owned materials/gold. |
| `CHIK_CUP_AUTH` | **OFF** | Signature required on Cup routes. |
| `CHIK_QUEST_AUTH` | **OFF** | Signature required on quest claims. |
| `FFISH_DAILY_MAX` | **60/day** | The real ceiling on fantasy-fish rolls per wallet. |
| `MARKET_ONCHAIN` | env-dependent | Only active if you set it *and* a mint and team wallet exist. |

---

## 7. Final regression tallies (all re-run today, fresh, by me)

### Backend sims — `~/Downloads/chiki-backend`, all 88 `*_sim.js` / `*_sim.mjs`

**79 clean · 9 with failures, every one proven pre-existing.**

Proof method: each failing sim was re-run against a pristine copy of the **committed**
`git show HEAD:server.js` in an isolated tree. Same tally on both = not caused here.

| Failing sim | Today | Pre-session baseline | Verdict |
|---|---|---|---|
| `_atk_identity_sim.js` | 1 pass / 3 fail | 1 / 3 | pre-existing |
| `_atk_operator_sim.js` | 10 / 2 | 10 / 2 | pre-existing |
| `_av_ws_attack_sim.mjs` | 51 / 1 | 51 / 1 | pre-existing |
| `_av_ws_load_sim.mjs` | 5 / 3 | 4 / 4 | pre-existing (identical 3 failures; the 4th on baseline was timing jitter) |
| `_mob_spec_probe_sim.js` | 9 / 7 | 9 / 7 | pre-existing |
| `audit_predeploy_sim.js` | 26 / 4 | 26 / 4 | pre-existing |
| `crafting_sim.mjs` | 18 / 9 | 18 / 9 | pre-existing |
| `whisper_sim.js` | 3 / 9 | 3 / 9 | pre-existing |
| `world_concurrency_sim.js` | 33 / 9 | 33 / 9 | pre-existing |

Two notes that correct the hand-off I was given:
* `_av_ws_load2_sim.mjs` failed 3/1 while five sims ran in parallel and passed **4 / 0** re-run alone
  — CPU contention, not a defect.
* `mat_flow_forge_sim.js` and `bot_faucet_sim2.js` were described as never terminating. They do:
  **109.9 s → 80 pass / 0 fail / 1 hole**, and `bot_faucet_sim2` exits 0. They just need more than a
  100-second cap. `_refute_treeuses.js` is genuinely pre-existing (1 / 5, identical on baseline).

Green, this session's work first:

```
stage3_actions 41/0    _rv_stage3 41/0        fish_onedie 17/0      _rv_fish_onedie 17/0
_rv_fish_attack 17/0   _rv_actions_attack 34/0 (honest refusals 0)  _rv_physwarp 6/0
fish_report 13/0       gather_authority 24/0  kill_report 12/0      physics_authority 67/0
terrain_parity 405/405 world_tick 66/0        ws_transport 78/0     mmo_sync 29/0
world_share 24/0       world_share_v2 14/0    party 40/0            interest_radius 16/0
delta_snapshot 15/0    presence_auth 8/0      pvp_live 19/0         pvp_auth 12/0
econ 16/0              market fuzzer 8/0      critical_econ 10/0    market_griefing 12/0
acquisition_bound 49/0 asset_registry 59/0    asset_perimeter 55/0  asset_forge 36/0
asset_audit 26/0       chikimon_forge 52/0    chikimon_sync 24/0    mount_forge 40/0
mount_sync 26/0        census 44/0            census_consolidation 51/0  meme_cap 19/0
egg_hatch_authority 15/0  egg_restitution 34/0  raid_claim 30/0     session_lock 19/0
mat_flow 21/0          mat_flow_forge 80/0    mat_save_flip 37/0    node_persist 19/0
node_extent 5/0        list_qty 28/0          cancel_reclaim 17/0   auction_authority 6/0
forged_roster 7/0      jsonb_nul 15/0         cup_deck 6/0          cd_grief 2/0
wire 5/0               mobile_desktop_sync 45/0  skeptic_mobpool 28/0
av_flip_attack 44/0    av_interest_attack 29/0   av_census_attack 60/0
av_party_attack 54/0   av_party_attack2 34/0     av_phys_attack 26/0
av_phys_honest 17/0    av_phys_preexist 6/0      av_ws_bounds 25/0  av_ws_latency 3/0
nftmint_escrow 32/0    nftmint_registry 47/0     rarity_truth breaches=0
```

### Scratchpad sims — 59 files

**48 clean · 11 with failures, all pre-existing.** Eleven of them could not even start at first
(they import `./server.js`, which lives in the backend folder); with that resolved they ran, and each
matched either its twin in `chiki-backend` or the pre-session baseline exactly:
`cheatsweep 21/11`, `cheatsweep2 14/4`, `cheatsweep3 3/4`, `cheatsweep4 5/2`, `fishing_sim 37 ok/1`,
`gathering_sim 11 ok/3`, `quests_sim 28 ok/6`, plus older superseded copies of the `atk_*` /
`_av_attack` sims. Every one of those tallies is identical on the committed baseline server.

### Client probes — `ChikoriaSmooth/dev_*.gd`

* **173 probes with a DONE marker run headless.** 47 completed headless; 126 need a window (they
  build the island and a viewport) and were retried windowed.
* **71 retried windowed**, ordered so that everything touching fishing, gathering, claims, tools,
  the network layer and physics ran first. All of those completed. The 106 not re-run are legacy
  visual/UI probes for systems this session did not touch.
* **The two full-stack fishing probes were run windowed against their own local servers** — this is
  the real end-to-end proof:

| Probe | Result |
|---|---|
| `dev_scriptcheck` (every script compiles) | **bad=0, checked=389** |
| `dev_mirror` (client/server constant parity) | **bad=0, checked=34** |
| `dev_fishonedie` (odds diff + verdict rules) | **21 / 0** |
| `dev_fishonedie_w` (real Player vs local server, windowed) | **13 / 0** — 12/12 bites had the server's verdict by strike time; chronicle rows exactly equal the fish shown; 10 ordinary catches entered no row; live save stashed and restored byte-identical |
| `dev_rvfishw` (Lv 1 + Lv 10 rod + tier-3 spot + ×10 festival, windowed) | **17 / 0** — 16 casts, 0 legend verdicts, 0 snapped lines, chronicle unchanged |
| `dev_clientauth` (after the guard was re-pointed) | **21 / 0** (was 18 / 2) |
| `dev_fishevent` 16/0 · `dev_fishodds` bad=0 · `dev_fishfix` 9/0 · `dev_fishreport` 5/0 · `dev_fishline5/6` DONE · `dev_fishseed` digest 4057925147 | clean |
| `dev_gathertool` 8/0 · `dev_dropauth` 9/0 · `dev_claimq` 6/0 · `dev_claimdrain` 4/0 · `dev_raidclaim` 10/0 · `dev_toolsize` 5/0 · `dev_hudfit` 0 offscreen / 0 overlaps | clean |

Client probes that failed, all in systems untouched today (and none of them fishing, gathering or
network): `dev_drillcheck` 0/10, `dev_cloudsig` 9/3 (wants a live backend), `dev_duelwire` 8/2,
`dev_eventcheck` 5/2 (its expected event window has drifted), `dev_egghatch` 14/1,
`dev_creatortab` 12/1, `dev_dragscroll` 1/1, `dev_fishline` 1 fail — that last one stops on
`Player.gd:1441` with "node is not in a scene tree", a limitation of the probe's own harness while
building a tool, not of the fishing code; its sibling probes 5 and 6 pass and the full-stack probes
drove the real cast→bite→strike→reel→land loop 28 times without a hitch. Six more probes report they
need `CHIK_FORCEPHONE=1`.

Your live save was snapshotted before any probe ran and **restored afterwards**; the file on disk now
matches that snapshot hash for hash.

---

## 8. Where everything is

* Backend: `~/Downloads/chiki-backend/server.js` — mirrored byte-identically into
  `~/Downloads/chiki-backend-repo-FIXED/server.js` (`cmp` clean, `node --check` clean). Modified but
  **uncommitted**, along with `REWARD_SECURITY.md` §12.
* Client: `~/Downloads/ChikoriaSmooth/Player.gd`, `Net.gd`, and the updated probe `dev_clientauth.gd`.
  Not versioned, not built, not exported.
* New sims (mirrored into the deploy repo): `stage3_actions_sim.mjs`, `stage3_flagoff_driver.mjs`,
  `_rv_actions_attack_sim.mjs`, `_rv_fish_attack_sim.mjs`, `_rv_physwarp_attack_sim.mjs`,
  `_rv_secrets_probe.mjs`; plus `fish_onedie_sim.js` and `_fish_onedie_host.mjs` in the dev copy.
* New probes: `dev_fishonedie.gd`, `dev_fishonedie_w.gd`, `dev_rvfishw.gd`.

### If you only do three things
1. Build and deploy a client carrying today's `Player.gd` / `Net.gd`, and **append the release to
   `updates.json`** — this is a client-behaviour release, so the news board should say so.
2. Deploy the client with or before the backend. Leave `FFISH_AUTHORITY` off until that build is
   confirmed live.
3. Watch the fishing round trip on the real host. If Render's cold start pushes the verdict past the
   strike window, the fix quietly degrades to the old behaviour and only a live measurement will
   tell you.
