// mdf_founder_cap_sim.mjs — THE FOUNDER DROP OVER A HARD-CAPPED POOL.
//
// Owner ruling 2026-08-12: "make the new meme dynasty chikimons the subject to the NFT Drop."
// The drop was built for LEGENDARIES, which are uncapped. The eleven new Meme Dynasty characters are
// HARD-CAPPED per species (10..25, 180 total) and 50 founders is 28% of the whole wave, so the risk
// this sim exists to disprove is: a founder grant that mints outside the cap accounting and silently
// inflates a 10-edition creature.
//
// Boots the REAL server.js in-process. Memory store, dead RPC, throwaway admin key and keypairs —
// nothing here can touch the live backend.
//
// PROVES, with printed actual values:
//   A  the pool is DERIVED from MEME_CHARS (the `wave` tag), not a hand-typed twelfth copy; the caps
//      are the owner's exact numbers; the eleven are NOT the legendary roster
//   B  the allocation is checked against LIVE REMAINING SUPPLY, not the nominal cap: burn editions
//      through a normal mint path first and the deal/hold shrink with them
//   C  RESERVATION SEMANTICS — a normal buyer is refused the LAST copies of a species a founder is
//      still owed (and freely served while there is slack), through mintAsset itself
//   D  THE TOCTOU SHAPE that produced the live double-sale earlier this session: a normal mint and a
//      founder grant land on the SAME species at its LAST copy, in the same tick, both orders
//   E  50 founders drain the pool with per-species counts printed before and after — no cap breached
//   F  edition numbers: one series per species, 1..N, no gaps and no duplicates, founder copies
//      interleaved with normal ones by the SAME counter
//   G  a mid-drop restart keeps the pool AND the already-granted set
//   H  the 51st claimant gets nothing
//   I  the sybil bar still needs BOTH 30 minutes AND 10 actions
//   J  a species already at its cap when the drop starts is never dealt and never minted
//   K  an uncapped (legendary) pool reserves NOTHING — the whole block is inert for the old drop
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59971"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39271";
process.env.ADMIN_KEY = "mdf-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1";
process.env.CHIK_NFT_HANDOVER = "1";
process.env.CHIK_MINT_AT_SALE = "1";    // editions at issuance — §F reads them
process.env.CHIK_REG_ALL = "1";         // /admin/grant-collection, the normal mint path used here
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
delete process.env.FOUNDER_SPECIES; delete process.env.FOUNDER_CAP; delete process.env.FOUNDER_PER_SPECIES;
delete process.env.FOUNDER_MIN_MINUTES; delete process.env.FOUNDER_MIN_ACTIONS;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SRV = await import("./server.js"); await sleep(1500);

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n————— ${s} —————`);

// ---- THE OWNER'S EXACT NUMBERS. Written down HERE and nowhere else in the change: the sim is the
// oracle, so a slip in MEME_CHARS fails loudly instead of quietly moving a cap.
const OWNER_CAPS = { ansem: 10, successkid: 10, chloe: 10, grumpycat: 20, peanut: 20, cryingcat: 15,
                     thisisfine: 15, babygoat: 15, triplet: 25, stonks: 20, nervousmonkey: 20 };
const OWNER_TOTAL = Object.values(OWNER_CAPS).reduce((a, b) => a + b, 0);   // 180

const BAR_MS = 30 * 60000, BAR_ACTS = 10, TICK_MS = 30000, WALK_TICKS = 64;
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
const claim = (w) => SRV._founderClaimForTest(w);
const act = (w) => SRV._founderActivityForTest(w);
const A = (w) => act(w) || { ms: 0, acts: 0 };
const founderRows = (w) => SRV._regOwnedForTest(w, "chikimon").filter(x => x.origin === "open-gates-founder");
const issued = (sp) => SRV._trueIssued("chikimon", sp).count;
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
// A NORMAL, NON-FOUNDER MINT through a real route: the owner's full-collection grant, which goes
// through mintAsset with origin "issued" exactly like a bought or hatched creature. One call mints at
// most one of each species to a fresh wallet, so N calls = N editions of every species.
async function normalMint() {
  const w = bs58.encode(nacl.sign.keyPair().publicKey);
  const r = await post("/admin/grant-collection", { key: KEY, wallet: w });
  return { wallet: w, status: r.status, body: r.body,
           gave: new Set((r.body.granted || []).filter(x => x.type === "chikimon").map(x => x.sp)),
           refusedBy: Object.fromEntries((r.body.refused || []).map(x => [x.sp, x.why || "cap"])) };
}
const table = (pool) => pool.map(sp => `${sp}=${issued(sp)}/${OWNER_CAPS[sp]}`).join("  ");

// ===============================================================================================
sec("A the pool is DERIVED from the one table, and the caps are the owner's");
const WAVE2 = SRV._memeWave2ForTest();
const CAPS = SRV._memeCapsForTest();
console.log("  MEME_CHARS wave-2 keys (derived off the `wave` tag):", JSON.stringify(WAVE2));
console.log("  server caps for those keys:", JSON.stringify(Object.fromEntries(WAVE2.map(k => [k, CAPS[k]]))));
chk(WAVE2.length === 11, `the derived wave-2 list holds ${WAVE2.length} species (expect 11)`);
chk(WAVE2.every(k => CAPS[k] === OWNER_CAPS[k]) && Object.keys(OWNER_CAPS).every(k => WAVE2.includes(k)),
    `every cap matches the owner's exact numbers: ${WAVE2.map(k => k + "=" + CAPS[k]).join(", ")}`);
chk(WAVE2.reduce((a, k) => a + CAPS[k], 0) === OWNER_TOTAL,
    `the wave totals ${WAVE2.reduce((a, k) => a + CAPS[k], 0)} editions (expect ${OWNER_TOTAL})`);
// the legendary roster, read through a channel that does NOT go through founderPool()
const catWallet = bs58.encode(nacl.sign.keyPair().publicKey);
const cat = await post("/admin/grant-collection?dryRun=1", { key: KEY, wallet: catWallet, dryRun: "1" });
const catRows = [...(cat.body.granted || []), ...(cat.body.already || []), ...(cat.body.refused || []), ...(cat.body.skipped || [])];
const LEGENDS = catRows.filter(x => x.type === "chikimon" && x.kind === "legendary").map(x => String(x.sp));
chk(LEGENDS.length >= 5 && !WAVE2.some(sp => LEGENDS.includes(sp)),
    `the drop moved OFF the legendaries: ${LEGENDS.length} legendaries, overlap with the eleven = ${JSON.stringify(WAVE2.filter(sp => LEGENDS.includes(sp)))}`);

// the owner starts the drop by TOKEN — the server expands it, the owner never types eleven keys
let r = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 14, species: "meme_dynasty" });
const POOL = (r.body.species || []).slice();
const CAP = Number(r.body.cap);
console.log(`  POST /admin/event/start {species:"meme_dynasty"} -> ${r.status}`);
console.log(`  species  : ${JSON.stringify(POOL)}`);
console.log(`  deal     : ${JSON.stringify(r.body.deal)}  (total ${r.body.dealTotal})`);
console.log(`  reserved : ${JSON.stringify(r.body.reserved)}  (total ${r.body.reservedTotal})`);
console.log(`  bar      : ${JSON.stringify(r.body.bar)}`);
chk(r.status === 200 && JSON.stringify(POOL) === JSON.stringify(WAVE2),
    `the token expanded to the DERIVED eleven, in table order (identical = ${JSON.stringify(POOL) === JSON.stringify(WAVE2)})`);
chk(CAP === 50 && r.body.dealTotal === 50,
    `${CAP} winners, and the deal allocates all ${r.body.dealTotal} of them`);
chk(POOL.every(sp => (r.body.deal[sp] || 0) <= OWNER_CAPS[sp]),
    `NO species is dealt more than its cap: ${POOL.map(sp => sp + " " + (r.body.deal[sp] || 0) + "<=" + OWNER_CAPS[sp]).join(", ")}`);
{ const d = POOL.map(sp => r.body.deal[sp] || 0);
  chk(d.filter(x => x === 5).length === 6 && d.filter(x => x === 4).length === 5,
      `50 over 11 = six species at 5 and five at 4 (measured ${d.filter(x => x === 5).length} x5, ${d.filter(x => x === 4).length} x4)`); }
chk(r.body.bar && r.body.bar.minutes === 30 && r.body.bar.actions === 10,
    `the sybil bar is untouched: ${JSON.stringify(r.body.bar)}`);
chk(r.body.reservedTotal === 50, `all ${r.body.reservedTotal} unclaimed drops are HELD from normal buyers right now`);

// ===============================================================================================
sec("B the reservation is against LIVE REMAINING SUPPLY, not the nominal cap");
// ansem's cap is 10 and its deal is 5, so with 10 left nothing is off-limits — the hold is on the
// LAST copies only. Burn editions through a normal mint path and watch the hold bite.
console.log(`  before any normal mint: ${table(POOL)}`);
chk(SRV._memeReservedOutForTest("ansem") === false,
    `ansem: 10 left, 5 held -> a normal buyer is served (reservedOut=${SRV._memeReservedOutForTest("ansem")})`);
const burners = [];
for (let i = 0; i < 5; i++) burners.push(await normalMint());
console.log(`  after 5 full-collection grants: ${table(POOL)}`);
let res = SRV._founderReserveForTest(), deal = SRV._founderDealForTest();
console.log(`  deal now : ${JSON.stringify(deal)}`);
console.log(`  held now : ${JSON.stringify(res)}`);
chk(issued("ansem") === 5 && issued("triplet") === 5,
    `five normal mints landed: ansem=${issued("ansem")}/10, triplet=${issued("triplet")}/25`);
chk((deal.ansem || 0) === 5 && (res.ansem || 0) === 5 && SRV._memeReservedOutForTest("ansem") === true,
    `ansem now has 5 left and 5 held -> RESERVED OUT to normal buyers (deal=${deal.ansem} held=${res.ansem} reservedOut=${SRV._memeReservedOutForTest("ansem")})`);
chk(SRV._memeReservedOutForTest("triplet") === false,
    `triplet still has slack: 20 left, ${res.triplet || 0} held -> NOT reserved out (${SRV._memeReservedOutForTest("triplet")})`);

// ===============================================================================================
sec("C what a normal buyer actually sees while a species is held");
const blocked = await normalMint();
console.log(`  /admin/grant-collection -> ansem: ${blocked.gave.has("ansem") ? "GRANTED" : "refused (" + blocked.refusedBy.ansem + ")"}`);
console.log(`                             triplet: ${blocked.gave.has("triplet") ? "GRANTED" : "refused (" + blocked.refusedBy.triplet + ")"}`);
chk(!blocked.gave.has("ansem") && blocked.refusedBy.ansem === "founder-drop-hold",
    `the held species is REFUSED and named as a hold, not as sold out: why="${blocked.refusedBy.ansem}"`);
chk(blocked.gave.has("triplet") && issued("ansem") === 5,
    `the rest of the catalog still went through (triplet granted=${blocked.gave.has("triplet")}) and ansem stayed at ${issued("ansem")} — a hold is not a capacity fault`);
{ const sup = SRV._memeSupplyForTest();
  console.log(`  /meme/supply ansem: ${JSON.stringify(sup.chars.ansem)}`);
  chk(sup.chars.ansem.left === 5 && sup.chars.ansem.held === 5 && sup.chars.ansem.buyable === 0,
      `the rarity read is honest: left=${sup.chars.ansem.left} held=${sup.chars.ansem.held} buyable=${sup.chars.ansem.buyable}`);
  chk(sup.chars.triplet.buyable === sup.chars.triplet.left - sup.chars.triplet.held,
      `and for a species with slack: triplet left=${sup.chars.triplet.left} held=${sup.chars.triplet.held} buyable=${sup.chars.triplet.buyable}`); }

// ===============================================================================================
sec("D THE TOCTOU: a normal mint and a founder grant on the SAME species at its LAST copy");
// Drive ansem to ONE edition left through the normal path. The hold has to come off to do it — which
// is itself the point: stop the drop, the held copies go back on sale immediately.
await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
chk(SRV._memeReservedOutForTest("ansem") === false && SRV._founderReserveTotalForTest() === 0,
    `stopping the drop releases every held edition at once (ansem reservedOut=${SRV._memeReservedOutForTest("ansem")}, total held=${SRV._founderReserveTotalForTest()})`);
for (let i = 0; i < 4; i++) await normalMint();
console.log(`  after 4 more normal grants with no drop running: ${table(POOL)}`);
chk(issued("ansem") === 9, `ansem now has ONE edition left: issued=${issued("ansem")}/${OWNER_CAPS.ansem}`);

// restart the drop: the deal must now read ansem's REAL remaining supply (1), not its cap (10)
r = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 14, species: "meme_dynasty" });
console.log(`  restarted deal  : ${JSON.stringify(r.body.deal)} (total ${r.body.dealTotal})`);
console.log(`  restarted held  : ${JSON.stringify(r.body.reserved)} (total ${r.body.reservedTotal})`);
console.log(`  live supply     : ${JSON.stringify(Object.fromEntries(POOL.map(sp => [sp, r.body.supply[sp].left])))}`);
chk((r.body.deal.ansem || 0) === 1,
    `RESERVED AGAINST ACTUAL REMAINING SUPPLY: ansem is dealt ${r.body.deal.ansem} founder, not the flat ${Math.ceil(50 / 11)} its cap of 10 would allow`);
chk(POOL.every(sp => (r.body.deal[sp] || 0) <= Math.max(0, OWNER_CAPS[sp] - issued(sp))),
    `and no species is dealt more than it can still supply: ${POOL.map(sp => `${sp} ${r.body.deal[sp] || 0}<=${Math.max(0, OWNER_CAPS[sp] - issued(sp))}`).join(", ")}`);
chk((r.body.reserved.ansem || 0) === 1 && SRV._memeReservedOutForTest("ansem") === true,
    `ansem's LAST copy is held: reserved=${r.body.reserved.ansem}, reservedOut=${SRV._memeReservedOutForTest("ansem")}`);

// ORDER 1 — the shape that produced the live double-sale: the normal mint's request is in flight when
// the founder grant runs synchronously in the same tick.
const raceWallet = await mkWallet();
const p1 = post("/admin/grant-collection", { key: KEY, wallet: bs58.encode(nacl.sign.keyPair().publicKey) });
const grantDuringRace = SRV._founderAwardForTest(raceWallet.wallet);
const r1 = await p1;
const r1ansem = (r1.body.granted || []).some(x => x.sp === "ansem");
const r1ref = (r1.body.refused || []).find(x => x.sp === "ansem");
console.log(`  concurrent: founder grant -> ${grantDuringRace ? "#" + grantDuringRace.n + " " + grantDuringRace.sp : "refused"}`);
console.log(`              normal mint  -> ansem ${r1ansem ? "GRANTED" : "refused (" + (r1ref && (r1ref.why || "cap")) + ")"}`);
console.log(`              ansem census after both = ${issued("ansem")} (cap ${OWNER_CAPS.ansem})`);
chk(issued("ansem") <= OWNER_CAPS.ansem,
    `THE CAP HELD under the race: ansem census=${issued("ansem")} <= ${OWNER_CAPS.ansem}`);
chk(grantDuringRace && grantDuringRace.sp === "ansem" && !r1ansem,
    `the reserved copy went to the FOUNDER and the buyer was refused (founder got ${grantDuringRace && grantDuringRace.sp}, buyer got ansem=${r1ansem})`);
chk(issued("ansem") === OWNER_CAPS.ansem,
    `ansem is now genuinely complete: issued=${issued("ansem")}/${OWNER_CAPS.ansem}`);

// ORDER 2 — the reverse, on a species that is now EXHAUSTED: the reroute must skip it silently.
const p2 = post("/admin/grant-collection", { key: KEY, wallet: bs58.encode(nacl.sign.keyPair().publicKey) });
const w2 = await mkWallet();
const g2 = SRV._founderAwardForTest(w2.wallet);
const r2 = await p2;
console.log(`  reverse order: founder -> ${g2 ? "#" + g2.n + " " + g2.sp : "refused"}, normal ansem granted=${(r2.body.granted || []).some(x => x.sp === "ansem")}, ansem census=${issued("ansem")}`);
chk(issued("ansem") === OWNER_CAPS.ansem && g2 && g2.sp !== "ansem",
    `still ${OWNER_CAPS.ansem}: the exhausted species is REROUTED past, never minted (founder #${g2 && g2.n} got ${g2 && g2.sp})`);
chk(!(r2.body.granted || []).some(x => x.sp === "ansem"),
    `and the concurrent buyer got nothing either (refused: ${JSON.stringify((r2.body.refused || []).find(x => x.sp === "ansem") || null)})`);

// ===============================================================================================
sec("E 50 founders drain the pool — per-species counts before and after");
const before = Object.fromEntries(POOL.map(sp => [sp, issued(sp)]));
const grantedBefore = SRV._liveEventsForTest().founderCount;
console.log(`  BEFORE (${grantedBefore} founders already granted in D):`);
for (const sp of POOL) console.log(`    ${sp.padEnd(14)} issued ${String(before[sp]).padStart(2)} / cap ${String(OWNER_CAPS[sp]).padStart(2)}`);
// take the rest of the 50 through the award path
let stopped = 0;
while (SRV._liveEventsForTest().founderCount < CAP) {
  const w = await mkWallet();
  const g = SRV._founderAwardForTest(w.wallet);
  if (!g) { stopped++; break; }
}
const ev = SRV._liveEventsForTest();
const after = Object.fromEntries(POOL.map(sp => [sp, issued(sp)]));
console.log(`  AFTER (${ev.founderCount} founders granted):`);
let sumGrants = 0;
for (const sp of POOL) {
  const g = Number(ev.perSp[sp] || 0); sumGrants += g;
  console.log(`    ${sp.padEnd(14)} issued ${String(after[sp]).padStart(2)} / cap ${String(OWNER_CAPS[sp]).padStart(2)}   founder grants ${String(g).padStart(2)}   normal ${String(after[sp] - g).padStart(2)}`);
}
chk(ev.founderCount === CAP && stopped === 0, `all ${ev.founderCount} drops issued (expect ${CAP}, pool-exhausted stops=${stopped})`);
chk(sumGrants === CAP, `the per-species book sums to the cap: ${sumGrants} = ${CAP}`);
chk(POOL.every(sp => after[sp] <= OWNER_CAPS[sp]),
    `NO CAP BREACHED: ${POOL.map(sp => `${sp} ${after[sp]}<=${OWNER_CAPS[sp]}`).join(", ")}`);
{ // EVERY founder grant is counted by the census exactly ONCE. The award writes a registry row AND a
  // satchel unit for the same creature; if the census failed to dedup them, a 10-edition species
  // would read 20 and the cap would slam shut at five real creatures.
  const delta = POOL.map(sp => [sp, after[sp] - before[sp]]);
  console.log(`  census delta per species: ${delta.map(([s, d]) => s + "+" + d).join(", ")}`);
  chk(delta.reduce((a, [, d]) => a + d, 0) === CAP - grantedBefore,
      `the census moved by exactly the number of grants: +${delta.reduce((a, [, d]) => a + d, 0)} for ${CAP - grantedBefore} awards (no double-count of the satchel copy)`); }
chk(SRV._founderReserveTotalForTest() === 0,
    `with the drop full, NOTHING is held any more: total=${SRV._founderReserveTotalForTest()} ${JSON.stringify(SRV._founderReserveForTest())}`);
{ const back = await normalMint();
  chk(back.gave.has("triplet"), `and a normal buyer is served again the moment the hold lifts (triplet granted=${back.gave.has("triplet")})`); }

// ===============================================================================================
sec("F edition numbers: one series per species, no gaps, no duplicates");
{
  let bad = [];
  for (const sp of POOL) {
    const rows = SRV._regAllForTest().filter(x => x.type === "chikimon" && x.sp === sp && x.state === "active");
    const eds = rows.map(x => Number(x.edition || 0)).sort((a, b) => a - b);
    const want = rows.map((_, i) => i + 1);
    const ok = eds.length === want.length && eds.every((e, i) => e === want[i]);
    const founderEds = rows.filter(x => x.origin === "open-gates-founder").map(x => Number(x.edition || 0)).sort((a, b) => a - b);
    console.log(`    ${sp.padEnd(14)} editions ${JSON.stringify(eds)}   founder copies at ${JSON.stringify(founderEds)}`);
    if (!ok) bad.push(sp);
  }
  chk(bad.length === 0, `every species is numbered 1..N with no gaps and no duplicates (bad: ${JSON.stringify(bad)})`);
  const mixed = POOL.filter(sp => {
    const rows = SRV._regAllForTest().filter(x => x.type === "chikimon" && x.sp === sp && x.state === "active");
    return rows.some(x => x.origin === "open-gates-founder") && rows.some(x => x.origin !== "open-gates-founder");
  });
  chk(mixed.length > 0, `founder and normal copies share ONE counter (species with both: ${JSON.stringify(mixed)})`);
  const kinds = new Set(SRV._regAllForTest().filter(x => x.origin === "open-gates-founder").map(x => x.kind));
  chk(kinds.size === 1 && kinds.has("meme"), `every founder Dynasty row is kind="meme" like every other copy (kinds seen: ${JSON.stringify([...kinds])})`);
}

// ===============================================================================================
sec("G a mid-drop restart keeps the pool AND the granted set");
{
  const evBefore = SRV._liveEventsForTest();
  const bookBefore = POOL.map(sp => `${sp}=${Number(evBefore.perSp[sp] || 0)}`).join(",");
  await SRV._saveLiveEventsForTest();
  SRV._resetLiveEventsForTest();
  chk(SRV._liveEventsForTest().founderCount === 0, `state wiped (dead process): count=${SRV._liveEventsForTest().founderCount}`);
  await SRV._bootRestoreLiveEventsForTest();
  const evAfter = SRV._liveEventsForTest();
  const bookAfter = POOL.map(sp => `${sp}=${Number(evAfter.perSp[sp] || 0)}`).join(",");
  const poolAfter = (await get("/world/event")).body.founderSpecies || [];
  console.log(`  pool after restart : ${JSON.stringify(poolAfter)}`);
  console.log(`  book before        : ${bookBefore}`);
  console.log(`  book after         : ${bookAfter}`);
  chk(JSON.stringify(poolAfter) === JSON.stringify(WAVE2), `the ELEVEN survived the restart (identical=${JSON.stringify(poolAfter) === JSON.stringify(WAVE2)})`);
  chk(bookAfter === bookBefore && evAfter.founderCount === CAP && evAfter.claims === CAP,
      `the granted set survived: count=${evAfter.founderCount} claims=${evAfter.claims}`);
  const again = SRV._founderAwardForTest(Object.keys({})[0] || (await mkWallet()).wallet);
  chk(again === null, `and no 51st slipped through the restart (award=${JSON.stringify(again)})`);
}

// ===============================================================================================
sec("H the 51st claimant gets nothing");
{
  const late = await mkWallet();
  const g = SRV._founderAwardForTest(late.wallet);
  const totalNow = POOL.reduce((a, sp) => a + issued(sp), 0);
  console.log(`  51st award attempt -> ${JSON.stringify(g)}; dynasty census total = ${totalNow}`);
  chk(g === null && claim(late.wallet) === null && founderRows(late.wallet).length === 0
      && SRV._liveEventsForTest().founderCount === CAP,
      `refused: claim=${JSON.stringify(claim(late.wallet))}, rows=${founderRows(late.wallet).length}, count=${SRV._liveEventsForTest().founderCount}/${CAP}`);
}

// ===============================================================================================
sec("J a species already AT ITS CAP when a drop starts is never dealt and never minted");
{
  // a genuinely FRESH drop (the book cleared) over a pool whose first three species are complete
  await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
  SRV._resetLiveEventsForTest();
  const full = POOL.filter(sp => issued(sp) >= OWNER_CAPS[sp]);
  const s2 = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species: "dynasty" });
  console.log(`  complete species: ${JSON.stringify(full)}`);
  console.log(`  fresh deal      : ${JSON.stringify(s2.body.deal)} (total ${s2.body.dealTotal})`);
  console.log(`  fresh held      : ${JSON.stringify(s2.body.reserved)} (total ${s2.body.reservedTotal})`);
  const d = s2.body.deal || {}, held = s2.body.reserved || {};
  chk(full.length > 0, `at least one species is complete going in (${JSON.stringify(full.map(sp => sp + " " + issued(sp) + "/" + OWNER_CAPS[sp]))})`);
  chk(full.every(sp => (d[sp] || 0) === 0), `a complete species is dealt ZERO founders: ${full.map(sp => sp + "=" + (d[sp] || 0)).join(", ")}`);
  chk(full.every(sp => !(sp in held)), `and nothing is held for it (held keys: ${JSON.stringify(Object.keys(held))})`);
  chk(POOL.every(sp => (d[sp] || 0) <= Math.max(0, OWNER_CAPS[sp] - issued(sp))),
      `every dealt share fits the live remaining supply: ${POOL.map(sp => `${sp} ${d[sp] || 0}<=${Math.max(0, OWNER_CAPS[sp] - issued(sp))}`).join(", ")}`);
  // and the award itself never lands on one
  const probe = SRV._founderAwardForTest((await mkWallet()).wallet);
  console.log(`  next award -> ${probe ? probe.sp : "refused"}`);
  chk(probe && !full.includes(probe.sp), `the award skips every complete species (got ${probe && probe.sp})`);
  await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
}

// ===============================================================================================
sec("I the sybil bar still needs BOTH 30 minutes AND 10 actions");
{
  // a fresh drop on a species with room, and three wallets: time-only, actions-only, both
  SRV._resetLiveEventsForTest();
  const s = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species: "meme_dynasty" });
  console.log(`  fresh drop: ${JSON.stringify(s.body.species)} deal=${JSON.stringify(s.body.deal)}`);
  const TIME_ONLY = await mkWallet(), ACTS_ONLY = await mkWallet(), BOTH = await mkWallet();
  await Promise.all([move(TIME_ONLY), move(ACTS_ONLY), move(BOTH)]);
  // arm 1 only: 30+ minutes, 9 actions
  await actAll([TIME_ONLY], BAR_ACTS - 1);
  walk([TIME_ONLY.wallet]);
  // arm 2 only: 10 actions, no presence walk
  await actAll([ACTS_ONLY], BAR_ACTS);
  // both: 9 actions + a walk, then the 10th
  await actAll([BOTH], BAR_ACTS - 1);
  walk([BOTH.wallet]);
  const bothPre = { ...A(BOTH.wallet) };
  await sleep(950); await move(BOTH); await fish(BOTH);
  const t = (w, l) => `${l}: ms=${A(w).ms} (${(A(w).ms / 60000).toFixed(1)} min), acts=${A(w).acts}, awarded=${claim(w) ? "#" + claim(w).n + " " + claim(w).sp : "NO"}`;
  console.log("  " + t(TIME_ONLY.wallet, "30+ min / 9 actions "));
  console.log("  " + t(ACTS_ONLY.wallet, "10 actions / <30 min"));
  console.log("  " + t(BOTH.wallet, "both arms          "));
  chk(A(TIME_ONLY.wallet).ms >= BAR_MS && A(TIME_ONLY.wallet).acts < BAR_ACTS && claim(TIME_ONLY.wallet) === null,
      `TIME-ONLY wins nothing: ms=${A(TIME_ONLY.wallet).ms}>=${BAR_MS}, acts=${A(TIME_ONLY.wallet).acts}<${BAR_ACTS}, claim=${JSON.stringify(claim(TIME_ONLY.wallet))}`);
  chk(A(ACTS_ONLY.wallet).acts >= BAR_ACTS && A(ACTS_ONLY.wallet).ms < BAR_MS && claim(ACTS_ONLY.wallet) === null,
      `ACTIONS-ONLY wins nothing: acts=${A(ACTS_ONLY.wallet).acts}>=${BAR_ACTS}, ms=${A(ACTS_ONLY.wallet).ms}<${BAR_MS}, claim=${JSON.stringify(claim(ACTS_ONLY.wallet))}`);
  const cb = claim(BOTH.wallet);
  chk(cb && bothPre.ms >= BAR_MS && bothPre.acts + 1 >= BAR_ACTS && WAVE2.includes(cb.sp),
      `BOTH ARMS wins a DYNASTY creature: ms=${bothPre.ms}, acts=${bothPre.acts + 1}, awarded=#${cb && cb.n} ${cb && cb.sp} (in the eleven=${cb ? WAVE2.includes(cb.sp) : false})`);
  const row = founderRows(BOTH.wallet)[0];
  console.log(`  the winner's row: ${JSON.stringify({ sp: row && row.sp, kind: row && row.kind, origin: row && row.origin, edition: row && row.edition })}`);
  chk(row && row.kind === "meme" && row.origin === "open-gates-founder" && Number(row.edition) >= 1
      && Number(row.edition) <= OWNER_CAPS[row.sp],
      `and it is a real capped edition: ${row && row.sp} #${row && row.edition} of ${OWNER_CAPS[row && row.sp]}, kind=${row && row.kind}`);
  await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
}

// ===============================================================================================
sec("K an UNCAPPED (legendary) pool reserves nothing — the old drop is untouched");
{
  SRV._resetLiveEventsForTest();
  const s = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species: "legendary" });
  const held = SRV._founderReserveForTest(), d = SRV._founderDealForTest();
  console.log(`  legendary pool (${(s.body.species || []).length}): deal total=${Object.values(d).reduce((a, b) => a + b, 0)}, held=${JSON.stringify(held)}`);
  chk(JSON.stringify(s.body.species) === JSON.stringify(LEGENDS), `the "legendary" token expands to the live roster: ${JSON.stringify(s.body.species)}`);
  chk(Object.keys(held).length === 0, `NOTHING is held for an uncapped pool (held=${JSON.stringify(held)})`);
  const spread = LEGENDS.map(sp => d[sp] || 0);
  const HI = Math.ceil(50 / LEGENDS.length), LO = Math.floor(50 / LEGENDS.length);
  chk(spread.every(n => n === HI || n === LO) && spread.reduce((a, b) => a + b, 0) === 50,
      `and the old floor/ceil spread is reproduced exactly: ${LEGENDS.map((sp, i) => sp + "=" + spread[i]).join(", ")} (total ${spread.reduce((a, b) => a + b, 0)})`);
  const t = await normalMint();
  chk(Object.values(t.refusedBy).every(w => w !== "founder-drop-hold"),
      `no normal mint is refused as a hold while the legendary drop runs (refusals: ${JSON.stringify(t.refusedBy)})`);
  await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
}

// ===============================================================================================
sec("L nothing is enabled by default — with NO event running the whole block is inert");
{
  await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
  SRV._resetLiveEventsForTest();
  const held = SRV._founderReserveForTest();
  console.log(`  no drop running: held=${JSON.stringify(held)} total=${SRV._founderReserveTotalForTest()}`);
  chk(Object.keys(held).length === 0 && SRV._founderReserveTotalForTest() === 0,
      `no event -> no hold anywhere (${JSON.stringify(held)})`);
  chk(WAVE2.every(sp => SRV._memeReservedOutForTest(sp) === false),
      `and no species reads as reserved: ${WAVE2.map(sp => sp + "=" + SRV._memeReservedOutForTest(sp)).join(", ")}`);
  const t = await normalMint();
  chk(Object.values(t.refusedBy).every(w => w !== "founder-drop-hold"),
      `a normal mint sees only real caps, never a hold: ${JSON.stringify(t.refusedBy)}`);
  chk(SRV._founderAwardForTest((await mkWallet()).wallet) === null,
      `and no award can be made with no drop running`);
  // the SHIPPED default pool is still the game's legendaries — starting a drop with no `species`
  // must NOT quietly become a Dynasty drop
  const d = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 1 });
  console.log(`  unnamed drop pool: ${JSON.stringify(d.body.species)}`);
  chk(JSON.stringify(d.body.species) === JSON.stringify(LEGENDS) && !WAVE2.some(sp => (d.body.species || []).includes(sp)),
      `an UNNAMED drop is still the legendary roster, not the Dynasty (overlap=${JSON.stringify((d.body.species || []).filter(sp => WAVE2.includes(sp)))})`);
  await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
}

console.log(`\n================  mdf_founder_cap_sim: ${pass} passed, ${fail} failed  ================`);
console.log(`MDF_FOUNDER_CAP_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
