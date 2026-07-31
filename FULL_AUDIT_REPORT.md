# Chikoria Realm — full audit report

**Written 2026-08-01.** Nothing in this pass has been committed or pushed. Every change sits in your
working copies (`~/Downloads/chiki-backend`, `~/Downloads/chiki-backend-repo-FIXED`,
`~/Downloads/ChikoriaSmooth`) for you to read and commit yourself.

This is the plain-language version. It says what was looked at, what was broken, what is now fixed,
what was deliberately left alone, and — importantly — what nobody has actually proven yet.

---

## 1. Read this first

Three things need a decision from you before anything ships.

**1. Deploy the client BEFORE the backend, and leave three switches off.**
Three new security gates exist on the server: `CHIK_CLAIM_TOKEN`, `CHIK_CUP_AUTH`, `CHIK_QUEST_AUTH`.
All three are **off**. They must stay off until the new client is live. They ask the game to prove
who it is when it gathers, enters the Cup, or claims a quest chapter, and the build that is on
`chikimonsters.com` today does not know how to answer. Turning them on first would refuse 100% of
honest play. The gates each accept a correct credential and refuse a wrong one already, so you can
verify the client half first and flip them afterwards.

**2. Check that the client compiles immediately before you export.**
The client-prediction work is being written right now, and I caught it mid-edit. At **01:45** this
morning `dev_scriptcheck` reported `bad=2` — `Net.gd` (`Cannot find member "z" in base "Vector2"`,
in `_close_bucket()`, where `mv` is a `Vector2` and the code read `mv.z`) and `Player.gd:441`
(`_net_reconcile(delta)` called but defined nowhere). Both files had been saved **30 seconds
before** I looked.

By **02:00** it was clean again: `bad=0 checked=386`. So this was a transient half-saved state, not
a defect — but it is a live demonstration that the client on disk is not stable while two workflows
are writing to it. **Run `dev_scriptcheck` and require `bad=0` immediately before any export.**
My own client regression, taken earlier, was `bad=0 checked=383`.

**3. The backend file is being edited by another workflow while I write this.**
`server.js` went 8592 → 8601 → 8731 lines during this session. My changes are all still present and
the deploy mirror is byte-identical to the dev copy (both `md5 1b92eef1021536f0f040e2d775485bad` at
the time of writing), but any tally below is a snapshot, not a permanent state.

---

## 2. What was audited, and how

Ten areas of the game were taken apart: **hatching and eggs, fishing, gathering, crafting, battles
and the Cup, the economy and the Trading Post, quests and their real-money payouts, client/server
consistency, the save file, and the world routes.**

"Cheatproof" was not treated as a claim to be argued about. Every question was answered by booting
your real `server.js` **inside a test process** — a throw-away wallet key, a fake blockchain address
that goes nowhere, an in-memory database, and its own port each time — and then attacking it over
plain HTTP exactly as a modified game client could. **No probe ever touched the live backend, the
live database, the treasury, or any blockchain.** Read-only requests to the live API were used only
to look at public numbers.

The client half was tested by running the real GDScript through Godot and reading the actual values
back, not by reading the code and reasoning about it.

Every finding was then handed to a second, skeptical pass whose job was to *destroy* it: reproduce
it independently, or refute it. **Thirteen findings were killed that way** — they are listed in
section 5 so you can see what was thrown out and why.

---

## 3. What was fixed — in player terms

*Every "after" number below is an assertion inside one of the four sims written for these fixes
(`fix_hatching_sim`, `fix_world_sim`, `fix_market_sim`, `fix_battlequest_sim`) or one of the client
probes. I re-ran all of them from scratch in this final pass and they all pass — see section 7. If
one of those sims ever stops passing, the corresponding claim below has stopped being true.*

### Eggs, hatching and rare creatures

- **The rarest mounts could be taken by anyone, for free.** The hatch route let the game *name* the
  animal it wanted. Five brand-new wallets that had never played took all five griffins that will
  ever exist, in seconds. Now the server picks, exactly as it does everywhere else. Measured after:
  the second griffin request answers *"every griffin that will ever exist has been claimed"* instead
  of quietly handing one over.
- **One player could own three of the same legendary and sell them all.** Three `dragonos` went to a
  single wallet and all three were listed at 250,000 $CHIKI each. Now: one per species per player,
  the same rule the honest path already had.
- **A wallet that never played got 37 free legendary eggs and 37 free mount eggs.** That was the fuel
  for both of the above. Free eggs after the fix: **0**. An honest gatherer still gets served, and so
  does someone who is five short on every ingredient because their connection dropped.
- **Azulon's scroll gave away supply-capped avatars for nothing.** Twenty empty wallets minted forty
  capped avatars in a tenth of a second — permanently burning slots nobody can ever get back. Now the
  scroll costs what the game says it costs (230 materials), charged once; a second attempt is
  refused.
- **A lost reply could cost you your egg.** If the server hatched your creature but the answer never
  arrived, the game used to roll a *different* creature locally — one egg, two different animals,
  and your save and the server permanently disagreeing. Now the game re-sends the same request once,
  and if the server says "already hatched" it reads back what the server actually minted.
- **Refusals no longer create creatures.** Of fourteen possible server answers, fourteen used to
  hand you a creature anyway. Now exactly two do (success, and "no record" — which is the offline
  case). Your egg stays in the nest instead of disappearing.
- **Claiming an egg could take your materials and give you nothing.** If the mint failed, the game
  answered "nothing was consumed" — while 40 crystal had already gone. Now the difference is **0**.
- **The make-good for the July 27th egg wipe can no longer be farmed.** It used to read a counter
  the player's own game wrote, so a brand-new wallet could claim four capped assets. Now it checks
  the date the *server* first saw that wallet. Genuine victims — including a wallet back-dated to
  July 20th — still get all four.

### Gathering

- **Someone could gather in your name and lock you out.** A stranger could send claims using your
  wallet address; you got the material, but your own gathering was throttled to nothing (measured:
  attacker 3 nodes, victim 0, over ten seconds). Your game now signs its claims. Importantly, if it
  cannot sign — offline, or an older build — the message it sends is byte-for-byte what it sends
  today, so nothing breaks.
- **A retried claim used to lose the item.** If a claim was retried after a dropped connection, the
  material could be silently taken back. Now it is kept. The gathering security probe went from
  7 pass / 1 fail to **13 pass / 0 fail**.
- **Nodes that do not exist can no longer be invented.** A fabricated kind (`essence:800:-400`) used
  to credit real, sellable essence. It is now refused, credits nothing, and does not pollute the
  shared node map. Writing the same rock's position six different ways used to yield six drops; it
  now yields one.
- **Teleport farming is over.** One wallet used to sweep all 24 monster spawns in 10.2 seconds and
  bank 48 essence. It now banks a fraction of that. The teleport itself is still allowed — Chikoria
  moves players around legitimately — but a gather or a kill cannot be *banked* for three seconds
  after an impossible jump. A runner at 18 units/second and a boat at 70 are unaffected; both were
  measured.
- **A pure-HTTP essence tap is closed.** A wallet that never fought anything could mint 7,194
  sellable essence an hour. Now: **0**.
- **One item per gather still holds.** Verified again this pass at real island coordinates: a wood
  claim pays exactly `["wood"]`, length 1. The cow remains the one documented two-material node
  (`beef` + `hide`) — that is by design and unchanged.

### The Trading Post and the economy

- **Goods could be sold that were never gathered.** Craft-order deliveries bypassed the ownership
  check completely: 30 deliveries of 99 gold each, from a wallet with no gathering record at all.
  Now 15 are served (the wallet's real allowance) and the rest are refused; declining an order
  correctly returns the goods.
- **A poster could destroy a filler's goods.** Re-using a settled order id silently swallowed the
  second return — the filler's materials simply vanished. Re-posting a used id is now refused.
- **Auctions accepted made-up money.** Every ordinary listing settles on the real blockchain rail,
  but auctions did not: a wallet with a zero balance bid 50,000 and won a real creature, which it
  could then sell for real $CHIKI. Both the posting and the bid are now refused while the on-chain
  rail is live.
- **The Trading Post double-sale fix from July 25th was re-verified** and still holds.
- Smaller: the seller's quoted share now reads the real split constant instead of a hard-coded
  0.75; listings and craft orders check that the item is a real item.

### Battles and the Cup

- **World duels accepted a completely made-up fighter.** An opponent could arrive with 1,200,240
  health against your 840 — 1,429× — and a full deck of the strongest cards. Both sides are now
  built the same way: 840 against 840, every card at tier 1, and a claimed battle rating of 100,000
  becomes 50.
- **Strangers could be dragged into a tournament they never entered.** Anyone could seat seven
  other people in a Cup lobby, filling it so real entrants were locked out and the attacker had a
  clean run at the 1.00 SOL champion prize. Registration now needs proof. Honest entry — both from
  in-world and with a credential — still works; a wrong credential is refused.
- **Card power could be farmed by doing nothing.** Deck tiers grew on wall-clock alone: three cards
  to eleven by idling, or a full twelve-card deck in a single save. Tiers are now ceilinged by wins,
  and — this matters — **nothing already stored is ever reduced.**

### Quests and real money

- **Long-standing players were permanently stuck.** Anyone who was playing before July 24th jammed
  at Chapter 15 forever, with 83,000 real $CHIKI blocked and the 1,000,000 winner slot unreachable.
  Measured after the fix: **20 chapters and 91,000 $CHIKI** flow through, with only one genuine
  gameplay requirement left in the way. No back-fill script is needed.
- **A cloud restore could pay you twice.** Signing in on a second device re-queued 63 chapters worth
  112,030 $CHIKI for someone who had already banked most of it. The overpayment is now **0**.
- **One unsigned number in the save was worth 12,030 real $CHIKI.** Editing the "last saved" time in
  the local file re-opened the same double payment with no tamper flag raised. The save seal now
  covers it (version 15). Every older save still verifies clean — twenty save/reload cycles produced
  **zero** false tamper flags.
- **The grand-prize claim was not what the comment said.** A comment promised the winner's holdings
  were re-checked at payout; that check did not exist, which meant 500,000 $CHIKI cycled through ten
  wallets could have captured all 10,000,000 of the prize pool. The check is now real — and it
  *skips* a wallet rather than clearing it, so nobody is silently disqualified.
- **The chapter queue could deadlock.** A single blocked chapter used to stop all the others
  forever; now three of four drain and only the genuinely blocked one waits.

### Fishing

- **Your fishing rod was invisible to the server.** Every catch report arrived with no rod and no
  spot, so the server rolled at rod 0 — a **0% chance of any legendary, across 4,500 reports**. The
  report now carries the tier, the rod and your level, and the server's answer is recorded.
- **A festival that had ended still gave festival odds** until a network reply happened to arrive.
  Now it expires on time: 0.024 outside the window, 0.096 inside it — exactly 4×, as intended.
- A daily ceiling was added to the fishing tap so a bot cannot mint an endless supply of catches
  into the record.

### Crafting

- **The five ANCIENT recipes paid half the crafting experience** for the same materials and twice
  the output. Now 28 XP against 28, on all five.
- The masterwork tooltip said "half the materials refunded"; on small recipes it can refund two
  thirds. The wording now says "at least half" rather than changing what players get.

---

## 4. What I fixed in this final pass

One real defect, found while re-running everything.

**Four real trees could not be chopped.**
The teleport fix added a sanity bound: a gather has to happen somewhere on the island. That bound
was sized from the placement ring the game uses for rocks, berries and flowers (a maximum of 640
units from the island centre) plus the mines (669). But **trees are not placed by that rule** — they
come from an authored file, and the furthest one is **927.8 units out**. The bound was 900.

Measured before the fix, chopping the four widest real trees:

```
wood:178:707   radius 927.8   HTTP 400  "no such node"
wood:-162:701  radius 919.7   HTTP 400  "no such node"
wood:398:618   radius 912.4   HTTP 400  "no such node"
wood:-192:675  radius 900.2   HTTP 400  "no such node"
```

A player would have chopped for sixteen seconds and been given nothing, every time, forever, on
those four trunks. Measured after (bound raised to 1000):

```
wood:178:707   radius 927.8   HTTP 200  drop=["wood"]
wood:-162:701  radius 919.7   HTTP 200  drop=["wood"]
wood:398:618   radius 912.4   HTTP 200  drop=["wood"]
wood:-192:675  radius 900.2   HTTP 200  drop=["wood"]
```

The bound still refuses what it was built to refuse — a claim 20,000 units off the island, and one
1,400 units out, are both still rejected. A new permanent guard, `node_extent_sim.js`, reads your
client's own tree data and fails if any real node ever falls outside the bound again (**5/5**).

This was caused by this session's own work and is now closed.

---

## 5. Found, and deliberately NOT fixed

### Thirteen reported problems were wrong, and were thrown out

Each of these was reproduced and found to be either a non-issue or a duplicate. They are listed so
you know they were considered, not missed.

| Claimed problem | Why it was rejected |
|---|---|
| Fantasy-fish possession is unenforced | Deliberate and documented. Turning it on today would refuse fish players watched themselves catch — the same harm as the gold wipe and the July egg wipe. |
| The save clamp is inert because the client sends version 1 | This is the written plan, in the code, in as many words: do not bump the client until it can read the corrections. Not a defect. |
| The baseline is taken net of market escrow | Not reachable: the bag caps at 1,100 per material, below the 1,500 allowance. Filed as a note for whoever lowers the allowance later. |
| Craft spends are never debited | Duplicate of the potion issue below. |
| The outbid-refund queue is a money tap | Refuted: it mints 10,753 fake $CHIKI over 172 requests, when one save field already mints nine trillion. Not an independent hole. |
| Every save truncates the old-game roster to 3 | Refuted — that is the anti-cheat working. The old game could never grant more than 3. The proposed "fix" would have made forged rosters permanent. |
| The allowance forgives 1,500 of every material | Correct observation, deliberate trade-off, and the report itself concluded nothing should change. |
| The refusal is "laundered end to end" | Only one of four refusal types could pass through, and the honest game never reaches it. Merged into the duplicate-species fix. |

Also rejected: three findings that could not be reproduced at all (a "vacuous" anti-win-farming
guard, client-side incubation fast-forwarding, and one framing of the potion issue).

### Real problems, deliberately left open

- **Crafted potions can be sold without ever having been crafted.** A wallet that has crafted nothing
  can list 900 healing draughts and it is accepted (measured, status 200). This is excluded *on
  purpose*: potion recipes are still calculated by your game, not the server, so enforcing this today
  would refuse honest brewers. It closes when crafting moves server-side. **This is the one
  real-money surface still open, and you should know about it.** The bound is soft — a buyer has to
  volunteer real money at a price the seller sets — but it is real.
- **There is still no list of where the nodes are.** The server now checks that a gather is of a real
  kind, on the island, within reach, and not faster than a human. It cannot check that a rock is
  actually *there*, because most node positions are generated by the game's own random number
  generator against the terrain, and pigs and cows *wander* — no fixed list can ever contain them.
  The remaining limit is the pace floor, which caps a fabricator at the same ~33 claims a minute an
  honest player gets. Closing this properly means dumping the position list from a real build and
  shipping it as data.
- **The fantasy-fish enforcement switch is still off.** It cannot be turned on until the new client —
  the one that reports rod and tier — is live everywhere. Flipping it early refuses honest anglers.
- **The trainer-level requirement for landing a legendary fish is client-side only.** The report now
  carries your level but the server ignores it. Low value; parity work.
- **The MALGROTH raid prize is still paid by your game, not the server.** The server gate is correct
  and idempotent but moves no value. The client already prefers server-reported amounts, so the
  server half can be added later without another client release.
- **The tree "loads remaining" count is still caller-controlled.** A modified client can tell the
  server a trunk has one load instead of three and fell it for the whole world in a single chop.
  This pre-dates this session (it fails identically against the last committed backend) and is
  griefing rather than theft.
- **Crafting XP for double-brew recipes was corrected, but `XP_CRAFT` itself was not touched** — it is
  a number you tuned by eye.
- **`CLAIM_BURST` is unreachable dead code.** Lowering it would put it within 8% of a real player's
  best berry-picking rate. Left alone, commented.

---

## 6. What is still unverified — the honest gaps

- **Nothing was tested against the live database or the live treasury.** Every measurement here comes
  from a server booted in a test process with an in-memory store. Behaviour that only appears with
  real Postgres, real balances, or real transactions is unproven.
- **The live environment variables are unknown.** `render.yaml` in the repo says `VERIFY_HOLDERS=false`
  while the live `/stats` reports mainnet with a 500,000 minimum hold — so the dashboard clearly
  overrides the file. **Only you can confirm what `FFISH_AUTHORITY` and the three new gates are
  actually set to in production.**
- **How many players are affected by the quest jam is unknown.** The mechanism is proven; counting the
  people it hit needs admin access to the live database, which was not used.
- **No blockchain transaction was ever executed.** Every settlement test ran against a dead RPC
  address. The money paths are verified in shape, not in flight.
- **The Cup prize (1.00 SOL champion, 4.00 SOL pool) was never paid in a test.** Lobby stuffing was
  fixed and verified; the payout itself was not exercised.
- **Two probes that need a phone were run with the phone flag forced on a desktop window.** They pass,
  but that is not a real phone.
- **The WebSocket transport, the party system and the terrain work are another workflow's, in flight.**
  Their sims were run and are reported below, but their code was not audited by this pass and was
  changing while it ran.
- **The client-prediction code being written right now (`Net.gd`, `Player.gd`) is unfinished and
  untested by anyone.** See section 1.

---

## 7. Regression results

Both suites were re-run from scratch in this final pass — not trusted from earlier reports.

### Backend

I ran it twice: once on arrival, and again after fixing the tree bug and correcting the sims whose
test coordinates the new island bound had invalidated.

```
first run   111 files  ·   99 clean ·  12 not clean  ·  1834 assertions passed  ·  71 failed
final run   113 files  ·  101 clean ·  12 not clean  ·  1926 assertions passed  ·  49 failed
            (113 = 111 + node_extent_sim.js + one sim another workflow added mid-run)
```

Every one of those files boots your real `server.js` in-process with a throw-away key, a dead RPC
address, an in-memory store and its own port.

**Files that do not come back clean, and why:**

| Sim | Result | Verdict |
|---|---|---|
| `whisper_sim.js` | 3 pass / 9 fail | **Pre-existing.** Identical against the last committed backend (3/9). It asserts the *old, broken* whisper behaviour; whispers were fixed, so it fails. It needs rewriting, not the code. |
| `audit_predeploy_sim.js` | 26 / 4 | **Pre-existing.** Identical against the committed backend (26/4). |
| `_mob_spec_probe_sim.js` | 9 / 7 | **Pre-existing** (committed backend: 9/7). Two of its assertions said "the teleport sweep clears the island" — that is now false because the sweep is blocked, so I inverted those two with a comment explaining what changed. |
| `_refute_treeuses.js` | 1 / 5 | **Pre-existing** (committed backend: 1/5). Documents the open tree-loads weakness in section 5. Its test coordinates were 1,142 units off the island and had to be moved onto it. |
| `_probe_nodegrief.js` | 8 / 2 | **Pre-existing** (committed backend: 8/2). Same coordinate move. |
| `world_concurrency_sim.js` | 33 / 9 | **Pre-existing** (committed backend: 33/9). Its node fixtures sat 60,000 units off the island; moved on-island with a comment. |
| `world_concurrency_sim2.js` | 11 / 3 | **Pre-existing**, identical. |
| `world_concurrency_sim3.js` | 10 / 2 | **Better** than the committed backend (8/4). |
| `world_concurrency_sim4.js` | 6 / 2 | **Better** than the committed backend (3/5). Its "every gatherable kind pays a drop" check was claiming at x = 20,000 and read as *"gathering is broken"*; moved on-island, now 12/12 kinds pay correctly. |
| `world_concurrency_sim5.js` | 1 / 4 | **Pre-existing**, identical. |
| `_av_ws_attack_sim.mjs` | 50 / 2 | **Not this session's.** The WebSocket transport does not exist in the committed backend at all — it is another workflow's in-flight work, and it changed between my two runs. Its remaining failure is a shared delta-memory leak between two sockets. |
| `_av_ws_load_sim.mjs` | timed out | Same workflow; a load test that needs longer than the cap. |

Every failure above is either pre-existing (proven by running the same sim against the last
committed `server.js`) or belongs to another workflow's in-flight code. **No failure in this suite is
caused by this session's changes.** The four sims written for this session's fixes —
`fix_hatching_sim` 25/25, `fix_world_sim` 29/29, `fix_market_sim` 19/19, `fix_battlequest_sim` 28/28
— all pass, plus the new `node_extent_sim` 5/5.

### Client

29 probes, run through Godot against the real game scripts. **All 29 clean.**

- **`dev_scriptcheck bad=0 checked=383`** at the time of my run.
- New: `dev_mirror` bad=0 (34 checks) · `dev_sig15` 17/0 · `dev_hatchverdict` 21/0 ·
  `dev_clientauth` 20/0 · `dev_queuefix` 13/0 · `dev_livesigcheck` bad=0
- Updated: `dev_gathersecprobe` 13/0 · `dev_questcloud` findings=0 · `dev_act1` bad=0 ·
  `dev_craftmw` bad=0 · `dev_matflow` 19/0 · `dev_sealfix` 10/0 · `dev_resto` fails=0 · `dev_fishingdim`
- Standing: `dev_mobileux` 14/0 · `dev_camlook` 8/0 · `dev_worldfeed` 19/0 · `dev_fishevent` 16/0 ·
  `dev_moments` 12/0 · `dev_bigmap` 12/0 · `dev_gathertool` 8/0 · `dev_eggcart` 8/0 ·
  `dev_mobiledesk` 21/0 · `dev_floorparity` 18/0 · `dev_eggsig`/`dev_persist`/`dev_walletsw`/`dev_ceremony` fails=0

That is **249 counted assertions, 34 mirror checks and 383 script compiles, with zero failures.**

`dev_mobileux` and `dev_camlook` failed on my first attempt (12/2 and 5/3) and I chased it down
rather than waving it off. The cause was not the game: an earlier probe had left a **test save** on
disk, that save has `seen_intro = false`, so the game correctly popped the first-run welcome — and
the touch controls correctly suspend themselves while a full-screen dialog is up, which meant every
simulated tap did nothing. The diagnostic printed `_blocked() = true, intro.visible = true`. Re-run
on your real save, both pass: camera yaw moved 0.0000 → -0.7200, pitch 0.7299 → 1.2699, pinch
distance 25.495 → 17.157.

---

## 8. One housekeeping problem you should know about

**Seven of the nine scene probes leave your live save replaced by a test fixture.** I measured this
directly, restoring your real save before each one:

```
after dev_sig15      INTACT
after dev_questcloud INTACT
after dev_act1       CLOBBERED  (level 21, 250,000 $CHIKI)
after dev_resto      CLOBBERED
after dev_eggcart    CLOBBERED
after dev_eggsig     CLOBBERED  (1,234 $CHIKI)
after dev_persist    CLOBBERED  (12,345 $CHIKI)
after dev_walletsw   CLOBBERED  (4,242 $CHIKI)
after dev_ceremony   CLOBBERED
```

Five of those (`dev_eggsig`, `dev_persist`, `dev_resto`, `dev_walletsw`, `dev_ceremony`) are in
`preflight.sh` — the script you run before **every** export. `dev_act1` even prints
`SAVE restored 9578 bytes identical=true` and is *still* clobbered afterwards, which means something
saves over the restored file during shutdown. `dev_persist` has the same shape and the same result.

Nothing was lost here. Your save was backed up before I started and restored byte-for-byte
afterwards (`sha256 2ed96252…`). It then drifted a little more while the last few probes ran the
real game for 22 seconds each, so the file on disk now differs from that backup — but only by
things you *gained*: an egg's incubation ticked forward, a pet's bond went 7.49 → 9.75, the "mine"
recipe was discovered, the news pop was marked seen. All 89 fields are present, none lost, and the
final state verifies clean: **seal version 15, signature matches, level 17, 4,264.5 $CHIKI, 7
creatures, horse.** Until those probes are made safe, **back your save up before running
preflight.**

Backup kept at:
`/private/tmp/claude-502/-Users-michaelkennethbrillantes-Downloads-chiki-monsters-github/af3679f8-9bd4-4f61-b5ce-8d086a78fa4b/scratchpad/FINALPASS_save_backup.json`

---

## 9. Files touched

Nothing committed. Nothing pushed.

- `~/Downloads/chiki-backend/server.js` and `~/Downloads/chiki-backend-repo-FIXED/server.js`
  (byte-identical mirrors)
- `~/Downloads/chiki-backend/node_extent_sim.js` (new guard, mirrored)
- Dev-only sims corrected for the new island bound, with comments saying why:
  `_refute_treeuses.js`, `_probe_nodegrief.js`, `_mob_spec_probe_sim.js`,
  `world_concurrency_sim.js`, `world_concurrency_sim4.js` — none of these ship
- `~/Downloads/ChikoriaSmooth/` — the client fixes from earlier in this session, plus one new
  diagnostic probe, `dev_touchdiag.gd`
- `~/Downloads/ChikoriaSmooth/updates.json` — the 2026-08-01 entry
- This report, in both backend copies
