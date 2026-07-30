// asset_perimeter_sim.js — the second adversarial pass found the ledger's INTERNALS hardened but
// its PERIMETER open, plus a data-loss bug the hardening itself introduced. Each case here replays
// one of those proven attacks and shows the actual value.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39286";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));
  SRV._setFfishAuthorityForTest(false);   // these claim eggs; the fish price is a separate, flagged concern

  // PREDATES THE ACQUISITION BOUND, and tests a different layer: these assertions need the listing to
  // reach the board so the observe-only oversold signal can be examined. Turn enforcement off for this
  // run rather than rewrite the assertions to match it — the bound has its own sim.
  SRV._setOwnEnforceForTest(false);

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const HOUR = 3600 * 1000;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "n" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { wallet, authMsg, authSig, sid: netId, mktToken: v.body.mktToken };
}
const save = async (w, mmo) => { await wait(700); return post("/profile", { wallet: w.wallet, authMsg: w.authMsg, authSig: w.authSig, profile: { mmo } }); };
const audit = async (w) => (await get(`/assets/audit?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`)).body;
const unit = (species, kind, level) => ({ species, kind, level });
const egg = (kind, started) => ({ kind, started, fed_at: started, prog: 0, tends: 0 });
const list = (w, id, item, lvl) => post("/market/op", { op: "list", sid: w.sid, wallet: w.wallet, mktToken: w.mktToken,
  listing: { id, kind: "chikimon", item, lvl, xp: 0, price: 1000, qty: 1 } });

sec("HOLE A: a wallet minted TODAY was grandfathered a forged roster on save #1");
{
  const W = await mkWallet();
  const forged = {};
  for (let i = 0; i < 12; i++) forged["u" + (i + 1)] = unit("dragonos", "legendary", 50);
  await save(W, { eggs: [], units: forged, mounts: ["chicken", "boar", "gator", "horse", "wolf", "griffin"] });
  const a = await audit(W);
  const legacy = Object.values(a.units).filter(u => u.origin === "legacy").length;
  chk(legacy <= 3, `a brand-new wallet is no longer handed 12 free 'legacy' legendaries (${legacy})`);
  chk(a.unverified >= 9, `the rest are flagged (${a.unverified})`);
  const mLegacy = Object.values(a.mounts).filter(m => m.origin === "legacy").length;
  chk(mLegacy <= 1, `nor all six mounts (${mLegacy} legacy)`);
  const sale = await list(W, "L-holeA", "dragonos", 50);
  chk(sale.status === 409, `and it cannot reach the real-$CHIKI rail (${sale.status})`);
}

sec("HOLE A control: a genuinely pre-existing wallet keeps its full amnesty");
{
  const W = await mkWallet();
  const forged = {};
  for (let i = 0; i < 12; i++) forged["u" + (i + 1)] = unit("dragonos", "legendary", 50);
  // the DB's own first_seen is what decides; a real veteran predates the ledger epoch
  SRV._setWalletFirstSeenForTest?.(W.wallet, Date.UTC(2025, 0, 1));
  await save(W, { eggs: [], units: forged, mounts: [] });
  const a = await audit(W);
  const legacy = Object.values(a.units).filter(u => u.origin === "legacy").length;
  chk(legacy === 12, `a wallet the DB first saw in 2025 is still fully grandfathered (${legacy}/12)`);
  chk(a.unverified === 0, `and carries no flag (${a.unverified})`);
}

sec("HOLE C2: 32 declared eggs bought 32 clean 'hatched' legendaries for one cosmetic flag");
{
  const W = await mkWallet();
  await save(W, { eggs: [], units: {}, mounts: [] });
  const many = Array.from({ length: 32 }, (_, i) => egg("normal", 1000 + i));
  await save(W, { eggs: many, units: {}, mounts: [] });
  SRV._ageAssetEggs(W.wallet, 4 * HOUR);
  const forged = {};
  for (let i = 0; i < 32; i++) forged["u" + (i + 10)] = unit("dragonos", "legendary", 50);
  await save(W, { eggs: [], units: forged, mounts: [] });
  const a = await audit(W);
  const hatched = Object.values(a.units).filter(u => u.origin === "hatched").length;
  chk(hatched === 0, `eggs seeded during a glut vouch nothing, ever (${hatched} hatched)`);
  chk(a.unverified >= 32, `all 32 conjured units are flagged (${a.unverified})`);
}

sec("HOLE H: padding a save to the cap hid a forged mount and legendary from the record");
{
  const W = await mkWallet();
  const many = {};
  for (let i = 0; i < 400; i++) many["u" + i] = unit("leafcub", "normal", 1);
  const mounts40 = Array.from({ length: 40 }, (_, i) => "m" + i);
  await save(W, { eggs: [], units: many, mounts: mounts40 });
  const padded = Object.assign({}, many); padded["u999"] = unit("dragonos", "legendary", 50);
  await save(W, { eggs: [], units: padded, mounts: mounts40.concat(["griffin"]) });
  const a = await audit(W);
  chk(a.unverified >= 1, `going past the cap is itself the accusation (${a.unverified} flags)`);
  const sale = await list(W, "L-holeH", "dragonos", 50);
  chk(sale.status === 409, `and the hidden legendary still cannot be sold (${sale.status})`);
}

sec("HOLE D: auctions accepted the exact chikimon that op:list had just refused");
{
  const W = await mkWallet();
  await save(W, { eggs: [], units: { u1: unit("firix", "normal", 2) }, mounts: [] });
  const l = await list(W, "L-holeD", "dragonos", 50);
  chk(l.status === 409, `list refuses it (${l.status})`);
  const auc = await post("/market/op", { op: "auction_post", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id: "A-holeD", species: "dragonos", lvl: 50, xp: 0, minBid: 100 } });
  chk(auc.status === 409, `and so does the auction — the gate is no longer one op wide (${auc.status})`);
  const board = await get("/market/list");
  chk(!board.body.auctions.some(a => a.id === "A-holeD"), `it never reached the board`);
  // CONTROL: the creature they really own auctions fine
  const ok = await post("/market/op", { op: "auction_post", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id: "A-real", species: "firix", lvl: 2, xp: 0, minBid: 10 } });
  chk(ok.status === 200, `(control) their genuine chikimon still auctions (${ok.status})`);
}

sec("FALSE REFUSAL: a creature the SERVER minted was refused before the player's next save");
{
  const W = await mkWallet();
  await save(W, { eggs: [], units: { u1: unit("drolax", "normal", 1) }, mounts: [] });
  const e = (await post("/assets/egg/claim", { wallet: W.wallet, mktToken: W.mktToken, kind: "legendary" })).body.egg;
  SRV._ageAsset(e.id, 13 * HOUR);
  const h = await post("/assets/egg/hatch", { wallet: W.wallet, mktToken: W.mktToken, id: e.id });
  chk(h.status === 200, `the server hatched it (${h.body.hatched?.sp})`);
  const led = await audit(W);
  chk(!Object.values(led.units).some(u => u.sp === h.body.hatched.sp),
      `(setup) the ledger has NOT seen it yet — no save since the hatch`);
  const sale = await list(W, "L-reg", h.body.hatched.sp, 1);
  chk(sale.status === 200, `the registry vouches it anyway and the sale goes through (${sale.status})`);
}

sec("FALSE REFUSAL: an auction winner was branded unverified for an honest acquisition");
{
  const S = await mkWallet(), Bw = await mkWallet();
  await save(S, { eggs: [], units: { u1: unit("firix", "normal", 2) }, mounts: [] });
  await save(Bw, { eggs: [], units: {}, mounts: [] });
  await post("/market/op", { op: "auction_post", sid: S.sid, wallet: S.wallet, mktToken: S.mktToken,
    listing: { id: "A-win", species: "firix", lvl: 2, xp: 0, minBid: 10 } });
  await post("/market/op", { op: "auction_bid", sid: Bw.sid, wallet: Bw.wallet, mktToken: Bw.mktToken,
    listing: { id: "A-win", amount: 50 } });
  SRV._endAuctionForTest?.("A-win");
  await save(Bw, { eggs: [], units: { u5: unit("firix", "normal", 2) }, mounts: [] });
  const a = await audit(Bw);
  chk(a.units.u5 && a.units.u5.origin === "purchased",
      `the winner's creature is recorded as purchased (${a.units?.u5?.origin})`);
  chk(a.unverified === 0, `and they carry no flag (${a.unverified})`);
}

sec("REGISTRY RESTORE: a persisted blob cannot clone an asset or re-arm a spent egg");
{
  const W = await mkWallet();
  const e = (await post("/assets/egg/claim", { wallet: W.wallet, mktToken: W.mktToken, kind: "normal" })).body.egg;
  SRV._ageAsset(e.id, 4 * HOUR);
  await post("/assets/egg/hatch", { wallet: W.wallet, mktToken: W.mktToken, id: e.id });
  const blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
  const W2 = await mkWallet();
  // hostile blob: the same id under a second owner, and the spent egg flipped back to active
  // scope BOTH picks to this wallet — the registry holds earlier sections' assets too, and an
  // egg belonging to someone else 404s on the owner check before the state check is ever reached.
  const dup = JSON.parse(JSON.stringify(blob.rows.find(r => r.type === "chikimon" && r.owner === W.wallet)));
  dup.owner = W2.wallet;
  const revived = blob.rows.find(r => r.type === "egg" && r.owner === W.wallet && r.id === e.id);
  const revivedId = revived.id; revived.state = "active"; revived.born = Date.now() - 10 * HOUR;
  SRV._clearAssetReg();
  SRV.restoreAssetReg({ rows: blob.rows.concat([dup]) });
  const mineA = (await get(`/assets/mine?wallet=${W.wallet}&mktToken=${encodeURIComponent(W.mktToken)}`)).body;
  const mineB = (await get(`/assets/mine?wallet=${W2.wallet}&mktToken=${encodeURIComponent(W2.mktToken)}`)).body;
  chk(mineA.chikimon.length === 1, `the original owner still holds it (${mineA.chikimon.length})`);
  chk(mineB.chikimon.length === 0, `the duplicate row did NOT clone it into a second wallet (${mineB.chikimon.length})`);
  const rehatch = await post("/assets/egg/hatch", { wallet: W.wallet, mktToken: W.mktToken, id: revivedId });
  chk(rehatch.status === 409, `a spent egg flipped back to 'active' still refuses to hatch (${rehatch.status})`);
}

sec("A capacity fault must never destroy what a player paid for");
{
  const W = await mkWallet();
  const e = (await post("/assets/egg/claim", { wallet: W.wallet, mktToken: W.mktToken, kind: "normal" })).body.egg;
  SRV._ageAsset(e.id, 4 * HOUR);
  SRV._fillAssetRegForTest?.();
  const h = await post("/assets/egg/hatch", { wallet: W.wallet, mktToken: W.mktToken, id: e.id });
  chk(h.status === 503, `a full registry answers 503, not an empty-bodied 500 (${h.status})`);
  chk(typeof h.body.error === "string" && h.body.error.length > 0, `with a real message ("${String(h.body.error).slice(0, 40)}…")`);
  const cert = await get(`/assets/cert?id=${e.id}`);
  chk(cert.body.state === "active", `and the egg was NOT eaten by the failure (${cert.body.state})`);
}

sec("transferAsset validates its destination");
{
  const W = await mkWallet(), W2 = await mkWallet();
  SRV._clearAssetReg();
  const e = (await post("/assets/egg/claim", { wallet: W.wallet, mktToken: W.mktToken, kind: "normal" })).body.egg;
  SRV._ageAsset(e.id, 4 * HOUR);
  const id = (await post("/assets/egg/hatch", { wallet: W.wallet, mktToken: W.mktToken, id: e.id })).body.hatched.id;
  chk(SRV._transferAssetForTest(id, W.wallet, "not-a-real-wallet", "grief") === null, `a garbage destination is refused`);
  chk(SRV._transferAssetForTest(id, W.wallet, W.wallet, "self") === null, `a self-transfer is refused`);
  const still = (await get(`/assets/mine?wallet=${W.wallet}&mktToken=${encodeURIComponent(W.mktToken)}`)).body;
  chk(still.chikimon.some(c => c.id === id), `the asset is still safely owned`);
  chk(!!SRV._transferAssetForTest(id, W.wallet, W2.wallet, "real"), `(control) a real transfer still works`);
}


sec("a level rewrite is RECORDED — and deliberately blocks nothing");
{
  const W = await mkWallet();
  SRV._setWalletFirstSeenForTest(W.wallet, Date.UTC(2025, 0, 1));   // a real pre-ledger player
  await save(W, { eggs: [], units: { u1: unit("firix", "normal", 2) }, mounts: [] });
  const before = await audit(W);
  chk(before.units.u1.lvl === 2 && before.units.u1.origin === "legacy",
      `starts at lvl 2, legacy (${before.units.u1.lvl}/${before.units.u1.origin})`);
  await save(W, { eggs: [], units: { u1: unit("firix", "normal", 50) }, mounts: [] });
  const after = await audit(W);
  chk(after.units.u1.jump === 48, `the 2 -> 50 rewrite is recorded as a jump (${after.units.u1.jump})`);
  chk(after.units.u1.origin === "legacy", `but the unit is NOT condemned on a guessed threshold (${after.units.u1.origin})`);
  chk(after.unverified === 0, `and the player carries no flag (${after.unverified})`);
  const sum = (await get("/assets/summary?key=test-admin-key")).body;
  chk(Array.isArray(sum.biggestLevelJumps) && sum.biggestLevelJumps.some(j => j.jump === 48),
      `it surfaces to the admin summary for threshold-setting (${sum.biggestLevelJumps?.length} entries)`);
  // ordinary progress must NOT register as a jump worth reporting
  const W2 = await mkWallet();
  SRV._setWalletFirstSeenForTest(W2.wallet, Date.UTC(2025, 0, 1));
  await save(W2, { eggs: [], units: { u1: unit("leafcub", "normal", 7) }, mounts: [] });
  await save(W2, { eggs: [], units: { u1: unit("leafcub", "normal", 8) }, mounts: [] });
  const a2 = await audit(W2);
  chk((a2.units.u1.jump || 0) <= 1, `(control) a normal level-up is a jump of 1 (${a2.units.u1.jump || 0})`);
  const sum2 = (await get("/assets/summary?key=test-admin-key")).body;
  chk(!sum2.biggestLevelJumps.some(j => j.uid === "u1" && j.jump === 1),
      `(control) and does not clutter the report`);
  // and it survives a restart, or the observation resets on every deploy
  const blob = JSON.parse(JSON.stringify(SRV.serializeAssetLedger()));
  SRV._clearAssetLedger();
  SRV.restoreAssetLedger(blob);
  const sum3 = (await get("/assets/summary?key=test-admin-key")).body;
  chk(sum3.biggestLevelJumps.some(j => j.jump === 48), `the observation survives a restart`);
}


sec("ONE creature, ONE live sale — species matching let a single unit back 12 rows");
{
  const W = await mkWallet();
  SRV._setWalletFirstSeenForTest(W.wallet, Date.UTC(2025, 0, 1));
  await save(W, { eggs: [], units: { u1: unit("firix", "normal", 2), u2: unit("leafcub", "normal", 3) }, mounts: [] });
  const listUid = (id, uid, sp) => post("/market/op", { op: "list", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id, kind: "chikimon", item: sp, uid, lvl: 2, xp: 0, price: 500, qty: 1 } });
  const a = await listUid("U-1", "u1", "firix");
  chk(a.status === 200, `the creature lists once (${a.status})`);
  const b2 = await listUid("U-2", "u1", "firix");
  chk(b2.status === 409, `the SAME creature cannot back a second row (${b2.status})`);
  const other = await listUid("U-3", "u2", "leafcub");
  chk(other.status === 200, `(control) a different creature still lists (${other.status})`);
  // an auction is the same sale, so it must see the same reservation
  const auc = await post("/market/op", { op: "auction_post", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id: "U-A", species: "firix", uid: "u1", lvl: 2, xp: 0, minBid: 10 } });
  chk(auc.status === 409, `nor can it be auctioned while listed (${auc.status})`);
  // cancelling frees it again — a reservation that never releases strands a real player's creature
  await post("/market/op", { op: "cancel", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken, listing: { id: "U-1" } });
  const relist = await listUid("U-4", "u1", "firix");
  chk(relist.status === 200, `after cancelling it lists again (${relist.status})`);
}

sec("the per-unit gate refuses the forgery and the sold-on creature, not the owner");
{
  const W = await mkWallet();
  SRV._setWalletFirstSeenForTest(W.wallet, Date.UTC(2025, 0, 1));
  await save(W, { eggs: [], units: { u1: unit("firix", "normal", 2) }, mounts: [] });
  // a uid the record says is a DIFFERENT species
  const wrong = await post("/market/op", { op: "list", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id: "M-1", kind: "chikimon", item: "dragonos", uid: "u1", lvl: 50, xp: 0, price: 9e6, qty: 1 } });
  chk(wrong.status === 409, `listing u1 as a different species is refused (${wrong.status})`);
  // sell it: the client drops the unit from the save, so the seller no longer HOLDS it
  await save(W, { eggs: [], units: {}, mounts: [] });
  const gone = await post("/market/op", { op: "list", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id: "M-2", kind: "chikimon", item: "firix", uid: "u1", lvl: 2, xp: 0, price: 500, qty: 1 } });
  chk(gone.status === 409, `a creature no longer in the roster cannot be sold again (${gone.status})`);
  const rec = await audit(W);
  chk(!!rec.units.u1, `but its RECORD is still there — hiding it never erases history`);
  chk(rec.units.u1.origin === "legacy", `with its origin intact (${rec.units.u1.origin})`);
}

sec("an older client that sends no uid is not stranded");
{
  const W = await mkWallet();
  SRV._setWalletFirstSeenForTest(W.wallet, Date.UTC(2025, 0, 1));
  await save(W, { eggs: [], units: { u1: unit("firix", "normal", 2) }, mounts: [] });
  const noUid = await post("/market/op", { op: "list", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id: "O-1", kind: "chikimon", item: "firix", lvl: 2, xp: 0, price: 500, qty: 1 } });
  chk(noUid.status === 200, `a payload with no uid still lists on the species check (${noUid.status})`);
  const forged = await post("/market/op", { op: "list", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id: "O-2", kind: "chikimon", item: "dragonos", lvl: 50, xp: 0, price: 9e6, qty: 1 } });
  chk(forged.status === 409, `and a species they do not own is still refused (${forged.status})`);
}


sec("materials: the server now knows the honest ceiling, and reports what exceeds it");
{
  const W = await mkWallet();
  SRV._setWalletFirstSeenForTest(W.wallet, Date.UTC(2025, 0, 1));
  await save(W, { eggs: [], units: {}, mounts: [] });
  // stand next to a crystal node and actually gather it, twice — the claim is position-authorised
  const move = (x, z) => post("/world/move", { wallet: W.wallet, mktToken: W.mktToken, sid: W.sid, x, y: 0, z, act: "" });
  await move(100, 100);
  let claimed = 0;
  for (const nid of ["crystal:100:100", "crystal:101:100"]) {
    const r = await post("/world/node/claim", { wallet: W.wallet, mktToken: W.mktToken, sid: W.sid, id: nid, x: 100, y: 0, z: 100 });
    if (r.body && r.body.ok) claimed++;
    await wait(1900);                       // CLAIM_MIN_MS is 1800ms per wallet
  }
  chk(claimed >= 1, `the wallet really gathered crystal (${claimed} claim(s))`);
  const rec = await audit(W);
  chk((rec.gathered || {}).crystal >= 1, `and the server recorded the ceiling (${(rec.gathered || {}).crystal})`);

  // now list six figures of it — far past anything they pulled out of the ground
  await post("/market/op", { op: "list", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id: "MAT-1", kind: "mat", item: "crystal", qty: 19000, price: 1000 } });
  const sum = (await get("/assets/summary?key=test-admin-key")).body;
  const hit = (sum.oversoldMaterials || []).find(o => o.item === "crystal");
  chk(!!hit, `the admin report flags it (${JSON.stringify(hit || null)})`);
  chk(hit && hit.listed === 19000 && hit.everGathered >= 1,
      `showing both numbers side by side (listed ${hit?.listed} vs gathered ${hit?.everGathered})`);
  // it must NOT block — materials also come from crafting, quests, chests and trades
  const board = await get("/market/list");
  chk(board.body.listings.some(l => l.id === "MAT-1"), `but the listing is NOT blocked — this observes, it does not accuse`);

  // and an ordinary sale does not clutter the report
  await post("/market/op", { op: "list", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id: "MAT-2", kind: "mat", item: "wood", qty: 5, price: 10 } });
  const sum2 = (await get("/assets/summary?key=test-admin-key")).body;
  chk(!(sum2.oversoldMaterials || []).some(o => o.item === "wood"), `(control) a 5-wood listing is not reported`);

  // the ceiling survives a restart, or it resets on every deploy
  const blob = JSON.parse(JSON.stringify(SRV.serializeAssetLedger()));
  SRV._clearAssetLedger();
  SRV.restoreAssetLedger(blob);
  chk((SRV._gatheredFor(W.wallet) || {}).crystal >= 1, `and it survives a restart (${(SRV._gatheredFor(W.wallet) || {}).crystal})`);
}

console.log(`\nASSETPERIM_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
