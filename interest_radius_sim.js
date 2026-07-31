#!/usr/bin/env node
// INTEREST RADIUS + HYSTERESIS. The client hides every remote past RENDER_DIST 240 (Net.gd:64),
// but /world/move snapshots shipped every peer within WORLD_RADIUS 4000 — at 60 peers most of the
// wire was players the receiver cannot see. The server now ships only peers within ENTER 260,
// holds them until LEAVE 320 (hysteresis), forgets the delta memory on eviction so re-entry gets a
// FULL row, and leaves GET /world/players + /world/roster + the online count wide.
// No live backend. Throwaway keypair, memory store, dummy RPC.
import { Keypair } from "@solana/web3.js";
import zlib from "node:zlib";

const treasury = Keypair.generate();
process.env.RPC_URL = "http://127.0.0.1:59991";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39147";
delete process.env.DATABASE_URL;
delete process.env.MARKET_ONCHAIN;

const BASE = "http://127.0.0.1:39147";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ok   " + n + (e ? "  [" + e + "]" : "")); } else { fail++; fails.push(n + (e ? " — " + e : "")); console.log("  FAIL " + n + (e ? "  [" + e + "]" : "")); } };
async function waitUp() { for (let i = 0; i < 80; i++) { try { if ((await get("/world/roster")).status === 200) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); } throw new Error("no server"); }
const br = (v) => zlib.brotliCompressSync(Buffer.from(JSON.stringify(v))).length;

// live presence ids are `godot-`+8hex net_ids — the realistic wire shape (random pubkeys carry
// ~32 bytes of incompressible entropy each and make brotli numbers lie; see the ledger 2026-07-31)
const nid = (i) => "godot-" + (0x10000000 + i * 2654435761 % 0xefffffff >>> 0).toString(16).slice(0, 8);
const move = (w, x, z, extra = {}) => post("/world/move", {
  wallet: w, x, z, y: 6, dir: 1.234, handle: "Trainer_" + w.slice(-4), leg: 14, el: "Fire", br: 9,
  avatar: "classic", comp: "chillguy", party: "chillguy,pepe,moodeng",
  mount: "", act: "", eggs: "normal", spr: false, ...extra,
});

async function main() {
  await import("./server.js");
  await waitUp();
  console.log("\n=== INTEREST RADIUS (enter 260 / leave 320) ===\n");

  // 60 peers: an observer inside a cluster of 8 near the origin, 52 spread across the island
  const OBS = "godot-0bserver";
  const cluster = []; const far = [];
  for (let i = 0; i < 7; i++) { const w = nid(i); cluster.push(w); await move(w, 10 + i * 5, 8 + i * 4); }        // 12..53 units out
  for (let i = 0; i < 52; i++) { const w = nid(100 + i); far.push(w); const a = i * 0.7, r = 500 + i * 45; await move(w, Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)); }  // 500..2795 units out
  await move(OBS, 0, 0);   // 60th trainer

  // ---------- 1. THE SNAPSHOT CARRIES ONLY THE CLUSTER ----------
  const s1 = await move(OBS, 0, 0, { dl: 1 });
  const rows1 = s1.json.players || [];
  ok("observer in a cluster of 8 receives exactly the 7 cluster peers", rows1.length === 7, `rows=${rows1.length}`);
  ok("...and every row IS a cluster peer", rows1.every(r => cluster.includes(r.wallet)), `got ${rows1.map(r => r.wallet.slice(-4)).join(",")}`);
  const wide = await get(`/world/players?wallet=${OBS}&x=0&z=0`);
  const wrows = wide.json.players || [];
  ok("spectate route GET /world/players stays WIDE (island view)", wrows.length === 59, `rows=${wrows.length}`);
  console.log(`  wire: before (wide, what /world/move used to ship) = ${wrows.length} rows, ${JSON.stringify(wrows).length} B raw, ${br(wrows)} B brotli`);
  console.log(`        after (interest-filtered /world/move reply)  = ${rows1.length} rows, ${JSON.stringify(rows1).length} B raw, ${br(rows1)} B brotli`);
  // sim rows are near-identical so brotli flatters the WIDE snapshot (live handles/parties differ);
  // raw bytes carry the honest ratio, brotli still must show a clear win
  ok("interest-filtered snapshot is a fraction of the wide wire (raw)", JSON.stringify(rows1).length < JSON.stringify(wrows).length / 4, `${JSON.stringify(rows1).length} B vs ${JSON.stringify(wrows).length} B raw`);
  ok("interest-filtered snapshot is smaller on the wire (brotli)", br(rows1) < br(wrows) / 3, `${br(rows1)} B vs ${br(wrows)} B brotli`);

  // ---------- 2. EVERYONE IS STILL COUNTED ----------
  ok("online count in the /world/move reply still reports all 60", s1.json.online === 60, `online=${s1.json.online}`);
  const rost = await get("/world/roster");
  ok("/world/roster still lists all 60", rost.json.count === 60, `count=${rost.json.count}`);

  // ---------- 3. HYSTERESIS: one flap per real crossing pair ----------
  const W = nid(300); // the walker dances on the boundary; observer polls after every step
  const path = [250, 300, 330, 300, 250, 330];         // in, hold(>260 but <320), out, still-out, re-enter, out
  const expect = ["in", "in", "out", "out", "in", "out"];
  const seq = [];
  for (const x of path) {
    await move(W, x, 0);
    const s = await move(OBS, 0, 0, { dl: 1 });
    seq.push((s.json.players || []).some(r => r.wallet === W) ? "in" : "out");
  }
  ok("boundary walker flaps exactly once per crossing pair", seq.join(",") === expect.join(","),
     `x=[${path.join(",")}] -> [${seq.join(",")}] (want [${expect.join(",")}])`);
  const transitions = seq.reduce((n, v, i) => n + (i > 0 && v !== seq[i - 1] ? 1 : 0), 0);
  ok("...3 transitions for 3 real crossings, not one per poll", transitions === 3, `transitions=${transitions}`);
  ok("...a peer at 300 who was NEVER inside stays out (enter is 260, not 320)", seq[3] === "out", `seq[3]=${seq[3]}`);

  // ---------- 4. DELTA CORRECTNESS ACROSS EVICTION ----------
  const P = cluster[0];
  const a1 = await move(OBS, 0, 0, { dl: 1 });
  const r1 = (a1.json.players || []).find(r => r.wallet === P) || {};
  ok("steady-state: a known cluster peer arrives ABBREVIATED (dl:1, no static half)", r1.dl === 1 && r1.handle === undefined, `dl=${r1.dl} handle=${r1.handle}`);
  await move(P, 400, 0);                                  // leaves the radius
  const a2 = await move(OBS, 0, 0, { dl: 1 });
  ok("peer beyond 320 vanishes from the snapshot", !(a2.json.players || []).some(r => r.wallet === P), `rows=${(a2.json.players || []).map(r => r.wallet.slice(-4)).join(",")}`);
  await move(P, 100, 0);                                  // re-enters (100 < 260)
  const a3 = await move(OBS, 0, 0, { dl: 1 });
  const r3 = (a3.json.players || []).find(r => r.wallet === P) || {};
  ok("re-entry after eviction ships a FULL row again (client freed the rig after 10s grace)",
     r3.dl === undefined && r3.handle === "Trainer_" + P.slice(-4) && Number(r3.sq) >= 1,
     `dl=${r3.dl} handle=${r3.handle} sq=${r3.sq} keys=${Object.keys(r3).join("/")}`);
  const a4 = await move(OBS, 0, 0, { dl: 1 });
  const r4 = (a4.json.players || []).find(r => r.wallet === P) || {};
  ok("...and the very next poll abbreviates again (delta memory re-armed)", r4.dl === 1 && r4.handle === undefined, `dl=${r4.dl} handle=${r4.handle}`);

  // the hysteresis walker's re-entry (test 3, x=330 -> 250) must also have been a full row
  await move(W, 330, 0); await move(OBS, 0, 0, { dl: 1 });   // evict W again
  await move(W, 120, 0);
  const a5 = await move(OBS, 0, 0, { dl: 1 });
  const r5 = (a5.json.players || []).find(r => r.wallet === W) || {};
  ok("walker re-entering through the hysteresis path also gets a FULL row", r5.dl === undefined && r5.handle === "Trainer_" + W.slice(-4), `dl=${r5.dl} handle=${r5.handle}`);

  // ---------- 5. A LEGACY (non-dl) CLIENT GETS FULL ROWS, STILL FILTERED ----------
  const s6 = await move(OBS, 0, 0);   // no dl
  const rows6 = s6.json.players || [];
  // P IS cluster[0] (now at 100), so in-radius = the 7 cluster peers + walker W@120 = 8
  ok("legacy client: interest-filtered too, every row full", rows6.length === 8 && rows6.every(r => r.dl === undefined && r.handle), `rows=${rows6.length} (cluster 7 incl P@100, + W@120), dl-free=${rows6.every(r => r.dl === undefined)}`);

  console.log(`\n${fail ? "FAILURES:\n  " + fails.join("\n  ") : "all green"}`);
  console.log(`INTEREST_RADIUS_DONE pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); console.log("INTEREST_RADIUS_DONE pass=0 fail=1"); process.exit(1); });
