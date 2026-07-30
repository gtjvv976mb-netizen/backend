// chikimon_sync_sim.js — Step 5 of server authority: legacy chikimon become permanent registry
// assets. POST /assets/chikimon/sync adopts the wallet's ledger-known, currently-held creatures into
// the registry carrying the ledger's origin, and answers with a species+provenance list. It is
// ADOPT-ONLY: it must never launder an unverified creature, never adopt one the player no longer
// holds, and — the safety crux — never modify the LEDGER, so the sale gate's per-uid verdict is
// untouched.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39293";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));
  SRV._setFfishAuthorityForTest(false);   // these claim eggs; the fish price is a separate, flagged concern

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
let _n = 0;
async function mkWallet(firstSeen) {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg, authSig });
  const w = { wallet, authMsg, authSig, mktToken: v.body.mktToken };
  if (firstSeen) SRV._setWalletFirstSeenForTest(wallet, firstSeen);
  return w;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const save = (w, mmo) => wait(700).then(() => post("/profile", { wallet: w.wallet, authMsg: w.authMsg, authSig: w.authSig, profile: { mmo } }));
const sync = (w) => post("/assets/chikimon/sync", { wallet: w.wallet, mktToken: w.mktToken });
const mine = (w) => get(`/assets/mine?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`);
const audit = (w) => get(`/assets/audit?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`);
const PRE = Date.UTC(2025, 0, 1);   // a pre-ledger (grandfathered) player

// ---------------------------------------------------------------------------
sec("a held legacy chikimon is adopted into permanent registry property, origin carried");
{
  const A = await mkWallet(PRE);
  await save(A, { onboarded: true, mounts: [], eggs: [],
    units: { u1: { species: "firix", kind: "normal", level: 30 } } });
  const before = (await mine(A)).body.chikimon || [];
  chk(before.length === 0, `before sync the registry has no chikimon rows (${before.length})`);

  const r = await sync(A);
  chk(r.status === 200 && r.body.ok, `sync answers ok (${r.status})`);
  chk(r.body.adopted.includes("firix"), `it adopts the firix (${JSON.stringify(r.body.adopted)})`);
  chk(r.body.species.includes("firix"), `and returns it in the canonical species list`);

  const rows = (await mine(A)).body.chikimon || [];
  chk(rows.length === 1 && rows[0].sp === "firix", `the registry now owns the firix (${rows.map(m => m.sp)})`);
  chk(rows[0].origin === "legacy", `carrying the ledger's origin — legacy, not laundered (${rows[0].origin})`);
  chk(rows[0].id && rows[0].id[0] === "c", `with a server-minted chikimon id (${rows[0].id})`);
  chk(rows[0].lvl === 1, `and the birth level is 1 — NOT the save's level 30, which stays the client's (${rows[0].lvl})`);
}

// ---------------------------------------------------------------------------
sec("re-sync does not clone; the ledger is never modified");
{
  const A = await mkWallet(PRE);
  await save(A, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "healix", kind: "normal", level: 12 } } });
  const auditBefore = (await audit(A)).body;
  const r1 = await sync(A);
  const r2 = await sync(A);
  chk(r1.body.adopted.length === 1 && r2.body.adopted.length === 0, `first sync adopts, second adopts nothing (${r2.body.adopted.length})`);
  const rows = (await mine(A)).body.chikimon || [];
  chk(rows.length === 1, `exactly one registry row after two syncs (${rows.length})`);
  const auditAfter = (await audit(A)).body;
  // THE SAFETY CRUX: adoption must not touch the ledger — the sale gate reads it per-uid
  chk(JSON.stringify(auditBefore.units) === JSON.stringify(auditAfter.units),
    `the ledger units are byte-identical before and after adoption (sale gate untouched)`);
}

// ---------------------------------------------------------------------------
sec("an unverified creature stays unverified — no laundering");
{
  const C = await mkWallet();   // fresh wallet, no grandfather
  // first save: one normal (grandfathered). second: a conjured legendary beyond the grandfather.
  await save(C, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "drolax", kind: "normal", level: 1 } } });
  await save(C, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "drolax", kind: "normal", level: 1 },
    u2: { species: "tyrannos", kind: "legendary", level: 50 } } });
  const a = (await audit(C)).body;
  chk(a.units.u2 && a.units.u2.origin === "unverified", `the conjured legendary is unverified in the ledger (${a.units.u2 && a.units.u2.origin})`);
  await sync(C);
  const rows = (await mine(C)).body.chikimon || [];
  const tyr = rows.find(r => r.sp === "tyrannos");
  chk(tyr && tyr.origin === "unverified", `and it adopts as an UNVERIFIED registry row — the flag is preserved (${tyr && tyr.origin})`);
  const sum = (await get(`/assets/summary?key=test-admin-key`)).body;
  chk(sum.byOrigin && sum.byOrigin.unverified >= 1, `the game-wide view still counts an unverified unit (${sum.byOrigin && sum.byOrigin.unverified})`);
}

// ---------------------------------------------------------------------------
sec("a creature the player no longer holds (sold) is NOT adopted");
{
  const D = await mkWallet(PRE);
  await save(D, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "owzard", kind: "normal", level: 8 },
    u2: { species: "mushrow", kind: "normal", level: 5 } } });
  // now the mushrow leaves the roster (sold/gone) — held becomes false on the next audit
  await save(D, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "owzard", kind: "normal", level: 8 } } });
  const a = (await audit(D)).body;
  chk(a.units.u2 && a.units.u2.held === false, `the departed mushrow is held=false in the ledger (${a.units.u2 && a.units.u2.held})`);
  const r = await sync(D);
  chk(r.body.adopted.includes("owzard"), `the held owzard is adopted (${JSON.stringify(r.body.adopted)})`);
  chk(!r.body.adopted.includes("mushrow"), `the departed mushrow is NOT adopted`);
  const rows = (await mine(D)).body.chikimon || [];
  chk(rows.every(x => x.sp !== "mushrow"), `and no mushrow row was minted (${rows.map(m => m.sp)})`);
}

// ---------------------------------------------------------------------------
sec("only catalog species are adopted; the body names nothing");
{
  const E = await mkWallet(PRE);
  await save(E, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "solarix", kind: "normal", level: 3 },
    u2: { species: "notacreature", kind: "legendary", level: 9 } } });
  // hand-craft a body naming a species we don't hold — it must be ignored
  const r = await post("/assets/chikimon/sync", { wallet: E.wallet, mktToken: E.mktToken, units: ["dragonos"], sp: "dragonos", species: ["dragonos"] });
  chk(r.body.species.includes("solarix"), `the catalog solarix is adopted (${JSON.stringify(r.body.species)})`);
  chk(!r.body.species.includes("notacreature"), `the junk ledger species is ignored`);
  chk(!r.body.species.includes("dragonos"), `the injected species in the body is ignored`);
  const rows = (await mine(E)).body.chikimon || [];
  chk(rows.length === 1 && rows[0].sp === "solarix", `only the solarix was minted (${rows.map(m => m.sp)})`);
}

// ---------------------------------------------------------------------------
sec("an unproven caller is refused — same gate as every /assets route");
{
  const F = await mkWallet(PRE);
  await save(F, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "scorplex", kind: "normal", level: 2 } } });
  const bad = await post("/assets/chikimon/sync", { wallet: F.wallet, mktToken: "" });
  chk(bad.status === 403, `no token → 403 (${bad.status})`);
  const rows = (await mine(F)).body.chikimon || [];
  chk(rows.length === 0, `and nothing was minted for the unproven caller (${rows.length})`);
}

// ---------------------------------------------------------------------------
console.log(`\nCHIKIMON_SYNC_SIM pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
