// evv_b_player.mjs — PLAYER-TRUTH verification (independent of the builder's ev_* sims).
// One persona, one week, through the REAL server.js booted in-process: memory store, dead RPC,
// throwaway admin key + keypairs, balances seeded through the _balCache sim seam. NEVER live.
//
// The week:
//   W0  before any event: the zero-hold newcomer is refused (baseline refusal copy printed)
//   W1  the owner's three curls land: open_gates 7d, fishing_festival 5d x4, founder_drop 7d
//       -> /world/event carries all three; each window is EXACT (active at ends-1ms, dead at +1ms)
//   W2  the gateless newcomer signs in: eligible via gateWaived, full session, chikis stays 0
//   W3  they PLAY: proven presence + a real profile save; six other newcomers cross the action
//       bar first, then OUR player crosses the 15-minute presence bar -> founder legendary #7
//       (adalor by round-robin), proven FOUR ways with printed values:
//         toast (/assets/news, owner token)  ·  satchel (/assets/arrivals delivers the creature)
//         chronicle (ev:founder total)       ·  census +1 for the species, row origin
//   W4  they FISH at festival odds: the chokepoint chance is exactly x4 the pre-event baseline,
//       the 0.25 cap still binds, a real /world/fish/report counts, the move reply carries the
//       frozen fishing `event` key AND the additive `events` key
//   W5  a mid-event redeploy (save -> reset -> boot-restore): events alive, claim book intact,
//       no re-award
//   W6  the event ends: next sign-in refuses honestly (gateNote printed VERBATIM), progress and
//       the founder creature are KEPT, chikis/balance truth intact, re-holding 500k re-enters
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59987";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "true"; process.env.NETWORK = "devnet"; process.env.PORT = "39291";
process.env.CHIKI_MINT = bs58.encode(nacl.sign.keyPair().publicKey);
process.env.ADMIN_KEY = "evv-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1";
process.env.CHIK_NFT_HANDOVER = "1";
process.env.CHIK_MINT_AT_SALE = "1";
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
let _n = 0;
function mkKeys() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  return { wallet, authMsg, authSig, kp, mktToken: "" };
}
const verify = (k, signed = true) => post("/verify", Object.assign({ wallet: k.wallet, netId: "n" + Date.now() + "_" + (++_n) },
  signed ? { authMsg: k.authMsg, authSig: k.authSig } : {}));
const move = (w) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, x: 2000, z: -204 });
const fish = (w) => post("/world/fish/report", { wallet: w.wallet, mktToken: w.mktToken, tier: 1, rod: 0 });
const founderRows = (w) => SRV._regOwnedForTest(w, "chikimon").filter(x => x.origin === "open-gates-founder");
const LEGENDS = ["galador", "adalor", "tyrannos", "grovador", "dragonos"];

// ---------------------------------------------------------------------------
sec("W0 before any event — the newcomer is refused, and the odds baseline is measured");
const PLAYER = mkKeys();
SRV._setBalanceForTest(PLAYER.wallet, 0);
let r = await verify(PLAYER);
chk(r.body.eligible === false && r.body.holdOk === false && r.body.gateWaived === undefined,
    `pre-event zero-hold refusal: eligible=${r.body.eligible} holdOk=${r.body.holdOk} gateWaived=${r.body.gateWaived}`);
console.log("  pre-event refusal copy:", JSON.stringify(r.body.gateNote));
chk(typeof r.body.gateNote === "string" && r.body.gateNote.includes("500,000"), `refusal names the 500,000 hold`);
const base = {};
for (const sp of ["golden_chikifish", "crystal_koi", "mystic_eel", "rainbow_fish"]) base[sp] = SRV._ffishChanceForTest(sp, 1, 8);
console.log("  baseline odds (tier1 rod8):", JSON.stringify(base));
chk(Object.values(base).every(v => v > 0), `baseline chances all > 0`);

// ---------------------------------------------------------------------------
sec("W1 the owner's three curls — exact windows");
const t0 = Date.now();
const g = await post("/admin/event/start", { key: KEY, event: "open_gates", days: 7 });
const f = await post("/admin/event/start", { key: KEY, event: "fishing_festival", days: 5, mult: 4 });
const d = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7 });
console.log("  start replies:", JSON.stringify(g.body), JSON.stringify(f.body), JSON.stringify(d.body));
const gEnds = Number(g.body.ends), fEnds = Number(f.body.ends), dEnds = Number(d.body.ends);
chk(Math.abs(gEnds - (t0 + 7 * 86400000)) < 3000, `open_gates ends-now=${gEnds - t0}ms (expect 7d=604800000, drift ${gEnds - t0 - 7 * 86400000}ms)`);
chk(Math.abs(fEnds - (t0 + 5 * 86400000)) < 3000, `festival ends-now=${fEnds - t0}ms (expect 5d=432000000, drift ${fEnds - t0 - 5 * 86400000}ms)`);
chk(SRV._openGatesActiveForTest(gEnds - 1) === true && SRV._openGatesActiveForTest(gEnds + 1) === false,
    `open_gates window exact: active(ends-1)=${SRV._openGatesActiveForTest(gEnds - 1)} active(ends+1)=${SRV._openGatesActiveForTest(gEnds + 1)}`);
chk(SRV._fishEventActiveForTest(fEnds - 1) === true && SRV._fishEventActiveForTest(fEnds + 1) === false,
    `festival window exact: active(ends-1)=${SRV._fishEventActiveForTest(fEnds - 1)} active(ends+1)=${SRV._fishEventActiveForTest(fEnds + 1)}`);
chk(SRV._founderEventActiveForTest(dEnds - 1) === true && SRV._founderEventActiveForTest(dEnds + 1) === false,
    `founder window exact: active(ends-1)=${SRV._founderEventActiveForTest(dEnds - 1)} active(ends+1)=${SRV._founderEventActiveForTest(dEnds + 1)}`);
r = await get("/world/event");
chk(r.body.events && r.body.events.openGates && r.body.events.fishing && r.body.events.founder,
    `/world/event carries all three: ${Object.keys(r.body.events || {}).join(",")}`);
chk(r.body.events.fishing.mult === 4 && r.body.events.founder.cap === 50 && r.body.events.founder.claimed === 0,
    `wire: fishing.mult=${r.body.events.fishing.mult} founder ${r.body.events.founder.claimed}/${r.body.events.founder.cap}`);

// ---------------------------------------------------------------------------
sec("W2 the gateless newcomer signs in");
r = await verify(PLAYER);
PLAYER.mktToken = r.body.mktToken;
chk(r.body.eligible === true && r.body.gateWaived === true && r.body.holdOk === false && r.body.balance === 0,
    `waived entry: eligible=${r.body.eligible} gateWaived=${r.body.gateWaived} holdOk=${r.body.holdOk} balance=${r.body.balance}`);
chk(r.body.signedIn === true && r.body.mktToken.length >= 16 && r.body.sessionId.length > 0,
    `full session: signedIn=${r.body.signedIn} mktToken.len=${r.body.mktToken.length} sessionId.len=${r.body.sessionId.length}`);
chk(r.body.chikis === 0, `the old accrual game stays hold-gated: chikis=${r.body.chikis}`);
chk(r.body.events && r.body.events.openGates && r.body.events.founder,
    `/verify carries the event banners (openGates remainingMs=${r.body.events.openGates.remainingMs})`);

// ---------------------------------------------------------------------------
sec("W3 they play — six neighbours cross the action bar, then OUR player crosses the presence bar");
r = await post("/profile", { wallet: PLAYER.wallet, profile: { name: "GatelessNed", progress: 12 } });
chk(r.status === 200, `mid-event profile save -> ${r.status}`);
const seeds = [];
for (let i = 0; i < 6; i++) { const s = mkKeys(); SRV._setBalanceForTest(s.wallet, 0); seeds.push(s); }
for (const s of seeds) { const v = await verify(s); s.mktToken = v.body.mktToken; }
await Promise.all(seeds.map(s => move(s)));
for (let k = 0; k < 3; k++) { await Promise.all(seeds.map(s => fish(s))); if (k < 2) await sleep(900); }
let ev = SRV._liveEventsForTest();
chk(ev.founderCount === 6, `six neighbours awarded first: founderCount=${ev.founderCount}`);
const censusBefore = SRV._trueIssued("chikimon", "adalor").count;
console.log(`  census(adalor) BEFORE the player's award = ${censusBefore}`);
let mv = await move(PLAYER);
chk(mv.status === 200, `player presence begins: move -> ${mv.status}`);
const T0 = Date.now();
let ticks = 0;
for (let k = 1; k <= 35; k++) {
  SRV._stampPresenceForTest(PLAYER.wallet, T0 + k * 30000 - 500);
  SRV._founderTickForTest(T0 + k * 30000);
  ticks = k;
  if (SRV._founderClaimForTest(PLAYER.wallet)) break;
}
const claim = SRV._founderClaimForTest(PLAYER.wallet);
console.log(`  claim after ${ticks * 30}s stamped presence:`, JSON.stringify(claim));
chk(claim && claim.n === 7 && claim.sp === "adalor", `founder legendary #${claim && claim.n} ${claim && claim.sp} (expect #7 adalor by round-robin)`);
chk(ticks * 30000 >= 15 * 60000, `presence bar honoured: ${ticks * 30000}ms >= 900000ms`);
// PROOF 1/4 — the toast, read with the PLAYER'S OWN token (not the admin key)
r = await get(`/assets/news?wallet=${PLAYER.wallet}&mktToken=${encodeURIComponent(PLAYER.mktToken)}`);
const notice = (r.body.notices || []).find(n => n.kind === "arrived");
console.log("  PROOF toast:", JSON.stringify(notice && notice.text));
chk(notice && /FOUNDER DROP/.test(notice.text) && /#7 of 50/.test(notice.text),
    `toast is the founder text with #7 of 50`);
// PROOF 2/4 — the satchel: /assets/arrivals materialises the creature
r = await post("/assets/arrivals", { wallet: PLAYER.wallet, mktToken: PLAYER.mktToken, have: [], haveMounts: [] });
console.log("  PROOF satchel:", JSON.stringify(r.body.add));
chk(r.body.count === 1 && r.body.add[0].sp === "adalor" && r.body.add[0].kind === "legendary",
    `satchel receives 1 creature: sp=${r.body.add[0] && r.body.add[0].sp} kind=${r.body.add[0] && r.body.add[0].kind}`);
// PROOF 3/4 — the chronicle
await SRV._chronFlushForTest();
r = await get(`/chronicle/summary?key=${KEY}&metric=ev:founder`);
const totRow = (r.body.totals || []).find(x => String(x.metric || x.m) === "ev:founder");
const totN = Number(totRow && (totRow.n ?? totRow.total ?? totRow.v));
console.log("  PROOF chronicle: ev:founder total =", totN);
chk(totN === 7, `chronicle ev:founder=${totN} (expect 7 — six neighbours + our player, once each)`);
// PROOF 4/4 — census +1 with the founder origin on the registry row
const censusAfter = SRV._trueIssued("chikimon", "adalor").count;
const row = founderRows(PLAYER.wallet)[0];
console.log(`  PROOF census: adalor ${censusBefore} -> ${censusAfter}; row=${JSON.stringify(row && { id: row.id, sp: row.sp, kind: row.kind, origin: row.origin })}`);
chk(censusAfter === censusBefore + 1, `census(adalor) ${censusBefore} -> ${censusAfter} (+1 exactly)`);
chk(row && row.origin === "open-gates-founder" && row.kind === "legendary",
    `registry row origin="${row && row.origin}" kind=${row && row.kind}`);
const fchain = (SRV._nftRowForTest(row.id).chain || []).find(e => e.what === "founder");
chk(fchain && fchain.number === 7 && fchain.of === 50, `founder chain event #${fchain && fchain.number} of ${fchain && fchain.of}`);

// ---------------------------------------------------------------------------
sec("W4 they fish at festival odds");
const active = {};
for (const sp of Object.keys(base)) active[sp] = SRV._ffishChanceForTest(sp, 1, 8);
for (const sp of Object.keys(base)) {
  const ratio = active[sp] / base[sp];
  chk(Math.abs(ratio - 4) < 1e-9 || active[sp] === 0.25,
      `${sp}: ${base[sp]} -> ${active[sp]} (x${ratio.toFixed(2)}${active[sp] === 0.25 ? ", capped" : ""})`);
}
const capProbe = SRV._ffishChanceForTest("golden_chikifish", 3, 10);
chk(capProbe <= 0.25, `EVENT_CAST_CAP binds: best-geared golden chance=${capProbe} <= 0.25`);
r = await fish(PLAYER);
chk(r.status === 200 && r.body.counted === true, `real catch report counted: ${r.status} counted=${r.body.counted}`);
await sleep(1100);   // the move-reply events cache is 1s
mv = await move(PLAYER);
chk(mv.body.event && mv.body.event.mult === 4, `frozen fishing 'event' key on move: mult=${mv.body.event && mv.body.event.mult}`);
chk(mv.body.events && mv.body.events.fishing && mv.body.events.openGates && mv.body.events.founder
    && mv.body.events.founder.claimed === 7,
    `additive 'events' key on move: founder ${mv.body.events && mv.body.events.founder && mv.body.events.founder.claimed}/50`);

// ---------------------------------------------------------------------------
sec("W5 a mid-event redeploy");
await SRV._saveLiveEventsForTest();
SRV._resetLiveEventsForTest();
chk(SRV._liveEventsForTest().founderCount === 0 && SRV._liveEventsForTest().openGates.ends === 0,
    `process died: in-memory state wiped (count=${SRV._liveEventsForTest().founderCount}, gates.ends=${SRV._liveEventsForTest().openGates.ends})`);
await SRV._bootRestoreLiveEventsForTest();
ev = SRV._liveEventsForTest();
chk(ev.openGates.ends === gEnds && ev.founder.ends === dEnds,
    `boot restore: gates.ends=${ev.openGates.ends}===${gEnds}, founder.ends=${ev.founder.ends}===${dEnds}`);
chk(ev.founderCount === 7 && SRV._founderClaimForTest(PLAYER.wallet).n === 7,
    `claim book intact: count=${ev.founderCount}, player still holds claim #${SRV._founderClaimForTest(PLAYER.wallet).n}`);
await fish(PLAYER); await sleep(900); await fish(PLAYER); await sleep(900); await fish(PLAYER);
chk(SRV._liveEventsForTest().founderCount === 7 && founderRows(PLAYER.wallet).length === 1,
    `no re-award after the redeploy: count=${SRV._liveEventsForTest().founderCount}, player rows=${founderRows(PLAYER.wallet).length}`);

// ---------------------------------------------------------------------------
sec("W6 the event ends — the honest keep-your-progress refusal");
for (const evk of ["open_gates", "fishing_festival", "founder_drop"]) {
  const s = await post("/admin/event/stop", { key: KEY, event: evk });
  chk(s.status === 200 && s.body.active === false, `stop ${evk}: active=${s.body.active}`);
}
r = await verify(PLAYER);   // still 0 $CHIKI — next sign-in after the event
chk(r.body.eligible === false && r.body.gateWaived === undefined && r.body.holdOk === false && r.body.balance === 0,
    `post-event: eligible=${r.body.eligible} gateWaived=${r.body.gateWaived} balance=${r.body.balance}`);
console.log("  POST-EVENT REFUSAL COPY (verbatim):");
console.log("   ", JSON.stringify(r.body.gateNote));
chk(typeof r.body.gateNote === "string" && /Open Gates/.test(r.body.gateNote)
    && /kept/i.test(r.body.gateNote) && r.body.gateNote.includes("500,000"),
    `gateNote: names Open Gates, states progress kept, states the 500,000 re-entry`);
chk(r.body.profile && r.body.profile.name === "GatelessNed" && r.body.profile.progress === 12,
    `progress KEPT: ${JSON.stringify(r.body.profile && { name: r.body.profile.name, progress: r.body.profile.progress })}`);
chk(founderRows(PLAYER.wallet).length === 1, `the founder creature is KEPT: registry rows=${founderRows(PLAYER.wallet).length}`);
r = await get("/world/event");
chk(!r.body.events && r.body.founderClaimed === 7,
    `after stop: events=${JSON.stringify(r.body.events)} (absent), founderClaimed=${r.body.founderClaimed} (history stays visible)`);
SRV._setBalanceForTest(PLAYER.wallet, 500000);
r = await verify(PLAYER);
chk(r.body.eligible === true && r.body.holdOk === true, `re-holding 500k re-enters: eligible=${r.body.eligible} holdOk=${r.body.holdOk}`);

console.log(`\n==== evv_b_player: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
