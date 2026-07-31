// census_consolidation_sim.js — HOW MANY OF THIS SPECIES REALLY EXIST?
//
// A cap is only as true as its denominator. Issuance used to be counted from the REGISTRY ALONE,
// which is the newest and smallest of three places a living creature is recorded:
//   1. assetReg    — server-minted rows
//   2. assetLedger — the LEGACY per-wallet ledger (old-game creatures live here and nowhere else)
//   3. memeMinted  — the paid Meme Dynasty sale counter
// So a legacy-heavy species could issue right past its advertised supply, while a naive union of
// the three would swing the other way and REFUSE honest players over creatures counted twice
// (adoption mints a registry row for a ledger entry; a sale is granted in-game and then adopted).
//
// This proves the consolidation: the deduped union equals the true distinct number, the cap binds
// on it, over-cap worlds are grandfathered rather than confiscated, and /world/rarity publishes
// arithmetic anyone can check.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39411";
process.env.ADMIN_KEY = "test-admin-key";
process.env.MEME_SALE_OPEN = "true"; process.env.MEME_VERIFY_PAY = "false";
delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));
SRV._setFfishAuthorityForTest(false);

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const HOUR = 3600 * 1000;
const PRE = Date.UTC(2025, 0, 1);         // a genuine pre-ledger player: their roster is "legacy"

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
// the exact shape a legacy roster arrives in
const roster = (units, mounts, avatars) => ({
  onboarded: true, eggs: [],
  units: Object.fromEntries((units || []).map((u, i) => [`u${i + 1}`, { species: u.sp, kind: u.kind || "normal", level: u.lvl || 5 }])),
  mounts: mounts || [], avatars: avatars || [],
});
const T = (type, sp) => SRV._trueIssued(type, sp);
const show = (type, sp) => { const t = T(type, sp); return `${type}/${sp}: count=${t.count} (registry=${t.registry} ledger=${t.ledger} sales=${t.sales} deduped=${t.deduped} flagged=${t.flagged})`; };
// issue exactly as a hatch does — this is the call the cap must refuse
function tryIssue(type, wallet, sp, kind) {
  try { return { ok: true, row: SRV._mintAssetForTest(type, wallet, { sp, kind: kind || type, lvl: 1 }, "hatched") }; }
  catch (e) { return { ok: false, code: e.code || null, msg: String(e.message || e) }; }
}

SRV._clearAssetReg(); SRV._clearAssetLedger();

// ===========================================================================================
sec("A. THE ARITHMETIC: registry-only, ledger-only (legacy), and ADOPTED (in both)");
{
  // registry-only: two players the server itself minted a tyrannos for (no save, no ledger)
  const R1 = await mkWallet(), R2 = await mkWallet();
  tryIssue("chikimon", R1.wallet, "tyrannos", "legendary");
  tryIssue("chikimon", R2.wallet, "tyrannos", "legendary");
  let t = T("chikimon", "tyrannos");
  chk(t.count === 2 && t.registry === 2 && t.ledger === 0,
    `registry-only: ${show("chikimon", "tyrannos")}`);

  // ledger-only: three old-game players whose tyrannos exists nowhere but the ledger
  const L = [];
  for (let i = 0; i < 3; i++) { const w = await mkWallet(); await w.save(roster([{ sp: "tyrannos", kind: "legendary" }])); L.push(w); }
  t = T("chikimon", "tyrannos");
  chk(t.count === 5 && t.registry === 2 && t.ledger === 3,
    `+3 legacy creatures the registry has never seen: ${show("chikimon", "tyrannos")}`);
  chk(t.count === 5, `the OLD registry-only counter would have said 2 — it under-counted by 3 (registry=${t.registry}, truth=${t.count})`);

  // ADOPTED: one of those legacy players signs in, and /assets/chikimon/sync mints a registry row
  // for the creature the ledger already knows. One creature; two records.
  const before = T("chikimon", "tyrannos").count;
  const s = await post("/assets/chikimon/sync", { wallet: L[0].wallet, mktToken: L[0].mktToken });
  chk(s.status === 200 && s.body.adopted.includes("tyrannos"), `sync adopts the legacy creature (adopted=${JSON.stringify(s.body?.adopted)})`);
  t = T("chikimon", "tyrannos");
  chk(t.registry === 3 && t.ledger === 3 && t.deduped === 1 && t.count === before,
    `adoption adds a RECORD, not a creature: ${show("chikimon", "tyrannos")} — still ${before}`);

  // the dedup key itself
  const mine = await get(`/assets/mine?wallet=${L[0].wallet}&mktToken=${encodeURIComponent(L[0].mktToken)}`);
  const cert = mine.body.chikimon && mine.body.chikimon[0];
  const full = cert ? (await get(`/assets/cert?id=${cert.id}`)).body : {};
  chk(!!full.id, `the adopted row exists (${full.id})`);
  // luid is not published on /assets/cert; prove it through the census instead — a second sync
  // must not adopt again, and the count must not move
  const s2 = await post("/assets/chikimon/sync", { wallet: L[0].wallet, mktToken: L[0].mktToken });
  chk(s2.body.adopted.length === 0 && T("chikimon", "tyrannos").count === before,
    `a second sync adopts nothing and moves nothing (${T("chikimon", "tyrannos").count})`);

  // all three legacy players adopt: 6 raw records, still 5 creatures
  await post("/assets/chikimon/sync", { wallet: L[1].wallet, mktToken: L[1].mktToken });
  await post("/assets/chikimon/sync", { wallet: L[2].wallet, mktToken: L[2].mktToken });
  t = T("chikimon", "tyrannos");
  chk(t.registry + t.ledger === 8 && t.count === 5 && t.deduped === 3,
    `8 records, 5 creatures: ${show("chikimon", "tyrannos")}`);
}

// ===========================================================================================
sec("B. THE BUG THIS FIXES: a legacy-heavy species must stop issuing at its TRUE total");
{
  // griffin's supply is 5. Five old-game players hold one each — in the LEDGER ONLY.
  const G = [];
  for (let i = 0; i < 5; i++) { const w = await mkWallet(); await w.save(roster([], ["griffin"])); G.push(w); }
  const t = T("mount", "griffin");
  chk(t.registry === 0 && t.ledger === 5 && t.count === 5,
    `the world holds 5 griffins, none of them in the registry: ${show("mount", "griffin")}`);

  const r = await get("/world/rarity");
  const g = r.body.mount.griffin;
  chk(g.cap === 5 && g.issued === 5 && g.remaining === 0,
    `the board says ${g.issued}/${g.cap}, ${g.remaining} left, rarity=${g.rarity}`);

  const N = await mkWallet();
  const att = tryIssue("mount", N.wallet, "griffin", "mount");
  chk(!att.ok && att.code === "SUPPLY_EXHAUSTED",
    `a sixth griffin is REFUSED (${att.ok ? "ISSUED — BUG" : att.code + ": " + att.msg})`);
  console.log(`     registry-only counting would have seen ${t.registry}/5 and issued 5 more.`);
}

// ===========================================================================================
sec("C. NO HONEST PLAYER IS REFUSED BY DOUBLE COUNTING");
{
  // horse's supply is 10. Four legacy owners, every one of them ADOPTED — 8 raw records.
  const H = [];
  for (let i = 0; i < 4; i++) {
    const w = await mkWallet(); await w.save(roster([], ["horse"]));
    await post("/assets/mounts/sync", { wallet: w.wallet, mktToken: w.mktToken });
    H.push(w);
  }
  const t = T("mount", "horse");
  chk(t.registry === 4 && t.ledger === 4 && t.count === 4 && t.deduped === 4,
    `8 records, 4 horses: ${show("mount", "horse")}`);

  // a naive union would read 8/10 and leave 2; the truth is 4/10 with 6 left. Six honest players
  // must all still be able to get one — and the seventh must not.
  let issued = 0, refused = null;
  for (let i = 0; i < 7; i++) {
    const w = await mkWallet();
    const a = tryIssue("mount", w.wallet, "horse", "mount");
    if (a.ok) issued++; else if (!refused) refused = a;
  }
  chk(issued === 6, `6 more horses are issued, not 2 (issued=${issued})`);
  chk(!!refused && refused.code === "SUPPLY_EXHAUSTED", `and the 11th is refused (${refused && refused.code})`);
  chk(T("mount", "horse").count === 10, `the world now holds exactly the cap (${T("mount", "horse").count}/10)`);
}

// ===========================================================================================
sec("D. GRANDFATHERING IS ABSOLUTE: over cap = stop issuing, take nothing");
{
  // wolf's supply is 10 and twelve old-game players hold one. Nobody may lose theirs.
  const W = [];
  for (let i = 0; i < 12; i++) { const w = await mkWallet(); await w.save(roster([], ["wolf"])); W.push(w); }
  const t = T("mount", "wolf");
  chk(t.count === 12, `the world is OVER cap: ${show("mount", "wolf")} against a supply of 10`);

  const att = tryIssue("mount", (await mkWallet()).wallet, "wolf", "mount");
  chk(!att.ok && att.code === "SUPPLY_EXHAUSTED", `issuance stops (${att.code})`);

  // nothing deleted, nothing flagged, nothing taken
  let stillHeld = 0, flags = 0;
  for (const w of W) {
    const a = await get(`/assets/audit?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`);
    if (a.body.mounts && a.body.mounts.wolf) stillHeld++;
    flags += Number(a.body.unverified) || 0;
    if (a.body.mounts && a.body.mounts.wolf && a.body.mounts.wolf.origin !== "legacy") flags += 100;
  }
  chk(stillHeld === 12, `all 12 owners still hold their wolf (${stillHeld}/12)`);
  chk(flags === 0, `not one of them is flagged or downgraded by being over cap (flags=${flags})`);

  // and they can still adopt into the registry — being over cap must not block RECORDING history
  const s = await post("/assets/mounts/sync", { wallet: W[0].wallet, mktToken: W[0].mktToken });
  chk(s.status === 200 && s.body.species.includes("wolf"), `an over-cap owner can still register theirs (${JSON.stringify(s.body.adopted)})`);
  chk(T("mount", "wolf").count === 12, `and that does not inflate the world count (${T("mount", "wolf").count})`);

  const r = await get("/world/rarity");
  const wv = r.body.mount.wolf;
  chk(wv.issued === 12 && wv.cap === 10 && wv.remaining === 0 && wv.rarity === "Extinct",
    `the board reports the overhang honestly: issued=${wv.issued} cap=${wv.cap} remaining=${wv.remaining} rarity=${wv.rarity}`);
}

// ===========================================================================================
sec("E. THE EXCLUSIONS: sold, consumed, forged, and species no table names");
{
  // held === false — a creature that was sold is gone from the count
  const S = await mkWallet();
  await S.save(roster([{ sp: "grovador", kind: "legendary" }]));
  chk(T("chikimon", "grovador").count === 1, `held: ${show("chikimon", "grovador")}`);
  await S.save(roster([]));                       // sold — the unit leaves the save
  chk(T("chikimon", "grovador").count === 0, `sold (held=false) leaves the live count: ${show("chikimon", "grovador")}`);
  const a = await get(`/assets/audit?wallet=${S.wallet}&mktToken=${encodeURIComponent(S.mktToken)}`);
  chk(!!a.body.units.u1, "…but the RECORD of it is still there — excluded, never erased");

  // a consumed egg is not a living egg
  const E = await mkWallet();
  // Mithra now charges (EGG_RECIPE_MATS) and issuance reads the STRICT unwitnessed allowance (25),
  // so the wallet has to be RECORDED acquiring the ingredients before an egg can be claimed at all.
  for (const m of ["wood", "berries", "essence"]) SRV._grantOwnForTest(E.wallet, m, 400, "mat");
  const claim = await post("/assets/egg/claim", { wallet: E.wallet, mktToken: E.mktToken, kind: "normal" });
  chk(claim.status === 200, `an egg is claimed (${claim.status})`);
  chk(T("egg", "normal").count >= 1, `a live egg counts: ${show("egg", "normal")}`);
  const eggsBefore = T("egg", "normal").count;
  SRV._ageAsset(claim.body.egg.id, 4 * HOUR);
  const h = await post("/assets/egg/hatch", { wallet: E.wallet, mktToken: E.mktToken, id: claim.body.egg.id });
  chk(h.status === 200, `it hatches (${h.status})`);
  chk(T("egg", "normal").count === eggsBefore - 1, `the consumed egg leaves the live count (${eggsBefore} -> ${T("egg", "normal").count})`);

  // a FORGED asset is reported, never counted — or conjuring 5 griffins would deny them to everyone
  const F = await mkWallet(false);   // a wallet with no history: its roster cannot be grandfathered
  await F.save(roster([], ["gator", "gator"]));
  await F.save(roster([], ["gator", "boar", "chicken", "wolf"]));
  const tg = T("mount", "chicken");
  chk(tg.flagged >= 1 && tg.count === 0,
    `a conjured mount is flagged and NOT counted: ${show("mount", "chicken")}`);
  const before = T("mount", "chicken").count;
  const honest = tryIssue("mount", (await mkWallet()).wallet, "chicken", "mount");
  chk(honest.ok, `so an honest player can still be issued one (${honest.ok ? "issued" : honest.code})`);
  chk(T("mount", "chicken").count === before + 1, `and that one DOES count (${before} -> ${T("mount", "chicken").count})`);

  // a species no supply table names: reported, never a crash
  const X = await mkWallet();
  await X.save(roster([{ sp: "notaspecies", kind: "normal" }]));
  const tx = T("chikimon", "notaspecies");
  chk(tx.count === 1, `an unknown species is still counted: ${show("chikimon", "notaspecies")}`);
  const r = await get("/world/rarity");
  chk(r.status === 200, `/world/rarity still answers (${r.status})`);
  const un = (r.body.unlisted || []).find(u => u.sp === "notaspecies");
  chk(!!un && un.issued === 1, `and reports it under unlisted (${JSON.stringify(un)})`);
  chk(r.body.chikimon.notaspecies && r.body.chikimon.notaspecies.cap === 0,
    `with cap 0 — nothing is invisible (${JSON.stringify(r.body.chikimon.notaspecies)})`);
}

// ===========================================================================================
sec("F. THE PAID SALE IS THE SAME CREATURE — count it once");
{
  const P = await mkWallet();
  const hatch = await post("/meme/hatch", { wallet: P.wallet });
  chk(hatch.status === 200, `a Meme Dynasty egg is bought (${hatch.status} ${hatch.body.error || ""})`);
  const done = await post("/meme/hatched", { wallet: P.wallet, hatchId: hatch.body.hatch.id });
  const sp = done.body.char;
  chk(!!sp, `it rolls a species (${sp}, edition ${done.body.edition})`);
  let t = T("chikimon", sp);
  chk(t.sales === 1 && t.count === 1, `the sale counts once: ${show("chikimon", sp)}`);

  // the buyer is granted the creature in game, so it reaches the save → the ledger → adoption
  await P.save(roster([{ sp, kind: "meme" }]));
  t = T("chikimon", sp);
  chk(t.ledger === 1 && t.sales === 1 && t.count === 1,
    `in the save too, still ONE creature: ${show("chikimon", sp)}`);
  await post("/assets/chikimon/sync", { wallet: P.wallet, mktToken: P.mktToken });
  t = T("chikimon", sp);
  chk(t.registry === 1 && t.ledger === 1 && t.sales === 1 && t.count === 1 && t.deduped === 2,
    `and adopted into the registry — three records, one creature: ${show("chikimon", sp)}`);
  console.log(`     the old counter (memeMinted + registry rows) would have said ${t.sales + t.registry}.`);

  // memeIssued is now the SAME number — one counter, not two that drift
  const sup = await get("/meme/supply");
  chk(sup.body.chars[sp].minted === t.count,
    `/meme/supply agrees with the census (${sup.body.chars[sp].minted} vs ${t.count})`);
  const rar = await get("/world/rarity");
  chk(rar.body.chikimon[sp].issued === t.count,
    `/world/rarity agrees too (${rar.body.chikimon[sp].issued})`);
}

// ===========================================================================================
sec("G. THE PUBLISHED BOARD MATCHES THE ARITHMETIC");
{
  const r = await get("/world/rarity");
  chk(r.status === 200, `GET /world/rarity is public and read-only (${r.status})`);
  let mismatched = 0, missingBreakdown = 0, checked = 0;
  for (const type of ["avatar", "mount", "chikimon", "egg"]) {
    for (const [sp, v] of Object.entries(r.body[type] || {})) {
      checked++;
      const t = T(type, sp);
      if (v.issued !== t.count) { mismatched++; console.log(`     MISMATCH ${type}/${sp}: board=${v.issued} census=${t.count}`); }
      if (!v.breakdown || v.breakdown.registry !== t.registry || v.breakdown.ledger !== t.ledger
          || v.breakdown.sales !== t.sales || v.breakdown.deduped !== t.deduped) missingBreakdown++;
      if (v.cap > 0 && v.remaining !== Math.max(0, v.cap - v.issued)) mismatched++;
    }
  }
  chk(checked > 0 && mismatched === 0, `every published number matches the census (${checked} species checked, ${mismatched} mismatched)`);
  chk(missingBreakdown === 0, `and every one carries its breakdown (${missingBreakdown} missing)`);
  const capped = Object.values(r.body.mount).filter(v => v.cap > 0).length;
  const uncapped = Object.values(r.body.chikimon).filter(v => v.cap === 0).length;
  chk(capped === 6, `all 6 mounts are capped (${capped})`);
  chk(uncapped > 0, `and the uncapped chikimon are published with cap 0 (${uncapped} of them)`);

  // THE TRUTH TABLE
  console.log("\n  === PER-SPECIES TRUTH TABLE (only what the world actually holds) ===");
  console.log("  type      species        cap  issued  left  registry  ledger  sales  dedup  flag  rarity");
  const rows = [];
  for (const type of ["avatar", "mount", "chikimon", "egg"]) {
    for (const [sp, v] of Object.entries(r.body[type] || {})) {
      if (!v.issued && !(v.breakdown && v.breakdown.flagged)) continue;
      rows.push([type, sp, v.cap, v.issued, v.remaining, v.breakdown.registry, v.breakdown.ledger,
                 v.breakdown.sales, v.breakdown.deduped, v.breakdown.flagged, v.rarity]);
    }
  }
  for (const c of rows) {
    console.log(`  ${String(c[0]).padEnd(9)} ${String(c[1]).padEnd(14)} ${String(c[2]).padStart(3)} ${String(c[3]).padStart(7)} ${String(c[4]).padStart(5)} ${String(c[5]).padStart(9)} ${String(c[6]).padStart(7)} ${String(c[7]).padStart(6)} ${String(c[8]).padStart(6)} ${String(c[9]).padStart(5)}  ${c[10]}`);
  }
  console.log(`  (${rows.length} species with a live population)`);
}

// ===========================================================================================
sec("H. THE COUNT SURVIVES A RESTART (the dedup key is persisted, or the restart double-counts)");
{
  const before = T("mount", "horse");
  const regBlob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
  const ledBlob = JSON.parse(JSON.stringify(SRV.serializeAssetLedger()));
  SRV._clearAssetReg(); SRV._clearAssetLedger();
  chk(T("mount", "horse").count === 0, `control: the wipe really empties it (${T("mount", "horse").count})`);
  SRV.restoreAssetReg(regBlob); SRV.restoreAssetLedger(ledBlob);
  const after = T("mount", "horse");
  chk(after.count === before.count && after.deduped === before.deduped,
    `after the restart the same 10 horses are still 10: ${show("mount", "horse")} (was count=${before.count} deduped=${before.deduped})`);
  const att = tryIssue("mount", (await mkWallet()).wallet, "horse", "mount");
  chk(!att.ok && att.code === "SUPPLY_EXHAUSTED", `and the cap still binds after the restart (${att.code})`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — pass=${pass} fail=${fail}`);
console.log(`census builds: ${JSON.stringify(SRV._censusStats())}`);
process.exit(fail === 0 ? 0 : 1);
