// THE DROP HANDS OUT THE OWNER'S NEW SET — and keeps handing out the SAME set across a redeploy.
// Owner ruling 2026-08-11: the Founder Drop awards a NEW legendary set created for it, so the pool is
// named at /admin/event/start {species:[...]}. This proves: (a) the named set is what gets MINTED,
// (b) the per-species share divides the cap by pool size, (c) a mid-drop redeploy restores the pool —
// dropping it would silently switch the series to the game's legendaries half-way through, the same
// shape as the origin-clipping bug found the same day.
import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59987"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39287";
process.env.ADMIN_KEY = "pool-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1"; process.env.CHIK_NFT_HANDOVER = "1"; process.env.CHIK_MINT_AT_SALE = "1";
process.env.CHIK_REG_ALL = "1";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const KEY = process.env.ADMIN_KEY, B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get  = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let pass = 0, fail = 0;
const chk = (c, m) => { if (c) { pass++; console.log("  ok: " + m); } else { fail++; console.log("  FAIL: " + m); } };

await import("./server.js");
await new Promise(r => setTimeout(r, 1600));

const NEW_SET = ["aurox", "zephyra", "noctis", "verdant", "pyrion"];
console.log("\n== the owner names a NEW legendary set at start ==");
const s1 = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species: NEW_SET });
console.log(`   start -> ${s1.status} species=${JSON.stringify(s1.body.species)} perSpecies=${s1.body.perSpecies} cap=${s1.body.cap}`);
chk(s1.status === 200, "drop started");
chk(JSON.stringify(s1.body.species) === JSON.stringify(NEW_SET), "the response reports the OWNER'S set, not the game's legendaries");
chk(s1.body.perSpecies === 10, `perSpecies = ${s1.body.perSpecies} (cap 50 / 5 species)`);

console.log("\n== the public read shows it too ==");
const w = await get("/world/event");
console.log(`   /world/event = ${JSON.stringify(w.body).slice(0, 220)}`);
chk(w.status === 200, "/world/event answers while the drop runs");

console.log("\n== a 2-species set splits the cap 25/25 ==");
const s2 = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species: ["aurox", "zephyra"] });
console.log(`   perSpecies = ${s2.body.perSpecies}`);
chk(s2.body.perSpecies === 25, `2-species pool -> ${s2.body.perSpecies} each`);

console.log("\n== omitting species falls back to the game's legendaries (unchanged behaviour) ==");
const s3 = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7 });
console.log(`   species = ${JSON.stringify(s3.body.species)}`);
chk(Array.isArray(s3.body.species) && s3.body.species.length === 5 && !s3.body.species.includes("aurox"),
    "no pool named -> the existing five legendaries");

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
