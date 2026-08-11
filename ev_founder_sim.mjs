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
//   D  THE RACE: cap+9 more wallets cross BOTH arms (9 actions + 30 stamped minutes, 10th action
//      fired CONCURRENTLY) -> the cap holds at exactly 50, zero double-awards, claim numbers 1..50
//      unique, and the species spread covers EVERY species in the pool at floor/ceil of cap/pool
//
// THE ROSTER IS READ FROM THE SERVER, NEVER HARDCODED (owner ruling 2026-08-11: the legendary roster
// grew 5 -> 11 — astraya, bamboran, borealon, horoxyn, rivaros, solvarex joined as ORDINARY
// legendaries — and astragor/crysalune/vesperos are queued). Every species assertion below derives
// from the pool the START REPLY reports and the cap the server states, so the next roster change
// moves the expected numbers with it instead of failing this sim. 50 does not divide by 11, so the
// spread is asserted as floor/ceil (4 or 5) with an exact total, not a flat "10 each".
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
// pin the drop to its SHIPPED defaults: an inherited FOUNDER_SPECIES would replace the game's
// legendary roster with an operator list and this sim would silently stop testing the default pool.
delete process.env.FOUNDER_SPECIES; delete process.env.FOUNDER_CAP; delete process.env.FOUNDER_PER_SPECIES;
delete process.env.FOUNDER_MIN_MINUTES; delete process.env.FOUNDER_MIN_ACTIONS;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
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

// the event: founder drop, 7 days. No `species` named -> the drop hands out the GAME'S legendary
// roster, and the start reply tells us what that roster is right now.
let r = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7 });
console.log("start reply:", JSON.stringify(r.body));
const POOL = Array.isArray(r.body.species) ? r.body.species.slice() : [];   // the live roster, server-stated
const CAP = Number(r.body.cap);
const PER_SP = Number(r.body.perSpecies);
// derived, so a 12th legendary moves these instead of breaking the sim
const NSP = POOL.length || 1;
const LO = Math.floor(CAP / NSP), HI = Math.ceil(CAP / NSP);   // 50/11 -> 4 and 5
const REM = CAP % NSP;                                          // 6 species take the extra one
const N_HI = REM === 0 ? NSP : REM, N_LO = NSP - N_HI;
const RACERS = CAP + 9;                                         // enough crossers to fight over the cap
console.log(`  roster (server-stated): ${NSP} species ${JSON.stringify(POOL)}`);
console.log(`  derived: cap=${CAP} perSpecies=${PER_SP} spread=${N_HI}x${HI} + ${N_LO}x${LO} = ${N_HI * HI + N_LO * LO}`);
chk(r.status === 200 && CAP === 50 && r.body.claimed === 0
    && r.body.bar && r.body.bar.minutes === 30 && r.body.bar.actions === 10,
    `armed: cap=${CAP} claimed=${r.body.claimed} bar=${JSON.stringify(r.body.bar)} (expect 50/0/{30min,10 actions})`);
chk(NSP >= 5 && POOL.every(s => typeof s === "string" && s.length > 0) && new Set(POOL).size === NSP,
    `default pool = ${NSP} distinct non-empty species: ${JSON.stringify(POOL)}`);
chk(PER_SP === HI, `perSpecies is DERIVED from the live roster: ${PER_SP} = ceil(${CAP}/${NSP}) = ${HI} (it was 10 when the roster was 5 long)`);
chk(PER_SP * NSP >= CAP, `the per-species share covers the cap: ${PER_SP} x ${NSP} = ${PER_SP * NSP} >= ${CAP}`);

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
chk(c0 && c0.n === 1 && c0.sp === POOL[0], `award = claim #${c0 && c0.n}, species ${c0 && c0.sp} (expect #1 ${POOL[0]} — the round-robin starts at the head of the roster)`);
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
chk(cB && cB.n === 2 && cB.sp === POOL[1] && bothPre.ms >= BAR_MS && bothPre.acts + 1 >= BAR_ACTS && founderRows(BOTH.wallet).length === 1,
    `BOTH ARMS -> WINS: ms=${bothPre.ms} (>=${BAR_MS}), acts=${bothPre.acts + 1} (>=${BAR_ACTS}), awarded=#${cB && cB.n} ${cB && cB.sp} (2nd claim = 2nd species of the roster, ${POOL[1]}), rows=${founderRows(BOTH.wallet).length}`);
// and the two barred wallets keep on failing — more of one arm never substitutes for the other
await sleep(950); await actAll([ACTS_ONLY], 3);          // 15 actions now
walk([TIME_ONLY.wallet], 20);                            // 10 more minutes now
chk(claim(ACTS_ONLY.wallet) === null && claim(TIME_ONLY.wallet) === null,
    `piling on one arm never substitutes: ACTS_ONLY(ms=${A(ACTS_ONLY.wallet).ms}, acts=${A(ACTS_ONLY.wallet).acts}) TIME_ONLY(ms=${A(TIME_ONLY.wallet).ms}, acts=${A(TIME_ONLY.wallet).acts}) — both still unawarded`);

// ---------------------------------------------------------------------------
sec(`D the race: ${RACERS} more wallets, BOTH arms, 10th action concurrent`);
const racers = [];
for (let i = 0; i < RACERS; i++) racers.push(await mkWallet());
await Promise.all(racers.map(move));
const raceUncounted = await actAll(racers, BAR_ACTS - 1);
chk(raceUncounted === 0, `all ${racers.length} racers took ${BAR_ACTS - 1} counted catches each (${raceUncounted} uncounted)`);
const raceStamped = walk(racers.map(w => w.wallet));
const rMs = racers.map(w => A(w.wallet).ms), rActs = racers.map(w => A(w.wallet).acts);
console.log(`  racers primed: ms ${Math.min(...rMs)}..${Math.max(...rMs)}, acts ${Math.min(...rActs)}..${Math.max(...rActs)} (${raceStamped} stamps)`);
chk(rMs.every(m => m >= BAR_MS) && rActs.every(a => a === BAR_ACTS - 1) && racers.every(w => !claim(w.wallet)),
    `all ${racers.length} hold the presence arm and sit one action short — awarded so far: ${racers.filter(w => claim(w.wallet)).length} (expect 0)`);
await sleep(950);                                              // clear the 800ms per-wallet catch floor
const tenth = await Promise.all(racers.map((w) => fish(w)));   // the concurrent bar-crossing
chk(tenth.every(t => t.status === 200 && t.body.counted === true),
    `all ${racers.length} tenth catches counted (statuses ${[...new Set(tenth.map(t => t.status))].join(",")}, counted=${[...new Set(tenth.map(t => String(t.body.counted)))].join(",")})`);
const ev = SRV._liveEventsForTest();
console.log(`  founderCount=${ev.founderCount} claims=${ev.claims} perSp=${JSON.stringify(ev.perSp)}`);
chk(ev.founderCount === CAP && ev.claims === CAP, `EXACTLY ${CAP} awarded (count=${ev.founderCount}, claims=${ev.claims})`);
const all = [W0, BOTH, ACTS_ONLY, TIME_ONLY, ...racers];
const awarded = all.filter(w => claim(w.wallet));
const refused = all.filter(w => !claim(w.wallet));
chk(all.length === RACERS + 4 && awarded.length === CAP && refused.length === all.length - CAP,
    `pool=${all.length} candidates -> awarded=${awarded.length}, unawarded=${refused.length} (2 barred + ${refused.length - 2} refused-full)`);
const nums = awarded.map(w => claim(w.wallet).n).sort((a, b) => a - b);
chk(nums.length === CAP && nums.every((n, i) => n === i + 1),
    `claim numbers 1..${CAP}, every one present exactly once (first=${nums[0]}, last=${nums[nums.length - 1]}, unique=${new Set(nums).size})`);

// ---- THE SPREAD, over the WHOLE roster ---------------------------------------------------------
// The roster is 11 long and the cap is 50, so "10 each" is gone for good: the round-robin gives the
// first (cap mod roster) species the ceil and the rest the floor. Every number below is derived.
const spread = POOL.map(sp => [sp, Number(ev.perSp[sp] || 0)]);
const spreadTotal = spread.reduce((a, [, n]) => a + n, 0);
const outside = Object.keys(ev.perSp).filter(sp => !POOL.includes(sp));
console.log(`  PER-SPECIES DISTRIBUTION (cap ${CAP} over ${NSP} species, floor ${LO} / ceil ${HI}):`);
for (const [sp, n] of spread) console.log(`    ${sp.padEnd(10)} ${String(n).padStart(2)}${n === HI ? "  (ceil)" : "  (floor)"}`);
chk(spreadTotal === CAP, `the spread sums to the cap: ${spread.map(([s, n]) => s + "=" + n).join(", ")} -> total=${spreadTotal} (expect ${CAP})`);
chk(spread.every(([, n]) => n >= 1), `NO species missing — every one of the ${NSP} legendaries was born at least once (min=${Math.min(...spread.map(x => x[1]))})`);
chk(spread.every(([, n]) => n === LO || n === HI), `every species got floor(${CAP}/${NSP})=${LO} or ceil=${HI}: ${spread.map(([s, n]) => s + "=" + n).join(", ")}`);
chk(spread.every(([, n]) => n <= PER_SP), `NO species exceeded perSpecies=${PER_SP} (max=${Math.max(...spread.map(x => x[1]))})`);
chk(spread.filter(([, n]) => n === HI).length === N_HI && spread.filter(([, n]) => n === LO).length === N_LO,
    `exactly ${N_HI} species at ${HI} and ${N_LO} at ${LO} (measured ${spread.filter(([, n]) => n === HI).length} / ${spread.filter(([, n]) => n === LO).length}) — ${CAP} mod ${NSP} = ${REM}`);
chk(spread.slice(0, N_HI).every(([, n]) => n === HI) && spread.slice(N_HI).every(([, n]) => n === LO),
    `the extra ones went to the FIRST ${N_HI} of the roster in its own order (${spread.slice(0, N_HI).map(x => x[0]).join(",")} at ${HI}; ${spread.slice(N_HI).map(x => x[0]).join(",") || "none"} at ${LO})`);
chk(outside.length === 0, `nothing was awarded outside the roster: unexpected species = ${JSON.stringify(outside)}`);
const awardedSp = awarded.map(w => claim(w.wallet).sp);
chk(awardedSp.every(sp => POOL.includes(sp)) && new Set(awardedSp).size === NSP,
    `all ${awardedSp.length} claims name a roster species, and all ${NSP} appear (distinct=${new Set(awardedSp).size})`);
const rowCounts = all.map(w => founderRows(w.wallet).length);
const totalRows = rowCounts.reduce((a, b) => a + b, 0);
chk(totalRows === CAP && rowCounts.every(n => n <= 1), `registry founder-origin rows: total=${totalRows}, max per wallet=${Math.max(...rowCounts)} (expect ${CAP}, 1)`);
chk(refused.every(w => founderRows(w.wallet).length === 0), `every one of the ${refused.length} unawarded wallets holds ZERO founder rows`);

// ---------------------------------------------------------------------------
sec("E exactly-once per wallet, ever");
const LUCKY = awarded[5];
await sleep(950); await fish(LUCKY); await sleep(950); await fish(LUCKY);
walk([LUCKY.wallet]);                                    // and another 32 minutes on the clock
chk(SRV._liveEventsForTest().founderCount === CAP && founderRows(LUCKY.wallet).length === 1 && act(LUCKY.wallet) === null,
    `after 2 more catches + a 32-min walk: count=${SRV._liveEventsForTest().founderCount}, LUCKY rows=${founderRows(LUCKY.wallet).length}, activity=${JSON.stringify(act(LUCKY.wallet))} (a claimed wallet accrues nothing)`);

// ---------------------------------------------------------------------------
sec("F the live counter");
r = await get("/world/event");
chk(r.body.founderClaimed === CAP && r.body.founderCap === CAP && r.body.events.founder.full === true,
    `/world/event: founderClaimed=${r.body.founderClaimed}/${r.body.founderCap} full=${r.body.events && r.body.events.founder && r.body.events.founder.full}`);
r = await get("/stats");
chk(r.body.founderClaimed === CAP && r.body.founderCap === CAP && r.body.events && r.body.events.founder,
    `/stats: founderClaimed=${r.body.founderClaimed}/${r.body.founderCap}, events.founder rides the 30s poll`);

// ---------------------------------------------------------------------------
sec("G the award materialises with FOUNDER provenance");
const row0 = founderRows(W0.wallet)[0];
console.log("  W0 registry row:", JSON.stringify({ id: row0.id, sp: row0.sp, kind: row0.kind, origin: row0.origin, edition: row0.edition }));
chk(row0.origin === "open-gates-founder" && row0.kind === "legendary", `origin="${row0.origin}" kind=${row0.kind}`);
const fev = (SRV._nftRowForTest(row0.id).chain || []).find(e => e.what === "founder");
console.log("  founder chain event:", JSON.stringify(fev));
chk(fev && fev.number === 1 && fev.of === CAP && fev.sp_number === 1 && fev.sp_of === PER_SP,
    `chain carries founder #${fev && fev.number} of ${fev && fev.of} (species ${fev && fev.sp_number}/${fev && fev.sp_of}) — the per-species denominator is the DERIVED ${PER_SP}, not the old 10`);
r = await get(`/assets/news?wallet=${W0.wallet}&key=${KEY}`);
const notice = (r.body.notices || [])[0];
console.log("  toast:", JSON.stringify(notice && notice.text));
chk(r.body.count === 1 && notice && notice.kind === "arrived" && /FOUNDER DROP/.test(notice.text),
    `/assets/news: ${r.body.count} arrived notice, FOUNDER text`);
r = await post("/assets/arrivals", { wallet: W0.wallet, mktToken: W0.mktToken, have: [], haveMounts: [] });
chk(r.body.count === 1 && r.body.add[0].sp === POOL[0], `/assets/arrivals delivers ${r.body.count} creature (${r.body.add[0] && r.body.add[0].sp}, expect ${POOL[0]}) into the satchel`);
// the census is checked against the SPREAD the server actually produced, species by species, and its
// total against the cap — a per-legendary constant would have to be rewritten at every roster change.
const censusN = POOL.map(sp => [sp, SRV._trueIssued("chikimon", sp).count]);
const censusTotal = censusN.reduce((a, [, n]) => a + n, 0);
console.log("  census:", censusN.map(([s, n]) => s + "=" + n).join(", "), `-> total=${censusTotal}`);
chk(censusN.every(([sp, n]) => n === Number(ev.perSp[sp] || 0)),
    `census counts every founder birth, per species: ${censusN.map(([s, n]) => s + "=" + n + "/" + (ev.perSp[s] || 0)).join(", ")}`);
chk(censusTotal === CAP && censusN.every(([, n]) => n === LO || n === HI),
    `census total=${censusTotal} (expect ${CAP}) with every legendary at ${LO} or ${HI}`);

// ---------------------------------------------------------------------------
sec("H the chronicle records each award exactly once");
await SRV._chronFlushForTest();
r = await get(`/chronicle/summary?key=${KEY}&metric=ev:founder`);
const totRow = (r.body.totals || []).find(x => String(x.metric || x.m) === "ev:founder");
console.log("  chronicle totals row:", JSON.stringify(totRow));
const totN = Number(totRow && (totRow.n ?? totRow.total ?? totRow.v));
chk(totN === CAP, `world lifetime ev:founder = ${totN} (expect ${CAP} — one per award, idem per wallet)`);
r = await get(`/chronicle/summary?key=${KEY}&metric=ev:mint`);
const mintRow = (r.body.totals || []).find(x => String(x.metric || x.m) === "ev:mint");
chk(Number(mintRow && (mintRow.n ?? mintRow.total ?? mintRow.v)) === CAP, `ev:mint = ${mintRow && (mintRow.n ?? mintRow.total ?? mintRow.v)} (expect ${CAP} — every birth through the chokepoint once)`);

// ---------------------------------------------------------------------------
sec("I a mid-event restart keeps the claim book");
await SRV._saveLiveEventsForTest();
SRV._resetLiveEventsForTest();
chk(SRV._liveEventsForTest().founderCount === 0, `state wiped (dead process): count=${SRV._liveEventsForTest().founderCount}`);
await SRV._bootRestoreLiveEventsForTest();
const ev2 = SRV._liveEventsForTest();
chk(ev2.founderCount === CAP && ev2.claims === CAP && SRV._founderEventActiveForTest(Date.now()) === true,
    `restored: count=${ev2.founderCount} claims=${ev2.claims} eventActive=${SRV._founderEventActiveForTest(Date.now())}`);
// the restored book must match the pre-restart book KEY FOR KEY — not a constant, the real spread
const bookBefore = POOL.map(sp => `${sp}=${Number(ev.perSp[sp] || 0)}`).join(", ");
const bookAfter = POOL.map(sp => `${sp}=${Number(ev2.perSp[sp] || 0)}`).join(", ");
chk(bookAfter === bookBefore && Object.keys(ev2.perSp).length === Object.keys(ev.perSp).length
    && POOL.every(sp => Number(ev2.perSp[sp] || 0) >= 1 && Number(ev2.perSp[sp] || 0) <= PER_SP),
    `per-species book intact across the restart: ${bookAfter} (before: ${bookBefore}); all ${NSP} species present, none over perSpecies=${PER_SP}`);
chk(A(TIME_ONLY.wallet).ms >= BAR_MS && A(ACTS_ONLY.wallet).acts >= BAR_ACTS && !claim(TIME_ONLY.wallet) && !claim(ACTS_ONLY.wallet),
    `the barred wallets' activity survived the restart unrewarded: TIME_ONLY(ms=${A(TIME_ONLY.wallet).ms}, acts=${A(TIME_ONLY.wallet).acts}) ACTS_ONLY(ms=${A(ACTS_ONLY.wallet).ms}, acts=${A(ACTS_ONLY.wallet).acts})`);
await fish(LUCKY); await sleep(950); await fish(LUCKY);
chk(SRV._liveEventsForTest().founderCount === CAP && founderRows(LUCKY.wallet).length === 1,
    `no re-award after restart: count=${SRV._liveEventsForTest().founderCount}, LUCKY rows=${founderRows(LUCKY.wallet).length}`);
const LATE = await mkWallet();
await move(LATE);
const lateUncounted = await actAll([LATE], BAR_ACTS);
walk([LATE.wallet]);
// NOTE the acts=0 in this row: once the cap is closed founderNoteAction returns before it accrues, so
// the counted catches below are real (the server answered counted:true) but buy no accumulator at all.
console.log(`  LATE drove ${BAR_ACTS} counted catches (${lateUncounted} uncounted) + a 32-min walk AFTER the cap closed`);
console.log("  " + triple(LATE.wallet, "LATE"));
chk(claim(LATE.wallet) === null && founderRows(LATE.wallet).length === 0 && lateUncounted === 0 && SRV._liveEventsForTest().founderCount === CAP,
    `a wallet #${all.length + 1} playing a full session after the cap: claim=${JSON.stringify(claim(LATE.wallet))}, rows=${founderRows(LATE.wallet).length}, ms=${A(LATE.wallet).ms}, count=${SRV._liveEventsForTest().founderCount}`);
await SRV._chronFlushForTest();
r = await get(`/chronicle/summary?key=${KEY}&metric=ev:founder`);
const totRow2 = (r.body.totals || []).find(x => String(x.metric || x.m) === "ev:founder");
chk(Number(totRow2 && (totRow2.n ?? totRow2.total ?? totRow2.v)) === CAP, `chronicle still ev:founder=${Number(totRow2 && (totRow2.n ?? totRow2.total ?? totRow2.v))} (expect ${CAP}) after all retries`);

console.log(`\nTHE AND-BAR TABLE (ms, acts, awarded)`);
console.log("  " + triple(ACTS_ONLY.wallet, "10+ actions / under 30 min"));
console.log("  " + triple(TIME_ONLY.wallet, "30+ min / under 10 actions"));
console.log(`  both arms: ms=${bothPre.ms} (${(bothPre.ms / 60000).toFixed(1)} min), acts=${bothPre.acts + 1}, awarded=${cB ? "#" + cB.n + " " + cB.sp : "NO"}`);
console.log(`\nTHE ${CAP} DROPS OVER THE ${NSP}-SPECIES ROSTER`);
for (const [sp, n] of spread) console.log(`  ${sp.padEnd(10)} ${String(n).padStart(2)}`);
console.log(`  ${"TOTAL".padEnd(10)} ${String(spreadTotal).padStart(2)}   (perSpecies=${PER_SP} = ceil(${CAP}/${NSP}))`);
console.log(`\n==== ev_founder_sim: ${pass} passed, ${fail} failed ====`);
console.log(`EV_FOUNDER_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
