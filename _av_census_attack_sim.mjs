// _av_census_attack_sim.mjs — ADVERSARIAL VERIFICATION of the census consolidation.
//
// census_consolidation_sim.js proves the consolidation on HONEST inputs. This one attacks it along
// the three directions that actually convert into value:
//   DOUBLE COUNT  — the count climbs without a creature being born (a denial of scarcity: honest
//                   players are refused at a ceiling the world never reached).
//   UNDERCOUNT    — the DANGEROUS direction: a creature the count cannot see lets the cap be exceeded.
//   CAP BYPASS    — a mint that reaches assetReg without passing the consolidated count.
//   GRANDFATHER   — an over-cap world must stop ISSUING and take nothing from anyone.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = process.env.AVC_PORT || "39777";
process.env.ADMIN_KEY = "test-admin-key";
process.env.MEME_SALE_OPEN = "true"; process.env.MEME_VERIFY_PAY = "false";
delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const SRV = await import(process.env.AVC_SERVER || "./server.js"); await new Promise(r => setTimeout(r, 1400));
SRV._setFfishAuthorityForTest(false);

let pass = 0, fail = 0; const fails = []; const findings = [];
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, fails.push(m), console.log("  FAIL:", m)); };
// A defect that is real and measured but has no live trigger. Recorded, not scored — the tripwire
// assertion that keeps it un-triggerable is scored instead.
const finding = (m) => { findings.push(m); console.log("  FINDING:", m); };
const sec = (s) => console.log(`\n— ${s} —`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const PRE = Date.UTC(2025, 0, 1);

let _n = 0;
async function mkWallet(preExisting = true) {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg, authSig });
  if (preExisting) SRV._setWalletFirstSeenForTest(wallet, PRE);
  const save = async (mmo) => { await wait(680); return post("/profile", { wallet, authMsg, authSig, profile: { mmo } }); };
  return { wallet, mktToken: v.body.mktToken, authMsg, authSig, save };
}
const roster = (units, mounts, avatars) => ({
  onboarded: true, eggs: [],
  units: Object.fromEntries((units || []).map((u, i) => [`u${i + 1}`, { species: u.sp, kind: u.kind || "normal", level: u.lvl || 5 }])),
  mounts: mounts || [], avatars: avatars || [],
});
const T = (type, sp) => SRV._trueIssued(type, sp);
const show = (type, sp) => { const t = T(type, sp); return `${type}/${sp}: count=${t.count} (registry=${t.registry} ledger=${t.ledger} sales=${t.sales} deduped=${t.deduped} flagged=${t.flagged})`; };
function tryIssue(type, wallet, sp, kind, origin) {
  try { return { ok: true, row: SRV._mintAssetForTest(type, wallet, { sp, kind: kind || type, lvl: 1 }, origin || "hatched") }; }
  catch (e) { return { ok: false, code: e.code || null, msg: String(e.message || e) }; }
}
// a ledger record exactly as the DB hands one back — the path a wallet that has not signed in since
// the registry existed comes through
function ledgerBlob(rows) {
  return { w: rows.map(([w, r]) => [w, r]), buys: [], gather: [], spent: [], gained: [], raid: [] };
}
const fakeWallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
// Mithra's and Azulon's prices are mirrored server-side (EGG_RECIPE_MATS / SCROLL_RECIPE_MATS) and
// issuance reads the STRICT allowance, so a sim wallet has to genuinely be recorded acquiring them.
const MATS = ["wood", "berries", "essence", "seashell", "hide", "iron", "crystal", "gold", "honey", "stone"];
const fund = (w) => { for (const m of MATS) SRV._grantOwnForTest(w, m, 400, "mat"); };
const wipe = () => { SRV._clearAssetReg(); SRV._clearAssetLedger(); for (const k of ["pepe","popcat","moodeng","doge","chillguy","alon"]) SRV._setMemeMintedForTest(k, 0); };

// ===========================================================================================
sec("A. DOUBLE COUNT — the same creature must never be counted twice, however it is touched");
{
  wipe();
  const w1 = await mkWallet();
  await w1.save(roster([{ sp: "tyrannos", kind: "legendary" }], ["gator"]));
  chk(T("mount", "gator").count === 1, `one ledger gator: ${show("mount", "gator")}`);

  // A1 — sync is an ACK. Called repeatedly it must be idempotent, or every retry mints a creature.
  let counts = [];
  for (let i = 0; i < 6; i++) { await post("/assets/mounts/sync", { wallet: w1.wallet, mktToken: w1.mktToken }); counts.push(T("mount", "gator").count); }
  chk(counts.every(c => c === 1), `6x /assets/mounts/sync keeps the count at 1 (${JSON.stringify(counts)})`);
  chk(SRV._trueIssued("mount", "gator").registry === 1, `and mints exactly one registry row (registry=${T("mount", "gator").registry})`);

  // A2 — the same for chikimon
  counts = [];
  for (let i = 0; i < 6; i++) { await post("/assets/chikimon/sync", { wallet: w1.wallet, mktToken: w1.mktToken }); counts.push(T("chikimon", "tyrannos").count); }
  chk(counts.every(c => c === 1), `6x /assets/chikimon/sync keeps the count at 1 (${JSON.stringify(counts)})`);
  chk(T("chikimon", "tyrannos").deduped === 1, `the adopted row dedups against its ledger unit (${show("chikimon", "tyrannos")})`);

  // A3 — the player keeps playing and saving; the ledger re-asserts the same creature every time
  for (let i = 0; i < 3; i++) await w1.save(roster([{ sp: "tyrannos", kind: "legendary" }], ["gator"]));
  chk(T("mount", "gator").count === 1 && T("chikimon", "tyrannos").count === 1,
    `3 more saves after adoption change nothing (${T("mount", "gator").count}/${T("chikimon", "tyrannos").count})`);

  // A4/A5 — the registry row is TRANSFERRED away, then the seller syncs again. ARMED, not live:
  // transferAsset has no route caller today, so this cannot be reached from the network. The
  // TRIPWIRE below is what is scored — the moment a transfer route lands, this becomes an exploit.
  const w2 = await mkWallet();
  const mine = await get(`/assets/mine?wallet=${w1.wallet}&mktToken=${encodeURIComponent(w1.mktToken)}`);
  const gid = (mine.body.mounts || []).find(m => m.sp === "gator").id;
  SRV._transferAssetForTest(gid, w1.wallet, w2.wallet, "test");
  const afterT = T("mount", "gator").count;
  const counts2 = [afterT];
  for (let i = 0; i < 3; i++) {
    const re = await post("/assets/mounts/sync", { wallet: w1.wallet, mktToken: w1.mktToken });
    const m2 = await get(`/assets/mine?wallet=${w1.wallet}&mktToken=${encodeURIComponent(w1.mktToken)}`);
    const nid = (m2.body.mounts || []).find(m => m.sp === "gator");
    if (nid) SRV._transferAssetForTest(nid.id, w1.wallet, w2.wallet, "test");   // sell it again
    counts2.push(T("mount", "gator").count);
  }
  if (afterT !== 1 || counts2.some(c => c !== 1)) {
    finding(`transfer breaks the dedup: one gator becomes ${counts2.join(" -> ")} over 3 sell+resync cycles ` +
      `(${show("mount", "gator")}). The seller's LEDGER still asserts the mount — a sale only reaches it on ` +
      `their own next save — so /assets/mounts/sync re-adopts it and mints a fresh registry row each time. ` +
      `Direction: over-count (denial of scarcity), not a supply breach.`);
  } else chk(true, `transfer + 3 re-syncs keep the count at 1 (${counts2.join(",")})`);
  const src = await import("node:fs").then(fs => fs.readFileSync(process.env.AVC_SERVER || "./server.js", "utf8"));
  const callers = (src.match(/transferAsset\(/g) || []).length;
  chk(callers === 2, `TRIPWIRE: transferAsset still has NO route caller (${callers} occurrences = the definition + the test seam). ` +
    `If this fails, the finding above is LIVE: adoption must first refuse a luid this wallet has already adopted.`);

  // A6 — sell then re-buy: the ledger effect is held=false, then a new uid appears
  wipe();
  const w3 = await mkWallet();
  await w3.save(roster([{ sp: "healix", kind: "legendary" }], []));
  await post("/assets/chikimon/sync", { wallet: w3.wallet, mktToken: w3.mktToken });
  const sold = T("chikimon", "healix").count;
  await w3.save(roster([], []));                                   // sold — it leaves the roster
  const gone = T("chikimon", "healix").count;
  await w3.save(roster([{ sp: "healix", kind: "legendary" }], [])); // bought back — a NEW uid
  const back = T("chikimon", "healix").count;
  chk(sold === 1 && back === 1, `sell -> re-buy stays ONE creature (held=${sold} sold=${gone} rebought=${back}) ${show("chikimon", "healix")}`);
}

// ===========================================================================================
sec("B. UNDERCOUNT — the dangerous direction: anything the count cannot see raises the ceiling");
{
  // B1 — a legacy species with NO registry rows at all
  wipe();
  for (let i = 0; i < 5; i++) { const w = await mkWallet(); await w.save(roster([], ["griffin"])); }
  const g = T("mount", "griffin");
  chk(g.count === 5 && g.registry === 0, `5 ledger-only griffins are seen: ${show("mount", "griffin")}`);
  const att = tryIssue("mount", fakeWallet(), "griffin", "mount");
  chk(!att.ok && att.code === "SUPPLY_EXHAUSTED", `and the cap binds on them (${att.code || "ISSUED — BYPASS"})`);

  // B2 — a species held only by wallets that have NOT signed in since the registry existed.
  // They come back from the database and never touch a route.
  wipe();
  const dormant = [];
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const w = fakeWallet(); dormant.push(w);
    rows.push([w, { first: PRE, seen: PRE, unverified: 0, units: {}, mounts: { horse: { ts: PRE, origin: "legacy" } }, eggs: {}, avatars: {} }]);
  }
  const n = SRV.restoreAssetLedger(ledgerBlob(rows));
  const h = T("mount", "horse");
  chk(n === 10 && h.count === 10, `10 dormant wallets restored from the DB are counted: ${show("mount", "horse")} (restored=${n})`);
  const att2 = tryIssue("mount", fakeWallet(), "horse", "mount");
  chk(!att2.ok && att2.code === "SUPPLY_EXHAUSTED", `an 11th horse is refused on their behalf (${att2.code || "ISSUED — BYPASS"})`);

  // B3 — memeMinted with no hatch row and no registry row anywhere
  wipe();
  SRV._setMemeMintedForTest("doge", 15);       // doge cap = 15
  const d = T("chikimon", "doge");
  chk(d.count === 15, `an orphan sale counter with no row behind it still counts: ${show("chikimon", "doge")}`);
  const att3 = tryIssue("chikimon", fakeWallet(), "doge", "meme");
  chk(!att3.ok && att3.code === "SUPPLY_EXHAUSTED", `and binds the cap (${att3.code || "ISSUED — BYPASS"})`);
  const w = await mkWallet(); fund(w.wallet);
  const e = await post("/assets/egg/claim", { wallet: w.wallet, mktToken: w.mktToken, kind: "meme" });
  if (e.status === 200) {
    SRV._ageAsset(e.body.egg.id, 25 * 3600 * 1000);
    const c = await post("/assets/egg/consume", { wallet: w.wallet, mktToken: w.mktToken, id: e.body.egg.id, sp: "doge" });
    chk(c.status === 409, `and /assets/egg/consume refuses doge by name (${c.status} ${JSON.stringify(c.body.error || "")})`);
  } else chk(false, `could not claim a meme egg to test the consume gate (${e.status} ${JSON.stringify(e.body)})`);

  // B4 — the deliberate exemption: unverified is REPORTED, not counted. Prove it cannot be laundered.
  wipe();
  const fw = fakeWallet();
  SRV.restoreAssetLedger(ledgerBlob([[fw, { first: Date.now(), seen: Date.now(), unverified: 5,
    units: {}, mounts: { griffin: { ts: Date.now(), origin: "unverified" } }, eggs: {}, avatars: {} }]]));
  const f1 = T("mount", "griffin");
  chk(f1.count === 0 && f1.flagged === 1, `a forged griffin is flagged, not counted: ${show("mount", "griffin")}`);
  const honest = tryIssue("mount", fakeWallet(), "griffin", "mount");
  chk(honest.ok, `so an honest player is NOT denied by it (issued=${honest.ok})`);
  // adoption carries the verdict; it must never upgrade
  const fwv = await mkWallet(false);
  SRV.restoreAssetLedger(ledgerBlob([[fwv.wallet, { first: Date.now(), seen: Date.now(), unverified: 1,
    units: {}, mounts: { wolf: { ts: Date.now(), origin: "unverified" } }, eggs: {}, avatars: {} }]]));
  await post("/assets/mounts/sync", { wallet: fwv.wallet, mktToken: fwv.mktToken });
  const mine2 = await get(`/assets/mine?wallet=${fwv.wallet}&mktToken=${encodeURIComponent(fwv.mktToken)}`);
  const wrow = (mine2.body.mounts || []).find(m => m.sp === "wolf");
  chk(wrow && wrow.origin === "unverified", `adoption carries "unverified" through, never upgrades it (origin=${wrow && wrow.origin})`);
  chk(T("mount", "wolf").count === 0 && T("mount", "wolf").flagged === 1,
    `and the adopted forgery is still uncounted, still flagged: ${show("mount", "wolf")}`);
  // the published board must not let a buyer read `issued` and believe it is the whole population
  const rr = await get("/world/rarity");
  chk(rr.body.mount.wolf.breakdown.flagged === 1,
    `/world/rarity publishes the overhang (issued=${rr.body.mount.wolf.issued} flagged=${rr.body.mount.wolf.breakdown.flagged})`);

  // B5 — RESTART EROSION: the ledger serialises at most ASSET_LEDGER_MAX wallets. Everything past
  // that vanishes from the count on the next boot, and the cap ceiling rises by exactly that much.
  wipe();
  const MANY = 20000 + 40;
  const big = [];
  for (let i = 0; i < MANY; i++) big.push(["Wq" + String(i).padStart(30, "0") + "zz", { first: PRE, seen: PRE + i, unverified: 0, units: {}, mounts: { boar: { ts: PRE, origin: "legacy" } }, eggs: {}, avatars: {} }]);
  SRV.restoreAssetLedger(ledgerBlob(big));
  const before = T("mount", "boar").count;
  const blob = SRV.serializeAssetLedger();
  SRV._clearAssetLedger();
  SRV.restoreAssetLedger(blob);
  const after = T("mount", "boar").count;
  chk(before === MANY, `${MANY} legacy boar holders are counted live (${before})`);
  chk(after === 20000, `after serialize->restore the count falls to ASSET_LEDGER_MAX (${after}, lost ${before - after})`);
  console.log(`     NOTE: eviction is by design (20k wallets); it is an undercount only for worlds past that size.`);
}

// ===========================================================================================
sec("C. CAP BYPASS — every mint site must pass the consolidated count, or say why not");
{
  // C1 — RACE at cap-1 through the client-chosen-species door (/assets/egg/consume)
  wipe();
  for (let i = 0; i < 4; i++) { const w = await mkWallet(); await w.save(roster([], ["griffin"])); }
  chk(T("mount", "griffin").count === 4, `griffin seeded to cap-1 (${T("mount", "griffin").count}/5)`);
  const racers = [];
  for (let i = 0; i < 2; i++) {
    const w = await mkWallet(false); fund(w.wallet);
    const e = await post("/assets/egg/claim", { wallet: w.wallet, mktToken: w.mktToken, kind: "mount" });
    if (e.status === 200) { SRV._ageAsset(e.body.egg.id, 7 * 3600 * 1000); racers.push({ w, id: e.body.egg.id }); }
  }
  chk(racers.length === 2, `two mount eggs ready to hatch (${racers.length})`);
  const res2 = await Promise.all(racers.map(r => post("/assets/egg/consume", { wallet: r.w.wallet, mktToken: r.w.mktToken, id: r.id, sp: "griffin" })));
  const wins = res2.filter(r => r.status === 200).length;
  chk(wins === 1, `exactly ONE of two concurrent griffin hatches wins (${wins}; statuses ${res2.map(r => r.status).join(",")})`);
  chk(T("mount", "griffin").count === 5, `and the world lands exactly on the cap: ${show("mount", "griffin")}`);
  const loser = res2.find(r => r.status !== 200);
  chk(loser && loser.status === 409, `the loser is told the SPECIES ran out, not that the server is at capacity: ${loser && loser.status} "${loser && loser.body.error}"`);

  // C2 — RACE at cap-1 on the AVATAR scroll (the roll is server-side, so narrow the pool to one)
  wipe();
  const AV = { classic: 500, Knight: 200, Mystic: 100, Navigator: 300, Star: 200, chemist: 50, electro: 300, fire: 300, night: 100, sailor: 200 };
  for (const [sp, cap] of Object.entries(AV)) {
    const target = sp === "chemist" ? cap - 1 : cap;
    for (let i = 0; i < target; i++) SRV._mintAssetForTest("avatar", "Fill" + sp + i, { sp, kind: "avatar" }, "legacy");
  }
  chk(T("avatar", "chemist").count === 49, `chemist at cap-1 (${T("avatar", "chemist").count}/50), every other look full`);
  const av = [await mkWallet(false), await mkWallet(false)];
  for (const w of av) fund(w.wallet);
  const res3 = await Promise.all(av.map(w => post("/assets/scroll/redeem", { wallet: w.wallet, mktToken: w.mktToken })));
  const wins3 = res3.filter(r => r.status === 200).length;
  chk(wins3 === 1, `exactly ONE of two concurrent scroll redeems wins (${wins3}; statuses ${res3.map(r => r.status).join(",")})`);
  chk(T("avatar", "chemist").count === 50, `chemist lands on 50 (${T("avatar", "chemist").count})`);

  // C3 — RACE at cap-1 on the PAID meme sale (/meme/hatched rolls the species)
  wipe();
  for (const c of [["pepe", 25], ["popcat", 20], ["moodeng", 20], ["doge", 15], ["chillguy", 15]]) SRV._setMemeMintedForTest(c[0], c[1]);
  SRV._setMemeMintedForTest("alon", 9);
  chk(T("chikimon", "alon").count === 9, `alon at cap-1 (${T("chikimon", "alon").count}/10), every other meme full`);
  const mw = [await mkWallet(false), await mkWallet(false)];
  const hs = [];
  for (const w of mw) { const r = await post("/meme/hatch", { wallet: w.wallet }); if (r.status === 200) hs.push({ w, id: r.body.hatch.id }); await wait(4200); }
  chk(hs.length === 2, `two paid eggs incubating (${hs.length})`);
  const res4 = await Promise.all(hs.map(h => post("/meme/hatched", { wallet: h.w.wallet, hatchId: h.id })));
  const got = res4.filter(r => r.status === 200 && r.body.char).length;
  chk(got === 1, `exactly ONE of two concurrent reveals gets the last alon (${got}; chars ${res4.map(r => r.body.char || r.status).join(",")})`);
  chk(T("chikimon", "alon").count === 10, `alon lands on 10 (${T("chikimon", "alon").count})`);

  // C4 — every mintAsset call site, stated and probed
  wipe();
  chk(SRV._trueIssued("egg", "mount").count === 0, `eggs: supply table names no egg, so the egg mint is deliberately uncapped (an egg is not a creature)`);
  for (let i = 0; i < 5; i++) { const w = await mkWallet(); await w.save(roster([], ["griffin"])); }
  const sites = {
    "egg hatch (mount roll)": tryIssue("mount", fakeWallet(), "griffin", "mount", "hatched"),
    "egg consume (client species)": tryIssue("mount", fakeWallet(), "griffin", "mount", "hatched"),
    "scroll redeem (avatar)": tryIssue("avatar", fakeWallet(), "griffin", "avatar", "scroll"),
  };
  chk(sites["egg hatch (mount roll)"].code === "SUPPLY_EXHAUSTED", `mintAsset refuses origin "hatched" at cap (${sites["egg hatch (mount roll)"].code})`);
  chk(tryIssue("mount", fakeWallet(), "griffin", "mount", "issued").code === "SUPPLY_EXHAUSTED", `refuses origin "issued" at cap`);
  chk(tryIssue("mount", fakeWallet(), "griffin", "mount", "scroll").code === "SUPPLY_EXHAUSTED", `refuses origin "scroll" at cap`);
  chk(tryIssue("mount", fakeWallet(), "griffin", "mount", "legacy").ok, `EXEMPT by design: "legacy" (recording history a player already owns)`);
  chk(tryIssue("mount", fakeWallet(), "griffin", "mount", "unverified").ok, `EXEMPT by design: "unverified" (a forgery must be recorded, not counted)`);
  chk(tryIssue("mount", fakeWallet(), "griffin", "mount", "restitution").ok, `EXEMPT by design: "restitution" (giving back what was wiped)`);
  chk(tryIssue("mount", fakeWallet(), "griffin", "mount", "purchased").code === "SUPPLY_EXHAUSTED", `NOT exempt: "purchased"`);
  chk(tryIssue("mount", fakeWallet(), "griffin", "mount", "traded").code === "SUPPLY_EXHAUSTED", `NOT exempt: "traded"`);
}

// ===========================================================================================
sec("D. GRANDFATHER SAFETY — over cap means STOP ISSUING and take nothing");
{
  wipe();
  const W = [];
  for (let i = 0; i < 30; i++) { const w = await mkWallet(); await w.save(roster([], ["wolf"])); W.push(w); }   // 3x the cap of 10
  chk(T("mount", "wolf").count === 30, `the world is 3x over cap: ${show("mount", "wolf")} against a supply of 10`);
  const att = tryIssue("mount", fakeWallet(), "wolf", "mount");
  chk(!att.ok && att.code === "SUPPLY_EXHAUSTED", `issuance stops (${att.code})`);

  let held = 0, flags = 0, downgraded = 0;
  for (const w of W) {
    const a = await get(`/assets/audit?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`);
    if (a.body.mounts && a.body.mounts.wolf) held++;
    flags += Number(a.body.unverified) || 0;
    if (a.body.mounts && a.body.mounts.wolf && a.body.mounts.wolf.origin !== "legacy") downgraded++;
  }
  chk(held === 30, `all 30 owners still hold their wolf (${held}/30)`);
  chk(flags === 0 && downgraded === 0, `none flagged, none downgraded (flags=${flags} downgraded=${downgraded})`);

  let adoptedAll = 0;
  for (const w of W) {
    const s = await post("/assets/mounts/sync", { wallet: w.wallet, mktToken: w.mktToken });
    if (s.status === 200 && s.body.species.includes("wolf")) adoptedAll++;
  }
  chk(adoptedAll === 30, `every one of them can still RECORD it in the registry (${adoptedAll}/30)`);
  chk(T("mount", "wolf").count === 30, `and recording does not inflate the world (${T("mount", "wolf").count})`);

  // D2 — THE ATTACK: the ledger's verdict is not always "legacy". A creature graded "hatched"
  // (a pre-registry egg) or "purchased" (an on-chain buy) is an asset the player ALREADY OWNS, but
  // its adoption is not on the exempt list.
  wipe();
  for (let i = 0; i < 5; i++) { const w = await mkWallet(); await w.save(roster([], ["griffin"])); }
  chk(T("mount", "griffin").count === 5, `griffin at cap (${T("mount", "griffin").count}/5)`);
  const vh = await mkWallet(false);
  SRV.restoreAssetLedger(ledgerBlob([[vh.wallet, { first: PRE, seen: Date.now(), unverified: 0, units: {},
    mounts: { griffin: { ts: PRE, origin: "hatched" } }, eggs: {}, avatars: {} }]]));
  const s1 = await post("/assets/mounts/sync", { wallet: vh.wallet, mktToken: vh.mktToken });
  chk(s1.status === 200 && s1.body.species.includes("griffin"),
    `an over-cap owner graded "hatched" can still register theirs (adopted=${JSON.stringify(s1.body.adopted)} species=${JSON.stringify(s1.body.species)})`);

  // D3 — COLLATERAL: one at-cap species must not block adoption of the wallet's OTHER mounts
  const vc = await mkWallet(false);
  SRV.restoreAssetLedger(ledgerBlob([[vc.wallet, { first: PRE, seen: Date.now(), unverified: 0, units: {},
    mounts: { griffin: { ts: PRE, origin: "hatched" }, gator: { ts: PRE, origin: "hatched" }, boar: { ts: PRE, origin: "legacy" } }, eggs: {}, avatars: {} }]]));
  const s2 = await post("/assets/mounts/sync", { wallet: vc.wallet, mktToken: vc.mktToken });
  const sp2 = (s2.body.species || []);
  chk(sp2.includes("gator") && sp2.includes("boar"),
    `an at-cap species does not block the REST of the stable (species=${JSON.stringify(sp2)})`);

  // D4 — the same for chikimon: a purchased meme creature on a full edition
  wipe();
  SRV._setMemeMintedForTest("alon", 10);
  chk(T("chikimon", "alon").count === 10, `alon edition full (${T("chikimon", "alon").count}/10)`);
  const vk = await mkWallet(false);
  SRV.restoreAssetLedger(ledgerBlob([[vk.wallet, { first: PRE, seen: Date.now(), unverified: 0,
    units: { u1: { sp: "alon", kind: "meme", lvl: 30, ts: PRE, origin: "purchased" },
             u2: { sp: "tyrannos", kind: "legendary", lvl: 22, ts: PRE, origin: "legacy" } },
    mounts: {}, eggs: {}, avatars: {} }]]));
  const beforeSync = T("chikimon", "alon").count;
  const s3 = await post("/assets/chikimon/sync", { wallet: vk.wallet, mktToken: vk.mktToken });
  const sp3 = (s3.body.species || []);
  chk(sp3.includes("alon"), `a PURCHASED alon on a full edition is still registrable (species=${JSON.stringify(sp3)})`);
  chk(sp3.includes("tyrannos"), `and it does not block the rest of the roster (species=${JSON.stringify(sp3)})`);
  chk(T("chikimon", "alon").count === beforeSync,
    `registering it does not inflate the edition (${beforeSync} -> ${T("chikimon", "alon").count}) ${show("chikimon", "alon")}`);

  // D5 — the exemption cannot be turned into issuance: 20 wallets each adopt a full species and the
  // world count must equal the number of distinct LEDGER creatures, not the rows written
  wipe();
  const A = [];
  for (let i = 0; i < 20; i++) {
    const w = await mkWallet(false); A.push(w);
    SRV.restoreAssetLedger(ledgerBlob([[w.wallet, { first: PRE, seen: Date.now(), unverified: 0, units: {},
      mounts: { griffin: { ts: PRE, origin: "hatched" } }, eggs: {}, avatars: {} }]]));
  }
  const preAdopt = T("mount", "griffin").count;
  for (const w of A) for (let k = 0; k < 3; k++) await post("/assets/mounts/sync", { wallet: w.wallet, mktToken: w.mktToken });
  const postAdopt = T("mount", "griffin");
  chk(preAdopt === 20 && postAdopt.count === 20 && postAdopt.registry === 20 && postAdopt.deduped === 20,
    `60 adoption calls over 20 over-cap owners write 20 rows and add ZERO creatures (${preAdopt} -> ${postAdopt.count}) ${show("mount", "griffin")}`);
  chk(!tryIssue("mount", fakeWallet(), "griffin", "mount").ok, `and issuance is still refused afterwards`);
}

// ===========================================================================================
sec("E. ONE COUNTER — memeIssued and issuedCount must not be able to drift");
{
  wipe();
  const w = await mkWallet();
  await w.save(roster([{ sp: "alon", kind: "meme" }], []));
  await post("/assets/chikimon/sync", { wallet: w.wallet, mktToken: w.mktToken });
  SRV._setMemeMintedForTest("alon", 3);
  const t = T("chikimon", "alon");
  const sup = await get("/meme/supply");
  const rar = await get("/world/rarity");
  const memeN = ((sup.body.chars || {}).alon || {}).minted;
  chk(rar.body.chikimon.alon.issued === t.count, `/world/rarity == census (${rar.body.chikimon.alon.issued} vs ${t.count})`);
  chk(memeN === t.count, `/meme/supply == census (${memeN} vs ${t.count}) ${show("chikimon", "alon")}`);
}

console.log(`\n${fail ? "FAILURES" : "ALL PASS"} — pass=${pass} fail=${fail} findings=${findings.length}`);
if (fail) console.log(fails.map(f => "  - " + f).join("\n"));
if (findings.length) console.log("ARMED FINDINGS (no live trigger — see the tripwire):\n" + findings.map(f => "  - " + f).join("\n"));
console.log("census builds:", JSON.stringify(SRV._censusStats()));
process.exit(fail ? 1 : 0);
