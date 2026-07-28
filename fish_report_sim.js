// fish_report_sim.js — Step 6 (observe-only): fishing joins the server-observed material faucet.
// POST /world/fish/report records ONE fish per catch into gatherCount, exactly as /world/node/claim
// records a gather. Proves: it counts with a live presence, rate-caps the count to human pace, needs
// presence, only counts pubkey wallets, and — the concrete value — FIXES the oversold false-positive
// where every honest angler who listed >50 fish looked suspicious because gatherCount["fish"] was 0.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39295";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

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
const move = (w) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, x: 5, z: 5, dir: 0, handle: "Angler" });
const fish = (w) => post("/world/fish/report", { wallet: w.wallet, mktToken: w.mktToken });
// read the server's counted-fish directly from the module (the /assets/audit endpoint needs a ledger
// record from an mmo save, which these fish-only test wallets never create — the real signal path
// oversoldMaterials reads gatherCount directly, exactly as this does)
const gatheredFish = async (w) => (SRV._gatheredFor(w.wallet) || {}).fish || 0;

// ---------------------------------------------------------------------------
sec("a catch with a live presence is counted once");
{
  const A = await mkWallet();
  await move(A);
  chk((await gatheredFish(A)) === 0, "before any catch the server has counted 0 fish");
  const r = await fish(A);
  chk(r.status === 200 && r.body.counted === true, `a catch is counted (${JSON.stringify(r.body)})`);
  chk((await gatheredFish(A)) === 1, "the server now knows 1 fish was caught");
}

// ---------------------------------------------------------------------------
sec("the count is rate-capped to a human pace; a machine-gun loop cannot inflate it");
{
  const Bw = await mkWallet();
  await move(Bw);
  await fish(Bw);                                  // 1 counted
  const burst = [];
  for (let i = 0; i < 20; i++) burst.push((await fish(Bw)).body.counted);   // all within FISH_REC_MIN_MS
  chk(burst.every(c => c === false), `a 20-report burst inside the interval counts none of them (${burst.filter(Boolean).length} counted)`);
  chk((await gatheredFish(Bw)) === 1, "so a spam loop leaves the ceiling at 1, not 21");
  await wait(850);                                 // just past FISH_REC_MIN_MS (800ms)
  const later = await fish(Bw);
  chk(later.body.counted === true && (await gatheredFish(Bw)) === 2, "after a human interval the next catch counts (now 2)");
}

// ---------------------------------------------------------------------------
sec("no live presence → refused, nothing counted");
{
  const C = await mkWallet();                      // signed, but never moved into the world
  const r = await fish(C);
  chk(r.status === 403, `a catch with no world presence is 403 (${r.status})`);
  chk((await gatheredFish(C)) === 0, "and nothing is counted");
}

// ---------------------------------------------------------------------------
sec("an unsigned net_id catch is accepted but not counted (recordGather is pubkey-only)");
{
  const nid = "n" + Date.now() + "_demo";
  await post("/world/move", { wallet: nid, x: 3, z: 3, dir: 0, handle: "Demo" });   // net_id stands alone
  const r = await post("/world/fish/report", { wallet: nid });
  chk(r.status === 200, `a net_id catch does not error (${r.status})`);
  // it cannot be read via /assets/audit (needs a pubkey), but recordGather's isPubkey guard drops it —
  // proven separately in Step 1; here we only confirm the endpoint tolerates a demo player safely
}

// ---------------------------------------------------------------------------
sec("THE VALUE: reporting catches fixes the oversold false-positive for an honest angler");
{
  const D = await mkWallet();
  await move(D);
  // list 60 fish on the market — with ZERO reported catches this trips oversold (60 > max(50, 0))
  const listOne = (qty) => post("/market/op", { sid: D.sid, op: "list", wallet: D.wallet, mktToken: D.mktToken,
    listing: { id: "Lfish" + Date.now(), item: "fish", kind: "mat", qty, price: 10, seller: "Angler" } });
  await listOne(60);
  let sum = (await get(`/assets/summary?key=test-admin-key`)).body;
  let flagged = (sum.oversoldMaterials || []).some(o => o.item === "fish" && o.w === D.wallet.slice(0, 8));
  chk(flagged, `with 0 reported catches, an honest 60-fish listing is FALSELY flagged oversold`);

  // now the angler's catches are reported (6 catches → threshold rises to max(50, 6*10)=60)
  for (let i = 0; i < 6; i++) { await fish(D); await wait(850); }
  chk((await gatheredFish(D)) === 6, "6 catches are now on the record");
  sum = (await get(`/assets/summary?key=test-admin-key`)).body;
  flagged = (sum.oversoldMaterials || []).some(o => o.item === "fish" && o.w === D.wallet.slice(0, 8));
  chk(!flagged, "the same 60-fish listing is no longer flagged — the false-positive is gone");
}

// ---------------------------------------------------------------------------
sec("a genuine over-lister is STILL caught (the signal isn't blunted)");
{
  const E = await mkWallet();
  await move(E);
  await fish(E);                                   // exactly 1 real catch on record
  await post("/market/op", { sid: E.sid, op: "list", wallet: E.wallet, mktToken: E.mktToken,
    listing: { id: "Lcheat" + Date.now(), item: "fish", kind: "mat", qty: 5000, price: 10, seller: "Cheat" } });
  const sum = (await get(`/assets/summary?key=test-admin-key`)).body;
  const flagged = (sum.oversoldMaterials || []).some(o => o.item === "fish" && o.w === E.wallet.slice(0, 8));
  chk(flagged, "listing 5000 fish on 1 reported catch is still flagged (5000 > max(50, 10))");
}

// ---------------------------------------------------------------------------
console.log(`\nFISH_REPORT_SIM pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
