// asset_forge_sim.js — reproduce EVERY forgery the adversarial probe verified against the asset
// ledger, and prove each one is now closed. Each case states the attack it replays.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39284";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => (await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
const get = async (p) => (await fetch(B + p)).json();
const raw = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const HOUR = 3600 * 1000;

// A throwaway wallet that can prove itself. The auth message shape and BASE64 signature are what
// /verify actually checks — a bs58 signature verifies as garbage and the wallet is never signed in,
// so its mktToken never binds and every audit answers "prove this wallet first".
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "n" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { wallet, authMsg, authSig, netId, mktToken: v.mktToken, sid: netId };
}
// /profile throttles writes inside 600ms and silently returns {throttled:true} — a real client
// never saves that fast, but a sim does, so wait it out or the save never reaches the ledger.
const saveAs = async (w, mmo) => { await new Promise(r => setTimeout(r, 700)); return post("/profile", { wallet: w.wallet, authMsg: w.authMsg, authSig: w.authSig, profile: { mmo } }); };
const auditAs = async (w) => ({ v: w, rec: await get(`/assets/audit?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`) });
const egg = (kind, started) => ({ kind, started, fed_at: started, prog: 0, tends: 0 });
const unit = (species, kind, level) => ({ species, kind, level });

// ============================================================================================
sec("ATTACK 1: conjure 12 eggs, drop them next save, mint 12 'hatched' legendaries (was 1412ms)");
{
  const W = await mkWallet();
  await saveAs(W, { eggs: [], units: { u1: unit("pipmoth", "normal", 2) }, mounts: [] });   // establish the record
  const twelve = Array.from({ length: 12 }, (_, i) => egg("legendary", 1000 + i));
  await saveAs(W, { eggs: twelve, units: { u1: unit("pipmoth", "normal", 2) }, mounts: [] });
  const forged = { u1: unit("pipmoth", "normal", 2) };
  for (let i = 0; i < 12; i++) forged["u" + (100 + i)] = unit("azulon", "legendary", 50);
  await saveAs(W, { eggs: [], units: forged, mounts: [] });
  const { rec } = await auditAs(W);
  const hatched = Object.values(rec.units).filter(u => u.origin === "hatched").length;
  const unver = Object.values(rec.units).filter(u => u.origin === "unverified").length;
  chk(hatched === 0, `none of the 12 are 'hatched' (${hatched} hatched)`);
  chk(unver === 12, `all 12 are flagged unverified (${unver})`);
  chk(rec.unverified >= 12, `the wallet carries the count (${rec.unverified})`);
  // the egg glut itself is impossible in real play — the client allows one egg per kind
  chk(Object.values(rec.units).every(u => u.sp !== "azulon" || u.origin === "unverified"),
      `every azulon is condemned`);
}

sec("ATTACK 1b: the SAME flow with a genuinely incubated egg must still hatch honestly");
{
  const W = await mkWallet();
  await saveAs(W, { eggs: [], units: { u1: unit("pipmoth", "normal", 2) }, mounts: [] });
  await saveAs(W, { eggs: [egg("legendary", 5000)], units: { u1: unit("pipmoth", "normal", 2) }, mounts: [] });
  const aged = SRV._ageAssetEggs(W.wallet, 13 * HOUR);        // 12h floor for a legendary + margin
  chk(aged === 1, `the sim aged the egg past its incubation floor (${aged} egg)`);
  await saveAs(W, { eggs: [], units: { u1: unit("pipmoth", "normal", 2), u2: unit("azulon", "legendary", 1) }, mounts: [] });
  const { rec } = await auditAs(W);
  chk(rec.units.u2 && rec.units.u2.origin === "hatched", `an egg that really incubated hatches clean (${rec.units?.u2?.origin})`);
  chk(rec.unverified === 0, `and the honest player is not flagged (${rec.unverified})`);
}

sec("ATTACK 1c: an egg dropped BEFORE its incubation floor cannot vouch anything");
{
  const W = await mkWallet();
  await saveAs(W, { eggs: [], units: {}, mounts: [] });
  await saveAs(W, { eggs: [egg("legendary", 6000)], units: {}, mounts: [] });
  SRV._ageAssetEggs(W.wallet, 3 * HOUR);                       // 3h of a 12h legendary
  await saveAs(W, { eggs: [], units: { u9: unit("azulon", "legendary", 50) }, mounts: [] });
  const { rec } = await auditAs(W);
  chk(rec.units.u9 && rec.units.u9.origin === "unverified", `a 3h-old legendary egg vouches nothing (${rec.units?.u9?.origin})`);
}

// ============================================================================================
sec("ATTACK 2: uids named after Object.prototype members (invisible units + process pollution)");
{
  const protoBefore = Object.prototype.lvl;
  const W = await mkWallet();
  await saveAs(W, { eggs: [], units: { u1: unit("pipmoth", "normal", 2) }, mounts: [] });
  const KEYS = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty",
                "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
                "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"];
  // Sent as RAW JSON TEXT on purpose. `obj["__proto__"] = v` in JS invokes the setter and changes
  // the prototype instead of creating a key, so an object literal can never carry this payload —
  // but JSON.parse creates a real own "__proto__" property, which is exactly how it reaches the
  // server from a crafted client. Building the body any other way silently tests nothing.
  const unitsJson = "{" + ['"u1":{"species":"pipmoth","kind":"normal","level":2}']
    .concat(KEYS.map(k => `${JSON.stringify(k)}:{"species":"azulon","kind":"legendary","level":50}`)).join(",") + "}";
  const body = `{"wallet":${JSON.stringify(W.wallet)},"authMsg":${JSON.stringify(W.authMsg)},"authSig":${JSON.stringify(W.authSig)},"profile":{"mmo":{"eggs":[],"units":${unitsJson},"mounts":[]}}}`;
  const parsedKeys = Object.keys(JSON.parse(unitsJson));
  chk(parsedKeys.includes("__proto__"), `(control) the wire payload really carries a "__proto__" key (${parsedKeys.length} keys)`);
  await new Promise(r => setTimeout(r, 700));
  await fetch(B + "/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const { rec } = await auditAs(W);
  chk(Object.prototype.lvl === protoBefore,
      `Object.prototype was NOT polluted (lvl=${String(Object.prototype.lvl)}, was ${String(protoBefore)})`);
  chk(({}).lvl === undefined, `a fresh {} is still clean`);
  const smuggled = Object.keys(rec.units).filter(k => k !== "u1");
  chk(smuggled.length === 0, `no prototype-keyed unit was admitted to the ledger (${smuggled.length})`);
  chk(rec.unverified >= KEYS.length, `all ${KEYS.length} were flagged rather than silently ignored (${rec.unverified})`);
}

// ============================================================================================
sec("ATTACK 3: rebrand a vouched uid — turn a legacy common into a legendary in place");
{
  const W = await mkWallet();
  await saveAs(W, { eggs: [], units: { u1: unit("pipmoth", "normal", 2) }, mounts: [] });
  const first = (await auditAs(W)).rec;
  chk(first.units.u1.origin === "legacy", `u1 starts legacy (${first.units.u1.origin})`);
  await saveAs(W, { eggs: [], units: { u1: unit("azulon", "legendary", 50) }, mounts: [] });
  const { rec } = await auditAs(W);
  chk(rec.units.u1.sp === "azulon", `the ledger now records the presented species (${rec.units.u1.sp})`);
  chk(rec.units.u1.origin === "unverified", `and the rebrand condemned it (${rec.units.u1.origin})`);
  chk(rec.unverified >= 1, `flag counted (${rec.unverified})`);
}

// ============================================================================================
sec("ATTACK 4: an HONEST mount-egg hatch was being flagged identically to appending all six");
{
  const W = await mkWallet();
  await saveAs(W, { eggs: [], units: {}, mounts: [] });
  await saveAs(W, { eggs: [egg("mount", 7000)], units: {}, mounts: [] });
  SRV._ageAssetEggs(W.wallet, 7 * HOUR);                       // 6h floor for a mount egg
  await saveAs(W, { eggs: [], units: {}, mounts: ["griffin"] });
  const { rec } = await auditAs(W);
  chk(rec.mounts.griffin && rec.mounts.griffin.origin === "hatched",
      `a real mount-egg hatch is vouched, not condemned (${rec.mounts?.griffin?.origin})`);
  chk(rec.unverified === 0, `the honest hatcher carries no flag (${rec.unverified})`);
}

sec("ATTACK 4b: appending all six mounts from nowhere is still caught");
{
  const W = await mkWallet();
  await saveAs(W, { eggs: [], units: {}, mounts: [] });
  await saveAs(W, { eggs: [], units: {}, mounts: ["chicken", "boar", "gator", "horse", "wolf", "griffin"] });
  const { rec } = await auditAs(W);
  const flagged = Object.values(rec.mounts).filter(m => m.origin === "unverified").length;
  chk(flagged === 6, `all six conjured mounts flagged (${flagged})`);
}

// ============================================================================================
sec("ATTACK 5: honest Trading Post buyers were condemned ('purchased' was doc-only)");
{
  const W = await mkWallet();
  await saveAs(W, { eggs: [], units: {}, mounts: [] });
  SRV._recordAssetBuyForTest?.(W.wallet, "chikimon", "azulon", 40);
  await saveAs(W, { eggs: [], units: { u3: unit("azulon", "legendary", 40) }, mounts: [] });
  const { rec } = await auditAs(W);
  chk(rec.units.u3 && rec.units.u3.origin === "purchased",
      `a verified on-chain purchase vouches the unit (${rec.units?.u3?.origin})`);
  chk(rec.unverified === 0, `the buyer is not flagged (${rec.unverified})`);
  // ONE purchase must not vouch an unlimited number of copies
  await saveAs(W, { eggs: [], units: { u3: unit("azulon", "legendary", 40), u4: unit("azulon", "legendary", 40) }, mounts: [] });
  const r2 = (await auditAs(W)).rec;
  chk(r2.units.u4 && r2.units.u4.origin === "unverified",
      `a SECOND copy of the same species is not vouched by one purchase (${r2.units?.u4?.origin})`);
}

// ============================================================================================
sec("ATTACK 6: list a forged legendary on the real-$CHIKI rail (the money path)");
{
  const W = await mkWallet();
  await saveAs(W, { eggs: [], units: { u1: unit("firix", "normal", 2) }, mounts: [] });
  const sid = W.sid, v = { mktToken: W.mktToken };
  // REAL SPECIES NAMES ON THE MARKET LEG. "pipmoth" and "azulon" are not in the catalog (azulon is
  // the scroll NPC), and op:list now catalog-checks `item` the way auction_post always has — so both
  // came back 400 "no such item", which tests the catalog rather than the provenance gate this case
  // is about. The ledger legs above keep the invented names on purpose: the point THERE is that the
  // audit records whatever a save presents.
  const listForged = await raw("/market/op", { op: "list", sid, wallet: W.wallet, mktToken: v.mktToken,
    listing: { id: "L-forged-1", kind: "chikimon", item: "dragonos", lvl: 50, xp: 999999, price: 9999999, qty: 1 } });
  chk(listForged.status === 409, `listing a chikimon absent from the record is refused (${listForged.status})`);
  const board = await get("/market/list");
  chk(!board.listings.some(l => l.id === "L-forged-1"), `it never reached the board`);
  // the unit the wallet REALLY owns must still be listable — a false refusal strands a real player
  const listReal = await raw("/market/op", { op: "list", sid, wallet: W.wallet, mktToken: v.mktToken,
    listing: { id: "L-real-1", kind: "chikimon", item: "firix", lvl: 2, xp: 10, price: 100, qty: 1 } });
  chk(listReal.status !== 409, `the wallet's genuine chikimon still lists fine (${listReal.status})`);
  const board2 = await get("/market/list");
  chk(board2.listings.some(l => l.id === "L-real-1"), `and it is on the board`);
}

// ============================================================================================
sec("ATTACK 7: persistence truncation drops the OLDEST rows regardless of flags");
{
  SRV._clearAssetLedger();
  const bulk = { w: [] };
  // 20200 CLEAN wallets inserted FIRST, then one flagged wallet last-but-oldest by `first`
  for (let i = 0; i < 20200; i++) {
    bulk.w.push([`Wclean${i}`.padEnd(44, "x"), { first: 1000 + i, seen: 1000 + i, eggsLast: 0,
      units: { u1: { sp: "leafcub", kind: "normal", lvl: 1, ts: 1, origin: "legacy" } }, mounts: {}, eggs: {} }]);
  }
  bulk.w.push(["WFLAGGEDoldest".padEnd(44, "x"), { first: 1, seen: 1, eggsLast: 0,
    units: { u1: { sp: "azulon", kind: "legendary", lvl: 50, ts: 1, origin: "unverified" } }, mounts: {}, eggs: {} }]);
  SRV.restoreAssetLedger(bulk);
  const blob = JSON.parse(JSON.stringify(SRV.serializeAssetLedger()));
  const kept = blob.w.map(e => e[0]);
  chk(kept.length <= 20000, `serialization respects the cap (${kept.length})`);
  chk(kept.some(k => k.startsWith("WFLAGGED")), `the FLAGGED-and-oldest wallet survived serialization`);
  SRV._clearAssetLedger();
  SRV.restoreAssetLedger(blob);
  const back = SRV.serializeAssetLedger().w.map(e => e[0]);
  chk(back.some(k => k.startsWith("WFLAGGED")), `and again after a full restart round-trip`);
}

sec("ATTACK 8: park a flagged uid past the 400-unit restore cap to wash it");
{
  SRV._clearAssetLedger();
  const units = {};
  for (let i = 0; i < 450; i++) units["u" + i] = { sp: "leafcub", kind: "normal", lvl: 1, ts: 1, origin: "legacy" };
  units["u999"] = { sp: "azulon", kind: "legendary", lvl: 50, ts: 1, origin: "unverified" };
  SRV.restoreAssetLedger({ w: [["Wpark".padEnd(44, "x"), { first: 1, seen: 1, eggsLast: 0, units, mounts: {}, eggs: {} }]] });
  const rec = SRV.serializeAssetLedger().w[0][1];
  chk(Object.keys(rec.units).length === 400, `the cap still applies (${Object.keys(rec.units).length})`);
  chk(!!rec.units.u999 && rec.units.u999.origin === "unverified", `the flagged uid was KEPT, not truncated away`);
  chk(rec.unverified >= 1, `its flag survived (${rec.unverified})`);
}

sec("ATTACK 9: /assets/audit as an oracle for 'the ledger is empty right now'");
{
  const W = await mkWallet();
  const r = await get(`/assets/audit?wallet=${W.wallet}&mktToken=${encodeURIComponent(W.mktToken)}`);
  chk(!("known" in r), `the response no longer reports whether the ledger knows this wallet`);
  chk(SRV._assetLedgerReady() === true, `(control) the ledger did load in this run`);
}

sec("ATTACK 10: hold more eggs than the client can physically produce");
{
  const W = await mkWallet();
  await saveAs(W, { eggs: [], units: {}, mounts: [] });
  await saveAs(W, { eggs: [egg("normal", 1), egg("normal", 2), egg("normal", 3), egg("normal", 4),
                          egg("normal", 5), egg("normal", 6)], units: {}, mounts: [] });
  const { rec } = await auditAs(W);
  chk(rec.unverified >= 1, `holding 6 eggs (client max is one per kind = 4) is flagged (${rec.unverified})`);
}

console.log(`\nASSETFORGE_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
