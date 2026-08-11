// evv_b_drop.mjs — FOUNDER DROP adversarial verification (independent of ev_founder_sim).
// Real server.js in-process: memory store, dead RPC, throwaway admin key/keypairs. NEVER live.
// Attacks, each with PRINTED ACTUAL VALUES:
//   A  bot burst: a proven wallet machine-guns 10 catch reports with no human gap — the 800ms
//      floor counts ~1, the bar is not crossed
//   B  sybil: one wallet re-verifies under 20 fresh netIds — still ONE award key; 20 net_id-only
//      (demo-style) sessions accrue nothing
//   C  same-wallet double-cross: two concurrent bar-crossing actions -> one award, one row
//   D  THE RACE, WITH A REDEPLOY IN THE MIDDLE: 70 wallets, 40 of them mid-bar when the process
//      dies; restore; all 70 finish concurrently -> EXACTLY 50 awarded, numbers 1..50 unique,
//      10 per species, 0 double rows, partial activity survived the restart
//   E  past the cap: fresh wallets crossing the bar are refused; counter pinned at 50; full=true
//   F  stop + re-arm the drop: the claim book is permanent — no re-award, no 51st
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59989";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39292";
process.env.ADMIN_KEY = "evv-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1"; process.env.CHIK_NFT_HANDOVER = "1"; process.env.CHIK_MINT_AT_SALE = "1";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SRV = await import("./server.js"); await sleep(1400);

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const LEGENDS = ["galador", "adalor", "tyrannos", "grovador", "dragonos"];
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg, authSig });
  return { wallet, authMsg, authSig, mktToken: v.body.mktToken };
}
const move = (w) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, x: 2000, z: -204 });
const fish = (w) => post("/world/fish/report", { wallet: w.wallet, mktToken: w.mktToken, tier: 1, rod: 0 });
const founderRows = (w) => SRV._regOwnedForTest(w, "chikimon").filter(x => x.origin === "open-gates-founder");

let r = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7 });
chk(r.status === 200 && r.body.cap === 50, `armed: cap=${r.body.cap} claimed=${r.body.claimed}`);

// ---------------------------------------------------------------------------
sec("A bot burst — 10 reports, no human gap");
const BOT = await mkWallet(); await move(BOT);
const burst = await Promise.all(Array.from({ length: 10 }, () => fish(BOT)));
const counted = burst.filter(b => b.status === 200 && b.body.counted === true).length;
const botAct = SRV._founderActivityForTest(BOT.wallet);
console.log(`  10 concurrent reports -> counted=${counted}, activity=${JSON.stringify(botAct)}`);
chk(counted <= 1, `800ms floor: only ${counted}/10 machine-gunned reports counted`);
chk(!SRV._founderClaimForTest(BOT.wallet), `bar not crossed by the burst: claim=${JSON.stringify(SRV._founderClaimForTest(BOT.wallet))}`);

// ---------------------------------------------------------------------------
sec("B sybil — 20 netIds, one wallet; and 20 walletless sessions");
const SYB = await mkWallet(); await move(SYB);
for (let i = 0; i < 20; i++)
  await post("/verify", { wallet: SYB.wallet, netId: "syb" + i + "_" + Date.now(), authMsg: SYB.authMsg, authSig: SYB.authSig });
for (let k = 0; k < 3; k++) { await fish(SYB); if (k < 2) await sleep(900); }
chk(SRV._founderClaimForTest(SYB.wallet) && founderRows(SYB.wallet).length === 1,
    `20 netIds, ONE award: claim=${JSON.stringify(SRV._founderClaimForTest(SYB.wallet))}, rows=${founderRows(SYB.wallet).length}`);
const ghosts = Array.from({ length: 20 }, (_, i) => ({ wallet: "godot-ghost-" + i, mktToken: "" }));
await Promise.all(ghosts.map(g => move(g)));
await Promise.all(ghosts.map(g => fish(g)));
SRV._founderTickForTest(Date.now() + 100);
const ghostAcc = ghosts.filter(g => SRV._founderActivityForTest(g.wallet) !== null || SRV._founderClaimForTest(g.wallet)).length;
chk(ghostAcc === 0, `20 walletless sessions accrue NOTHING (accrued=${ghostAcc})`);

// ---------------------------------------------------------------------------
sec("C same-wallet double-cross");
const DBL = await mkWallet(); await move(DBL);
await fish(DBL); await sleep(900); await fish(DBL); await sleep(900);
const both = await Promise.all([fish(DBL), fish(DBL)]);   // two concurrent 3rd actions
console.log(`  concurrent 3rd actions: statuses=${both.map(b => b.status).join(",")} counted=${both.map(b => !!b.body.counted).join(",")}`);
chk(founderRows(DBL.wallet).length === 1, `exactly ONE row minted: rows=${founderRows(DBL.wallet).length}`);

// state so far: BOT has 1 act; SYB + DBL awarded
const claimedSoFar = SRV._liveEventsForTest().founderCount;
console.log(`  claimed so far = ${claimedSoFar}`);

// ---------------------------------------------------------------------------
sec("D the race with a redeploy in the middle — 70 wallets");
const racers = [];
for (let i = 0; i < 70; i++) racers.push(await mkWallet());
await Promise.all(racers.map(w => move(w)));
// 40 of them get 2 actions in before the process dies
const early = racers.slice(0, 40);
await Promise.all(early.map(w => fish(w))); await sleep(900);
await Promise.all(early.map(w => fish(w))); await sleep(900);
const preAct = SRV._founderActivityForTest(early[0].wallet);
console.log(`  early racer activity before the crash: ${JSON.stringify(preAct)}`);
await SRV._saveLiveEventsForTest();
SRV._resetLiveEventsForTest();
await SRV._bootRestoreLiveEventsForTest();
const postAct = SRV._founderActivityForTest(early[0].wallet);
chk(postAct && postAct.acts === preAct.acts, `partial bar SURVIVED the redeploy: acts=${postAct && postAct.acts} (was ${preAct.acts})`);
chk(SRV._liveEventsForTest().founderCount === claimedSoFar, `claim book intact through the crash: count=${SRV._liveEventsForTest().founderCount}`);
// racers' presence rows died with the process (worldPlayers is in-memory) — they move again, then everyone crosses at once
await Promise.all(racers.map(w => move(w)));
await Promise.all(racers.map(w => fish(w))); await sleep(900);            // early: 3rd (cross); late: 1st
await Promise.all(racers.map(w => fish(w))); await sleep(900);            // late: 2nd
const last = await Promise.all(racers.map(w => fish(w)));                 // late: 3rd — the concurrent stampede
chk(last.every(t => t.status === 200), `stampede statuses all 200 (${[...new Set(last.map(t => t.status))].join(",")})`);
const ev = SRV._liveEventsForTest();
console.log(`  founderCount=${ev.founderCount} claims=${ev.claims} perSp=${JSON.stringify(ev.perSp)}`);
chk(ev.founderCount === 50 && ev.claims === 50, `EXACTLY 50 total (count=${ev.founderCount}, claims=${ev.claims})`);
chk(LEGENDS.every(sp => ev.perSp[sp] === 10), `10 per species: ${LEGENDS.map(sp => sp + "=" + ev.perSp[sp]).join(", ")}`);
const everyone = [SYB, DBL, ...racers];
const awarded = everyone.filter(w => SRV._founderClaimForTest(w.wallet));
const nums = awarded.map(w => SRV._founderClaimForTest(w.wallet).n).sort((a, b) => a - b);
chk(awarded.length === 50 && new Set(nums).size === 50 && nums[0] === 1 && nums[49] === 50,
    `50 awarded, numbers 1..50 unique (first=${nums[0]} last=${nums[49]} unique=${new Set(nums).size})`);
const rowTotals = everyone.map(w => founderRows(w.wallet).length);
chk(rowTotals.reduce((a, b) => a + b, 0) === 50 && Math.max(...rowTotals) === 1,
    `registry rows: total=${rowTotals.reduce((a, b) => a + b, 0)}, max per wallet=${Math.max(...rowTotals)} (expect 50/1)`);
const censusTotal = LEGENDS.map(sp => SRV._trueIssued("chikimon", sp).count).reduce((a, b) => a + b, 0);
chk(censusTotal === 50, `census across the 5 legendaries = ${censusTotal} (the event added exactly 50 to world supply)`);

// ---------------------------------------------------------------------------
sec("E past the cap");
const LATE = await mkWallet(); await move(LATE);
for (let k = 0; k < 3; k++) { await fish(LATE); if (k < 2) await sleep(900); }
chk(!SRV._founderClaimForTest(LATE.wallet) && founderRows(LATE.wallet).length === 0,
    `late wallet refused: claim=${JSON.stringify(SRV._founderClaimForTest(LATE.wallet))} rows=${founderRows(LATE.wallet).length}`);
r = await get("/world/event");
chk(r.body.founderClaimed === 50 && r.body.events.founder.full === true,
    `counter pinned: founderClaimed=${r.body.founderClaimed}/${r.body.founderCap} full=${r.body.events.founder.full}`);

// ---------------------------------------------------------------------------
sec("F stop + re-arm — the claim book is permanent");
await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
r = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 3 });
chk(r.status === 200 && r.body.claimed === 50, `re-armed drop reports claimed=${r.body.claimed} (the book survived the stop)`);
await move(SYB);
for (let k = 0; k < 3; k++) { await fish(SYB); if (k < 2) await sleep(900); }
const FRESH = await mkWallet(); await move(FRESH);
for (let k = 0; k < 3; k++) { await fish(FRESH); if (k < 2) await sleep(900); }
const fin = SRV._liveEventsForTest();
chk(fin.founderCount === 50 && founderRows(SYB.wallet).length === 1 && founderRows(FRESH.wallet).length === 0,
    `after re-arm: count=${fin.founderCount}, awarded wallet rows=${founderRows(SYB.wallet).length}, fresh wallet rows=${founderRows(FRESH.wallet).length}`);
await SRV._chronFlushForTest();
r = await get(`/chronicle/summary?key=${KEY}&metric=ev:founder`);
const totRow = (r.body.totals || []).find(x => String(x.metric || x.m) === "ev:founder");
const totN = Number(totRow && (totRow.n ?? totRow.total ?? totRow.v));
chk(totN === 50, `chronicle ev:founder=${totN} (one record per award, forever)`);

console.log(`\n==== evv_b_drop: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
