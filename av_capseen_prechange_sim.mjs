#!/usr/bin/env node
// STASH TEST for finding F: does the WORLD_MAX_PEERS cap poison the delta `seen` memory?
// Runs the SAME scenario against whichever server.js is named in AV_SERVER, so the pre-change
// build (git HEAD, before interest management) and the current build can be compared directly.
// Memory store, throwaway keypair, dummy RPC, unique port. Never touches the live backend.
import { createRequire } from "module";
import crypto from "node:crypto";
const require = createRequire(new URL("./package.json", import.meta.url));
const nacl = (m => m.default || m)(require("tweetnacl"));

const TARGET = process.env.AV_SERVER || new URL("./server.js", import.meta.url).href;
const PORT = process.env.AV_PORT || "39511";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59982";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = PORT;
delete process.env.DATABASE_URL;

const BASE = "http://127.0.0.1:" + PORT;
await import(TARGET);
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => r.json().catch(() => ({})));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status }));
for (let i = 0; i < 100; i++) { try { if ((await get("/world/roster")).status === 200) break; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }

const nid = (s) => "godot-" + crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
const mv = (w, x, z, extra = {}) => post("/world/move", { wallet: w, x, z, y: 6, dir: 1.2, handle: "T_" + w.slice(-4), leg: 14, el: "Fire", br: 9, avatar: "classic", comp: "chillguy", party: "a,b", mount: "", act: "", eggs: "", spr: false, ...extra });

const OBS = nid("capObs"); const crowd = [];
// 70 peers all packed inside 250 units — inside the interest radius on the NEW build, and inside
// WORLD_RADIUS on both, so the ONLY thing that cuts anyone is the 60-peer cap.
for (let i = 0; i < 70; i++) { const w = nid("cap" + i); crowd.push(w); await mv(w, 40 + i * 3, 0); }
let j = await mv(OBS, 0, 0, { dl: 1 });
const shipped = new Set((j.players || []).map(p => p.wallet));
const cut = crowd.filter(w => !shipped.has(w));
console.log(`  server=${TARGET.split("/").pop()}  rows=${(j.players || []).length}  cut=${cut.length}`);
// the 20 nearest leave; peers that were cut are now inside the cap window for the first time
for (let i = 0; i < 20; i++) await mv(crowd[i], 3000, 3000);
for (let i = 20; i < 70; i++) await mv(crowd[i], 40 + i * 3, 0);
j = await mv(OBS, 0, 0, { dl: 1 });
const promoted = (j.players || []).filter(p => cut.includes(p.wallet));
const poisoned = promoted.filter(p => p.dl === 1 && !p.handle);
console.log(`  promoted-from-cut=${promoted.length}  UNRENDERABLE dl:1 (server thinks it already sent them)=${poisoned.length}`);
console.log(`CAPSEEN ${TARGET.split("/").pop()} poisoned=${poisoned.length}`);
process.exit(0);
