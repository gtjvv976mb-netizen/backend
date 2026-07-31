#!/usr/bin/env node
// WIRE-SHAPE REGRESSION. Moving the static half of a snapshot row out of the scan loop and into a
// post-cap pass could silently reorder or drop keys — the client parses by key, but the delta sims
// budget in BYTES, so the emitted JSON must be identical. Prints the exact key list and byte count
// for a FULL row and a dl row. Run against AV_SERVER to diff old vs new.
import { createRequire } from "module";
import crypto from "node:crypto";
const require = createRequire(new URL("./package.json", import.meta.url));
const nacl = (m => m.default || m)(require("tweetnacl"));
const TARGET = process.env.AV_SERVER || new URL("./server.js", import.meta.url).href;
const PORT = process.env.AV_PORT || "39521";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59984";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = PORT;
delete process.env.DATABASE_URL;
const BASE = "http://127.0.0.1:" + PORT;
await import(TARGET);
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json().catch(() => ({})));
const get = (p) => fetch(BASE + p).then(r => ({ status: r.status }));
for (let i = 0; i < 100; i++) { try { if ((await get("/world/roster")).status === 200) break; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
const nid = (s) => "godot-" + crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
const mv = (w, x, z, extra = {}) => post("/world/move", { wallet: w, x, z, y: 6.25, dir: 1.234, handle: "Trainer_" + w.slice(-4), leg: 14, el: "Fire", br: 9, avatar: "classic", comp: "chillguy", party: "chillguy,pepe,moodeng", mount: "griffin", act: "chop:axe", eggs: "normal", spr: true, ...extra });
const O = nid("wsObs"), P = nid("wsPeer");
await mv(P, 100, 0);
let j = await mv(O, 0, 0, { dl: 1 });
const full = (j.players || []).find(p => p.wallet === P);
j = await mv(O, 0, 0, { dl: 1 });
const dl = (j.players || []).find(p => p.wallet === P);
// and the WIDE (non-interest, non-delta) spectate shape
const wideJ = await fetch(`${BASE}/world/players?wallet=${O}&x=0&z=0`).then(r => r.json());
const wide = (wideJ.players || []).find(p => p.wallet === P);
console.log(`SHAPE ${TARGET.split("/").pop()}`);
console.log(`  full keys : ${Object.keys(full || {}).join(",")}`);
console.log(`  full bytes: ${JSON.stringify(full).length}`);
console.log(`  dl   keys : ${Object.keys(dl || {}).join(",")}`);
console.log(`  dl   bytes: ${JSON.stringify(dl).length}`);
console.log(`  wide keys : ${Object.keys(wide || {}).join(",")}`);
console.log(`  wide bytes: ${JSON.stringify(wide).length}`);
process.exit(0);
