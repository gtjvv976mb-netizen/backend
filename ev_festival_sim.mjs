// ev_festival_sim.mjs — FISHING FESTIVAL parameterized to N DAYS through /admin/event/start.
// Boots the REAL server.js in-process (memory store, dead RPC, throwaway admin key).
// Proves, with PRINTED ACTUAL VALUES:
//   A  /admin/event/start {event:"fishing", days:5, mult:4} arms the EXISTING _fishEvent machinery:
//      ends = start + 5 days exactly; active at ends-1ms and NOT at ends+1ms (active exactly N days)
//   B  the odds chokepoint multiplies by 4 while active, EVENT_CAST_CAP 0.25 still binds
//   C  every surface carries it: /world/event (old shape + events key), the frozen move-reply
//      `event` key {mult,ends,label}, /stats.events.fishing
//   D  /admin/event/stop ends it: odds return to base, surfaces go quiet
//   E  the legacy /admin/fishing-event hours route still works unchanged (24h festival)
import nacl from "tweetnacl";
import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59982"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39282";
process.env.ADMIN_KEY = "ev-throwaway-" + crypto.randomBytes(12).toString("hex");
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);

// ---------------------------------------------------------------------------
sec("A start: fishing festival, 5 days, 4x");
const base = { golden_chikifish: SRV._ffishChanceForTest("golden_chikifish", 1, 10),
               crystal_koi: SRV._ffishChanceForTest("crystal_koi", 1, 10),
               mystic_eel: SRV._ffishChanceForTest("mystic_eel", 1, 10),
               rainbow_fish: SRV._ffishChanceForTest("rainbow_fish", 1, 10) };
console.log("  base odds (tier1, rod10):", JSON.stringify(base));
const t0 = Date.now();
let r = await post("/admin/event/start", { key: KEY, event: "fishing", days: 5, mult: 4, label: "Fishing Festival" });
console.log("  start reply:", JSON.stringify(r.body));
chk(r.status === 200 && r.body.event === "fishing_festival" && r.body.mult === 4 && r.body.days === 5,
    `started: ${r.status} event=${r.body.event} mult=${r.body.mult} days=${r.body.days}`);
const ends = Number(r.body.ends);
const drift = Math.abs(ends - (t0 + 5 * 86400000));
chk(drift < 2000, `ends = start + 5 days (120h) exactly: ends-start=${ends - t0} ms, drift ${drift} ms`);
chk(SRV._fishEventActiveForTest(ends - 1) === true && SRV._fishEventActiveForTest(ends + 1) === false,
    `festival active at ends-1ms=${SRV._fishEventActiveForTest(ends - 1)}, ends+1ms=${SRV._fishEventActiveForTest(ends + 1)} (exactly 5 days)`);

// ---------------------------------------------------------------------------
sec("B the odds chokepoint");
for (const sp of Object.keys(base)) {
  const now4 = SRV._ffishChanceForTest(sp, 1, 10);
  const expect = Math.min(base[sp] * 4, 0.25);
  chk(Math.abs(now4 - expect) < 1e-12, `${sp}: ${base[sp]} -> ${now4} (expect ${expect}, x${(now4 / base[sp]).toFixed(2)})`);
}
const capped = SRV._ffishChanceForTest("golden_chikifish", 3, 10);
console.log(`  tier3 golden_chikifish during festival = ${capped} (EVENT_CAST_CAP 0.25 is the ceiling)`);
chk(capped <= 0.25, `no single cast beats 1-in-4: ${capped} <= 0.25`);

// ---------------------------------------------------------------------------
sec("C every surface");
r = await get("/world/event");
chk(r.body.active === true && r.body.mult === 4 && Math.abs(r.body.remainingMs - 5 * 86400000) < 5000,
    `/world/event: active=${r.body.active} mult=${r.body.mult} remainingMs=${r.body.remainingMs} (~432000000)`);
chk(r.body.events && r.body.events.fishing && r.body.events.fishing.mult === 4,
    `/world/event.events.fishing rides too (mult=${r.body.events && r.body.events.fishing && r.body.events.fishing.mult})`);
let mv = await post("/world/move", { wallet: "nfest_" + Date.now(), x: 0, z: 0 });
chk(mv.body.event && mv.body.event.mult === 4 && mv.body.event.ends === ends && typeof mv.body.event.label === "string",
    `move reply FROZEN key intact: event=${JSON.stringify(mv.body.event)}`);
chk(mv.body.events && mv.body.events.fishing && mv.body.events.fishing.ends === ends,
    `move reply NEW key: events.fishing.ends=${mv.body.events && mv.body.events.fishing && mv.body.events.fishing.ends}`);
r = await get("/stats");
chk(r.body.events && r.body.events.fishing && r.body.events.fishing.mult === 4,
    `/stats.events.fishing.mult=${r.body.events && r.body.events.fishing && r.body.events.fishing.mult}`);

// ---------------------------------------------------------------------------
sec("D stop");
r = await post("/admin/event/stop", { key: KEY, event: "fishing_festival" });
chk(r.status === 200 && r.body.active === false, `stopped: ${JSON.stringify(r.body)}`);
const after = SRV._ffishChanceForTest("golden_chikifish", 1, 10);
chk(after === base.golden_chikifish, `odds back to base: ${after} === ${base.golden_chikifish}`);
r = await get("/world/event");
chk(r.body.active === false && !r.body.events, `/world/event quiet: ${JSON.stringify(r.body)}`);

// ---------------------------------------------------------------------------
sec("E the legacy hours route is unchanged");
r = await post("/admin/fishing-event", { key: KEY, mult: 4, hours: 24 });
chk(r.status === 200 && r.body.active === true && r.body.hours === 24, `legacy 24h start: ${JSON.stringify(r.body)}`);
const e24 = Number(r.body.ends);
chk(SRV._fishEventActiveForTest(e24 - 1) === true && SRV._fishEventActiveForTest(e24 + 1) === false,
    `legacy festival exactly 24h (ends-1 ${SRV._fishEventActiveForTest(e24 - 1)}, ends+1 ${SRV._fishEventActiveForTest(e24 + 1)})`);
r = await post("/admin/fishing-event", { key: KEY, mult: 1, hours: 0 });
chk(r.body.active === false, `legacy cancel: ${JSON.stringify(r.body)}`);

console.log(`\n==== ev_festival_sim: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
