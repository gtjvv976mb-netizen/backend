#!/usr/bin/env node
// THE PURGE (Wicked Temple mini-game) — boots the REAL server.js in-process against throwaway
// keypairs, a dummy RPC and the memory store. Nothing here can reach the live backend.
//
// What it proves, every assertion printing the ACTUAL value:
//   * CHIK_TEMPLE off  -> the route pays 0 and touches nothing        (child process — the flag is read at module-eval)
//   * CHIK_TEMPLE on   -> a perfect 3/3 pays TEMPLE_CHIKI_PER x 3
//   * the daily $CHIKI ceiling DEGRADES: the day's total equals the cap EXACTLY, never more
//   * the daily RUN ceiling pays the 7th run nothing
//   * TEMPLE_MIN_GAP_MS returns 429 and the refusal consumes nothing (the replay bound)
//   * clamps and rejections: purified > rounds, negative, garbage, rounds != 3
//   * refusals: net_id wallet, banned wallet, stale market token, forged signature
//   * the book survives a simulated restart through the REAL save/restore + the real store
//
// Run: node temple_purge_sim.mjs      (the parent forks itself once with TEMPLE_ROLE=off)
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import nacl from "tweetnacl";
import bs58 from "bs58";

const ROLE = process.env.TEMPLE_ROLE || "on";
const PORT = ROLE === "off" ? "39178" : "39177";
const BASE = "http://127.0.0.1:" + PORT;

// ---- throwaway identities, generated BEFORE the server is imported so BANNED_WALLETS can name one
const kps = {};
function newKp(tag) { const kp = nacl.sign.keyPair(); kps[tag] = kp; return bs58.encode(kp.publicKey); }
const W = {
  perfect: newKp("perfect"),   // proves 3/3 = 120 and the replay bound
  capMoney: newKp("capMoney"), // walks the $CHIKI ceiling to exactly 240
  partial:  newKp("partial"),  // proves the DEGRADE (a remainder smaller than the run earned)
  capRuns:  newKp("capRuns"),  // walks the run ceiling to the refused 7th
  clamp:    newKp("clamp"),    // clamps and rejections
  token:    newKp("token"),    // credential refusals
  banned:   newKp("banned"),   // named in BANNED_WALLETS below
  restart:  newKp("restart"),  // the persistence round-trip
  stranger: newKp("stranger"), // reads someone else's state
};

const _t = nacl.sign.keyPair();                                  // THROWAWAY treasury, never a real key
process.env.RPC_URL = "http://127.0.0.1:59999";                  // dummy, never called
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";                            // skip on-chain
process.env.NETWORK = "devnet";
process.env.PORT = PORT;
process.env.BANNED_WALLETS = W.banned;                           // the ban list is seeded from env at boot
process.env.CHIK_CHRONICLE = "1";                                // so the chronicle row is really written
delete process.env.DATABASE_URL;                                 // memory store
// the flag under test — read at module-eval, which is exactly why the OFF case needs its own process
if (ROLE === "off") delete process.env.CHIK_TEMPLE; else process.env.CHIK_TEMPLE = "1";
// every TEMPLE_* default must be the SHIPPED one, or the sim measures an operator's env
for (const k of ["TEMPLE_CHIKI_PER", "TEMPLE_DAILY_CHIKI", "TEMPLE_DAILY_RUNS", "TEMPLE_MIN_GAP_MS"]) delete process.env[k];

// RED-TEAM CONTROL. The same sim file can be pointed at a defanged snapshot (a real COPY sitting
// beside server.js, never a symlink — Node resolves a symlink to its real path before resolving
// ./world_terrain.js and friends, so a symlinked snapshot silently boots the FIXED siblings).
const TARGET = process.env.TEMPLE_TARGET || "./server.js";
const SRV = await import(TARGET);
await new Promise((r) => setTimeout(r, 1400));                   // let it bind

const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })
  .then(async (r) => ({ status: r.status, b: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async (r) => ({ status: r.status, b: await r.json().catch(() => ({})) }));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ok: " + msg); } else { fail++; console.log("  FAIL: " + msg); } };

function signIn(tag) {
  const wallet = bs58.encode(kps[tag].publicKey);
  const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(msg, "utf8"), kps[tag].secretKey)).toString("base64");
  return { wallet, authMsg: msg, authSig: sig };
}
// one purge run; the pace gate is stepped over with the server's OWN seam, never by faking a clock
const purge = (wallet, purified, rounds = 3, extra = {}) => post("/world/temple/purge", { wallet, purified, rounds, ...extra });
const clearGap = (w) => SRV._templeClearGapForTest(w);
async function waitUp() { for (let i = 0; i < 100; i++) { try { if ((await get("/health")).status) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); } throw new Error("no server"); }

await waitUp();

// =====================================================================================
if (ROLE === "off") {
  console.log("\n--- [child] CHIK_TEMPLE UNSET (the shipped default) ---");
  const cfg = SRV._templeStateForTest();
  ok(cfg.on === false, `the flag reads OFF by default (got on=${cfg.on})`);
  const r = await purge(W.perfect, 3);
  ok(r.status === 200, `flag-off purge answers 200, not an error (got ${r.status})`);
  ok(r.b.ok === false && r.b.reason === "off", `flag-off body is the documented refusal (got ok=${r.b.ok} reason=${JSON.stringify(r.b.reason)})`);
  ok((r.b.chiki || 0) === 0, `flag-off pays 0 (got chiki=${r.b.chiki === undefined ? "undefined" : r.b.chiki})`);
  ok(SRV._templeRowForTest(W.perfect) === null, `flag-off wrote NO book row (got ${JSON.stringify(SRV._templeRowForTest(W.perfect))})`);
  // even a body that would otherwise pay the maximum, repeated, moves nothing
  for (let i = 0; i < 5; i++) await purge(W.perfect, 3);
  ok(SRV._templeStateForTest().size === 0, `5 more flag-off runs left the book empty (size=${SRV._templeStateForTest().size})`);
  const st = await get("/world/temple/state?wallet=" + W.perfect);
  ok(st.status === 200 && st.b.on === false, `flag-off state says on=false (status=${st.status} on=${st.b.on})`);
  ok(st.b.runsLeft === 0 && st.b.chikiLeft === 0, `flag-off state offers nothing (runsLeft=${st.b.runsLeft} chikiLeft=${st.b.chikiLeft})`);
  console.log(`TEMPLE_OFF_DONE pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

// =====================================================================================
console.log("\n=== THE PURGE — WICKED TEMPLE (server-decided payout) ===");

// ---- 1. the shipped defaults, read from the server itself -----------------------------
console.log("\n--- 1. shipped defaults ---");
const CFG = SRV._templeStateForTest();
console.log("  config:", JSON.stringify(CFG));
ok(CFG.on === true, `CHIK_TEMPLE=1 turns the route on (got on=${CFG.on})`);
ok(CFG.rounds === 3, `a purge is 3 rounds (got rounds=${CFG.rounds})`);
ok(CFG.per === 40, `TEMPLE_CHIKI_PER default (got ${CFG.per})`);
ok(CFG.dailyChiki === 240, `TEMPLE_DAILY_CHIKI default (got ${CFG.dailyChiki})`);
ok(CFG.dailyRuns === 6, `TEMPLE_DAILY_RUNS default (got ${CFG.dailyRuns})`);
ok(CFG.gapMs === 90000, `TEMPLE_MIN_GAP_MS default (got ${CFG.gapMs})`);
ok(CFG.offering === 3, `the offering is 3 essence (got ${CFG.offering})`);
ok(CFG.ready === true, `the day-book restore landed, so writes are armed (got ready=${CFG.ready})`);

// ---- 2. a fresh wallet's state, and a perfect run --------------------------------------
console.log("\n--- 2. a perfect 3/3 ---");
{
  const s0 = await get("/world/temple/state?wallet=" + W.perfect);
  ok(s0.b.runsLeft === 6 && s0.b.chikiLeft === 240,
     `a fresh wallet is offered the whole day (runsLeft=${s0.b.runsLeft} chikiLeft=${s0.b.chikiLeft})`);
  ok(s0.b.resetMs > 0 && s0.b.resetMs <= 86400000,
     `resetMs is a real countdown to UTC midnight (got ${s0.b.resetMs} ms = ${(s0.b.resetMs / 3600000).toFixed(2)} h)`);
  const r = await purge(W.perfect, 3);
  console.log("  reply:", JSON.stringify(r.b));
  ok(r.status === 200 && r.b.ok === true, `a perfect run is accepted (status=${r.status} ok=${r.b.ok})`);
  ok(r.b.chiki === 120, `3/3 pays 3 x 40 = 120 (got chiki=${r.b.chiki})`);
  ok(r.b.purified === 3, `the score comes back as reported (got purified=${r.b.purified})`);
  ok(r.b.capped === false, `an uncapped run is not flagged capped (got capped=${r.b.capped})`);
  ok(r.b.left === 120, `120 of the day's 240 is left (got left=${r.b.left})`);
  ok(r.b.runsLeft === 5, `5 of the day's 6 runs are left (got runsLeft=${r.b.runsLeft})`);
  const row = SRV._templeRowForTest(W.perfect);
  ok(row && row.runs === 1 && row.chiki === 120, `the book recorded exactly that run (got ${JSON.stringify(row)})`);
}

// ---- 3. the pace gate IS the replay bound ----------------------------------------------
console.log("\n--- 3. TEMPLE_MIN_GAP_MS 90000 and the replay ---");
{
  const before = SRV._templeRowForTest(W.perfect);
  const r = await purge(W.perfect, 3);                       // the identical body, immediately
  ok(r.status === 429, `a replay inside the gap is 429 (got ${r.status})`);
  ok(r.b.retryInMs > 0 && r.b.retryInMs <= 90000, `it says how long to wait (got retryInMs=${r.b.retryInMs})`);
  ok((r.b.chiki || 0) === 0, `the replay pays nothing (got chiki=${r.b.chiki === undefined ? "undefined" : r.b.chiki})`);
  const after = SRV._templeRowForTest(W.perfect);
  ok(after.runs === before.runs && after.chiki === before.chiki,
     `the replay did NOT double-pay — book unchanged (before ${JSON.stringify(before)} after ${JSON.stringify(after)})`);
  // and a REFUSED run must not consume the window either: the wallet is still exactly one gap in
  const r2 = await purge(W.perfect, 3);
  ok(r2.status === 429, `a second replay is still refused, not silently accepted (got ${r2.status})`);
  ok(SRV._templeRowForTest(W.perfect).runs === 1, `still one run on the book (got runs=${SRV._templeRowForTest(W.perfect).runs})`);
}

// ---- 4. the daily $CHIKI ceiling degrades and the total lands EXACTLY on the cap --------
console.log("\n--- 4. the daily $CHIKI ceiling (degrade, do not refuse) ---");
{
  const w = W.capMoney;
  let paid = 0, replies = [];
  for (let i = 0; i < 5; i++) {
    clearGap(w);
    const r = await purge(w, 3);
    paid += r.b.chiki || 0;
    replies.push(`run${i + 1}:chiki=${r.b.chiki} capped=${r.b.capped} left=${r.b.left} runsLeft=${r.b.runsLeft}`);
  }
  console.log("  " + replies.join("  |  "));
  ok(paid === 240, `five perfect runs paid the cap and NOT A COIN MORE (sum=${paid}, cap=${CFG.dailyChiki})`);
  const row = SRV._templeRowForTest(w);
  ok(row.chiki === 240, `the book agrees with the sum (row.chiki=${row.chiki})`);
  ok(row.runs === 5, `all five runs were counted even though three paid 0 (row.runs=${row.runs})`);
  // the run that first exceeded the ceiling must be the DEGRADE shape, not an error
  clearGap(w);
  const over = await purge(w, 3);
  ok(over.status === 200 && over.b.ok === true, `an over-cap run is still answered 200/ok (status=${over.status} ok=${over.b.ok})`);
  ok(over.b.chiki === 0 && over.b.capped === true && over.b.left === 0,
     `over the ceiling it pays the remainder (0) and says so (chiki=${over.b.chiki} capped=${over.b.capped} left=${over.b.left})`);
  const st = await get("/world/temple/state?wallet=" + w);
  ok(st.b.chikiLeft === 0, `the state read agrees the day is spent (chikiLeft=${st.b.chikiLeft})`);
}

// ---- 5. a PARTIAL remainder — the degrade paying less than the run earned ---------------
console.log("\n--- 5. the partial remainder ---");
{
  const w = W.partial;
  clearGap(w); const a = await purge(w, 2);       // 80
  clearGap(w); const b = await purge(w, 2);       // 80  -> 160 spent, 80 left
  clearGap(w); const c = await purge(w, 3);       // earns 120, only 80 of the day remains
  console.log(`  runs: ${a.b.chiki} + ${b.b.chiki} + ${c.b.chiki}`);
  ok(a.b.chiki === 80 && b.b.chiki === 80, `2/3 pays 2 x 40 = 80 (got ${a.b.chiki} and ${b.b.chiki})`);
  ok(c.b.chiki === 80, `the third run earned 120 but was paid the 80 that was left (got chiki=${c.b.chiki})`);
  ok(c.b.capped === true, `and it is flagged capped (got capped=${c.b.capped})`);
  ok(c.b.left === 0, `with nothing left (got left=${c.b.left})`);
  ok(a.b.chiki + b.b.chiki + c.b.chiki === 240, `the day's total is exactly the cap (sum=${a.b.chiki + b.b.chiki + c.b.chiki})`);
  ok(SRV._templeRowForTest(w).chiki === 240, `book total matches (got ${SRV._templeRowForTest(w).chiki})`);
}

// ---- 6. the daily RUN ceiling — the 7th run pays nothing --------------------------------
console.log("\n--- 6. the daily RUN ceiling ---");
{
  const w = W.capRuns;
  // score 0 every time, so the MONEY ceiling can never be the thing that binds here
  for (let i = 0; i < 6; i++) { clearGap(w); const r = await purge(w, 0); if (i === 5) console.log(`  run6: ${JSON.stringify(r.b)}`); }
  const row6 = SRV._templeRowForTest(w);
  ok(row6.runs === 6 && row6.chiki === 0, `six 0/3 runs cost the run allowance and nothing else (got ${JSON.stringify(row6)})`);
  const st6 = await get("/world/temple/state?wallet=" + w);
  ok(st6.b.runsLeft === 0 && st6.b.chikiLeft === 240,
     `state: no runs left, money untouched (runsLeft=${st6.b.runsLeft} chikiLeft=${st6.b.chikiLeft})`);
  clearGap(w);
  const r7 = await purge(w, 3);                              // a PERFECT 7th run — it must still pay 0
  console.log("  run7:", JSON.stringify(r7.b));
  ok(r7.status === 200, `the 7th run is answered, not errored (status=${r7.status})`);
  ok(r7.b.chiki === 0, `a PERFECT 7th run pays nothing (got chiki=${r7.b.chiki})`);
  ok(r7.b.capped === true && r7.b.left === 0 && r7.b.runsLeft === 0,
     `and it says why (capped=${r7.b.capped} left=${r7.b.left} runsLeft=${r7.b.runsLeft} reason=${JSON.stringify(r7.b.reason)})`);
  ok(r7.b.reason === "daily_runs", `the reason names the run ceiling, not the money one (got ${JSON.stringify(r7.b.reason)})`);
  ok(SRV._templeRowForTest(w).runs === 6, `the refused 7th did not inflate the book (runs=${SRV._templeRowForTest(w).runs})`);
  ok(SRV._templeRowForTest(w).chiki === 0, `and paid nothing into it (chiki=${SRV._templeRowForTest(w).chiki})`);
}

// ---- 7. clamps and rejections ------------------------------------------------------------
console.log("\n--- 7. clamps and rejections ---");
{
  const w = W.clamp;
  clearGap(w); const hi = await purge(w, 99);
  ok(hi.b.purified === 3 && hi.b.chiki === 120, `purified 99 clamps to rounds (got purified=${hi.b.purified} chiki=${hi.b.chiki})`);
  clearGap(w); const neg = await purge(w, -5);
  ok(neg.b.purified === 0 && neg.b.chiki === 0, `purified -5 clamps to 0 (got purified=${neg.b.purified} chiki=${neg.b.chiki})`);
  clearGap(w); const str = await purge(w, "2");
  ok(str.b.purified === 2 && str.b.chiki === 80, `the decimal string "2" is a real score (got purified=${str.b.purified} chiki=${str.b.chiki})`);
  clearGap(w); const hex = await purge(w, "0x2");
  ok(hex.b.purified === 0 && hex.b.chiki === 0, `"0x2" is NOT 2 — it scores 0 (got purified=${hex.b.purified} chiki=${hex.b.chiki})`);
  clearGap(w); const nul = await purge(w, null);
  ok(nul.b.purified === 0 && nul.b.chiki === 0, `purified null scores 0, never Number(null)=0-as-a-real-score-of-something (got purified=${nul.b.purified} chiki=${nul.b.chiki})`);
  // rounds must be EXACTLY 3
  const w2 = W.stranger;   // a wallet with no runs, so a rejection cannot be confused with a cap
  const BAD_ROUNDS = [1, 4, 0, -3, null, "", true, [], {}, "0x3", "three", 2.9];
  for (const bad of BAD_ROUNDS) {
    clearGap(w2);
    const r = await purge(w2, 3, bad);
    ok(r.status === 400, `rounds=${JSON.stringify(bad)} is rejected 400 (got ${r.status}${r.b.chiki !== undefined ? " chiki=" + r.b.chiki : ""})`);
  }
  // ...and a body with NO rounds key at all. NOTE this must be posted raw: `purge(w,3,undefined)`
  // takes the helper's own default parameter and silently sends rounds:3 — the sim would be testing
  // its own default, not the server (it did, and read as a code failure).
  clearGap(w2);
  const omitted = await post("/world/temple/purge", { wallet: w2, purified: 3 });
  ok(omitted.status === 400, `a body with no rounds key at all is rejected 400 (got ${omitted.status}${omitted.b.chiki !== undefined ? " chiki=" + omitted.b.chiki : ""})`);
  clearGap(w2); const good = await purge(w2, 1, "3");
  ok(good.status === 200 && good.b.chiki === 40, `rounds="3" as a decimal string is accepted (status=${good.status} chiki=${good.b.chiki})`);
  ok(SRV._templeRowForTest(w2).runs === 1,
     `the ${BAD_ROUNDS.length + 1} rejected bodies wrote nothing to the book — only the one good run is on it (runs=${SRV._templeRowForTest(w2).runs})`);
}

// ---- 8. identity refusals -----------------------------------------------------------------
console.log("\n--- 8. identity refusals ---");
{
  const nid = await purge("godot-a1b2c3d4", 3);
  ok(nid.status === 400, `a per-install net_id has no durable book and is refused 400 (got ${nid.status}: ${JSON.stringify(nid.b.error)})`);
  const junk = await purge("nope", 3);
  ok(junk.status === 400, `a junk wallet is refused 400 (got ${junk.status})`);
  const none = await post("/world/temple/purge", { purified: 3, rounds: 3 });
  ok(none.status === 400, `no wallet at all is refused 400 (got ${none.status})`);
  const ban = await purge(W.banned, 3);
  ok(ban.status === 403, `a banned wallet is refused 403 (got ${ban.status}: ${JSON.stringify(ban.b.error)})`);
  ok(SRV._templeRowForTest(W.banned) === null, `and the banned wallet has no book row (got ${JSON.stringify(SRV._templeRowForTest(W.banned))})`);
}

// ---- 9. credentials: optional, but a WRONG one is always refused ---------------------------
console.log("\n--- 9. credentials ---");
{
  const si = signIn("token");
  const v = await post("/verify", { ...si, netId: "net_" + W.token.slice(0, 10) });
  const tok = v.b.mktToken;
  ok(typeof tok === "string" && tok.length >= 16, `/verify minted a market token (len=${tok ? tok.length : 0})`);
  clearGap(W.token);
  const good = await purge(W.token, 3, 3, { mktToken: tok });
  ok(good.status === 200 && good.b.chiki === 120, `the real token is served (status=${good.status} chiki=${good.b.chiki})`);
  clearGap(W.token);
  const stale = await purge(W.token, 3, 3, { mktToken: "0".repeat(32) });
  ok(stale.status === 401, `a stale market token is 401, never quietly accepted (got ${stale.status}: ${JSON.stringify(stale.b.error)})`);
  clearGap(W.token);
  const forged = await purge(W.token, 3, 3, { authMsg: si.authMsg, authSig: Buffer.alloc(64).toString("base64") });
  ok(forged.status === 401, `a forged signature is 401 (got ${forged.status}: ${JSON.stringify(forged.b.error)})`);
  clearGap(W.token);
  const other = signIn("stranger");                        // a real signature — for the WRONG wallet
  const wrongOwner = await purge(W.token, 3, 3, { authMsg: other.authMsg, authSig: other.authSig });
  ok(wrongOwner.status === 401, `a valid signature from a DIFFERENT wallet is 401 (got ${wrongOwner.status})`);
  ok(SRV._templeRowForTest(W.token).runs === 1, `the three refused runs cost nothing (runs=${SRV._templeRowForTest(W.token).runs}, only the served one)`);
  ok(SRV._templeRowForTest(W.token).chiki === 120, `and paid once (chiki=${SRV._templeRowForTest(W.token).chiki})`);
  // an UNPROVEN run is still served (the fleet has no credential for this route yet) — stated, not hidden
  clearGap(W.token);
  const bare = await purge(W.token, 1);
  ok(bare.status === 200 && bare.b.chiki === 40, `a bare {wallet,purified,rounds} is served today (status=${bare.status} chiki=${bare.b.chiki})`);
}

// ---- 10. a stranger reading someone else's state -------------------------------------------
console.log("\n--- 10. the state read ---");
{
  const mine = await get("/world/temple/state?wallet=" + W.perfect);
  ok(mine.status === 200, `the owner's own read is 200 (got ${mine.status})`);
  ok(mine.b.runsLeft === 5 && mine.b.chikiLeft === 120, `and shows the day so far (runsLeft=${mine.b.runsLeft} chikiLeft=${mine.b.chikiLeft})`);
  const keys = Object.keys(mine.b).sort().join(",");
  ok(!/wallet|name|balance|purse|chikis|token/i.test(keys), `the reply names nothing but allowances and constants (keys=${keys})`);
  const badw = await get("/world/temple/state?wallet=godot-a1b2c3d4");
  ok(badw.status === 400, `a net_id state read is refused 400 (got ${badw.status})`);
  const stale = await get("/world/temple/state?wallet=" + W.perfect + "&mktToken=" + "0".repeat(32));
  ok(stale.status === 401, `a stale token on the READ is refused too (got ${stale.status}: ${JSON.stringify(stale.b.error)})`);
  const sizeBefore = SRV._templeStateForTest().size;
  for (let i = 0; i < 20; i++) await get("/world/temple/state?wallet=" + bs58.encode(nacl.sign.keyPair().publicKey));
  ok(SRV._templeStateForTest().size === sizeBefore,
     `20 reads of 20 strangers created NO book rows (size ${sizeBefore} -> ${SRV._templeStateForTest().size})`);
}

// ---- 11. the book survives a simulated restart ---------------------------------------------
console.log("\n--- 11. the restart ---");
{
  const w = W.restart;
  clearGap(w); await purge(w, 3);                       // 120
  clearGap(w); await purge(w, 1);                       // +40 = 160, 2 runs
  const before = SRV._templeRowForTest(w);
  ok(before.runs === 2 && before.chiki === 160, `two runs on the book before the restart (got ${JSON.stringify(before)})`);
  // the REAL write path -> the REAL store -> wipe every in-memory row -> the REAL boot restore
  await SRV._saveTempleBookForTest();
  const snap = SRV._templeSnapshotForTest();
  ok(Array.isArray(snap.w) && snap.w.some((r) => r[0] === w), `the persisted blob carries the wallet (rows=${snap.w.length}, day=${snap.d})`);
  SRV._clearTempleBookForTest();
  ok(SRV._templeRowForTest(w) === null, `the book is wiped, as a restarted process would find it (got ${JSON.stringify(SRV._templeRowForTest(w))})`);
  const n = await SRV._bootRestoreTempleForTest();
  const after = SRV._templeRowForTest(w);
  ok(n > 0, `the boot restore read the blob back (${n} wallets)`);
  ok(after && after.runs === before.runs && after.chiki === before.chiki,
     `the day-book survived the restart (before ${JSON.stringify(before)} after ${JSON.stringify(after)})`);
  // and it still BINDS: the restored total is what the next run is measured against
  clearGap(w);
  const r = await purge(w, 3);
  ok(r.b.chiki === 80, `the run after the restart is paid the restored remainder, not a fresh 120 (got chiki=${r.b.chiki})`);
  ok(r.b.left === 0 && r.b.capped === true, `and the day is spent (left=${r.b.left} capped=${r.b.capped})`);
  // a restore MERGES: a run paid inside the restore window is never forgotten. Persist the CURRENT
  // book first — the earlier blob predates the third run, and merging against a stale blob measures
  // the fixture, not the rule.
  await SRV._saveTempleBookForTest();
  const stored = SRV._templeRowForTest(w);
  clearGap(w);
  SRV._clearTempleBookForTest();
  await purge(w, 3);                                    // "inside the restore window" — a fresh 120
  const inWindow = SRV._templeRowForTest(w);
  await SRV._bootRestoreTempleForTest();                // the stored row lands on top
  const merged = SRV._templeRowForTest(w);
  ok(merged.chiki === Math.max(inWindow.chiki, stored.chiki) && merged.runs === Math.max(inWindow.runs, stored.runs),
     `restore MERGES on the larger counter (stored ${JSON.stringify(stored)} in-window ${JSON.stringify(inWindow)} merged ${JSON.stringify(merged)})`);
  ok(merged.chiki === 240 && merged.runs === 3,
     `so the in-window run is never handed the day's cap a second time (merged chiki=${merged.chiki} runs=${merged.runs}, cap=${CFG.dailyChiki})`);
}

// ---- 12. the chronicle row ------------------------------------------------------------------
console.log("\n--- 12. the chronicle ---");
{
  const w = W.perfect;
  const day = Math.floor(Date.now() / 86400000);
  const row = SRV._templeRowForTest(w);
  const idem = `temple:${w}:${day}:${row.runs}`;
  const dup = SRV._chronAddForTest("temple", w, { idem });
  ok(dup === false, `the run's idem key ${idem.slice(0, 24)}... is already spent — a replay records nothing (chronicleAdd returned ${dup})`);
  const fresh = SRV._chronAddForTest("temple", w, { idem: `temple:${w}:${day}:${row.runs + 99}` });
  ok(fresh === true, `an unseen key IS recorded, so the check above is not vacuous (returned ${fresh})`);
  const st = SRV._chronStatsForTest();
  ok(st.on === true && st.queued > 0, `the chronicle is on and holding rows (on=${st.on} queued=${st.queued})`);
}

// ---- 13. no treasury / on-chain path was touched ---------------------------------------------
console.log("\n--- 13. the money boundary ---");
{
  const src = await (await import("node:fs/promises")).readFile(TARGET, "utf8");
  const i = src.indexOf('app.post("/world/temple/purge"');
  const j = src.indexOf('app.get("/world/temple/state"');
  const slice = src.slice(i, j);
  // MEASURE THE CODE, NOT THE PROSE. The first run of this section failed on the word "payout"
  // inside an explanatory comment about /quest/state — the ruler was reading English, not calls.
  const route = slice.split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/.*$/, "")).join("\n");
  ok(i > 0 && j > i, `the route was located in server.js (${slice.length} bytes, ${route.replace(/\s+/g, " ").length} with comments stripped)`);
  for (const forbidden of ["sendChikiRaw", "treasury", "conn.", "payout", "chikiBalance", "TREASURY_SECRET"]) {
    ok(!route.includes(forbidden), `the purge route CODE contains no "${forbidden}" (found=${route.includes(forbidden)})`);
  }
  ok(!route.includes("b.chiki") && !route.includes("b.amount") && !route.includes("b.reward"),
     `the route reads NO client-supplied amount (b.chiki=${route.includes("b.chiki")} b.amount=${route.includes("b.amount")} b.reward=${route.includes("b.reward")})`);
  // the ruler must be able to fail: it finds a token that IS there
  ok(route.includes("TEMPLE_CHIKI_PER"), `the stripped slice still contains the server's own constant, so the scan is not vacuous (found=${route.includes("TEMPLE_CHIKI_PER")})`);
}

// ---- run the flag-OFF half in its own process (the flag is read at module-eval) --------------
console.log("\n--- 14. flag OFF (child process) ---");
const child = await new Promise((resolve) => {
  const p = spawn(process.execPath, [new URL(import.meta.url).pathname], {
    env: { ...process.env, TEMPLE_ROLE: "off", PORT: "39178" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("close", (code) => resolve({ code, out }));
});
for (const line of child.out.split("\n")) if (/^\s{2}(ok|FAIL):/.test(line)) console.log(line);
const m = child.out.match(/TEMPLE_OFF_DONE pass=(\d+) fail=(\d+)/);
ok(!!m, `the flag-off child reported (${m ? m[0] : "NO TALLY — output: " + child.out.slice(-400)})`);
if (m) { pass += Number(m[1]); fail += Number(m[2]); }

console.log(`\nTEMPLE_PURGE_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
