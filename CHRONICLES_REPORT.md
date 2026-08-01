# The Island's Chronicles — notification button with a history that is kept

Written for someone who was away. Plain language first, numbers where the numbers matter.
Nothing here has been committed, pushed, or sent to the live backend.

**What was asked for:** *"make the island's chronicles a button where players can click and see all
updates, DO NOT ERASE THE HISTORY, just make it a notification button."*

**What was built:** the pill under the minimap is now a button with an unread badge; clicking it
opens a pop-up listing every moment the player has ever been told about, newest first; and the
history is retained on disk, survives a reload, and cannot be erased by a stranger.

---

## 1. What a player now sees and can do

The blue pill under the minimap has always announced rare moments as they happen — a legendary
hatch, a Meme Dynasty arrival, a new steed, a fabled catch. It still does. It still shows the
newest four headlines, and it still scrolls. Nothing about how it looks at rest has changed.

What is new:

- **The pill is now a button.** Click or tap it and the Island's Chronicles pop-up opens. Tap it
  again and it closes, the same toggle the top-bar tabs use.
- **A small gold number sits in its top-right corner** — how many moments have arrived since the
  player last opened the pop-up. It is empty when there is nothing new. Opening the pop-up clears
  the number. It never clears the history.
- **The pop-up lists everything**, newest first, with a count at the top ("Recorded moments · 47").
  Each line shows the actual creature's or fish's own artwork, who did it and what they did, the
  category and species written out underneath, and how long ago it happened ("3m ago", "2h ago").
- **It closes with the ✕ in the top-right corner** — the house standard, no second close button at
  the bottom. Parchment styling, sized to fit the screen, and on a phone it fits inside the screen
  with the touch buttons and chat still reachable (measured: the card lands at (16, 117.8) and is
  441 × 444 inside a 1185 × 667 phone viewport, overlapping nothing).
- **If the history is empty** — which is what most players will see on the first day — the page
  says so in-world rather than looking broken: *"The chronicle is blank — the island is still
  waiting for its first legend."*
- **New moments flow into the page while it is open.** No need to close and reopen.

On a phone the pill now steps out of the way of an open pop-up and of the chat box, so the tap
always goes where the player is looking.

---

## 2. HOW THE HISTORY IS KEPT

This is the part that was emphasised, so it is spelled out in full rather than summarised.

### Where the history actually lives: on the player's device

The server's chronicle is **island-wide and shared** — everyone's moments mixed together. It is not
a per-player archive and it cannot be, because it holds only the most recent activity for the whole
world. So **the player's own history is the copy on their device.** That copy is the one the
owner's rule protects, and it is the one built here.

| | Bound | What it means |
|---|---|---|
| In memory while playing | **300 entries** | The newest 300 the player has ever been shown |
| Saved to the device | **300 entries** | Same number — a reload loses nothing |
| Carried in the cloud save | **300 entries**, trimmed only if the whole profile would be too big | Cross-device history |
| Shown on the pill itself | 4 headlines | Unchanged; the rest is in the pop-up |

**The two client bounds are deliberately the same number.** They were not, and that was a defect
found in this pass: memory held 300 but the save held 200, so a player who had seen 300 moments and
then reloaded came back to 200 — a silent erasure of 100 entries they had already read. That is
exactly the thing the feature exists to prevent, so the saved bound was raised to match. The local
save file has no size ceiling, so this is free: measured at roughly 74 bytes per entry, 300 entries
is about 22 KB on disk.

### What survives what

- **A page refresh or reloading the game: everything survives.** Proven end-to-end — the probe
  writes the history, reloads through a real save/restore round trip, and all entries come back,
  along with the read-marker (so the badge does not falsely light up) and the pill's headlines.
- **Switching devices: up to 300 entries travel with the cloud save.** The one exception is a
  player whose profile is already very large. The backend refuses any profile over 65,000 bytes and
  that refusal loses the *whole* save, not just the overflow — so if the profile plus the full
  history would cross the line, the *exported copy* drops chronicle entries until it fits (measured:
  a 45 KB profile that would have been 83,101 bytes exports at 59,446 bytes, keeping 37 entries).
  **The copy on the device still keeps all 300.** The trim is export-only, and it is
  signature-neutral, so it cannot invalidate the save.
- **A server restart:** the server's own 400-entry backlog is written to the database and restored
  on boot, the same way world chat is. On the live Render deployment (which has a database) the
  island-wide backlog survives deploys and spin-downs. Without a database it is memory-only and
  dies with the process. **Either way the player's own history is unaffected** — it is on their
  device, not the server's.

### The bounds are large, documented, and never silent

- **300 entries** on the client, **400** on the server. Both are constants with the arithmetic
  written next to them in the code (`CHRON_CAP` / `CHRON_PERSIST` in `Net.gd`, `WORLD_FEED_MAX` in
  `server.js`).
- **When the client is full, the entry dropped is the oldest one belonging to whoever holds the
  most entries** — never simply the oldest overall. Oldest-first is the obvious rule and it is the
  one a flood exploits: 300 entries from one loud source would erase every moment the player
  actually cared about. Measured: after a 600-entry flood from a single name, all 12 other
  trainers' moments and all 3 of the player's own survived. **The player's own moments are never
  the ones dropped while anyone else's remain.**
- **The server applies the same idea**: any one wallet holds at most 24 of the 400 entries, and at
  that share it replaces its *own* oldest rather than a stranger's. When the ring is genuinely full
  the entry dropped belongs to whoever holds the most. Measured on 20 wallets pushing 450 entries:
  400 kept, every wallet still holding 20, and all 50 of the newest entries intact.
- **Nothing periodically clears the list.** The de-duplication keys are erased one at a time with
  the entries they belong to, so replaying the same moment never adds it twice and never resets
  anything.

### The one thing that genuinely cannot be recovered

**Moments that scrolled past before this ships are gone.** The old client stored nothing — the pill
was a rolling ticker and what scrolled away was never written down anywhere. Retention starts the
day this deploys. There is no way to reconstruct what earlier players saw, and it would be wrong to
imply otherwise.

---

## 3. Every defect found and fixed

### Found in this final pass

1. **A reload silently dropped up to 100 entries the player had already read.** The in-memory bound
   was 300 and the saved bound was 200. Directly against the owner's rule. Fixed by matching them at
   300; the local save has no size ceiling and the cloud overflow case was already handled
   non-destructively. The probe now asserts the invariant itself — the saved bound may never be
   smaller than the memory bound — so it cannot silently drift back.

2. **The unread badge clipped its own number.** Measured, not guessed: the badge slot is 19.0 px
   wide at font size 10, and any three-character count renders 22.0 px — so "300" was drawn wider
   than the box it sits in. This is reachable in ordinary play (the maximum unread count is 300, and
   a player away for a week hits three digits easily). Fixed by capping the *label* at "99+" while
   the *count itself* stays exact, and widening the slot to 24 px so "99+" fits with margin. The
   probe now measures the rendered width against the slot and asserts it fits.

3. **The retention sim was testing a contract that no longer existed.** `feed_backlog_sim.mjs`
   pushed 300 entries from a single unproven `godot-…` presence id — which the security work
   correctly now refuses outright, so the sim retained zero and failed. It was written before the
   author rules existed and had never been re-run after them. Rewritten to fill the history the way
   a real island does, from 20 proven wallets, which now proves retention *and* fairness in one run,
   plus the small-default-page rule and the negative/garbage limit cases. 34 checks, all passing.

4. **An older adversarial sim asserted that the chronicle was floodable.** `_rv_fish_attack_sim.mjs`
   section E checked `flood > 0` — it *recorded* the hole as expected behaviour, because when the
   feed was an 8-entry rolling ticker the flood was cosmetic and the fix was deferred. Retention
   turned that same flood into permanent destruction of the history, and the fix closed it, so the
   sim now failed. **Bisected before changing anything:** booting the deployed `git HEAD` server
   scores "24 fabricated ids wrote 8 of the 8 chronicle rows" and passes 17/17; the patched server
   scores 0. The assertion was inverted to the fixed contract with the history written into the
   comment, and a second check added that no genuine entry is evicted by the attempt. 18 checks, all
   passing.

5. **A stale comment in `Net.gd`** still described the server as keeping "an 8-row in-memory ring,
   forgotten on restart" — untrue since the retention work. Corrected to describe what is actually
   there, and why the client copy is still the player's history regardless.

6. **A hard-coded 200 in the adversarial probe** would have quietly stopped testing the real worst
   case once the bound moved. Now sized from the constant.

### Fixed earlier in this task, verified again here

The retention change and the button were built first, then attacked. The attack found real defects,
all of which are closed and re-proven by the runs in section 6:

- **Anyone on the internet could erase the entire history in 12.3 seconds**, and the erasure
  persisted to the database. Fabricated presence ids could write chronicle entries; raising
  retention turned that from ticker spam into destruction of the feature. Now the author must be a
  proven wallet, no author can evict another, and the trim is fair. Measured before/after: attacker
  entries 400/400 → 0/400; genuine moments 0/12 → 12/12.
- **The restored database blob was never re-validated** — a corrupted or hostile blob was trusted
  wholesale, including a far-future timestamp that would have silenced the chronicle for every
  player at once. Now re-validated on the way in.
- **The public chronicle endpoint was an unauthenticated bandwidth amplifier** — 33,761 bytes per
  request, 18.3 MiB/s of egress from one client. The default page is now 60 entries; the full
  backlog is still available but has to be asked for.
- **A stranger's player-typed name was fed to the rich-text renderer unescaped.** Transient before;
  retention would have made it a *stored* injection replayed on every boot and carried in the cloud
  save. Escaped.
- **Loading the saved history was unbounded**, and **two distinct events in the same millisecond
  were silently merged into one**, and **the client's trim was oldest-first** (so a flood erased
  everything). All three fixed.
- **The chronicle could grow large enough to make the whole cloud save be rejected**, losing
  everything. Now trimmed in the export only.
- **A desktop regression introduced by the button itself** — the new clickable pill sat underneath
  an open pop-up's category tabs. It now yields its input while a pop-up is up.

---

## 4. What is deliberately not done, and why

- **The server does not back-fill a new player's history.** Its 400-entry backlog is island-wide,
  not per-player, and handing a brand-new player 400 strangers' moments as "their" chronicle would
  be a fiction. A player's chronicle starts when they start.
- **No production client calls `GET /world/feed`.** The 400-entry server backlog exists for
  operators and diagnosis. The player's pop-up is drawn entirely from the local copy. This is
  deliberate: it means the pop-up opens instantly, works offline, and cannot be affected by what
  another player does to the shared ring.
- **A player without a connected wallet no longer writes to the shared chronicle.** Their legendary
  still hatches, is still shown to them, and is still banked — it just does not enter the island's
  permanent shared record, because a permanent record is value and value settles against a wallet.
  This is a real narrowing compared with before and is stated plainly rather than buried.
- **There is no per-author rate limit.** One was written, proven to work, and then removed: with the
  fair-share cap it protects nothing, and it *would* drop a real moment whenever an angler lands two
  legends inside the window. Refusing to record something that actually happened is the one failure
  this feature must not have.
- **No filtering, searching or paging in the pop-up.** At 300 entries a scrolling list is fine.
  Worth revisiting only if the bound ever grows.
- **`updates.json` was not touched.** That is the release-notes board, a different feed; the parent
  session writes the release note.

---

## 5. What remains unverified

Honest limits of what could be checked on this machine:

- **No real phone.** All phone results come from a forced phone-shaped viewport in the desktop
  engine. Real touch latency, real Safari/Chrome behaviour, and real device pixel ratios are
  untested.
- **No real browser.** Everything ran in the native Godot build. The WASM build was not produced or
  loaded, so nothing here is verified against the browser client.
- **No live players.** All multiplayer behaviour is simulated in-process. Nobody has clicked the
  button.
- **No Postgres on this machine.** The server's restart-survival is proven by calling the real save,
  wipe and restore functions in one process — a true cross-process restart with a database was not
  possible. The behaviour on live Render (which has a database) is inferred from the fact that this
  uses the identical mechanism world chat already uses in production.
- **No live backend call was made at any point.** Every simulation booted its own copy of the server
  with a throwaway keypair, a dead RPC endpoint, an in-memory store and its own port.
- **The visual result was checked from screenshots and measured rectangles**, not by a person
  looking at the running game.
- **Nothing has been committed or pushed.**

---

## 6. Regression tallies

All re-run fresh in this final pass. Every number below is from a run made after the last code
change, not carried over.

### Client probes (Godot, windowed; `dev_scriptcheck` headless)

| Probe | Result |
|---|---|
| `dev_scriptcheck` | **bad=0** |
| `dev_worldfeed` | **19 pass / 0 fail** |
| `dev_bigmap` | **12 / 0** |
| `dev_moments` | **12 / 0** |
| `dev_chronicles` (desktop) | **37 / 0** |
| `dev_chronicles` (phone) | **43 / 0** |
| `dev_chronattack` (desktop) | **19 / 0** |
| `dev_chronattack` (phone) | **19 / 0** |
| `dev_mobileux` (phone) | **14 / 0** |
| `dev_hudfit` (phone, panel) | offscreen=0 · overlaps=0 · small=0 |
| `dev_hudfit` (phone, pop-up) | offscreen=0 · overlaps=0 · small=0 |
| `dev_hudfit` (phone, chat) | offscreen=0 · overlaps=0 · small=0 |

Notable values printed by the runs: 300 entries retained of 328 arrivals; 300 entries in the save
(equal to memory — a reload loses nothing); unread count exact at 300 with the label reading "99+"
at 22.0 px inside a 24.0 px slot; the ✕ at x=406 against a card centre of 236; the leviathan's
artwork resolving through the fish table because its conventional path does not exist.

### Backend simulations

Every one boots the real `server.js` in-process with a throwaway keypair, a dummy RPC URL,
`VERIFY_HOLDERS=false`, no database and its own port.

| Simulation | Result |
|---|---|
| `feed_backlog_sim` (retention, backlog, persistence, old-client A/B) | **34 / 0** |
| `chron_attack_sim` (adversarial: can the history be erased?) | **46 / 0** |
| `chron_secrets_probe` | **16 / 0** |
| `fish_onedie_sim` | **17 / 0** |
| `_rv_fish_onedie_sim` | **17 / 0** |
| `_rv_fish_attack_sim` | **18 / 0** |
| `world_share_sim` | **24 / 0** |
| `world_share_v2_sim` | **14 / 0** |
| `mmo_sync_sim` | **29 / 0** |
| `mobile_desktop_sync_sim` | **45 / 0** |
| `ws_transport_sim` | **78 / 0** |
| `node_persist_sim` | **19 / 0** |
| `fish_report_sim` | **13 / 0** |
| `kill_report_sim` | **12 / 0** |
| `delta_snapshot_sim` | **15 / 0** |
| `presence_auth_sim` | **8 / 0** |
| `interest_radius_sim` | **16 / 0** |
| `party_sim` | **40 / 0** |
| `pvp_live_sim` | **19 / 0** |
| `econ_sim` | **16 / 0** |
| `market_sim` | **8 / 0** |
| `gather_authority_sim` | **24 / 0** |
| `stage3_actions_sim` | **41 / 0** |
| `_rv_stage3_sim` | **41 / 0** |

**24 simulations, 0 failures.**

### The two failures this pass produced, and what they turned out to be

Both were stale tests, not server defects, and both were proven so by bisecting against the
deployed server rather than by assertion:

- `feed_backlog_sim` retained 0 of 300 — because it authored from an unproven presence id, which the
  server now correctly refuses. Rewritten to the current contract.
- `_rv_fish_attack_sim` section E failed — because it asserted the chronicle *was* floodable.
  Booting `git HEAD:server.js` (byte-identical to the deployed baseline in the repo) reproduces the
  flood at 8 of 8 entries and passes 17/17 there; the patched server scores 0. The assertion was
  inverted to the fixed behaviour.

### Old clients are unaffected — proven, not claimed

Two real child processes, deployed `git HEAD` against the patched server, one fixed transcript,
normalised only on the wall clock:

- First contact: both serve the same 8 entries, 457 bytes each.
- Caught-up cursor: both omit the feed key entirely.
- Three new events: identical deltas on both.
- Row shape on the wire: `d,h,k,t` on both — an old client cannot tell the two servers apart.

Measured sizes on the patched server: the per-tick reply's feed block is **481 bytes for 8 entries**
at full 400-entry retention (the old whole-ring was 505 bytes); the anonymous default page is
**4,207 bytes for 60 entries**; the full backlog is **27,705 bytes for 400 entries** (69.3 bytes per
entry) and only when explicitly asked for.

### File integrity

`server.js` is byte-identical between the development copy and the deploy mirror (`cmp` clean), and
both parse (`node --check`). The corrected simulation was mirrored to the deploy repo as well.

---

## 7. Deploy order

The server may ship first — the A/B above proves already-deployed clients cannot tell the
difference. The new pop-up's history is entirely client-side, so it does not wait on the server.
The one thing that *does* need the new server is the shared chronicle's protection against being
erased, which is why it should not be left behind.
