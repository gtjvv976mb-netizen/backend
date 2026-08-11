// evv_a_founder.mjs — ADVERSARIAL: the 200-wallet FOUNDER DROP burst + replay. No source edits.
// Boots the REAL server.js in-process (throwaway keypair, dead RPC, throwaway ADMIN_KEY, memory store).
//
// THE BAR CHANGED (owner ruling 2026-08-11): 15 min OR 3 actions became 30 MINUTES OF PROVEN PRESENCE
// **AND** 10 WITNESSED ACTIONS. This sim is the reason: signing in is free — it mints 200 valid
// wallets in seconds — so under the OR bar those 200 needed only 3 quick catches each to take every
// drop. Now each of them must also hold half an hour of proven presence, walked here through the REAL
// sweep (which clamps itself to 30s per tick, so the forged clock buys no shortcut). Prints ACTUALS.
//   E  a demo/net_id session bursting BOTH arms -> zero accrual (control: proven pubkeys DO accrue)
//   B  THE NEW RULE, the point of the change — (ms, acts, awarded) for three wallets:
//        10+ actions, under 30 min -> NOTHING · 30+ min, under 10 actions -> NOTHING · both -> WINS
//   A  200 throwaway wallets burst the drop: 9 verified actions + 30 stamped minutes each, the 10th
//      action fired CONCURRENTLY -> the cap holds at exactly 50 across the whole pool, with the LIST
//   C  replay an award (re-fire verified actions and re-walk presence after winning) -> no second
//      creature, chronicle idem
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59983";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39383";
process.env.ADMIN_KEY = "evv-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1"; process.env.CHIK_NFT_HANDOVER = "1"; process.env.CHIK_MINT_AT_SALE = "1";
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
// n COUNTED actions for a whole group. FISH_REC_MIN_MS is 800ms per wallet, and a presence row is
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

let r = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7 });
console.log("start reply:", JSON.stringify(r.body));
// NO species named here, so the pool falls back to the game's own SPECIES_LEGEND — which grew
// 5 -> 11 on 2026-08-11, making perSpecies ceil(50/11) = 5 rather than ceil(50/5) = 10. Derived from
// the pool the server reports rather than hardcoded, so the roster can grow again without lying here.
const POOL = r.body.species || [];
const PER = Math.max(1, Math.ceil(50 / (POOL.length || 1)));
chk(r.body.cap === 50 && r.body.perSpecies === PER && r.body.bar && r.body.bar.minutes === 30 && r.body.bar.actions === 10,
    `armed cap=${r.body.cap} perSp=${r.body.perSpecies} pool=${POOL.length} species (expect ceil(50/${POOL.length})=${PER}) bar=${JSON.stringify(r.body.bar)}`);

// ---------------------------------------------------------------------------
sec("E control — a demo/net_id session cannot accrue no matter how it bursts");
const DEMO = { wallet: "ndemo_" + Date.now(), mktToken: "" };
await move(DEMO);
const dUncounted = await actAll([DEMO], BAR_ACTS);
const dStamped = walk([DEMO.wallet]);
console.log(`  demo drove ${BAR_ACTS} counted catches (${dUncounted} uncounted) and ${dStamped} stamped presence ticks — both arms' worth`);
chk(dStamped === WALK_TICKS, `the demo presence row WAS stamped every tick (${dStamped}/${WALK_TICKS}) — the walk is not a no-op`);
chk(act(DEMO.wallet) === null && claim(DEMO.wallet) === null,
    `demo: activity=${JSON.stringify(act(DEMO.wallet))} claim=${JSON.stringify(claim(DEMO.wallet))} (both null)`);

// ---------------------------------------------------------------------------
sec("B THE NEW RULE — both arms or nothing (each of these won under the OLD 'OR' bar)");
const ACTS_ONLY = await mkWallet();   // 12 actions, 28 minutes — one arm only
const TIME_ONLY = await mkWallet();   // 32 minutes, 9 actions — the other arm only
const BOTH = await mkWallet();        // 32 minutes AND 10 actions
await Promise.all([move(ACTS_ONLY), move(TIME_ONLY), move(BOTH)]);
const trioUncounted = await actAll([ACTS_ONLY, TIME_ONLY, BOTH], BAR_ACTS - 1);
await sleep(950);
await actAll([ACTS_ONLY], 3);                          // 12 > the 10-action arm
const shortStamped = walk([ACTS_ONLY.wallet], 56);     // 28 min — deliberately just short of the arm
const trioStamped = walk([TIME_ONLY.wallet, BOTH.wallet]);
chk(trioUncounted === 0 && shortStamped === 56 && trioStamped === WALK_TICKS * 2,
    `trio primed: ${trioUncounted} uncounted actions, ${shortStamped} + ${trioStamped} stamped ticks`);
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
chk(cB && cB.n === 1 && cB.sp === "galador" && bothPre.ms >= BAR_MS && bothPre.acts + 1 >= BAR_ACTS && founderRows(BOTH.wallet).length === 1,
    `BOTH ARMS -> WINS: ms=${bothPre.ms} (>=${BAR_MS}), acts=${bothPre.acts + 1} (>=${BAR_ACTS}), awarded=#${cB && cB.n} ${cB && cB.sp}, rows=${founderRows(BOTH.wallet).length}`);
// piling on one arm never substitutes for the other
await sleep(950); await actAll([ACTS_ONLY], 3);        // 15 actions
walk([TIME_ONLY.wallet], 20);                          // 10 more minutes
chk(claim(ACTS_ONLY.wallet) === null && claim(TIME_ONLY.wallet) === null && A(ACTS_ONLY.wallet).ms < BAR_MS,
    `piling on one arm never substitutes: ACTS_ONLY(ms=${A(ACTS_ONLY.wallet).ms}, acts=${A(ACTS_ONLY.wallet).acts}) TIME_ONLY(ms=${A(TIME_ONLY.wallet).ms}, acts=${A(TIME_ONLY.wallet).acts}) — both still unawarded`);

// ---------------------------------------------------------------------------
sec("A the 200-wallet burst — both arms each, cap holds at 50 exactly");
const N = 200;
const mob = [];
for (let i = 0; i < N; i++) mob.push(await mkWallet());
await Promise.all(mob.map(move));
const mobUncounted = await actAll(mob, BAR_ACTS - 1);
chk(mobUncounted === 0, `all ${N} wallets took ${BAR_ACTS - 1} counted catches each (${mobUncounted} uncounted)`);
const mobStamped = walk(mob.map(w => w.wallet));
const mMs = mob.map(w => A(w.wallet).ms), mActs = mob.map(w => A(w.wallet).acts);
console.log(`  mob primed: ms ${Math.min(...mMs)}..${Math.max(...mMs)}, acts ${Math.min(...mActs)}..${Math.max(...mActs)} (${mobStamped} stamps)`);
chk(mobStamped === N * WALK_TICKS && mMs.every(m => m >= BAR_MS) && mActs.every(a => a === BAR_ACTS - 1),
    `all ${N} hold the presence arm (min ms=${Math.min(...mMs)}) and sit one action short (acts=${Math.max(...mActs)})`);
chk(mob.filter(w => claim(w.wallet)).length === 0 && SRV._liveEventsForTest().founderCount === 1,
    `THE PRESENCE ARM ALONE AWARDS NOTHING AT SCALE: ${N} wallets x 32 proven minutes + 9 actions -> ${mob.filter(w => claim(w.wallet)).length} awards (count still ${SRV._liveEventsForTest().founderCount})`);
await sleep(950);                                       // clear the 800ms per-wallet catch floor
const tenth = await Promise.all(mob.map(fish));         // the concurrent bar-crossing
chk(tenth.every(t => t.status === 200 && t.body.counted === true),
    `all ${N} tenth catches counted (statuses ${[...new Set(tenth.map(t => t.status))].join(",")}, counted=${[...new Set(tenth.map(t => String(t.body.counted)))].join(",")})`);
const ev = SRV._liveEventsForTest();
console.log(`  founderCount=${ev.founderCount} claims=${ev.claims} perSp=${JSON.stringify(ev.perSp)}`);
chk(ev.founderCount === 50 && ev.claims === 50, `EXACTLY 50 issued (count=${ev.founderCount}, claims=${ev.claims})`);
const pool = [BOTH, ACTS_ONLY, TIME_ONLY, ...mob];
const awarded = pool.filter(w => claim(w.wallet));
const refused = pool.filter(w => !claim(w.wallet));
const mobAwarded = mob.filter(w => claim(w.wallet));
chk(pool.length === N + 3 && awarded.length === 50 && mobAwarded.length === 49 && refused.length === pool.length - 50,
    `pool=${pool.length} candidates -> awarded=${awarded.length} (${mobAwarded.length} of the ${N} mob + BOTH), unawarded=${refused.length}`);
const nums = awarded.map(w => claim(w.wallet).n).sort((a, b) => a - b);
chk(nums.length === 50 && new Set(nums).size === 50 && nums[0] === 1 && nums[49] === 50,
    `claim numbers 1..50 unique (first=${nums[0]}, last=${nums[49]}, unique=${new Set(nums).size})`);
// EVEN ACROSS THE WHOLE POOL. The round-robin gives every species floor(cap/pool) or ceil(cap/pool)
// — 10 each when the pool was five, 5/5/5/5/5/5/4/4/4/4/4 now that it is eleven. The invariant is
// that the awards sum to the cap and no species is favoured by more than one.
{
  const spread = POOL.map(sp => ev.perSp[sp] || 0);
  const lo = Math.floor(50 / POOL.length), hi = Math.ceil(50 / POOL.length);
  chk(spread.reduce((a, b) => a + b, 0) === 50 && spread.every(n => n >= lo && n <= hi),
      `species spread over the ${POOL.length}-species pool (each ${lo}..${hi}, sum ${spread.reduce((a, b) => a + b, 0)}): ${POOL.map(sp => sp + "=" + (ev.perSp[sp] || 0)).join(", ")}`);
}
const rowCounts = pool.map(w => founderRows(w.wallet).length);
chk(rowCounts.reduce((a, b) => a + b, 0) === 50 && Math.max(...rowCounts) === 1, `registry founder rows total=${rowCounts.reduce((a, b) => a + b, 0)}, max/wallet=${Math.max(...rowCounts)}`);
chk(refused.every(w => founderRows(w.wallet).length === 0), `every one of the ${refused.length} unawarded wallets holds ZERO founder rows`);
console.log("  THE AWARD LIST (#n species wallet8):");
for (const w of awarded.sort((a, b) => claim(a.wallet).n - claim(b.wallet).n))
  console.log(`    #${String(claim(w.wallet).n).padStart(2)}  ${claim(w.wallet).sp.padEnd(9)}  ${w.wallet.slice(0, 8)}`);

// ---------------------------------------------------------------------------
sec("C replay — an awarded wallet keeps firing verified actions and accruing presence, no second creature");
const LUCKY = mobAwarded[7];
const before2 = SRV._liveEventsForTest().founderCount;
await sleep(950); await fish(LUCKY); await sleep(950); await fish(LUCKY); await sleep(950); await fish(LUCKY);
const luckyStamped = walk([LUCKY.wallet]);
chk(SRV._liveEventsForTest().founderCount === before2 && founderRows(LUCKY.wallet).length === 1 && act(LUCKY.wallet) === null,
    `after 3 replayed actions + a 32-min walk (${luckyStamped} stamps): count=${SRV._liveEventsForTest().founderCount} (was ${before2}), LUCKY rows=${founderRows(LUCKY.wallet).length}, activity=${JSON.stringify(act(LUCKY.wallet))}`);
await SRV._chronFlushForTest();
r = await get(`/chronicle/summary?key=${KEY}&metric=ev:founder`);
const totRow = (r.body.totals || []).find(x => String(x.metric || x.m) === "ev:founder");
chk(Number(totRow && (totRow.n ?? totRow.total ?? totRow.v)) === 50, `chronicle ev:founder=${totRow && (totRow.n ?? totRow.total ?? totRow.v)} (one per award, no replay dup)`);

console.log(`\nTHE AND-BAR TABLE (ms, acts, awarded)`);
console.log("  " + triple(ACTS_ONLY.wallet, "10+ actions / under 30 min"));
console.log("  " + triple(TIME_ONLY.wallet, "30+ min / under 10 actions"));
console.log(`  both arms: ms=${bothPre.ms} (${(bothPre.ms / 60000).toFixed(1)} min), acts=${bothPre.acts + 1}, awarded=${cB ? "#" + cB.n + " " + cB.sp : "NO"}`);
console.log(`\n==== evv_a_founder: ${pass} passed, ${fail} failed ====`);
console.log(`EVV_A_FOUNDER_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
