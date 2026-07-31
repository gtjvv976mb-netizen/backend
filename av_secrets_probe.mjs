#!/usr/bin/env node
// SECRET-ISOLATION SWEEP over every public response the two changes touch (and their neighbours).
// RPC_URL is server-only and must never appear anywhere; CLIENT_RPC is public and must FAIL CLOSED.
// Local server, throwaway keypair, memory store, dummy RPC. Never touches the live backend.
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";

const treasury = Keypair.generate();
const CANARY = "https://rpc.CANARY-SERVER-ONLY.example/?api-key=DEADBEEFSECRET";
process.env.RPC_URL = CANARY;                 // if this string ever appears in a body, that is the leak
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.PORT = "39503";
process.env.NETWORK = "devnet";
process.env.ADMIN_KEY = "simonly-" + crypto.randomBytes(8).toString("hex");
delete process.env.CLIENT_RPC;                // the fail-closed case
delete process.env.DATABASE_URL;

const BASE = "http://127.0.0.1:39503";
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, text: await r.text() }));
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, text: await r.text() }));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ok   " + n + (e ? "  [" + e + "]" : "")); } else { fail++; fails.push(n); console.log("  FAIL " + n + (e ? "  [" + e + "]" : "")); } };

await import(new URL("./server.js", import.meta.url).href);
for (let i = 0; i < 100; i++) { try { if ((await get("/stats")).status === 200) break; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }

const nid = "godot-" + crypto.randomBytes(4).toString("hex");
const bodies = [];
const grab = async (label, r) => { bodies.push([label, r.text]); return r; };
await grab("GET /stats", await get("/stats"));
await grab("GET /world/roster", await get("/world/roster"));
await grab("GET /world/players", await get(`/world/players?wallet=${nid}&x=0&z=0`));
await grab("POST /world/move", await post("/world/move", { wallet: nid, x: 1, z: 1, y: 6, dir: 0, handle: "T", leg: 1, el: "Fire", br: 1, dl: 1 }));
await grab("GET /market/list", await get("/market/list"));
await grab("GET /leaderboard", await get("/leaderboard"));
await grab("GET /assets/summary (admin)", await get(`/assets/summary?key=${process.env.ADMIN_KEY}`));
await grab("GET /assets/summary (no key)", await get("/assets/summary"));
await grab("GET /profile (no auth)", await get(`/profile?wallet=${Keypair.generate().publicKey.toBase58()}`));
await grab("POST /profile (unauth)", await post("/profile", { wallet: Keypair.generate().publicKey.toBase58(), profile: { mmo: { v: 2, mats: { wood: 1 } } } }));

const secretBits = [CANARY, "DEADBEEFSECRET", "CANARY-SERVER-ONLY", process.env.ADMIN_KEY, process.env.TREASURY_SECRET.slice(0, 40)];
for (const [label, text] of bodies) {
  const hit = secretBits.find(s => s && text.includes(s));
  ok(`${label} carries no server secret`, !hit, hit ? `LEAKED ${String(hit).slice(0, 40)}` : `${text.length} B`);
}
const stats = JSON.parse(bodies.find(b => b[0] === "GET /stats")[1]);
console.log(`     /stats clientRpc = ${JSON.stringify(stats.clientRpc)}  (RPC_URL was ${CANARY.slice(0, 30)}...)`);
ok("CLIENT_RPC unset -> /stats.clientRpc FAILS CLOSED to \"\", never falls back to RPC_URL",
   stats.clientRpc === "", `clientRpc=${JSON.stringify(stats.clientRpc)}`);
ok("...and `rpc`/`rpcUrl` are not published under any other name",
   !("rpc" in stats) && !("rpcUrl" in stats) && !("RPC_URL" in stats), `keys=${Object.keys(stats).join(",")}`);

console.log("");
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
console.log(`SECRETS_PROBE_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
