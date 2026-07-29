// census_sim.js — GET /assets/census, the live per-species dex numbers.
// Drives real signed saves through auditAssets and real egg claims/hatches through the registry,
// then checks the census reports what actually happened — including the distinction that matters:
// "holders" (wallets seen holding one) vs "minted" (issued/adopted through the registry).
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39305";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const HOUR = 3600 * 1000;
let _n = 0;
async function mkWallet(firstSeen) {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg, authSig });
  const w = { wallet, authMsg, authSig, mktToken: v.body.mktToken, sessionId: v.body.sessionId };
  if (firstSeen) SRV._setWalletFirstSeenForTest(wallet, firstSeen);
  return w;
}
const save = (w, mmo) => wait(700).then(() => post("/profile",
  { wallet: w.wallet, authMsg: w.authMsg, authSig: w.authSig, profile: { mmo }, sessionId: w.sessionId }));
const census = async () => (await get(`/assets/census?key=test-admin-key`)).body;
const find = (arr, sp) => arr.find(x => x.sp === sp) || { holders: 0, minted: 0, byOrigin: {} };
const unit = (sp, kind, lvl) => ({ species: sp, kind, level: lvl });
const PRE = Date.UTC(2025, 0, 1);

SRV._clearAssetLedger(); SRV._clearAssetReg();

// ---------------------------------------------------------------------------
sec("it is admin-gated and never names a wallet");
{
  const anon = await get("/assets/census");
  chk(anon.status === 403, `no key -> 403 (${anon.status})`);
  const c = await census();
  chk(!JSON.stringify(c).includes("ledgerWallets\":null"), "an admin key gets the report");
  chk(Array.isArray(c.chikimon) && Array.isArray(c.mounts) && Array.isArray(c.avatars),
    "it carries chikimon, mounts and avatars");
}

// ---------------------------------------------------------------------------
sec("HOLDERS: what players are actually seen holding");
{
  const A = await mkWallet(PRE);
  await save(A, { onboarded: true, mounts: ["horse", "griffin"], avatars: ["Mystic"], avatar: "Mystic",
                  eggs: [], units: { u1: unit("firix", "normal", 12), u2: unit("dragonos", "legendary", 40) } });
  const B2 = await mkWallet(PRE);
  await save(B2, { onboarded: true, mounts: ["horse"], avatars: ["Knight"], avatar: "classic",
                   eggs: [], units: { u1: unit("firix", "normal", 3) } });

  const c = await census();
  chk(find(c.chikimon, "firix").holders === 2, `firix is held by 2 wallets (${find(c.chikimon, "firix").holders})`);
  chk(find(c.chikimon, "dragonos").holders === 1, `dragonos by 1 (${find(c.chikimon, "dragonos").holders})`);
  chk(find(c.chikimon, "jellox").holders === 0, `an unhatched species reports 0, not missing (${find(c.chikimon, "jellox").holders})`);
  chk(find(c.mounts, "horse").holders === 2 && find(c.mounts, "griffin").holders === 1,
    `mounts counted per wallet (horse ${find(c.mounts, "horse").holders}, griffin ${find(c.mounts, "griffin").holders})`);
  chk(c.ledgerWallets === 2, `ledger wallet count (${c.ledgerWallets})`);
}

// ---------------------------------------------------------------------------
sec("AVATARS are counted — including the one being WORN");
{
  const c = await census();
  chk(find(c.avatars, "Mystic").holders === 1, `an owned avatar is counted (${find(c.avatars, "Mystic").holders})`);
  chk(find(c.avatars, "Knight").holders === 1, `and a second wallet's (${find(c.avatars, "Knight").holders})`);
  chk(find(c.avatars, "classic").holders === 1, `the WORN look counts even if not in the owned list (${find(c.avatars, "classic").holders})`);
  chk(c.avatars.every(a => Object.keys(a.byOrigin).length === 0),
    "avatars carry NO origin grading — census only, never flagged");
  const sum = (await get("/assets/summary?key=test-admin-key")).body;
  chk((sum.unverified || 0) === 0, `and no avatar raised an unverified flag (${sum.unverified})`);
}

// ---------------------------------------------------------------------------
sec("origins are broken out, so legacy and unverified are distinguishable");
{
  const C = await mkWallet();                    // fresh wallet, no grandfather
  await save(C, { onboarded: true, mounts: [], avatars: [], eggs: [], units: { u1: unit("drolax", "normal", 1) } });
  await save(C, { onboarded: true, mounts: [], avatars: [], eggs: [],
                  units: { u1: unit("drolax", "normal", 1), u9: unit("tyrannos", "legendary", 50) } });
  const c = await census();
  const tyr = find(c.chikimon, "tyrannos");
  chk((tyr.byOrigin.unverified || 0) >= 1, `a conjured legendary shows as unverified (${JSON.stringify(tyr.byOrigin)})`);
  const firix = find(c.chikimon, "firix");
  chk((firix.byOrigin.legacy || 0) >= 1, `an honest legacy creature shows as legacy (${JSON.stringify(firix.byOrigin)})`);
}

// ---------------------------------------------------------------------------
sec("EGGS: claimed vs hatched vs still nesting");
{
  const D = await mkWallet(PRE);
  const e1 = await post("/assets/egg/claim", { wallet: D.wallet, mktToken: D.mktToken, kind: "mount" });
  chk(e1.status === 200, `a mount egg is claimed (${e1.status})`);
  await wait(5100);
  const e2 = await post("/assets/egg/claim", { wallet: D.wallet, mktToken: D.mktToken, kind: "normal" });
  chk(e2.status === 200, `and a normal egg (${e2.status})`);

  let c = await census();
  chk(c.eggs.claimed.mount === 1 && c.eggs.claimed.normal === 1, `both count as claimed (${JSON.stringify(c.eggs.claimed)})`);
  chk((c.eggs.hatched.mount || 0) === 0, "neither has hatched yet");
  chk(c.eggs.nesting.mount === 1, `and they read as still nesting (${JSON.stringify(c.eggs.nesting)})`);

  SRV._ageAsset(e1.body.egg.id, 7 * HOUR);
  const h = await post("/assets/egg/hatch", { wallet: D.wallet, mktToken: D.mktToken, id: e1.body.egg.id });
  chk(h.status === 200, `the mount egg hatches (${h.status} -> ${h.body.hatched?.sp})`);

  c = await census();
  chk(c.eggs.hatched.mount === 1, `it now counts as hatched (${JSON.stringify(c.eggs.hatched)})`);
  chk((c.eggs.nesting.mount || 0) === 0, "and no longer as nesting");
  chk(c.eggs.claimed.mount === 1, "while still counting as ever-claimed");
  chk(c.totals.eggsClaimed === 2 && c.totals.eggsHatched === 1,
    `totals line up (claimed ${c.totals.eggsClaimed}, hatched ${c.totals.eggsHatched})`);

  // the hatched mount is MINTED even though no cloud save has reported it yet
  const sp = h.body.hatched.sp;
  chk(find(c.mounts, sp).minted === 1, `the hatched ${sp} is counted as minted (${find(c.mounts, sp).minted})`);
}

// ---------------------------------------------------------------------------
sec("minted and holders are reported separately, not blended");
{
  const c = await census();
  const anyMintedNotHeld = c.mounts.some(m => m.minted > 0 && m.holders === 0);
  chk(anyMintedNotHeld, "a freshly minted mount shows minted>0 with holders=0 until its owner saves");
  const heldNotMinted = c.chikimon.some(m => m.holders > 0 && m.minted === 0);
  chk(heldNotMinted, "and a legacy creature shows holders>0 with minted=0 — the two never merge");
  chk(typeof c.note === "string" && c.note.includes("fill in"), "the payload states the freshness caveat itself");
}

// ---------------------------------------------------------------------------
sec("the whole catalog is always present, so the dex can render every slot");
{
  const c = await census();
  chk(c.chikimon.length === 21, `all 21 chikimon appear (${c.chikimon.length})`);
  chk(c.mounts.length === 6, `all 6 mounts (${c.mounts.length})`);
  chk(c.avatars.length === 10, `all 10 avatars (${c.avatars.length})`);
  chk(c.chikimon[0].holders >= c.chikimon[c.chikimon.length - 1].holders, "sorted most-held first");
}

// ---------------------------------------------------------------------------
console.log(`\nCENSUS_SIM pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
