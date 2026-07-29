// kill_report_sim.js — Step 6 (observe-only): combat essence joins the observed faucet.
// POST /world/kill/report records a per-kill CEILING of essence (ESSENCE_PER_KILL=6) into gatherCount
// so "essence" — the one other material with no gather node — stops permanently reading 0 and stops
// falsely flagging every essence seller. Proves: it counts with presence, rate-caps the count, needs
// presence, and fixes the oversold false-positive while still catching a genuine over-lister.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39296";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const ESSENCE_PER_KILL = 6;
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
const move = (w) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, x: 5, z: 5, dir: 0, handle: "Fighter" });
const kill = (w) => post("/world/kill/report", { wallet: w.wallet, mktToken: w.mktToken });
const essence = (w) => (SRV._gatheredFor(w.wallet) || {}).essence || 0;

// ---------------------------------------------------------------------------
sec("a kill with a live presence records the per-kill essence ceiling");
{
  const A = await mkWallet();
  await move(A);
  chk(essence(A) === 0, "before any kill the server has counted 0 essence");
  const r = await kill(A);
  chk(r.status === 200 && r.body.counted === true, `a kill is counted (${JSON.stringify(r.body)})`);
  chk(essence(A) === ESSENCE_PER_KILL, `the server credits the ${ESSENCE_PER_KILL}-essence ceiling for one kill (${essence(A)})`);
}

// ---------------------------------------------------------------------------
sec("the count is rate-capped; a machine-gun loop cannot inflate essence");
{
  const Bw = await mkWallet();
  await move(Bw);
  await kill(Bw);                                  // 1 counted -> 6
  const burst = [];
  for (let i = 0; i < 20; i++) burst.push((await kill(Bw)).body.counted);
  chk(burst.every(c => c === false), `a 20-kill burst inside the interval counts none (${burst.filter(Boolean).length} counted)`);
  chk(essence(Bw) === ESSENCE_PER_KILL, `so a spam loop leaves essence at ${ESSENCE_PER_KILL}, not ${ESSENCE_PER_KILL * 21}`);
  await wait(560);                                 // just past KILL_REC_MIN_MS (500)
  await kill(Bw);
  chk(essence(Bw) === ESSENCE_PER_KILL * 2, `after a human interval the next kill counts (now ${essence(Bw)})`);
}

// ---------------------------------------------------------------------------
sec("no live presence → refused, nothing counted");
{
  const C = await mkWallet();
  const r = await kill(C);
  chk(r.status === 403, `a kill report with no world presence is 403 (${r.status})`);
  chk(essence(C) === 0, "and nothing is counted");
}

// ---------------------------------------------------------------------------
sec("THE VALUE: reporting kills fixes the essence oversold false-positive");
{
  const D = await mkWallet();
  await move(D);
  const listE = (qty) => post("/market/op", { sid: D.sid, op: "list", wallet: D.wallet, mktToken: D.mktToken,
    listing: { id: "Less" + Date.now(), item: "essence", kind: "mat", qty, price: 10, seller: "Fighter" } });
  await listE(60);
  let sum = (await get(`/assets/summary?key=test-admin-key`)).body;
  let flagged = (sum.oversoldMaterials || []).some(o => o.item === "essence" && o.w === D.wallet.slice(0, 8));
  chk(flagged, "with 0 reported kills, an honest 60-essence listing is FALSELY flagged oversold");

  await kill(D);                                   // one kill -> essence ceiling 6 -> threshold max(50, 60)=60
  chk(essence(D) === ESSENCE_PER_KILL, "one kill is on the record");
  sum = (await get(`/assets/summary?key=test-admin-key`)).body;
  flagged = (sum.oversoldMaterials || []).some(o => o.item === "essence" && o.w === D.wallet.slice(0, 8));
  chk(!flagged, "the same 60-essence listing is no longer flagged — the false-positive is gone");
}

// ---------------------------------------------------------------------------
sec("a genuine essence over-lister is STILL caught");
{
  const E = await mkWallet();
  await move(E);
  await kill(E);                                   // 1 kill -> essence 6
  await post("/market/op", { sid: E.sid, op: "list", wallet: E.wallet, mktToken: E.mktToken,
    listing: { id: "Lcheat" + Date.now(), item: "essence", kind: "mat", qty: 5000, price: 10, seller: "Cheat" } });
  const sum = (await get(`/assets/summary?key=test-admin-key`)).body;
  const flagged = (sum.oversoldMaterials || []).some(o => o.item === "essence" && o.w === E.wallet.slice(0, 8));
  chk(flagged, "listing 5000 essence on 1 kill is still flagged (5000 > max(50, 60))");
}

// ---------------------------------------------------------------------------
console.log(`\nKILL_REPORT_SIM pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
