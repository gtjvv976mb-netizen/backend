#!/usr/bin/env node
// ADVERSARIAL VERIFICATION of the interest-radius change (ENTER 260 / LEAVE 320).
// Boots the REAL server.js in-process. Throwaway keypair, memory store, dummy RPC, unique port.
// NEVER touches the live backend.
//
// Attacks:
//   A  boundary dwell — a peer parked at exactly d=260 with float jitter for a simulated 10 min
//   B  fast observer — border crossings in BOTH directions, actual crossing distances printed
//   C  two corners — must NOT see each other, must BOTH count in `online` and in /world/roster
//   D  delta re-entry under packet loss — skip a snapshot, then re-enter; row must be FULL
//   E  out-of-WORLD_RADIUS teleport — does eviction still clear the receiver's delta memory?
//   F  crowd > WORLD_MAX_PEERS inside the radius — does the 60-cap poison `seen`?
import { createRequire } from "module";
const require = createRequire(new URL("./package.json", import.meta.url));
const nacl = (m => m.default || m)(require("tweetnacl"));

const _t = nacl.sign.keyPair();                       // THROWAWAY
process.env.RPC_URL = "http://127.0.0.1:59981";       // dummy, never called
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39501";
delete process.env.DATABASE_URL;
delete process.env.MARKET_ONCHAIN;

const BASE = "http://127.0.0.1:39501";
await import(new URL("./server.js", import.meta.url).href);

const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, actual = "") => { if (c) { pass++; console.log("  ok   " + n + (actual ? "  [" + actual + "]" : "")); } else { fail++; fails.push(n + " — " + actual); console.log("  FAIL " + n + (actual ? "  [" + actual + "]" : "")); } };
for (let i = 0; i < 100; i++) { try { if ((await get("/world/roster")).status === 200) break; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }

// HARNESS TRAP (cost me a whole run): the obvious `hex(name).slice(0,8)` keeps only the first FOUR
// characters, so cornr1/cornr2 and all 70 crowd ids collapsed to ONE presence row and half the
// assertions were testing a single peer talking to itself. Hash the whole name.
import crypto from "node:crypto";
const nid = (s) => "godot-" + crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
const mv = (w, x, z, extra = {}) => post("/world/move", {
  wallet: w, x, z, y: 6, dir: 1.2, handle: "T_" + w.slice(-4), leg: 14, el: "Fire", br: 9,
  avatar: "classic", comp: "chillguy", party: "chillguy,pepe", mount: "", act: "", eggs: "", spr: false, ...extra,
});
const sees = (r, w) => (r.j.players || []).some(p => p.wallet === w);
const rowOf = (r, w) => (r.j.players || []).find(p => p.wallet === w);

// ================= A. BOUNDARY DWELL =================
console.log("\n=== A. a peer parked at EXACTLY the enter boundary, jittering, for a simulated 10 min ===");
const OBS = nid("obsA"), PEER = nid("peerA");
await mv(PEER, 260, 0); await mv(OBS, 0, 0);
let visible = sees(await mv(OBS, 0, 0), PEER);
ok("d = 260.00 exactly is INSIDE the enter radius (enter is `d > 260` -> skip)", visible === true, `visible=${visible}`);

// 1200 observer polls with the peer jittering +-0.45 units around x=260 (float32 presence noise).
// At 500ms per client poll this is 10 minutes of dwell. The peer re-pings every poll so it never TTLs.
let flaps = 0, wasVis = visible, wouldFlapNoHysteresis = 0, lastRaw = visible;
const JIT = [0.31, -0.44, 0.12, -0.28, 0.41, -0.07, 0.22, -0.39, 0.05, -0.19];
for (let i = 0; i < 1200; i++) {
  const jx = 260 + JIT[i % JIT.length];
  await mv(PEER, jx, 0);
  const r = await mv(OBS, 0, 0);
  const v = sees(r, PEER);
  if (v !== wasVis) flaps++;
  wasVis = v;
  const rawIn = jx <= 260;                       // what a NO-hysteresis (single 260 radius) server would do
  if (rawIn !== lastRaw) wouldFlapNoHysteresis++;
  lastRaw = rawIn;
}
ok("1200 polls (~10 min) at the boundary produce ZERO visibility flaps", flaps === 0, `flaps=${flaps}`);
console.log(`     counterfactual: a plain 260 radius with the same jitter would have flapped ${wouldFlapNoHysteresis} times`);
ok("...and the counterfactual actually flaps, so the test has teeth", wouldFlapNoHysteresis > 100, `noHyst=${wouldFlapNoHysteresis}`);
// leave edge: exactly 320 must STILL be held (leave is `d > 320`)
await mv(PEER, 320, 0);
ok("d = 320.00 exactly is still HELD (leave is `d > 320` -> skip)", sees(await mv(OBS, 0, 0), PEER) === true, `visible=${sees(await mv(OBS, 0, 0), PEER)}`);
await mv(PEER, 320.5, 0);
ok("d = 320.5 is dropped", sees(await mv(OBS, 0, 0), PEER) === false, `visible=${sees(await mv(OBS, 0, 0), PEER)}`);
await mv(PEER, 260.5, 0);
ok("...and 260.5 does NOT re-enter (enter is the tight radius)", sees(await mv(OBS, 0, 0), PEER) === false, `visible=${sees(await mv(OBS, 0, 0), PEER)}`);

// ================= B. FAST OBSERVER, BOTH DIRECTIONS =================
console.log("\n=== B. a fast observer sweeping out past LEAVE and back in past ENTER ===");
const OBS2 = nid("obsB"), PEER2 = nid("peerB");
await mv(PEER2, 0, 0);
let events = [], prev = false;
const sweep = async (from, to, step) => {
  for (let x = from; step > 0 ? x <= to : x >= to; x += step) {
    await mv(PEER2, 0, 0);
    const v = sees(await mv(OBS2, x, 0), PEER2);
    if (v !== prev) { events.push({ at: x, to: v ? "IN" : "OUT" }); prev = v; }
  }
};
await mv(OBS2, 0, 0); prev = sees(await mv(OBS2, 0, 0), PEER2);   // start already INSIDE, so events == crossings
events = [];
await sweep(0, 600, 8);      // outbound: 8 units/step = a griffin sprint at 10 Hz
await sweep(592, 0, -8);     // inbound
ok("outbound: exactly one IN->OUT transition", events.filter(e => e.to === "OUT").length === 1, `events=${JSON.stringify(events)}`);
ok("inbound: exactly one OUT->IN transition", events.filter(e => e.to === "IN").length === 1, `events=${JSON.stringify(events)}`);
const outAt = events.find(e => e.to === "OUT"), inAt = events.find(e => e.to === "IN");
ok("...drop happens just past LEAVE 320, not at ENTER 260", outAt && outAt.at > 320 && outAt.at <= 328, `dropped at x=${outAt && outAt.at}`);
ok("...re-entry happens at ENTER 260, not at LEAVE 320", inAt && inAt.at <= 260 && inAt.at > 252, `re-entered at x=${inAt && inAt.at}`);
// a 60-unit dead band means a fast observer cannot oscillate: prove by sitting in the band
let bandFlaps = 0; prev = sees(await mv(OBS2, 0, 0), PEER2);
for (let i = 0; i < 200; i++) { await mv(PEER2, 0, 0); const v = sees(await mv(OBS2, 260 + (i % 60), 0), PEER2); if (v !== prev) bandFlaps++; prev = v; }
ok("200 polls anywhere inside the 260..320 dead band never flap", bandFlaps === 0, `bandFlaps=${bandFlaps}`);

// ================= C. TWO CORNERS =================
console.log("\n=== C. two players in opposite corners ===");
const C1 = nid("cornr1"), C2 = nid("cornr2");
const r1 = await mv(C1, -1200, -1200);
const r2 = await mv(C2, 1200, 1200);
const r1b = await mv(C1, -1200, -1200);
const dCorner = Math.hypot(2400, 2400);
ok("corner separation is inside WORLD_RADIUS but outside the interest radius", dCorner < 4000 && dCorner > 320, `d=${dCorner.toFixed(0)}`);
ok("C1 does NOT receive C2 in /world/move", sees(r1b, C2) === false, `sees=${sees(r1b, C2)}`);
ok("C2 does NOT receive C1 in /world/move", sees(r2, C1) === false, `sees=${sees(r2, C1)}`);
ok("...but BOTH are in `online`", (r1b.j.online || 0) >= 2, `online=${r1b.j.online}`);
const ros = await get("/world/roster");
const rosHas = (w) => (ros.j.users || []).some(u => u.wallet === w);
ok("...and BOTH are in /world/roster (the presence pill)", rosHas(C1) && rosHas(C2), `count=${ros.j.count} c1=${rosHas(C1)} c2=${rosHas(C2)}`);
const wide = await get(`/world/players?wallet=${C1}&x=-1200&z=-1200`);
ok("...and the WIDE spectate route still shows the far corner", (wide.j.players || []).some(p => p.wallet === C2), `widerows=${(wide.j.players || []).length}`);

// ================= D. DELTA RE-ENTRY UNDER PACKET LOSS =================
console.log("\n=== D. delta re-entry after a dropped poll ===");
const OBS3 = nid("obsD"), PEER3 = nid("peerD");
await mv(PEER3, 100, 0); await mv(OBS3, 0, 0, { dl: 1 });
let rr = await mv(OBS3, 0, 0, { dl: 1 });
let row = rowOf(rr, PEER3);
ok("steady state: the second dl poll is abbreviated", row && row.dl === 1 && row.handle === undefined, `dl=${row && row.dl} handle=${row && row.handle}`);

// PACKET LOSS: the peer walks out and the observer's polls during that window are LOST (never sent).
await mv(PEER3, 500, 0);                       // out of LEAVE  (observer poll #1 dropped)
await mv(PEER3, 900, 0);                       // still out     (observer poll #2 dropped)
rr = await mv(OBS3, 0, 0, { dl: 1 });          // first poll that actually lands
ok("after the lost polls, the departed peer is simply absent", sees(rr, PEER3) === false, `visible=${sees(rr, PEER3)}`);
await mv(PEER3, 100, 0);                       // walks back in
rr = await mv(OBS3, 0, 0, { dl: 1 });
row = rowOf(rr, PEER3);
ok("re-entry ships a FULL row (handle+sq present), not a dl:1 the client cannot render",
   !!(row && row.dl === undefined && row.handle && row.sq), `dl=${row && row.dl} handle=${row && row.handle} sq=${row && row.sq}`);
rr = await mv(OBS3, 0, 0, { dl: 1 });
row = rowOf(rr, PEER3);
ok("...and the poll after re-entry is abbreviated again (delta memory rebuilt)", row && row.dl === 1, `dl=${row && row.dl}`);

// NO-LOSS control: peer bounces out and back BETWEEN two observer polls -> never evicted -> dl:1 is correct
await mv(PEER3, 500, 0); await mv(PEER3, 100, 0);
rr = await mv(OBS3, 0, 0, { dl: 1 });
row = rowOf(rr, PEER3);
ok("a bounce the observer never observed keeps the row abbreviated (no needless full send)", row && row.dl === 1, `dl=${row && row.dl}`);

// the observer itself vanishing (its own row TTLs) must not leave stale memory
const OBS3b = nid("obsD2");
await mv(PEER3, 100, 0);
rr = await mv(OBS3b, 0, 0, { dl: 1 });
ok("a brand-new observer's first dl poll is FULL for everyone", !!(rowOf(rr, PEER3) && rowOf(rr, PEER3).handle), `handle=${rowOf(rr, PEER3) && rowOf(rr, PEER3).handle}`);

// ================= E. TELEPORT PAST WORLD_RADIUS =================
console.log("\n=== E. a hostile client teleporting past WORLD_RADIUS (4000) ===");
const OBS4 = nid("obsE"), GRIEF = nid("grief1");
await mv(GRIEF, 100, 0);
await mv(OBS4, 0, 0, { dl: 1 });
rr = await mv(OBS4, 0, 0, { dl: 1 });
ok("griefer is visible and abbreviated first", rowOf(rr, GRIEF) && rowOf(rr, GRIEF).dl === 1, `dl=${rowOf(rr, GRIEF) && rowOf(rr, GRIEF).dl}`);
await mv(GRIEF, 50000, 0);                 // d = 50000 > WORLD_RADIUS 4000
rr = await mv(OBS4, 0, 0, { dl: 1 });
ok("griefer past WORLD_RADIUS is not shipped", sees(rr, GRIEF) === false, `visible=${sees(rr, GRIEF)}`);
await mv(GRIEF, 100, 0);                   // teleports back next to the victim
rr = await mv(OBS4, 0, 0, { dl: 1 });
row = rowOf(rr, GRIEF);
console.log(`     re-entry row after a >WORLD_RADIUS excursion: dl=${row && row.dl} handle=${row && row.handle}`);
ok("re-entry after a >WORLD_RADIUS excursion ALSO ships a FULL row (same guarantee as an interest eviction)",
   !!(row && row.dl === undefined && row.handle), `dl=${row && row.dl} handle=${row && row.handle}`);

// ================= F. CROWD LARGER THAN THE PEER CAP, INSIDE THE RADIUS =================
console.log("\n=== F. 70 peers inside the interest radius (cap is 60) ===");
const OBS5 = nid("obsF"); const crowd = [];
for (let i = 0; i < 70; i++) { const w = nid("cw" + String(i).padStart(4, "0")); crowd.push(w); await mv(w, 40 + i * 3, 0); }   // 40..247, all inside ENTER
rr = await mv(OBS5, 0, 0, { dl: 1 });
ok("the snapshot is capped at WORLD_MAX_PEERS 60", (rr.j.players || []).length === 60, `rows=${(rr.j.players || []).length}`);
const shipped = new Set((rr.j.players || []).map(p => p.wallet));
const cut = crowd.filter(w => !shipped.has(w));
// (earlier sections leave a few peers alive inside this radius too, so the cut count is > 10; the
// property that matters is that the cap took the NEAREST — every cut crowd member is farther than
// every shipped one, i.e. the cut indices are a contiguous tail.)
const cutIdx = cut.map(w => crowd.indexOf(w)).sort((a, b) => a - b);
const keptIdx = crowd.map((w, i) => shipped.has(w) ? i : -1).filter(i => i >= 0);
ok("...and the cut are the FARTHEST, not arbitrary (cap takes the nearest)",
   cutIdx.length > 0 && Math.min(...cutIdx) > Math.max(...keptIdx), `cut idx=${cutIdx.join(",")} maxKept=${Math.max(...keptIdx)}`);
// now the near ones leave, so a previously-cut peer becomes top-60. Was its `seen` poisoned while it was cut?
for (let i = 0; i < 20; i++) await mv(crowd[i], 3000, 3000);
for (let i = 20; i < 70; i++) await mv(crowd[i], 40 + i * 3, 0);
rr = await mv(OBS5, 0, 0, { dl: 1 });
const promoted = (rr.j.players || []).filter(p => cut.includes(p.wallet));
const poisoned = promoted.filter(p => p.dl === 1 && !p.handle);
console.log(`     promoted-from-cut rows=${promoted.length}, of which abbreviated-but-never-sent=${poisoned.length}`);
ok("a peer promoted into the cap window is NOT sent an unrenderable dl:1 (seen must not be set for cut rows)",
   poisoned.length === 0, `poisoned=${poisoned.length} of ${promoted.length}`);

console.log("");
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
console.log(`INTEREST_ATTACK_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
