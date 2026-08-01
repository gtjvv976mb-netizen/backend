# WebSocket latency — where it actually is, what changed, what you have to decide

**Date:** 2026-08-01 · **server.js** `b3299760c5f3c8f1f255aa3180e48a12`, byte-identical to the deploy
mirror (`cmp` clean) · **nothing committed, nothing pushed, nothing written to the live backend.**

---

## The short version

We went looking for milliseconds to remove from the multiplayer socket. **We found almost none —
because they had already been removed.** The 50 ms we expected to reclaim from the tick was never
being paid on the path that matters, and the two remaining candidate fixes (Nagle, self-ack) were
already optimal. Measured end to end, the whole latency pass moved the number by **−0.23 to +1.92 ms,
which is inside the run-to-run noise of the measurement.**

What we did find is that **the single biggest number in the system was mislabelled.** The backend was
believed to be ~117 ms away. It is **252 ms away.** The 117 ms figure was measuring a Cloudflare edge
server in Singapore, not the Render machine in Oregon. That is not a code problem and no code change
touches it — it is a decision about where the server lives, and it is the only lever left that is
worth more than a rounding error.

Separately, the work produced a large **bandwidth** win (90–95% fewer bytes on the wire), shipped as
two flags that are **switched OFF**. Bandwidth is not latency, and this report is careful not to
pretend otherwise — but on a phone on a slow connection the two do connect, and that is explained
below.

---

## 1. Where the latency actually is — the budget

This is one round trip for a player on this machine's connection (Singapore egress), measured today
against the live backend with read-only GETs. `/health` is a constant object with no database, no
RPC and no disk, so essentially all of it is network.

```
  ONE ROUND TRIP TO THE BACKEND, AS MEASURED  (min of 15 samples)

  client  →  Cloudflare edge  →  Render Oregon  →  edge  →  client
  |________ 73.0 ms _________|                         |
                             |________ 179.2 ms _______|
  |_______________________ 252.2 ms _____________________|
```

| Leg | Measured | How |
|---|---|---|
| client ⇄ Cloudflare edge | **73.0 ms** | `/cdn-cgi/trace` — terminated at the edge, never reaches Render |
| Cloudflare edge ⇄ Render Oregon | **179.2 ms** | 252.2 − 73.0 |
| **Total app round-trip** | **252.2 ms min** (p50 287.2, p95 702.9) | `/health`, post-TLS request→response |
| TCP handshake to edge | 70.5 ms min | |
| TLS complete | 154.2 ms min | one-time, at connect |

Now stack the rest of the multiplayer path on top. This is "another player moves, and the fact
reaches my machine":

| Term | ms | Share | Can code remove it? |
|---|---|---|---|
| **Physics of distance** — client⇄edge⇄Oregon⇄edge⇄client | **252.2** | **91.0%** | **No.** Only a region move. |
| **Tick quantization** — mean wait for the next 20 Hz frame | **25.0** (worst 50.0) | 9.0% | Only by raising the rate — measured, not worth it (§5) |
| Server work in the tick, 60 peers in one square | 5.5 | 2.0% | Already small |
| **Sum, to the moment the bytes arrive** | **~277 ms** | | |
| *Client interpolation buffer* (`Net.gd INTERP_DELAY = 0.45`) | *+450* | | *Deliberate. It is what makes remote players smooth instead of teleporting.* |

**Read that table as: 91% of the delay is the distance to Oregon, 9% is the tick, and 0% is anything
a code change can take out.**

### The correction that matters

The brief for this work said the backend was 117.5 ms away (avg ICMP). That number is real, but it
is not measuring the backend. Reproduced today:

| Ping target | min RTT |
|---|---|
| `backend-wffd.onrender.com` | **70.78 ms** |
| `1.1.1.1` (pure Cloudflare anycast, unrelated to Render) | **70.38 ms** |

Those are the same number because they are the same machine — a Cloudflare edge box. DNS confirms it:
`backend-wffd.onrender.com` → `gcp-us-west1-1.origin.onrender.com` → **`…cdn.cloudflare.net`**.
Ping never reaches Oregon. The origin is **3.4× further away than the ping suggests.**

### The one thing the tick does *not* delay

Your own movement is acknowledged **synchronously in the message handler**, not by the tick — the
last line of the socket's `message` handler writes the reply immediately (`server.js:7446`). Measured
on loopback: **move → own ack p50 0.272 ms**, versus **move → next tick frame p50 39.2 ms**, with the
tick provably silenced. So the immediate ack is already saving p50 ~39 ms that a tick-driven design
would have spent. **The 50 ms we hoped to reclaim was never being paid.**

The tick rate therefore only ever affects **other players' motion**, never your own responsiveness.

---

## 2. What changed, and what each change bought

### The big one already shipped, before this pass

Replacing the 280 ms HTTP poll with the WebSocket. Re-measured today on loopback (transport term
only, network excluded):

| | p50 | p95 |
|---|---|---|
| HTTP poll, 280 ms free-running | 119.6 ms | 260.1 ms |
| **WebSocket, 20 Hz push** | **27.3 ms** | **51.4 ms** |

**−92 ms p50, −209 ms p95.** That is the whole latency win in this system, and it was already live
before this pass began.

### What this pass added

| Change | Measured latency effect | Measured other effect |
|---|---|---|
| `permessage-deflate` on `/ws/world` (flag) | **+0.374 ms p50** on a 17.7 KB frame; **−0.015 ms** on a small one (noise) | **Bytes per tick frame at 60 peers: 11,160 → 495 (−95.6%)** |
| Tick dedupe — don't resend a frame identical to the last one (flag) | not measurable | Tick bytes: **−77 to −78%** when the world is still; −4% when everyone is moving |
| **Both, end to end, honest play** | **−0.23 ms (0 peers) / −0.53 ms (12) / +1.92 ms (40)** — A-to-A noise was 0.83–2.00 ms | Browser client total bytes **37,908 → 3,647 (−90.4%)** |

**Be clear about this: the flags did not make the game faster. They made it cheaper.** The honest
end-to-end deltas sit inside the noise floor at every occupancy tested.

### What was investigated and found to have nothing in it

| Candidate | Verdict |
|---|---|
| Disable Nagle (`noDelay`) | **Already on.** The `ws` library sets it unconditionally, and Node's http.Server defaults it on. A/B/A test: 0.384 / 0.401 / 0.359 ms p50 — the whole "penalty" is smaller than the A-to-A spread. **Worth 0 ms.** |
| Make the move-ack immediate instead of tick-bound | **Already immediate.** See §1. **Worth 0 ms.** |
| Raise the tick rate 20 → 60 Hz | Buys 17.2 ms of peer-motion latency, which sits **26× inside** the client's own 450 ms interpolation buffer, and costs +154% bandwidth and 2.4× the DoS ceiling. **Refused.** |
| HTTP gzip at the origin | **Cloudflare already gzips every HTTP reply** (`/world/players` 590→374 B). Nothing to gain. Cloudflare does **not** compress WebSocket frames, which is why socket-level deflate is the only compression a player could feel. |
| Packed binary wire format | 88% smaller — **beaten by the deflate flag at 95%**, and it would fork the wire format. Refused. |
| Short keys / enum interning / coarser angles | 1.5–10% raw, ~1% after compression. Refused. |
| Row-level suppression (81% of rows are re-sends) | **Would make every standing player invisible.** `Net.gd:1958` hides a remote the moment it is absent from a snapshot. Dedupe drops whole frames, never rows — that is the only safe form. |
| HTTP/3 / 0-RTT | Advertised by Cloudflare (`alt-svc: h3`), but browsers do not do WebSockets over HTTP/3. Even if they did, it saves ~73 ms **once, at connect** — 0.003 ms per tick over a 20-minute session. |

---

## 3. What is switched ON and what is switched OFF, as shipped

Read directly off a real boot of the shipped `server.js` with no environment overrides:

```
world socket on /ws/world · 20Hz · max 250 · deflate off · dedupe off
```

| Setting | Shipped value | What it does |
|---|---|---|
| `CHIK_WS` | **on** (socket enabled) | the WebSocket transport itself |
| `CHIK_WS_HZ` | **20** | tick rate |
| `CHIK_WS_MAX` | **250** | hard socket ceiling |
| `CHIK_WS_GRACE_MS` | **30 000** | close a socket that never gets a move accepted |
| `CHIK_WS_IDLE_MS` | **4 000** | stop pushing to a socket that has gone quiet |
| **`CHIK_WS_DEFLATE`** | **OFF** | compression |
| **`CHIK_WS_DEDUPE`** | **OFF** | suppress identical repeat frames |
| `CHIK_WS_DEFLATE_MAX` | 120 | how many sockets may compress at once (bounds RAM) |
| `CHIK_WS_DEFLATE_MIN` | 256 B | below this, frames skip zlib |

`render.yaml` sets neither new flag, so **both are off in production and the deployed behaviour is
unchanged.** No client update is needed for either — `Net.gd` was not touched.

### If you flip `CHIK_WS_DEDUPE=1`

- **Bytes:** −77 to −78% while the square is still; −4% while everyone is running.
- **CPU:** 34% → 38% of one core at 250 sockets.
- **Risk:** low. Two independent observers were proved to reconstruct **identical world views** with
  it on, at five different occupancies. Real Godot client: 51/51 with it on, 51/51 with it off.
- **Caveat you should know:** it goes dormant for **90 seconds after any monster dies**, because the
  monster snapshot carries a per-tick respawn countdown that changes every frame. Measured on a real
  kill: the same still square went from 49 suppressed frames to 0.

### If you flip `CHIK_WS_DEFLATE=1`

- **Bytes:** 60-peer frame 11,160 → 495 B (−95.6%). A browser player in a crowded square stops
  pulling ~187 KiB/s and starts pulling ~9 KiB/s.
- **CPU:** 34% → **66%** of one core at 250 sockets. *With dedupe also on it is 39%*, because dedupe
  leaves almost nothing for zlib to do.
- **RAM:** ~330 KiB per compressing socket, capped at 120 sockets → **~40 MiB**. The instance is on
  Render's **free plan (512 MiB)**. Under a backpressure stress test, 250 sockets extrapolate to
  287 MiB (flags off) / 324 MiB (on). That is the number to watch.
- **Old clients are safe:** native Godot offers no compression and silently gets the plain server;
  a non-offering client's bytes were measured **unchanged** (11,198 vs 11,160 B — noise).
- **Flip order matters: turn on dedupe first, or both together. Never deflate alone** — alone it
  doubles CPU and, against a real attacker, buys nothing (below).

### The honest DoS picture

The reason those guards exist: one ~300 B message once bought 240 snapshots. Both flags were first
benchmarked against a *cooperative* attacker (one that offers compression and parks on fixed
coordinates). A real attacker does neither:

| At 250 sockets | Cooperative attacker | **Hostile attacker** |
|---|---|---|
| today | 29.5 MiB/s, ×3542 | 33.97 MiB/s, ×3653 |
| deflate | 1.34 MiB/s, ×161 | **33.95 MiB/s, ×3655 — no effect at all** |
| dedupe | 0.86 MiB/s, ×103 | 23.93 MiB/s, ×2573 |
| both | 0.04 MiB/s, ×5 | **23.98 MiB/s, ×2576** |

**Real reduction under attack is about 30%, not 99.9%.** Neither flag buys headroom to raise
`WS_MAX_SOCKETS`. The only things that actually bound an attacker remain `WS_MAX_SOCKETS` 250 and
`WS_MOVE_IDLE_MS` 4 s, exactly as before. This is now written into the code comment so nobody reads
the optimistic number later and relaxes a guard on the strength of it.

### The one pre-flip check that could not be closed from here

Cloudflare sits between the browser and the origin. The compression **offer** was proven to traverse
it on the live path. Whether Cloudflare forwards the **acceptance** back cannot be tested until the
flag is on. If it strips the acceptance the flag is a silent no-op, not a hazard.

**After flipping, read this once:** `GET /assets/summary` (admin-keyed) now returns a `wsTransport`
block. `wsTransport.negotiated > 0` with browser players connected means compression is working end
to end. `0` means Cloudflare stripped it — turn the flag back off and nothing else changes.

---

## 4. The owner decisions

### DECISION 1 — the server region. This is the whole game.

**179 of the 252 ms is the hop between the Cloudflare edge and the Render machine in Oregon.** That
is **7× the entire tick-quantization budget**, and it is the only large number left. `render.yaml`
has no `region:` key at all, so the service sits on Render's default (Oregon) by accident, not by
choice.

Measured client→region round-trips from this machine (TCP handshake to in-region AWS endpoints,
which are not anycast — 8 samples each):

| Render region | min RTT from here |
|---|---|
| **Singapore** | **72.2 ms** |
| Frankfurt | 225.7 ms |
| **Oregon — current** | 264.0 ms |
| Virginia / Ohio | 293–295 ms |

| Origin | Asia player (measured here) | Asia player in SEA (derived) | US-West (derived) | EU (derived) |
|---|---|---|---|---|
| **Oregon — today** | **252 ms** | ~180 ms | ~30–45 ms | ~160–180 ms |
| **Singapore** | **~77 ms (−175)** | ~10–15 ms | ~185 ms (+145) | ~230 ms (+60) |
| Frankfurt | ~305 ms (+53) | ~235 ms | ~150 ms | ~25–35 ms |
| Virginia / Ohio | ~370 ms (+118) | ~300 ms | ~90 ms | ~110 ms |

Only the first column is measured. The rest is derived from the inter-region geometry above — there
is no vantage point in the US or EU to measure from.

**The decision rule:**

- **Asia-majority playerbase → move to Singapore.** Largest single win available anywhere in this
  system: **−175 ms**. It is one `render.yaml` key. Move the Postgres instance with it, or the
  database round-trip simply replaces the network one you removed. Check free-tier availability in
  the target region first. Expect a redeploy with a cold start; the live world is in-memory and is
  lost on any restart anyway, so nothing permanent is at risk.
- **US-majority → stay on Oregon and do nothing.** They already have the good experience.
- **Genuinely split → still pick one region, by headcount.** Frankfurt makes everyone mediocre
  rather than anyone good.

**Do not go multi-region.** The shared world lives in seven in-memory `Map`s in one process
(`server.js:3363, 3383, 3390, 3912, 5231, 7476, 7511` — players, gather nodes, node uses, feed, mobs,
chat, DMs). Postgres holds player *saves*, not the live world. Two regions means **two disjoint
worlds**: two mob pools, two chat rooms, two "N online" counts — and because `worldMobs` carries a
per-wallet damage map, *the same wallet could bank kill credit on the same monster in both regions.*
At the current concurrency ceiling that also splits the population into two empty worlds, which is a
worse product than one laggy one.

**Do not remove Cloudflare.** Measured: 252 ms through Cloudflare to Oregon versus 264 ms raw
internet to the same metro (AWS Oregon reference) and 301 ms (GCP Oregon reference). The proxy is
*saving* roughly 20 ms despite adding a hop. It is a benefit, not overhead.

### DECISION 2 — flip the two flags, or leave them off

They buy **no latency**. They buy a 90–95% cut in bytes. That is worth having if either of these is
true for your players:

- **Phones on slow connections.** Arithmetic from the measured byte counts: on a 5 Mbit/s link, a
  60-peer frame takes **15.3 ms** just to serialize onto the wire and consumes 31% of the link
  continuously. Compressed, it is **0.7 ms and 1.4%.** That is where a crowded town square stops
  being playable on a phone.
- **Render bandwidth cost.** 90% is 90%.

If neither bothers you, leaving them off is a perfectly defensible choice — the shipped behaviour is
unchanged and this decision can be made later. **If you do flip them: `CHIK_WS_DEDUPE=1` first or
both together, never deflate alone**, then read `wsTransport.negotiated` once.

### DECISION 3 — the tick rate (recommendation: leave it at 20 Hz)

Measured, real server, out-of-process clients:

| Rate | peer motion p50 | own move-ack | bytes/sock @60 peers | egress @250 sockets | achieved |
|---|---|---|---|---|---|
| **20 Hz** | 26.8 ms | 0.50 ms | 148.7 KB/s | 32.1 MiB/s | 19.7 |
| 30 Hz | 19.0 ms | 0.42 ms | 211.2 KB/s | 47.7 MiB/s | 29.4 |
| 60 Hz | 10.6 ms | 0.40 ms | 377.2 KB/s | 78.0 MiB/s | **48.2 (!)** |

60 Hz costs +154% bandwidth, 2.4× the attack ceiling, **and does not even deliver 60 Hz** under the
shipped socket cap — it degrades to 48.2 Hz with 70 ms jitter on a fast laptop, and Render's instance
is weaker. It buys 17.2 ms that the client's 450 ms interpolation buffer discards, under a 252 ms
network. There is no case for it. 30 Hz is survivable but costs +42% bandwidth for 8 ms nobody sees.

**Any future rate change must re-measure the amplification ceiling first** — it is linear in the rate.

---

## 5. What remains unverified

Stated plainly, because several of these are load-bearing.

1. **No real phone was tested.** Every client-side number is desktop. The mobile bandwidth argument
   in Decision 2 is *arithmetic on measured byte counts*, not a measurement on a phone.
2. **No live players.** Every occupancy figure comes from synthetic clients. The world has never been
   observed with 60 real people in one square.
3. **No real browser.** The Godot client probe negotiates no compression (which is itself the
   old-client safety proof), and a browser-shaped client was simulated — but Chrome/Safari against
   the live backend through Cloudflare was never run.
4. **Whether Cloudflare forwards the deflate acceptance is unknown** until the flag is on. Only the
   offer was proven to traverse. See the `wsTransport.negotiated` check above.
5. **All network measurement is from one machine in one geography** (Singapore egress). Every US and
   EU figure in the region table is *derived*, not measured. Also, this machine is 71 ms from its own
   nearest Cloudflare edge, where a player physically in SEA would be 2–10 ms — so the absolute floor
   here is ~70 ms pessimistic while the *deltas between regions* remain valid.
6. **HTTP/3 was not measured** — this machine's `curl` has no h3 support. It is stated as
   unmeasurable, and separately argued to be irrelevant to a long-lived socket.
7. **RSS on the deployed Render instance has never been read.** The 40 MiB / 324 MiB figures are from
   a local process. The instance is on the 512 MiB free plan.
8. **Dedupe was benchmarked with server-side physics off** (`CHIK_PHYS`). With server-simulated
   movement, rows change every tick and the still-world win shrinks.
9. **The p95 to the live origin was 702.9 ms** against a 252.2 ms minimum. That spread is the Render
   free-tier instance, not the network, and it was not characterised further.

---

## 6. Regression tallies — re-run fresh today

Every suite run from scratch against the shipped `server.js` at its default flag values. Each boots
the real server in-process on its own throwaway port with a throwaway keypair, memory store and a
dummy RPC. Nothing touched the live backend.

**Total: 574 passed, 4 failed across 20 suites.** Both failures are pre-existing and were proven so
by bisection, not by assertion.

| Suite | pass | fail |
|---|---|---|
| `ws_transport_sim` | 78 | 0 |
| `physics_authority_sim` | 67 | 0 |
| `world_tick_sim` | 66 | 0 |
| `_av_ws_attack_sim` | 51 | **1** |
| `mobile_desktop_sync_sim` | 45 | 0 |
| `party_sim` | 40 | 0 |
| `mmo_sync_sim` | 29 | 0 |
| `av_interest_attack_sim` | 29 | 0 |
| `mount_sync_sim` | 26 | 0 |
| `_av_ws_bounds_sim` | 25 | 0 |
| `world_share_sim` | 24 | 0 |
| `pvp_live_sim` | 19 | 0 |
| `interest_radius_sim` | 16 | 0 |
| `delta_snapshot_sim` | 15 | 0 |
| `world_share_v2_sim` | 14 | 0 |
| `critical_econ_sim` | 10 | 0 |
| `presence_auth_sim` | 8 | 0 |
| `_av_ws_load_sim` | 5 | **3** |
| `_av_ws_load2_sim` | 4 | 0 |
| `_av_ws_latency_sim` | 3 | 0 |
| **Total** | **574** | **4** |

### Failure 1 — `_av_ws_attack_sim`, 1 of 52: shared delta memory across two tabs

The assertion: a second socket opened by the same wallet is sent abbreviated rows that only the
*first* socket ever received, because the delta memory lives on the presence row rather than the
connection.

**Proven pre-existing two ways.** First, the sim's own control — which runs before it — already
demonstrates the identical behaviour over plain HTTP with no socket involved (`abbrev=20/20`, and
that control **passes**). Second, bisection: the same sim run against `git show HEAD:server.js`
(md5 `a4d7a67aaeef20bd7f447225b26519fe`, i.e. the last committed build, before any of this work)
produces a **byte-identical failure line on the same log line, with the same value `abbrev=21`.**

### Failure 2 — `_av_ws_load_sim`, 3 of 8: WebSocket propagation measured 0 samples

Phase C reports `WS n=0 p50=NaN` and three assertions fail on the NaN.

**This is a defect in the test harness, not in the server, and it is pre-existing.** Bisection first:
running the identical sim against `git show HEAD:server.js` produces the same `ws n=0` and the same
three failures.

Then the root cause, proven rather than argued. The sim's HTTP leg walks its test subject to
`x = 11…70`; its WebSocket leg walks the same subject to `x = 501…560`. The observer sits at `x = 0`.
Interest management (`INTEREST_ENTER = 260`, `INTEREST_LEAVE = 320`, `server.js:5019`) correctly
excludes a player 500+ units away, so the observer never sees it and the sim measures nothing. A
probe that copies Phase C's WebSocket measurement verbatim and changes **only that coordinate**:

```
  sim's WS offset 500  -> mover walks x=501..540, distance 540 > 320  -> n=0  p50=NaN
  HTTP leg offset 10   -> mover walks x=11..50,   distance  50 < 260  -> n=40 p50=27.3 p95=51.4 ms
```

So the transport is healthy and the assertion the phase was trying to make is comfortably true —
27.3 ms versus HTTP's 119.6 ms p50. The sim has been broken since interest management shipped, which
predates this work. **Recommend fixing the sim's coordinate; nothing to fix in the server.**

---

## 7. Housekeeping

Three untracked scratch files sit **inside the deploy repo**: `_lw_child.mjs`, `_lw_lib.mjs`,
`latency_wins_sim.mjs`. `.gitignore` does not cover them, and the `_lw_child.mjs` copy there is
**stale** (differs from the dev copy). A `git add -A` would ship all three. Delete them or ignore
them before the next commit.

The deploy mirror currently shows `server.js` and `REWARD_SECURITY.md` modified — 207 insertions,
8 deletions in `server.js`, confined to exactly two regions: the `/assets/summary` gauge and the
`/ws/world` block. Nothing else in the file was touched.

---

## Files

| What | Where |
|---|---|
| Backend (dev) | `/Users/michaelkennethbrillantes/Downloads/chiki-backend/server.js` |
| Backend (deploy mirror) | `/Users/michaelkennethbrillantes/Downloads/chiki-backend-repo-FIXED/server.js` |
| This report | `/Users/michaelkennethbrillantes/Downloads/chiki-backend/WS_LATENCY_REPORT.md` (+ mirror) |
| Security write-up | `/Users/michaelkennethbrillantes/Downloads/chiki-backend-repo-FIXED/REWARD_SECURITY.md` §13 |
| Wire-byte analysis | `/Users/michaelkennethbrillantes/Downloads/chiki-backend/wire_bytes_sim.mjs` |
| Flag verification | `/Users/michaelkennethbrillantes/Downloads/chiki-backend/latency_wins_sim.mjs` |
| Adversarial suite | `/Users/michaelkennethbrillantes/Downloads/chiki-backend/_av_lw_{honest,dos,attack,press}_sim.mjs`, `_av_lw_rerun.mjs` |
| Client decode bench | `/Users/michaelkennethbrillantes/Downloads/ChikoriaSmooth/dev_wirebench.gd` |
