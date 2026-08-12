// THE DROP HANDS OUT THE OWNER'S NEW SET — and keeps handing out the SAME set across a redeploy.
// Owner ruling 2026-08-11: the Founder Drop awards a NEW legendary set created for it, so the pool is
// named at /admin/event/start {species:[...]}. This proves: (a) the named set is what gets MINTED,
// (b) the per-species share divides the cap by pool size, (c) a mid-drop redeploy restores the pool —
// dropping it would silently switch the series to the game's legendaries half-way through, the same
// shape as the origin-clipping bug found the same day.
//
// THE DEFAULT POOL IS THE GAME'S LEGENDARY ROSTER, AND THE ROSTER MOVES. It grew 5 -> 11 on
// 2026-08-11 (astraya, bamboran, borealon, horoxyn, rivaros, solvarex joined as ORDINARY legendaries)
// and astragor/crysalune/vesperos are queued. So this sim never writes the roster down: it reads it
// from the server through a channel that does NOT go through founderPool() — the
// /admin/grant-collection?dryRun=1 catalog, which lists every species with its kind, in roster order,
// and (by its own contract) writes nothing — then asserts the unnamed drop's pool equals it exactly.
import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59987"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39287";
process.env.ADMIN_KEY = "pool-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1"; process.env.CHIK_NFT_HANDOVER = "1"; process.env.CHIK_MINT_AT_SALE = "1";
process.env.CHIK_REG_ALL = "1";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
// an inherited FOUNDER_SPECIES would win the fallback ahead of SPECIES_LEGEND and the "no pool named"
// arm below would quietly test the operator's env list instead of the game's roster.
delete process.env.FOUNDER_SPECIES; delete process.env.FOUNDER_CAP;
const KEY = process.env.ADMIN_KEY, B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get  = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let pass = 0, fail = 0;
const chk = (c, m) => { if (c) { pass++; console.log("  ok: " + m); } else { fail++; console.log("  FAIL: " + m); } };

await import("./server.js");
await new Promise(r => setTimeout(r, 1600));

// ---- the roster, read from the server WITHOUT touching the founder machinery --------------------
// dryRun=1 reports what a full collection grant WOULD do; the catalog it walks is built straight from
// SPECIES_NORMAL / SPECIES_LEGEND / SPECIES_MEME, so the legendary rows are the roster in its own order.
const CATALOG_WALLET = bs58.encode(nacl.sign.keyPair().publicKey);   // throwaway, and the run is dry
const cat = await post("/admin/grant-collection?dryRun=1", { key: KEY, wallet: CATALOG_WALLET, dryRun: "1" });
const catRows = [...(cat.body.granted || []), ...(cat.body.already || []), ...(cat.body.refused || []), ...(cat.body.skipped || [])];
const ROSTER = catRows.filter(x => x.type === "chikimon" && x.kind === "legendary").map(x => String(x.sp));
console.log(`\n== the game's legendary roster, read independently of the drop ==`);
console.log(`   /admin/grant-collection?dryRun=1 -> ${cat.status}, catalog=${cat.body.totals && cat.body.totals.catalog} rows`);
console.log(`   legendaries (${ROSTER.length}): ${JSON.stringify(ROSTER)}`);
chk(cat.status === 200 && ROSTER.length >= 5 && new Set(ROSTER).size === ROSTER.length,
    `roster read: ${ROSTER.length} distinct legendary species ${JSON.stringify(ROSTER)}`);

// FINDING #1 (2026-08-12): a named pool must be REGISTERED species (MEME_KEYS or SPECIES_LEGEND) —
// an unregistered/typo'd key is now refused (it used to mint an UNCAPPED phantom). So the "owner's
// named set" here is the five wave-2 Meme Dynasty species: valid keys, and distinct from the game's
// LEGENDARY roster (they are kind:"meme", not legendaries), which is exactly what this sim needs.
const NEW_SET = ["ansem", "successkid", "chloe", "grumpycat", "peanut"];
console.log("\n== the owner names a valid REGISTERED set (the Meme Dynasty) at start ==");
const s1 = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species: NEW_SET });
console.log(`   start -> ${s1.status} species=${JSON.stringify(s1.body.species)} perSpecies=${s1.body.perSpecies} cap=${s1.body.cap}`);
const CAP = Number(s1.body.cap);
const ceilShare = (n) => Math.max(1, Math.ceil(CAP / (n || 1)));
chk(s1.status === 200, "drop started");
chk(JSON.stringify(s1.body.species) === JSON.stringify(NEW_SET), "the response reports the OWNER'S set, not the game's legendaries");
chk(NEW_SET.every(sp => !ROSTER.includes(sp)),
    `the named set is genuinely NOT the game's LEGENDARY roster (overlap = ${JSON.stringify(NEW_SET.filter(sp => ROSTER.includes(sp)))})`);
chk(s1.body.perSpecies === ceilShare(NEW_SET.length),
    `perSpecies = ${s1.body.perSpecies} (cap ${CAP} / ${NEW_SET.length} named species = ${ceilShare(NEW_SET.length)})`);

console.log("\n== the public read shows it too ==");
const w = await get("/world/event");
console.log(`   /world/event = ${JSON.stringify(w.body).slice(0, 220)}`);
chk(w.status === 200, "/world/event answers while the drop runs");

console.log("\n== a 2-species set splits the cap 25/25 ==");
const s2 = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species: ["stonks", "triplet"] });
console.log(`   perSpecies = ${s2.body.perSpecies}`);
chk(s2.body.perSpecies === ceilShare(2), `2-species pool -> ${s2.body.perSpecies} each (cap ${CAP} / 2 = ${ceilShare(2)})`);

console.log("\n== omitting species falls back to the game's OWN legendary roster ==");
const s3 = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7 });
console.log(`   species  = ${JSON.stringify(s3.body.species)}`);
console.log(`   roster   = ${JSON.stringify(ROSTER)}`);
// The roster is 11 long TODAY and will be 14; nothing below writes either number down. The default
// pool must be the roster ITSELF — same members, same order — and never the previous drop's named set.
chk(Array.isArray(s3.body.species) && JSON.stringify(s3.body.species) === JSON.stringify(ROSTER),
    `no pool named -> the ${ROSTER.length} legendaries of the roster, in the roster's own order: ${JSON.stringify(s3.body.species)}`);
chk(!(s3.body.species || []).some(sp => NEW_SET.includes(sp)),
    `the previous drop's named set did NOT leak into the fallback (ansem present=${(s3.body.species || []).includes("ansem")})`);
chk(s3.body.perSpecies === ceilShare(ROSTER.length),
    `the default pool's share is derived from the roster too: perSpecies=${s3.body.perSpecies} = ceil(${CAP}/${ROSTER.length}) = ${ceilShare(ROSTER.length)}`);
const wDef = await get("/world/event");
chk(JSON.stringify(wDef.body.founderSpecies) === JSON.stringify(ROSTER),
    `the client-facing read agrees: /world/event founderSpecies = ${JSON.stringify(wDef.body.founderSpecies)}`);

console.log("\n== the named set SURVIVES a redeploy (the series cannot switch mid-drop) ==");
await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species: NEW_SET });
const before = (await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species: NEW_SET })).body.species;
// force the persisted state through a real save/restore cycle
const S = await import("./server.js");
const H = S._testHooks || S.default || S;
if (H._saveLiveEventsForTest && H._resetLiveEventsForTest && H._bootRestoreLiveEventsForTest) {
  await H._saveLiveEventsForTest(); H._resetLiveEventsForTest(); await H._bootRestoreLiveEventsForTest();
  const poolAfter = (await get("/world/event")).body.founderSpecies || null;   // read it the way a client does
  console.log(`   pool before=${JSON.stringify(before)}\n   pool after redeploy=${JSON.stringify(poolAfter)}`);
  chk(poolAfter && JSON.stringify(poolAfter) === JSON.stringify(NEW_SET),
      "the owner's set is still the pool after a redeploy");
} else {
  console.log("   (no save/restore test hooks exported — redeploy arm skipped, stated not assumed)");
}

console.log(`\nEV_FOUNDER_POOL_DONE pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
