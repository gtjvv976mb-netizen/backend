// meme_cap_sim.js — the Meme Dynasty edition cap must be REAL, on every route.
//
// There are two disjoint ways to obtain a meme chikimon:
//   1. the paid Meme Dynasty sale (memeHatches -> memeMinted)
//   2. the in-game MEME EGG (/assets/egg/hatch | /assets/egg/consume -> a registry chikimon row)
// Route 2 counted toward nothing and was capped by nothing, so "Alon, 1 of 10" was decoration: the
// scarcity bar could read 0/10 while players owned one, and an unlimited number could be hatched.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39307";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));
  SRV._setFfishAuthorityForTest(false);   // these claim eggs; the fish price is a separate, flagged concern

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const HOUR = 3600 * 1000;
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg, authSig });
  return { wallet, mktToken: v.body.mktToken };
}
const supply = async () => (await get("/meme/supply")).body;
const memeOf = async (k) => (await supply()).chars[k];
// mint a meme chikimon straight into the registry, exactly as an in-game meme egg hatch does
const inGameMint = (w, sp) => SRV._mintAssetForTest
  ? SRV._mintAssetForTest("chikimon", w, { sp, kind: "meme", lvl: 1 }, "hatched")
  : null;

SRV._clearAssetReg(); SRV._clearAssetLedger();

// ---------------------------------------------------------------------------
sec("THE REPORTED BUG: an in-game hatch was invisible to the scarcity bar");
{
  const before = await memeOf("alon");
  chk(before.cap === 10, `alon's cap is 10 (${before.cap})`);
  chk(before.minted === 0, `and nothing exists yet (${before.minted})`);

  // two players obtain alon the in-game way (registry rows, no sale involved)
  const A = await mkWallet(), Bw = await mkWallet();
  const m1 = inGameMint(A.wallet, "alon"), m2 = inGameMint(Bw.wallet, "alon");
  chk(!!m1 && !!m2, "two alon are minted through the in-game route");

  const after = await memeOf("alon");
  chk(after.minted === 2, `the bar now reports 2, not 0 — this is the bug that was reported (${after.minted}/${after.cap})`);
  chk(after.left === 8, `and 8 editions remain (${after.left})`);
  chk(after.sold === 0, `while the paid-sale count is still 0, reported separately (${after.sold})`);
}

// ---------------------------------------------------------------------------
sec("THE CAP NOW BINDS on the in-game route — the promise is enforced");
{
  // fill alon to its cap of 10 (2 already exist)
  for (let i = 0; i < 8; i++) inGameMint((await mkWallet()).wallet, "alon");
  const at = await memeOf("alon");
  chk(at.minted === 10 && at.left === 0, `alon is at its cap (${at.minted}/${at.cap}, left ${at.left})`);

  // a server-rolled meme egg must now never produce an alon
  const C = await mkWallet();
  // issuance no longer spends the 1500 market allowance (see fix_hatching_sim H1) — pay Mithra
  for (const [m, n] of Object.entries({ crystal: 50, honey: 34, berries: 40, essence: 34 })) SRV._grantOwnForTest(C.wallet, m, n);
  const ce = await post("/assets/egg/claim", { wallet: C.wallet, mktToken: C.mktToken, kind: "meme" });
  chk(ce.status === 200, `a meme egg is claimed (${ce.status})`);
  SRV._ageAsset(ce.body.egg.id, 25 * HOUR);                  // meme eggs are 24h
  const h = await post("/assets/egg/hatch", { wallet: C.wallet, mktToken: C.mktToken, id: ce.body.egg.id });
  chk(h.status === 200, `it hatches (${h.status})`);
  chk(h.body.hatched.sp !== "alon", `and it is NOT an at-cap alon (${h.body.hatched.sp})`);

  // and a client REPORTING an alon must be refused outright
  const D = await mkWallet();
  await wait(5100);
  for (const [m, n] of Object.entries({ crystal: 50, honey: 34, berries: 40, essence: 34 })) SRV._grantOwnForTest(D.wallet, m, n);
  const de = await post("/assets/egg/claim", { wallet: D.wallet, mktToken: D.mktToken, kind: "meme" });
  SRV._ageAsset(de.body.egg.id, 25 * HOUR);
  const con = await post("/assets/egg/consume", { wallet: D.wallet, mktToken: D.mktToken, id: de.body.egg.id, sp: "alon" });
  chk(con.status === 409, `a client claiming an at-cap alon is refused (${con.status})`);
  const still = await memeOf("alon");
  chk(still.minted === 10, `alon is still exactly at cap, never over (${still.minted}/10)`);
  // the egg is NOT destroyed by the refusal
  const mine = (await get(`/assets/mine?wallet=${D.wallet}&mktToken=${encodeURIComponent(D.mktToken)}`)).body;
  chk((mine.eggs || []).some(e => e.id === de.body.egg.id && e.state === "active"),
    "and the player's egg survives the refusal — it can be hatched again");
}

// ---------------------------------------------------------------------------
sec("an UNDER-cap character is unaffected — this only ever blocks what is exhausted");
{
  // capture dynamically: an earlier meme egg in this run rolls a RANDOM non-alon species and can
  // legitimately land on pepe, so asserting a hard 0 here makes the probe flake on its own randomness
  const pepe = await memeOf("pepe");
  chk(pepe.cap === 25 && pepe.minted < pepe.cap, `pepe is under its cap (${pepe.minted}/${pepe.cap})`);
  const E = await mkWallet();
  const r = inGameMint(E.wallet, "pepe");
  chk(!!r, "a pepe mints normally");
  chk((await memeOf("pepe")).minted === pepe.minted + 1,
    `and is counted (${pepe.minted} -> ${(await memeOf("pepe")).minted})`);
}

// ---------------------------------------------------------------------------
sec("the two routes ADD UP rather than double-count");
{
  const before = (await memeOf("doge")).minted;
  inGameMint((await mkWallet()).wallet, "doge");              // route 2
  const mid = (await memeOf("doge")).minted;
  chk(mid === before + 1, `an in-game doge adds one (${before} -> ${mid})`);
  SRV._setMemeMintedForTest && SRV._setMemeMintedForTest("doge", 3);   // route 1: three sold
  const after = (await memeOf("doge")).minted;
  chk(after === mid + 3, `three sold add three more, not replacing the count (${mid} -> ${after})`);
  chk((await memeOf("doge")).sold === 3, "and the paid-sale figure is still reported on its own");
}

// ---------------------------------------------------------------------------
console.log(`\nMEME_CAP_SIM pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
