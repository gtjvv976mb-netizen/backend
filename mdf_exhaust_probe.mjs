// mdf_exhaust_probe.mjs — THE ONE SHAPE mdf_founder_cap_sim DOES NOT DRIVE:
// the pool runs DRY while the drop is still UNFILLED and still RUNNING.
//
// mdf §E drains the pool by AWARDING all 50, so _founderCount hits FOUNDER_CAP and founderAward
// short-circuits on the cap line. This probe instead lets NORMAL BUYERS take every remaining
// edition, leaving _founderCount < FOUNDER_CAP with nothing left to give. A qualified wallet then
// keeps ticking. Measures, with actual counts:
//   1. is the grant REFUSED (nothing minted past a cap, no claim written, count unmoved)?
//   2. how many times does the refusal log fire per qualified wallet per sweep? (ops: log flood)
//
// Throwaway keypair, memory store, dead RPC, throwaway ADMIN_KEY. Never touches the live backend.
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59973"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39273";
process.env.ADMIN_KEY = "mdfx-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1"; process.env.CHIK_MINT_AT_SALE = "1"; process.env.CHIK_REG_ALL = "1";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
delete process.env.FOUNDER_SPECIES; delete process.env.FOUNDER_CAP; delete process.env.FOUNDER_MIN_MINUTES;
delete process.env.FOUNDER_MIN_ACTIONS;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- count the refusal log WITHOUT changing server behaviour ----
const _err = console.error;
let poolExhaustLogs = 0;
console.error = (...a) => { if (String(a[0] || "").includes("pool exhausted")) poolExhaustLogs++; else _err(...a); };

const SRV = await import("./server.js"); await sleep(1500);
let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const issued = (sp) => SRV._trueIssued("chikimon", sp).count;
const CAPS = SRV._memeCapsForTest();
const WAVE2 = SRV._memeWave2ForTest();
const table = () => WAVE2.map(sp => `${sp}=${issued(sp)}/${CAPS[sp]}`).join("  ");

// start the Dynasty drop
let r = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 14, species: "meme_dynasty" });
console.log(`\nstart -> ${r.status}  pool=${(r.body.species || []).length}  dealTotal=${r.body.dealTotal}  reservedTotal=${r.body.reservedTotal}`);
console.log("  BEFORE:", table());

// ---- award a handful of REAL founders so _founderCount is > 0 but < 50 ----
const won = [];
for (let i = 0; i < 3; i++) {
  const w = bs58.encode(nacl.sign.keyPair().publicKey);
  const a = SRV._founderAwardForTest(w);
  if (a) won.push({ w, ...a });
}
console.log(`  founders awarded normally: ${won.length} -> ${JSON.stringify(won.map(x => x.n + ":" + x.sp))}`);
const countAfterAwards = SRV._liveEventsForTest().founderCount;

// ---- now let NORMAL BUYERS take EVERY remaining edition. The hold blocks them, so the honest way
// to empty the shelf is to stop the drop (which releases the hold), drain, then restart it.
await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
let drained = 0;
for (let i = 0; i < 40; i++) {
  const w = bs58.encode(nacl.sign.keyPair().publicKey);
  const g = await post("/admin/grant-collection", { key: KEY, wallet: w });
  drained += (g.body.granted || []).filter(x => x.type === "chikimon" && WAVE2.includes(x.sp)).length;
  if (WAVE2.every(sp => issued(sp) >= CAPS[sp])) break;
}
console.log(`  normal buyers took ${drained} Dynasty editions`);
console.log("  AFTER DRAIN:", table());
const allFull = WAVE2.every(sp => issued(sp) >= CAPS[sp]);
chk(allFull, `every Dynasty species is now at its cap (${WAVE2.map(sp => issued(sp) + "/" + CAPS[sp]).join(",")})`);
chk(WAVE2.every(sp => issued(sp) <= CAPS[sp]), `and NOT ONE was overminted in the draining`);

// restart the drop over the now-empty pool — unfilled (count 3) but nothing left to give
r = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 14, species: "meme_dynasty" });
console.log(`\nrestart over an EMPTY pool -> ${r.status}`);
console.log(`  deal     : ${JSON.stringify(r.body.deal)} (total ${r.body.dealTotal})`);
console.log(`  reserved : ${JSON.stringify(r.body.reserved)} (total ${r.body.reservedTotal})`);
console.log(`  claimed  : ${r.body.claimed} / ${r.body.cap}`);
// NOT dealTotal===0: founderRoomOf adds `_founderPerSp` back, so the deal is a WHOLE-SERIES plan
// that counts grants already made. On an exhausted pool it therefore equals exactly the grants
// already given — which is the correct invariant to assert, and the one that would break if the
// deal ever planned an edition that no longer exists.
chk(r.body.dealTotal === countAfterAwards,
    `the deal plans ONLY what has already been given — nothing that no longer exists (dealTotal=${r.body.dealTotal} = grants made ${countAfterAwards})`);
chk(WAVE2.every(sp => (r.body.deal[sp] || 0) <= issued(sp)),
    `and no species is dealt more than actually exists: ${WAVE2.map(sp => sp + " " + (r.body.deal[sp] || 0) + "<=" + issued(sp)).join(", ")}`);
chk(r.body.reservedTotal === 0, `and nothing is held, so no buyer is blocked for a drop that cannot pay (reservedTotal=${r.body.reservedTotal})`);
chk(Number(r.body.claimed) === countAfterAwards && countAfterAwards < 50,
    `the drop is UNFILLED and still running: claimed=${r.body.claimed} of ${r.body.cap}`);

// ---- 1. IS THE GRANT REFUSED? ----
const before = WAVE2.map(sp => issued(sp));
poolExhaustLogs = 0;
const hopeful = bs58.encode(nacl.sign.keyPair().publicKey);
const got = SRV._founderAwardForTest(hopeful);
const after = WAVE2.map(sp => issued(sp));
console.log(`\n  award on an empty pool -> ${JSON.stringify(got)}`);
console.log(`  census before: [${before.join(",")}]`);
console.log(`  census after : [${after.join(",")}]`);
chk(got === null, `the grant is REFUSED, not minted anyway (award=${JSON.stringify(got)})`);
chk(before.join(",") === after.join(","), `NOT ONE edition was minted past a cap by the refused grant`);
chk(SRV._founderClaimForTest(hopeful) === null, `the refused claimant is NOT marked as having claimed (claim=null) — the slot stays unspent`);
chk(SRV._liveEventsForTest().founderCount === countAfterAwards,
    `and the counter did not move: ${SRV._liveEventsForTest().founderCount} = ${countAfterAwards}`);

// ---- 2. HOW LOUD IS THE REFUSAL? ----
const REPS = 200;
poolExhaustLogs = 0;
for (let i = 0; i < REPS; i++) SRV._founderAwardForTest(hopeful);
console.log(`\n  ${REPS} refused award attempts -> ${poolExhaustLogs} "pool exhausted" lines logged`);
console.log(`  ratio: ${(poolExhaustLogs / REPS).toFixed(2)} log lines per refused attempt`);
// THE BAR: a dry pool is a steady state, not an incident. 200 refusals inside one minute must not
// produce 200 log lines — before the throttle this measured exactly 1.00 lines/attempt.
chk(poolExhaustLogs <= 2,
    `the refusal is throttled: ${poolExhaustLogs} lines for ${REPS} attempts in one minute (was ${REPS})`);

// what that means on a live server: the presence sweep runs every 10s and calls founderMaybeAward
// for EVERY proven player over the bar. Extrapolate honestly.
const SWEEPS_PER_HOUR = 360;
const perWalletPerHour = (poolExhaustLogs / REPS) * SWEEPS_PER_HOUR;
console.log(`  extrapolated: ${perWalletPerHour.toFixed(0)} lines/hour PER qualified wallet (10s sweep)`);
console.log(`                ${(perWalletPerHour * 20).toFixed(0)} lines/hour with 20 such wallets online`);

console.log(`\n================  mdf_exhaust_probe: ${pass} passed, ${fail} failed  ================`);
console.log(`MDF_EXHAUST_DONE pass=${pass} fail=${fail} logsPerAttempt=${(poolExhaustLogs / REPS).toFixed(2)}`);
process.exit(0);
