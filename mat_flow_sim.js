// mat_flow_sim.js — Step 6 increment 3: the FULL material flow becomes observable.
// POST /world/mat/flow records client-declared spends (matSpent) and no-world-event gains
// (matGained), kept DELIBERATELY SEPARATE from gatherCount.
//
// THE ASSERTION THAT MATTERS MOST: a client-declared GAIN must never reach gatherCount or the
// oversold signal. Otherwise a cheater declares "I found 10,000 crystal in chests" and launders a
// forged stockpile past the one anti-cheat signal materials have. Spends are self-limiting (declaring
// more spend only lowers your own plausible balance) — gains are the laundering direction.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39297";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

  // PREDATES THE ACQUISITION BOUND, and tests a different layer: these assertions need the listing to
  // reach the board so the observe-only oversold signal can be examined. Turn enforcement off for this
  // run rather than rewrite the assertions to match it — the bound has its own sim.
  SRV._setOwnEnforceForTest(false);

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "n" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { wallet, sid: netId, mktToken: v.body.mktToken };
}
const move = (w) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, x: 5, z: 5, dir: 0, handle: "Crafter" });
const flow = (w, ev) => post("/world/mat/flow", { wallet: w.wallet, mktToken: w.mktToken, ev });
const spent = (w) => (SRV._flowFor(w.wallet).spent) || {};
const gained = (w) => (SRV._flowFor(w.wallet).gained) || {};
const gath = (w) => SRV._gatheredFor(w.wallet) || {};

// ---------------------------------------------------------------------------
sec("spends and gains are recorded into their own separate tallies");
{
  const A = await mkWallet();
  await move(A);
  const r = await flow(A, [{ k: "craft", m: { wood: 16, stone: 11 } }, { k: "chest", m: { crystal: 6 } }]);
  chk(r.status === 200 && r.body.counted === true, `a flow batch is counted (${JSON.stringify(r.body)})`);
  chk(spent(A).wood === 16 && spent(A).stone === 11, `the craft spend is tallied (wood ${spent(A).wood}, stone ${spent(A).stone})`);
  chk(gained(A).crystal === 6, `the chest gain is tallied separately (crystal ${gained(A).crystal})`);
  chk(Object.keys(gath(A)).length === 0, `and gatherCount is untouched by either (${JSON.stringify(gath(A))})`);
}

// ---------------------------------------------------------------------------
sec("THE LAUNDERING GUARD: a declared gain can never excuse an oversold stockpile");
{
  const C = await mkWallet();
  await move(C);
  // the cheater declares an enormous chest haul, then lists a forged stockpile
  await flow(C, [{ k: "chest", m: { crystal: 500 } }, { k: "task", m: { crystal: 500 } }, { k: "raid", m: { crystal: 500 } }]);
  chk(gained(C).crystal > 0, `the declared gains are recorded as telemetry (${gained(C).crystal})`);
  chk((gath(C).crystal || 0) === 0, `but gatherCount.crystal stays 0 — declared gains are NOT evidence`);
  await post("/market/op", { sid: C.sid, op: "list", wallet: C.wallet, mktToken: C.mktToken,
    listing: { id: "Llaunder" + Date.now(), item: "crystal", kind: "mat", qty: 5000, price: 10, seller: "Cheat" } });
  const sum = (await get(`/assets/summary?key=test-admin-key`)).body;
  const flagged = (sum.oversoldMaterials || []).some(o => o.item === "crystal" && o.w === C.wallet.slice(0, 8));
  chk(flagged, "the 5000-crystal listing is STILL flagged — the laundering attempt fails");
}

// ---------------------------------------------------------------------------
sec("junk keys, unknown kinds and bad quantities never enter a tally");
{
  const D = await mkWallet();
  await move(D);
  await flow(D, [
    { k: "craft", m: { __proto__: 99, constructor: 99, notarealmat: 99, wood: 5 } },
    { k: "notarealkind", m: { wood: 1000 } },
    { k: "chest", m: { crystal: -50, iron: 0, gold: "abc" } },
  ]);
  chk(spent(D).wood === 5, `the one real material is tallied (wood ${spent(D).wood})`);
  chk(spent(D).notarealmat === undefined && spent(D).constructor === undefined, "junk material keys are ignored");
  chk(!("wood" in gained(D)), "an unknown event kind contributes nothing");
  chk(gained(D).crystal === undefined && gained(D).iron === undefined && gained(D).gold === undefined,
    "negative, zero and non-numeric quantities are ignored");
  chk(({}).notarealmat === undefined && Object.prototype.wood === undefined, "no prototype pollution");
}

// ---------------------------------------------------------------------------
sec("quantities are capped and batches are rate-limited");
{
  const E = await mkWallet();
  await move(E);
  await flow(E, [{ k: "craft", m: { wood: 999999 } }]);
  chk(spent(E).wood === 600, `an absurd quantity is capped at FLOW_QTY_MAX (${spent(E).wood})`);
  const burst = [];
  for (let i = 0; i < 5; i++) burst.push((await flow(E, [{ k: "craft", m: { stone: 10 } }])).body.counted);
  chk(burst.every(c => c === false), `batches inside the rate window are refused (${burst.filter(Boolean).length} counted)`);
  chk(spent(E).stone === undefined, "so a spam loop adds nothing");
  await wait(3100);
  await flow(E, [{ k: "craft", m: { stone: 10 } }]);
  chk(spent(E).stone === 10, `after the window the next batch counts (stone ${spent(E).stone})`);
}

// ---------------------------------------------------------------------------
sec("presence is required, and an oversized batch is truncated not dropped");
{
  const F = await mkWallet();
  const noPres = await flow(F, [{ k: "craft", m: { wood: 1 } }]);
  chk(noPres.status === 403, `no world presence → 403 (${noPres.status})`);
  await move(F);
  const many = [];
  for (let i = 0; i < 100; i++) many.push({ k: "craft", m: { wood: 1 } });
  const r = await flow(F, many);
  chk(r.body.counted === true && spent(F).wood === 32, `a 100-event batch counts the first 32 (${spent(F).wood})`);
}

// ---------------------------------------------------------------------------
sec("the tallies survive a restart (persisted beside gatherCount)");
{
  const G = await mkWallet();
  await move(G);
  await flow(G, [{ k: "craft", m: { iron: 12 } }, { k: "chest", m: { honey: 3 } }]);
  const blob = SRV.serializeAssetLedger();
  chk(Array.isArray(blob.spent) && Array.isArray(blob.gained), "serialize carries both tallies");
  SRV._clearAssetLedger();
  chk(Object.keys(spent(G)).length === 0, "after a clear the tallies are empty");
  SRV.restoreAssetLedger(blob);
  chk(spent(G).iron === 12 && gained(G).honey === 3, `restore brings them back (iron ${spent(G).iron}, honey ${gained(G).honey})`);
}

// ---------------------------------------------------------------------------
console.log(`\nMAT_FLOW_SIM pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
