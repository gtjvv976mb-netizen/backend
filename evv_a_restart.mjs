// evv_a_restart.mjs — ADVERSARIAL: restart the server at award #49, then RACE #50 vs #51 across the
// reboot boundary. No source edits. Clean boot, memory store, throwaway keypair/ADMIN_KEY, dead RPC.
//
// THE BAR CHANGED (owner ruling 2026-08-11): 15 min OR 3 actions became 30 MINUTES OF PROVEN PRESENCE
// **AND** 10 WITNESSED ACTIONS. Every wallet here therefore has to clear BOTH arms: 9 server-verified
// actions plus ~32 minutes of proven presence walked through the REAL sweep (which clamps itself to
// 30s per tick, so the forged clock buys no shortcut), and only then the 10th action crosses.
// Prints ACTUAL VALUES.
//   1  drive the drop to EXACTLY #49 — both arms, 49 fillers, concurrent crossing
//   2  prime two racers one ACTION short of the bar, with the presence arm already held
//   3  redeploy at #49 (persist -> wipe -> boot restore): the claim book AND both accumulator arms
//      survive, and the restored rows still obey AND — a post-reboot presence sweep awards nothing
//   4  THE RACE across the boundary: both fire their 10th action in the same instant -> exactly ONE
//      #50, the loser holds zero founder rows, there is no #51
//   5  a late wallet clearing BOTH arms after the cap gets nothing
import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59985";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39385";
process.env.ADMIN_KEY = "evv-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1"; process.env.CHIK_NFT_HANDOVER = "1"; process.env.CHIK_MINT_AT_SALE = "1";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));
let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const BAR_MS = 30 * 60000;      // FOUNDER_MIN_MINUTES 30
const BAR_ACTS = 10;            // FOUNDER_MIN_ACTIONS 10
const TICK_MS = 30000;          // the server clamps one sweep to at most 30s of presence
const WALK_TICKS = 64;          // 64 x 30s = 32 min — clears BAR_MS with margin
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg, authSig });
  return { wallet, mktToken: v.body.mktToken };
}
const move = (w) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, x: 2000, z: -204 });
const fish = (w) => post("/world/fish/report", { wallet: w.wallet, mktToken: w.mktToken, tier: 1, rod: 0 });
const founderRows = (w) => SRV._regOwnedForTest(w, "chikimon").filter(x => x.origin === "open-gates-founder");
const claim = (w) => SRV._founderClaimForTest(w);
const act = (w) => SRV._founderActivityForTest(w);
const A = (w) => act(w) || { ms: 0, acts: 0 };
const triple = (w, label) => `${label}: ms=${A(w).ms} (${(A(w).ms / 60000).toFixed(1)} min), acts=${A(w).acts}, awarded=${claim(w) ? "#" + claim(w).n + " " + claim(w).sp : "NO"}`;

// the forged sweep clock — only ever forward. _stampPresenceForTest just sets a presence row's ts;
// the server's own founderPresenceTick still applies TTL (12s), `proven`, isPubkey and its 30s clamp.
let CLK = Date.now();
function walk(wallets, ticks = WALK_TICKS) {
  let stamped = 0;
  for (let k = 0; k < ticks; k++) {
    CLK += TICK_MS;
    for (const w of wallets) if (SRV._stampPresenceForTest(w, CLK - 500)) stamped++;
    SRV._founderTickForTest(CLK);
  }
  return stamped;
}
// n COUNTED actions for a whole group. Two measured server rules shape this: FISH_REC_MIN_MS is 800ms
// per wallet, and a presence row is DROPPED after WORLD_TTL_MS = 12s without a ping while
// /world/fish/report does not refresh it (measured: cast 14 at +12,429ms -> 403 "no live presence").
// So ten actions needs the /world/move heartbeat a real client sends anyway.
async function actAll(ws, n, gap = 950) {
  let uncounted = 0;
  for (let k = 0; k < n; k++) {
    await Promise.all(ws.map(move));
    const rs = await Promise.all(ws.map(fish));
    uncounted += rs.filter(r => !(r.status === 200 && r.body.counted === true)).length;
    if (k < n - 1) await sleep(gap);
  }
  return uncounted;
}

let r = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7 });
chk(r.body.cap === 50 && r.body.bar && r.body.bar.minutes === 30 && r.body.bar.actions === 10,
    `armed cap=${r.body.cap} bar=${JSON.stringify(r.body.bar)} (expect 50 / {30min,10 actions})`);

// drive to EXACTLY 49, both arms ------------------------------------------------
sec("drive the drop to #49 — 49 wallets over BOTH arms");
const fillers = [];
for (let i = 0; i < 49; i++) fillers.push(await mkWallet());
await Promise.all(fillers.map(move));
const fillUncounted = await actAll(fillers, BAR_ACTS - 1);
const fillStamped = walk(fillers.map(w => w.wallet));
const fMs = fillers.map(w => A(w.wallet).ms), fActs = fillers.map(w => A(w.wallet).acts);
console.log(`  fillers primed: ms ${Math.min(...fMs)}..${Math.max(...fMs)}, acts ${Math.min(...fActs)}..${Math.max(...fActs)} (${fillStamped} stamps, ${fillUncounted} uncounted)`);
chk(fillUncounted === 0 && fillStamped === 49 * WALK_TICKS && fMs.every(m => m >= BAR_MS) && fActs.every(a => a === BAR_ACTS - 1),
    `49 wallets hold the presence arm (min ms=${Math.min(...fMs)} >= ${BAR_MS}) and sit one action short (acts=${Math.max(...fActs)})`);
chk(SRV._liveEventsForTest().founderCount === 0,
    `and NOTHING is awarded yet — presence + 9 actions is not the bar: count=${SRV._liveEventsForTest().founderCount}`);
await sleep(950);                                   // clear the 800ms per-wallet catch floor
const cross = await Promise.all(fillers.map(fish)); // the concurrent crossing
chk(cross.every(t => t.status === 200 && t.body.counted === true),
    `all 49 tenth catches counted (statuses ${[...new Set(cross.map(t => t.status))].join(",")}, counted=${[...new Set(cross.map(t => String(t.body.counted)))].join(",")})`);
console.log("  count:", SRV._liveEventsForTest().founderCount);
chk(SRV._liveEventsForTest().founderCount === 49, `count=${SRV._liveEventsForTest().founderCount} (expect 49)`);

// two racers primed at acts=9 with the presence arm already held ------------------
sec("prime two racers: presence arm held, ONE action short");
const R1 = await mkWallet(), R2 = await mkWallet();
await move(R1); await move(R2);
const raceUncounted = await actAll([R1, R2], BAR_ACTS - 1);
const raceStamped = walk([R1.wallet, R2.wallet]);
const a1 = act(R1.wallet), a2 = act(R2.wallet);
console.log("  racer activity:", JSON.stringify(a1), JSON.stringify(a2));
chk(raceUncounted === 0 && raceStamped === WALK_TICKS * 2
    && a1 && a1.acts === BAR_ACTS - 1 && a1.ms >= BAR_MS
    && a2 && a2.acts === BAR_ACTS - 1 && a2.ms >= BAR_MS
    && !claim(R1.wallet) && !claim(R2.wallet),
    `both racers ms=${a1 && a1.ms}/${a2 && a2.ms} (>=${BAR_MS}) acts=${a1 && a1.acts}/${a2 && a2.acts} (bar ${BAR_ACTS}), unawarded`);

// REDEPLOY at #49: persist -> wipe in-memory -> boot restore ----------------------
sec("redeploy at #49 (persist -> wipe -> boot restore)");
await SRV._saveLiveEventsForTest();
SRV._resetLiveEventsForTest();
chk(SRV._liveEventsForTest().founderCount === 0 && act(R1.wallet) === null,
    `in-memory wiped: count=${SRV._liveEventsForTest().founderCount}, R1 activity=${JSON.stringify(act(R1.wallet))}`);
await SRV._bootRestoreLiveEventsForTest();
const rst = SRV._liveEventsForTest();
console.log("  restored:", JSON.stringify({ count: rst.founderCount, claims: rst.claims }));
chk(rst.founderCount === 49 && rst.claims === 49, `restored count=${rst.founderCount} claims=${rst.claims} (claim book intact)`);
chk(A(R1.wallet).acts === BAR_ACTS - 1 && A(R2.wallet).acts === BAR_ACTS - 1
    && A(R1.wallet).ms >= BAR_MS && A(R2.wallet).ms >= BAR_MS,
    `BOTH arms of the accumulator survived the restart: R1(ms=${A(R1.wallet).ms}, acts=${A(R1.wallet).acts}) R2(ms=${A(R2.wallet).ms}, acts=${A(R2.wallet).acts})`);
chk(SRV._founderEventActiveForTest(Date.now()) === true, `event still active after restart`);
// the reboot did not degrade the bar to OR: a restored row with the presence arm and 9 actions still
// wins nothing, however much more presence the sweep credits it
const postBootStamped = walk([R1.wallet, R2.wallet], 20);
chk(!claim(R1.wallet) && !claim(R2.wallet) && SRV._liveEventsForTest().founderCount === 49,
    `10 more restored minutes award NOTHING at 9 actions (${postBootStamped} stamps): R1 ms=${A(R1.wallet).ms} R2 ms=${A(R2.wallet).ms}, count=${SRV._liveEventsForTest().founderCount}`);

// THE RACE: both fire their 10th verified action CONCURRENTLY ---------------------
sec("the race — both cross the bar in the same instant, across the reboot boundary");
await move(R1); await move(R2);   // fresh presence heartbeats across the reboot
const pre1 = { ms: A(R1.wallet).ms, acts: A(R1.wallet).acts }, pre2 = { ms: A(R2.wallet).ms, acts: A(R2.wallet).acts };
await sleep(950);                 // clear the 800ms per-wallet catch floor
const race = await Promise.all([fish(R1), fish(R2)]);
console.log("  race replies:", JSON.stringify(race.map(x => x.body)));
chk(race.every(t => t.status === 200 && t.body.counted === true),
    `both 10th catches counted (statuses ${race.map(t => t.status).join(",")}, counted=${race.map(t => String(t.body.counted)).join(",")})`);
const c1 = claim(R1.wallet), c2 = claim(R2.wallet);
const wins = [c1, c2].filter(Boolean);
console.log(`  R1 crossed with (ms=${pre1.ms}, acts=${pre1.acts + 1}):`, JSON.stringify(c1));
console.log(`  R2 crossed with (ms=${pre2.ms}, acts=${pre2.acts + 1}):`, JSON.stringify(c2));
chk(wins.length === 1 && wins[0].n === 50 && SRV._liveEventsForTest().founderCount === 50,
    `exactly ONE crossed: winners=${wins.length}, #${wins[0] && wins[0].n}, count=${SRV._liveEventsForTest().founderCount} — no #51`);
const winner = c1 ? R1 : R2, loser = c1 ? R2 : R1;
chk(founderRows(loser.wallet).length === 0,
    `the #51 loser holds ZERO founder rows (it met BOTH arms: ms=${(c1 ? pre2 : pre1).ms}, acts=${(c1 ? pre2 : pre1).acts + 1})`);
chk(founderRows(winner.wallet).length === 1, `the #50 winner holds exactly ONE founder row`);

// a late wallet clearing BOTH arms after the cap gets nothing ---------------------
sec("a 52nd wallet clearing BOTH arms after the cap");
const LATE = await mkWallet(); await move(LATE);
const lateUncounted = await actAll([LATE], BAR_ACTS);
walk([LATE.wallet]);
// NOTE the acts=0: once the cap is closed founderNoteAction returns before it accrues, so the counted
// catches below are real (the server answered counted:true) but buy no accumulator at all.
console.log(`  LATE drove ${BAR_ACTS} counted catches (${lateUncounted} uncounted) + a 32-min walk AFTER the cap closed`);
console.log("  " + triple(LATE.wallet, "LATE"));
chk(lateUncounted === 0 && claim(LATE.wallet) === null && founderRows(LATE.wallet).length === 0 && SRV._liveEventsForTest().founderCount === 50,
    `late wallet: claim=${JSON.stringify(claim(LATE.wallet))}, rows=${founderRows(LATE.wallet).length}, ms=${A(LATE.wallet).ms}, count=${SRV._liveEventsForTest().founderCount}`);
// and the loser is still empty-handed after all of that
chk(founderRows(loser.wallet).length === 0 && claim(loser.wallet) === null,
    `the race loser is still unawarded at the end: claim=${JSON.stringify(claim(loser.wallet))}, rows=${founderRows(loser.wallet).length}`);

console.log(`\n==== evv_a_restart: ${pass} passed, ${fail} failed ====`);
console.log(`EVV_A_RESTART_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
