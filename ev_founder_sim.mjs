// ev_founder_sim.mjs — FOUNDER DROP: first 50 genuinely-active wallets, one legendary each.
// Boots the REAL server.js in-process (memory store, dead RPC, throwaway admin key + keypairs).
//
// THE BAR CHANGED (owner ruling 2026-08-11): 15 minutes OR 3 actions became
// **30 MINUTES OF PROVEN PRESENCE *AND* 10 WITNESSED ACTIONS**. Sign-in is free, so an OR bar let one
// operator take all 50 drops with 3 quick actions per throwaway wallet. This sim drives BOTH arms.
//
// Proves, with PRINTED ACTUAL VALUES:
//   A  demo/net_id sessions NEVER accrue — 10 actions AND a stamped 30-min presence walk, zero
//   B  an unproven public wallet cannot accrue — fish/report 403s, the presence sweep skips its row
//   C  arm 1: the forged clock is CLAMPED (a 30-minute jump buys 30s), 30 min of stamped presence
//      through the REAL sweep, and presence ALONE awards nothing at 9 actions
//   C2 THE NEW RULE, the whole point of the change — (ms, acts, awarded) for three wallets:
//        10+ actions, under 30 min  -> NOTHING (won under the OR bar)
//        30+ min, under 10 actions  -> NOTHING (won under the OR bar)
//        both arms                  -> WINS
//   D  THE RACE: 59 more wallets cross BOTH arms (9 actions + 30 stamped minutes, 10th action fired
//      CONCURRENTLY) -> the cap holds at exactly 50 across a 63-wallet pool, zero double-awards,
//      species spread exactly 10 x 5 legendaries, claim numbers 1..50 unique
//   E  exactly-once per wallet: an awarded wallet keeps acting AND keeps accruing presence, no second
//   F  live counter on every surface: /world/event + /stats founderClaimed 50/50
//   G  the award materialises: /assets/news toast + /assets/arrivals delivers the creature,
//      registry row origin "open-gates-founder" + founder chain event + census-counted
//   H  the chronicle records each award exactly once (ev:founder = 50, idem per wallet)
//   I  a mid-event restart keeps the claim book: nobody re-awarded, a late wallet clearing BOTH arms
//      after the cap gets nothing
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59983"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39283";
process.env.ADMIN_KEY = "ev-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1";       // the award record
process.env.CHIK_NFT_HANDOVER = "1";    // /assets/news + /assets/arrivals materialisation
process.env.CHIK_MINT_AT_SALE = "1";    // editions at issuance
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const LEGENDS = ["galador", "adalor", "tyrannos", "grovador", "dragonos"];
// THE NEW BAR, in the sim's own terms. Both arms must be met by the same wallet.
const BAR_MS = 30 * 60000;      // FOUNDER_MIN_MINUTES 30
const BAR_ACTS = 10;            // FOUNDER_MIN_ACTIONS 10
const TICK_MS = 30000;          // the server clamps one sweep to at most 30s of presence
const WALK_TICKS = 64;          // 64 x 30s = 32 min — clears BAR_MS with margin for a dt=0 first tick
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
// the (ms, acts, awarded) triple this whole change is about
const triple = (w, label) => `${label}: ms=${A(w).ms} (${(A(w).ms / 60000).toFixed(1)} min), acts=${A(w).acts}, awarded=${claim(w) ? "#" + claim(w).n + " " + claim(w).sp : "NO"}`;

// ---- the forged sweep clock: walk PROVEN presence through the REAL tick ------------------------
// _stampPresenceForTest only sets a presence row's ts; the server's own founderPresenceTick still
// applies its TTL (12s), `proven` and isPubkey checks and its own 30s-per-sweep clamp. The clock only
// ever moves forward, so a row we do NOT stamp goes stale and is skipped — that is what keeps the
// "actions but no time" wallet below the presence arm.
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
// n COUNTED actions for a whole group, one round at a time. Two server rules make the shape of this:
// FISH_REC_MIN_MS is 800ms per wallet (a faster catch answers counted:false), and a presence row is
// dropped after WORLD_TTL_MS = 12s without a ping — so ten actions needs the /world/move heartbeat a
// real client sends anyway, or the sixth cast is refused "no live presence".
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

// the event: founder drop, 7 days
let r = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7 });
console.log("start reply:", JSON.stringify(r.body));
chk(r.status === 200 && r.body.cap === 50 && r.body.perSpecies === 10 && r.body.claimed === 0
    && r.body.bar && r.body.bar.minutes === 30 && r.body.bar.actions === 10,
    `armed: cap=${r.body.cap} perSpecies=${r.body.perSpecies} bar=${JSON.stringify(r.body.bar)} (expect 50/10/{30min,10 actions})`);

// ---------------------------------------------------------------------------
sec("A demo/net_id sessions never accrue — even clearing both arms");
const DEMO = { wallet: "ndemo_" + Date.now(), mktToken: "" };
await move(DEMO);
const dUncounted = await actAll([DEMO], BAR_ACTS);
const dStamped = walk([DEMO.wallet]);
console.log(`  demo drove ${BAR_ACTS} counted catches (${dUncounted} uncounted) and ${dStamped} stamped presence ticks`);
chk(dStamped === WALK_TICKS, `the demo presence row WAS stamped every tick (${dStamped}/${WALK_TICKS}) — the walk is not a no-op`);
chk(act(DEMO.wallet) === null && claim(DEMO.wallet) === null,
    `demo activity=${JSON.stringify(act(DEMO.wallet))} claim=${JSON.stringify(claim(DEMO.wallet))} (both null)`);

// ---------------------------------------------------------------------------
sec("B an unproven public wallet cannot accrue");
const PUP = bs58.encode(nacl.sign.keyPair().publicKey);   // a wallet that never signed in
await post("/world/move", { wallet: PUP, x: 2000, z: -204 });   // unclaimed slot, proven=false
r = await post("/world/fish/report", { wallet: PUP, tier: 1, rod: 0 });
chk(r.status === 403, `tokenless fish/report -> ${r.status} "${r.body.error}" (expect 403)`);
const pStamped = walk([PUP]);
chk(pStamped === WALK_TICKS && act(PUP) === null,
    `presence sweep skips the unproven row across ${pStamped} stamped ticks: activity=${JSON.stringify(act(PUP))}`);

// ---------------------------------------------------------------------------
sec("C arm 1 — 30 minutes of PROVEN presence, and it awards NOTHING alone");
const W0 = await mkWallet();
await move(W0);
CLK += TICK_MS; SRV._stampPresenceForTest(W0.wallet, CLK - 500); SRV._founderTickForTest(CLK);   // baseline sweep
// THE FORGED CLOCK IS CLAMPED: hand the sweep a 30-MINUTE jump in ONE tick — it buys 30s, not 30 min.
// (no await between these three lines: nothing else can touch _founderLastSweep in between)
const msBeforeJump = A(W0.wallet).ms;
CLK += BAR_MS; SRV._stampPresenceForTest(W0.wallet, CLK - 500); SRV._founderTickForTest(CLK);
const jumpGain = A(W0.wallet).ms - msBeforeJump;
chk(jumpGain === TICK_MS, `a forged ${BAR_MS} ms clock jump credited ${jumpGain} ms (clamped to ${TICK_MS}) — ms=${A(W0.wallet).ms} after`);
chk(claim(W0.wallet) === null, `and it did not award: claim=${JSON.stringify(claim(W0.wallet))}`);
// 9 actions — ONE short of the action arm — then a full 30-minute presence walk
const w0Uncounted = await actAll([W0], BAR_ACTS - 1);
const w0Stamped = walk([W0.wallet]);
console.log(`  ${triple(W0.wallet, "W0 after 9 actions + a 32-min walk")}  (${w0Stamped} ticks stamped, ${w0Uncounted} uncounted)`);
chk(A(W0.wallet).ms >= BAR_MS, `presence arm MET through the real sweep: ms=${A(W0.wallet).ms} >= ${BAR_MS}`);
chk(A(W0.wallet).acts === BAR_ACTS - 1, `action arm one short: acts=${A(W0.wallet).acts} (bar ${BAR_ACTS})`);
chk(claim(W0.wallet) === null && founderRows(W0.wallet).length === 0,
    `PRESENCE ALONE AWARDS NOTHING: claim=${JSON.stringify(claim(W0.wallet))}, founder rows=${founderRows(W0.wallet).length}`);
// the 10th action closes the AND
const w0Pre = { ms: A(W0.wallet).ms, acts: A(W0.wallet).acts };
await sleep(950); await fish(W0);
const c0 = claim(W0.wallet);
console.log(`  the 10th action closed the AND: was (ms=${w0Pre.ms}, acts=${w0Pre.acts}) ->`, JSON.stringify(c0));
chk(c0 && c0.n === 1 && c0.sp === "galador", `award = claim #${c0 && c0.n}, species ${c0 && c0.sp} (expect #1 galador — round-robin start)`);
chk(w0Pre.ms >= BAR_MS && w0Pre.acts + 1 >= BAR_ACTS, `both arms were satisfied at the moment of award: ms=${w0Pre.ms}>=${BAR_MS}, acts=${w0Pre.acts + 1}>=${BAR_ACTS}`);

// ---------------------------------------------------------------------------
sec("C2 THE NEW RULE — both arms or nothing (each of these won under the OLD 'OR' bar)");
const ACTS_ONLY = await mkWallet();   // 12 actions, minutes nowhere near 30
const TIME_ONLY = await mkWallet();   // 32 minutes, 9 actions
const BOTH = await mkWallet();        // 32 minutes and 10 actions
await Promise.all([move(ACTS_ONLY), move(TIME_ONLY), move(BOTH)]);
const trioUncounted = await actAll([ACTS_ONLY, TIME_ONLY, BOTH], BAR_ACTS - 1);
await sleep(950);
await actAll([ACTS_ONLY], 3);         // ACTS_ONLY overshoots the action arm: 12 > 10
// ACTS_ONLY gets 28 minutes — a real session's worth, deliberately just SHORT of the arm. (Not 29.5:
// the live 10s sweep can still credit a few seconds here, and a probe that squeaks under by one tick
// would be flaky. The printed ms is the actual value either way.)
const shortStamped = walk([ACTS_ONLY.wallet], 56);
// then the two time wallets — the unstamped ACTS_ONLY row goes stale against the forged clock
const trioStamped = walk([TIME_ONLY.wallet, BOTH.wallet]);
chk(shortStamped === 56 && A(ACTS_ONLY.wallet).ms > 0 && A(ACTS_ONLY.wallet).ms < BAR_MS,
    `ACTS_ONLY parked JUST under the presence arm: ms=${A(ACTS_ONLY.wallet).ms} (${(A(ACTS_ONLY.wallet).ms / 60000).toFixed(1)} min, bar ${BAR_MS / 60000} min) over ${shortStamped} stamped ticks`);
chk(trioStamped === WALK_TICKS * 2, `both time-wallet rows stamped every tick (${trioStamped}/${WALK_TICKS * 2}), ${trioUncounted} uncounted actions`);
console.log("  " + triple(ACTS_ONLY.wallet, "ACTS_ONLY"));
console.log("  " + triple(TIME_ONLY.wallet, "TIME_ONLY"));
console.log("  " + triple(BOTH.wallet, "BOTH (before its 10th action)"));
chk(A(ACTS_ONLY.wallet).acts >= BAR_ACTS && A(ACTS_ONLY.wallet).ms < BAR_MS && claim(ACTS_ONLY.wallet) === null && founderRows(ACTS_ONLY.wallet).length === 0,
    `10+ ACTIONS, UNDER 30 MIN -> NOTHING: ms=${A(ACTS_ONLY.wallet).ms} (<${BAR_MS}), acts=${A(ACTS_ONLY.wallet).acts} (>=${BAR_ACTS}), awarded=${claim(ACTS_ONLY.wallet) ? "YES" : "NO"}, rows=${founderRows(ACTS_ONLY.wallet).length}`);
chk(A(TIME_ONLY.wallet).ms >= BAR_MS && A(TIME_ONLY.wallet).acts < BAR_ACTS && claim(TIME_ONLY.wallet) === null && founderRows(TIME_ONLY.wallet).length === 0,
    `30+ MIN, UNDER 10 ACTIONS -> NOTHING: ms=${A(TIME_ONLY.wallet).ms} (>=${BAR_MS}), acts=${A(TIME_ONLY.wallet).acts} (<${BAR_ACTS}), awarded=${claim(TIME_ONLY.wallet) ? "YES" : "NO"}, rows=${founderRows(TIME_ONLY.wallet).length}`);
const bothPre = { ms: A(BOTH.wallet).ms, acts: A(BOTH.wallet).acts };
await sleep(950); await fish(BOTH);
const cB = claim(BOTH.wallet);
console.log("  " + triple(BOTH.wallet, "BOTH (after its 10th action)"));
chk(cB && cB.n === 2 && bothPre.ms >= BAR_MS && bothPre.acts + 1 >= BAR_ACTS && founderRows(BOTH.wallet).length === 1,
    `BOTH ARMS -> WINS: ms=${bothPre.ms} (>=${BAR_MS}), acts=${bothPre.acts + 1} (>=${BAR_ACTS}), awarded=#${cB && cB.n} ${cB && cB.sp}, rows=${founderRows(BOTH.wallet).length}`);
// and the two barred wallets keep on failing — more of one arm never substitutes for the other
await sleep(950); await actAll([ACTS_ONLY], 3);          // 15 actions now
walk([TIME_ONLY.wallet], 20);                            // 10 more minutes now
chk(claim(ACTS_ONLY.wallet) === null && claim(TIME_ONLY.wallet) === null,
    `piling on one arm never substitutes: ACTS_ONLY(ms=${A(ACTS_ONLY.wallet).ms}, acts=${A(ACTS_ONLY.wallet).acts}) TIME_ONLY(ms=${A(TIME_ONLY.wallet).ms}, acts=${A(TIME_ONLY.wallet).acts}) — both still unawarded`);

// ---------------------------------------------------------------------------
sec("D the race: 59 more wallets, BOTH arms, 10th action concurrent");
const racers = [];
for (let i = 0; i < 59; i++) racers.push(await mkWallet());
await Promise.all(racers.map(move));
const raceUncounted = await actAll(racers, BAR_ACTS - 1);
chk(raceUncounted === 0, `all ${racers.length} racers took ${BAR_ACTS - 1} counted catches each (${raceUncounted} uncounted)`);
const raceStamped = walk(racers.map(w => w.wallet));
const rMs = racers.map(w => A(w.wallet).ms), rActs = racers.map(w => A(w.wallet).acts);
console.log(`  racers primed: ms ${Math.min(...rMs)}..${Math.max(...rMs)}, acts ${Math.min(...rActs)}..${Math.max(...rActs)} (${raceStamped} stamps)`);
chk(rMs.every(m => m >= BAR_MS) && rActs.every(a => a === BAR_ACTS - 1) && racers.every(w => !claim(w.wallet)),
    `all 59 hold the presence arm and sit one action short — awarded so far: ${racers.filter(w => claim(w.wallet)).length} (expect 0)`);
await sleep(950);                                              // clear the 800ms per-wallet catch floor
const tenth = await Promise.all(racers.map((w) => fish(w)));   // the concurrent bar-crossing
chk(tenth.every(t => t.status === 200 && t.body.counted === true),
    `all 59 tenth catches counted (statuses ${[...new Set(tenth.map(t => t.status))].join(",")}, counted=${[...new Set(tenth.map(t => String(t.body.counted)))].join(",")})`);
const ev = SRV._liveEventsForTest();
console.log(`  founderCount=${ev.founderCount} claims=${ev.claims} perSp=${JSON.stringify(ev.perSp)}`);
chk(ev.founderCount === 50 && ev.claims === 50, `EXACTLY 50 awarded (count=${ev.founderCount}, claims=${ev.claims})`);
const all = [W0, BOTH, ACTS_ONLY, TIME_ONLY, ...racers];
const awarded = all.filter(w => claim(w.wallet));
const refused = all.filter(w => !claim(w.wallet));
chk(all.length === 63 && awarded.length === 50 && refused.length === all.length - 50,
    `pool=${all.length} candidates -> awarded=${awarded.length}, unawarded=${refused.length} (2 barred + ${refused.length - 2} refused-full)`);
const nums = awarded.map(w => claim(w.wallet).n).sort((a, b) => a - b);
chk(nums.length === 50 && new Set(nums).size === 50 && nums[0] === 1 && nums[49] === 50,
    `claim numbers 1..50, all unique (first=${nums[0]}, last=${nums[49]}, unique=${new Set(nums).size})`);
chk(LEGENDS.every(sp => ev.perSp[sp] === 10), `species spread exactly 10 each: ${LEGENDS.map(sp => sp + "=" + ev.perSp[sp]).join(", ")}`);
const rowCounts = all.map(w => founderRows(w.wallet).length);
const totalRows = rowCounts.reduce((a, b) => a + b, 0);
chk(totalRows === 50 && rowCounts.every(n => n <= 1), `registry founder-origin rows: total=${totalRows}, max per wallet=${Math.max(...rowCounts)} (expect 50, 1)`);
chk(refused.every(w => founderRows(w.wallet).length === 0), `every one of the ${refused.length} unawarded wallets holds ZERO founder rows`);

// ---------------------------------------------------------------------------
sec("E exactly-once per wallet, ever");
const LUCKY = awarded[5];
await sleep(950); await fish(LUCKY); await sleep(950); await fish(LUCKY);
walk([LUCKY.wallet]);                                    // and another 32 minutes on the clock
chk(SRV._liveEventsForTest().founderCount === 50 && founderRows(LUCKY.wallet).length === 1 && act(LUCKY.wallet) === null,
    `after 2 more catches + a 32-min walk: count=${SRV._liveEventsForTest().founderCount}, LUCKY rows=${founderRows(LUCKY.wallet).length}, activity=${JSON.stringify(act(LUCKY.wallet))} (a claimed wallet accrues nothing)`);

// ---------------------------------------------------------------------------
sec("F the live counter");
r = await get("/world/event");
chk(r.body.founderClaimed === 50 && r.body.founderCap === 50 && r.body.events.founder.full === true,
    `/world/event: founderClaimed=${r.body.founderClaimed}/${r.body.founderCap} full=${r.body.events && r.body.events.founder && r.body.events.founder.full}`);
r = await get("/stats");
chk(r.body.founderClaimed === 50 && r.body.founderCap === 50 && r.body.events && r.body.events.founder,
    `/stats: founderClaimed=${r.body.founderClaimed}/${r.body.founderCap}, events.founder rides the 30s poll`);

// ---------------------------------------------------------------------------
sec("G the award materialises with FOUNDER provenance");
const row0 = founderRows(W0.wallet)[0];
console.log("  W0 registry row:", JSON.stringify({ id: row0.id, sp: row0.sp, kind: row0.kind, origin: row0.origin, edition: row0.edition }));
chk(row0.origin === "open-gates-founder" && row0.kind === "legendary", `origin="${row0.origin}" kind=${row0.kind}`);
const fev = (SRV._nftRowForTest(row0.id).chain || []).find(e => e.what === "founder");
console.log("  founder chain event:", JSON.stringify(fev));
chk(fev && fev.number === 1 && fev.of === 50 && fev.sp_of === 10, `chain carries founder #${fev && fev.number} of ${fev && fev.of} (species ${fev && fev.sp_number}/${fev && fev.sp_of})`);
r = await get(`/assets/news?wallet=${W0.wallet}&key=${KEY}`);
const notice = (r.body.notices || [])[0];
console.log("  toast:", JSON.stringify(notice && notice.text));
chk(r.body.count === 1 && notice && notice.kind === "arrived" && /FOUNDER DROP/.test(notice.text),
    `/assets/news: ${r.body.count} arrived notice, FOUNDER text`);
r = await post("/assets/arrivals", { wallet: W0.wallet, mktToken: W0.mktToken, have: [], haveMounts: [] });
chk(r.body.count === 1 && r.body.add[0].sp === "galador", `/assets/arrivals delivers ${r.body.count} creature (${r.body.add[0] && r.body.add[0].sp}) into the satchel`);
const census = LEGENDS.map(sp => `${sp}=${SRV._trueIssued("chikimon", sp).count}`);
console.log("  census:", census.join(", "));
chk(LEGENDS.every(sp => SRV._trueIssued("chikimon", sp).count === 10), `census counts every founder birth (10 per legendary)`);

// ---------------------------------------------------------------------------
sec("H the chronicle records each award exactly once");
await SRV._chronFlushForTest();
r = await get(`/chronicle/summary?key=${KEY}&metric=ev:founder`);
const totRow = (r.body.totals || []).find(x => String(x.metric || x.m) === "ev:founder");
console.log("  chronicle totals row:", JSON.stringify(totRow));
const totN = Number(totRow && (totRow.n ?? totRow.total ?? totRow.v));
chk(totN === 50, `world lifetime ev:founder = ${totN} (expect 50 — one per award, idem per wallet)`);
r = await get(`/chronicle/summary?key=${KEY}&metric=ev:mint`);
const mintRow = (r.body.totals || []).find(x => String(x.metric || x.m) === "ev:mint");
chk(Number(mintRow && (mintRow.n ?? mintRow.total ?? mintRow.v)) === 50, `ev:mint = ${mintRow && (mintRow.n ?? mintRow.total ?? mintRow.v)} (every birth through the chokepoint once)`);

// ---------------------------------------------------------------------------
sec("I a mid-event restart keeps the claim book");
await SRV._saveLiveEventsForTest();
SRV._resetLiveEventsForTest();
chk(SRV._liveEventsForTest().founderCount === 0, `state wiped (dead process): count=${SRV._liveEventsForTest().founderCount}`);
await SRV._bootRestoreLiveEventsForTest();
const ev2 = SRV._liveEventsForTest();
chk(ev2.founderCount === 50 && ev2.claims === 50 && SRV._founderEventActiveForTest(Date.now()) === true,
    `restored: count=${ev2.founderCount} claims=${ev2.claims} eventActive=${SRV._founderEventActiveForTest(Date.now())}`);
chk(LEGENDS.every(sp => ev2.perSp[sp] === 10), `per-species book intact: ${LEGENDS.map(sp => sp + "=" + ev2.perSp[sp]).join(", ")}`);
chk(A(TIME_ONLY.wallet).ms >= BAR_MS && A(ACTS_ONLY.wallet).acts >= BAR_ACTS && !claim(TIME_ONLY.wallet) && !claim(ACTS_ONLY.wallet),
    `the barred wallets' activity survived the restart unrewarded: TIME_ONLY(ms=${A(TIME_ONLY.wallet).ms}, acts=${A(TIME_ONLY.wallet).acts}) ACTS_ONLY(ms=${A(ACTS_ONLY.wallet).ms}, acts=${A(ACTS_ONLY.wallet).acts})`);
await fish(LUCKY); await sleep(950); await fish(LUCKY);
chk(SRV._liveEventsForTest().founderCount === 50 && founderRows(LUCKY.wallet).length === 1,
    `no re-award after restart: count=${SRV._liveEventsForTest().founderCount}, LUCKY rows=${founderRows(LUCKY.wallet).length}`);
const LATE = await mkWallet();
await move(LATE);
const lateUncounted = await actAll([LATE], BAR_ACTS);
walk([LATE.wallet]);
// NOTE the acts=0 in this row: once the cap is closed founderNoteAction returns before it accrues, so
// the counted catches below are real (the server answered counted:true) but buy no accumulator at all.
console.log(`  LATE drove ${BAR_ACTS} counted catches (${lateUncounted} uncounted) + a 32-min walk AFTER the cap closed`);
console.log("  " + triple(LATE.wallet, "LATE"));
chk(claim(LATE.wallet) === null && founderRows(LATE.wallet).length === 0 && lateUncounted === 0 && SRV._liveEventsForTest().founderCount === 50,
    `a 64th wallet playing a full session after the cap: claim=${JSON.stringify(claim(LATE.wallet))}, rows=${founderRows(LATE.wallet).length}, ms=${A(LATE.wallet).ms}, count=${SRV._liveEventsForTest().founderCount}`);
await SRV._chronFlushForTest();
r = await get(`/chronicle/summary?key=${KEY}&metric=ev:founder`);
const totRow2 = (r.body.totals || []).find(x => String(x.metric || x.m) === "ev:founder");
chk(Number(totRow2 && (totRow2.n ?? totRow2.total ?? totRow2.v)) === 50, `chronicle still ev:founder=50 after all retries`);

console.log(`\nTHE AND-BAR TABLE (ms, acts, awarded)`);
console.log("  " + triple(ACTS_ONLY.wallet, "10+ actions / under 30 min"));
console.log("  " + triple(TIME_ONLY.wallet, "30+ min / under 10 actions"));
console.log(`  both arms: ms=${bothPre.ms} (${(bothPre.ms / 60000).toFixed(1)} min), acts=${bothPre.acts + 1}, awarded=${cB ? "#" + cB.n + " " + cB.sp : "NO"}`);
console.log(`\n==== ev_founder_sim: ${pass} passed, ${fail} failed ====`);
console.log(`EV_FOUNDER_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
