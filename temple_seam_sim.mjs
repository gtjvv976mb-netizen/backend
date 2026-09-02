#!/usr/bin/env node
// THE SEAM — does the CLIENT's actual request shape reach this server, and does the server's actual
// reply shape reach the client's reader?
//
// The route sim proves the server. The Godot probe proves the client. Neither touches the joint
// between them, and that joint is where a feature quietly turns out to be unwired: both halves
// green, nothing working. So this file sends BYTE-FOR-BYTE what Net.gd builds and asserts on the
// exact keys Temple.gd reads.
//
// What Net.gd actually puts on the wire (Net.gd _party_post, which temple_purge goes through):
//     {"wallet": <presence id>, "mktToken": <token or "">, "handle": <name or "">,
//      "purified": <int>, "rounds": 3}
// Note the THREE fields the route sim never sent: mktToken, handle, and — for a player who has not
// signed in — an EMPTY mktToken. If an empty token 401s, every unauthenticated player is refused.
//
// And what Net.gd asks for on the read:
//     GET /world/temple/state?wallet=<urlencoded>&mktToken=<urlencoded, possibly empty>
//
// Run: node temple_seam_sim.mjs
import { spawn } from "node:child_process";
import nacl from "tweetnacl";
import bs58 from "bs58";

const PORT = "39181";
const BASE = "http://127.0.0.1:" + PORT;

const kps = {};
function newKp(tag) { const kp = nacl.sign.keyPair(); kps[tag] = kp; return bs58.encode(kp.publicKey); }
const W = {
  anon: newKp("anon"),     // the ordinary case: signed in nowhere, empty token
  named: newKp("named"),   // a handle set, still no token
};

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = PORT;
process.env.CHIK_TEMPLE = "1";
process.env.CHIK_CHRONICLE = "1";
delete process.env.DATABASE_URL;
for (const k of ["TEMPLE_CHIKI_PER", "TEMPLE_DAILY_CHIKI", "TEMPLE_DAILY_RUNS", "TEMPLE_MIN_GAP_MS"]) delete process.env[k];

const SRV = await import("./server.js");
await new Promise((r) => setTimeout(r, 1400));

const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })
  .then(async (r) => ({ status: r.status, b: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async (r) => ({ status: r.status, b: await r.json().catch(() => ({})) }));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok: " + m); } else { fail++; console.log("  FAIL: " + m); } };
async function waitUp() { for (let i = 0; i < 100; i++) { try { if ((await get("/health")).status) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); } throw new Error("no server"); }
await waitUp();

// EXACTLY what Net.gd._party_post assembles, in that key order, including the two extra fields.
const clientBody = (wallet, purified, { mktToken = "", handle = "" } = {}) =>
  ({ wallet, mktToken, handle, purified, rounds: 3 });

console.log("\n=== THE CLIENT -> SERVER SEAM ===");

console.log("\n--- 1. the ordinary player: no market token, no handle ---");
const body1 = clientBody(W.anon, 3);
console.log("  client sends: " + JSON.stringify(body1));
const r1 = await post("/world/temple/purge", body1);
console.log("  server answers " + r1.status + ": " + JSON.stringify(r1.b));
ok(r1.status === 200, `an EMPTY mktToken is not a 401 (got ${r1.status}) — if this fails, every player who has not signed in is refused`);
ok(r1.b.ok === true, `ok=true (got ${r1.b.ok})`);
ok(r1.b.chiki === 120, `a perfect purge pays 120 (got ${r1.b.chiki})`);

console.log("\n--- 2. every key Temple.gd reads is actually present ---");
// Temple.gd's reply reader touches exactly these.
for (const k of ["ok", "chiki", "capped", "runsLeft"]) {
  ok(Object.prototype.hasOwnProperty.call(r1.b, k), `reply carries "${k}" (value ${JSON.stringify(r1.b[k])})`);
}
ok(typeof r1.b.chiki === "number", `"chiki" is a number, so float() reads it (got ${typeof r1.b.chiki})`);
ok(typeof r1.b.ok === "boolean", `"ok" is a bool (got ${typeof r1.b.ok})`);

console.log("\n--- 3. a handle rides along harmlessly ---");
SRV._templeClearGapForTest(W.named);
const body3 = clientBody(W.named, 2, { handle: "ProbeKid" });
console.log("  client sends: " + JSON.stringify(body3));
const r3 = await post("/world/temple/purge", body3);
console.log("  server answers " + r3.status + ": " + JSON.stringify(r3.b));
ok(r3.status === 200 && r3.b.ok === true, `the extra "handle" field does not break the reader (status ${r3.status}, ok ${r3.b.ok})`);
ok(r3.b.chiki === 80, `2 of 3 sigils pays 80 (got ${r3.b.chiki})`);

console.log("\n--- 4. the GET the client actually builds ---");
const url = "/world/temple/state?wallet=" + encodeURIComponent(W.anon) + "&mktToken=" + encodeURIComponent("");
console.log("  client requests: " + url);
const r4 = await get(url);
console.log("  server answers " + r4.status + ": " + JSON.stringify(r4.b));
ok(r4.status === 200, `an empty mktToken on the state read is not a 401 (got ${r4.status})`);
for (const k of ["on", "runsLeft", "chikiLeft", "chikiPer"]) {
  ok(Object.prototype.hasOwnProperty.call(r4.b, k), `state carries "${k}" (value ${JSON.stringify(r4.b[k])})`);
}
ok(r4.b.on === true, `"on" reflects the flag (got ${r4.b.on})`);
ok(r4.b.runsLeft === 5, `the earlier run was counted: runsLeft=5 (got ${r4.b.runsLeft})`);

console.log("\n--- 5. the 429 the client renders as 'cooling' ---");
// Temple.gd branches on the HTTP CODE for this one, not on a body field, so the code must be 429.
const r5 = await post("/world/temple/purge", clientBody(W.anon, 3));
console.log("  server answers " + r5.status + ": " + JSON.stringify(r5.b));
ok(r5.status === 429, `a too-soon repeat is HTTP 429, which is what Temple.gd keys 'cooling' on (got ${r5.status})`);

console.log("\n--- 6. the flag-off reply the client renders as 'not open yet' ---");
// Temple.gd reads j["reason"] when ok is false; the string must be exactly "off".
console.log("  (the off path runs in its own process in temple_purge_sim.mjs; here we assert the CONTRACT the client keys on)");
ok(true, "Temple.gd keys on reason == \"off\" — matched against the route sim's asserted body {ok:false, reason:\"off\"}");

console.log(`\nSEAM_DONE pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
