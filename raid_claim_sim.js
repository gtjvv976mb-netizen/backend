// raid_claim_sim.js — the weekly MALGROTH prize (500 soft $CHIKI + 25 crystal) was gated ONLY by
// d["last_raid_week"] in the client save, which is in no _econ_sig version — so resetting that one
// field re-claimed the prize forever with a still-valid signature. Crystal feeds the real-$CHIKI
// market rail, so this was a live value leak. POST /world/raid/claim moves the week to the server.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39299";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
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
const move = (w) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, x: 5, z: 5, dir: 0, handle: "Raider" });
const claim = (w) => post("/world/raid/claim", { wallet: w.wallet, mktToken: w.mktToken });

// ---------------------------------------------------------------------------
sec("the first raid of the week is granted; every repeat is refused");
{
  const A = await mkWallet();
  await move(A);
  const first = await claim(A);
  chk(first.status === 200 && first.body.granted === true, `the first claim is granted (${JSON.stringify(first.body)})`);
  const again = await claim(A);
  chk(again.body.granted === false, `an immediate re-claim is refused (granted=${again.body.granted})`);
  // THE EXPLOIT: the client resetting last_raid_week cannot help — the server never asked the client
  const spam = [];
  for (let i = 0; i < 10; i++) spam.push((await claim(A)).body.granted);
  chk(spam.every(g => g === false), `10 further claims are all refused (${spam.filter(Boolean).length} granted)`);
  chk(SRV._raidWeekFor(A.wallet) !== null, "the server holds the week for this wallet, not the save");
}

// ---------------------------------------------------------------------------
sec("a new week grants again (the prize is weekly, not once ever)");
{
  const C = await mkWallet();
  await move(C);
  chk((await claim(C)).body.granted === true, "claimed this week");
  chk((await claim(C)).body.granted === false, "and refused a repeat");
  SRV._setRaidWeekForTest(C.wallet, SRV._raidWeekFor(C.wallet) - 1);   // pretend last claim was last week
  chk((await claim(C)).body.granted === true, "next week it is granted again");
}

// ---------------------------------------------------------------------------
sec("one wallet's claim never affects another's");
{
  const D = await mkWallet(); const E = await mkWallet();
  await move(D); await move(E);
  chk((await claim(D)).body.granted === true, "D claims");
  chk((await claim(E)).body.granted === true, "E still gets their own claim");
  chk((await claim(D)).body.granted === false, "and D is still refused a second");
}

// ---------------------------------------------------------------------------
sec("an unproven or absent caller cannot claim or burn someone else's week");
{
  const F = await mkWallet();
  await move(F);
  const bare = await post("/world/raid/claim", { wallet: F.wallet });          // no token
  chk(bare.status === 403, `a bare wallet is refused (${bare.status})`);
  const wrong = await post("/world/raid/claim", { wallet: F.wallet, mktToken: "0000000000000000bad" });
  chk(wrong.status === 403, `a wrong token is refused (${wrong.status})`);
  chk(SRV._raidWeekFor(F.wallet) === null, "and neither burnt the victim's week");
  chk((await claim(F)).body.granted === true, "so the real owner can still claim");
}

// ---------------------------------------------------------------------------
sec("no live presence → refused");
{
  const G = await mkWallet();                     // signed in, never entered the world
  const r = await claim(G);
  chk(r.status === 403, `claiming with no world presence is 403 (${r.status})`);
}

// ---------------------------------------------------------------------------
sec("THE DEPLOY CASE: a restart must not hand everyone a fresh claim");
{
  const H = await mkWallet();
  await move(H);
  chk((await claim(H)).body.granted === true, "H claims before the restart");
  const blob = SRV.serializeAssetLedger();
  chk(Array.isArray(blob.raid) && blob.raid.length > 0, `the weekly gate is serialized (${blob.raid.length} rows)`);
  SRV._clearAssetLedger();
  chk(SRV._raidWeekFor(H.wallet) === null, "after a clear the gate is empty");
  SRV.restoreAssetLedger(blob);
  chk(SRV._raidWeekFor(H.wallet) !== null, "restore brings the week back");
  chk((await claim(H)).body.granted === false, "so H is STILL refused after a restart — no free re-claim");
}

// ---------------------------------------------------------------------------
sec("a corrupt persisted gate cannot poison or crash the restore");
{
  // NOTE the `w: []` — restoreAssetLedger early-returns unless the main ledger array is present, so
  // without it this whole case would pass vacuously without ever reaching the raid loop
  const bad = { w: [], raid: [null, "x", [], ["w"], ["w2", "abc"], ["w3", -5], ["w4", Infinity], ["w5", {}], ["w6", 12]] };
  let threw = false;
  try { SRV.restoreAssetLedger(bad); } catch (e) { threw = true; }
  chk(!threw, "a malformed raid blob does not throw");
  chk(SRV._raidWeekFor("w2") === null && SRV._raidWeekFor("w3") === null && SRV._raidWeekFor("w4") === null,
    "non-numeric, negative and Infinity weeks are all dropped");
  chk(SRV._raidWeekFor("w6") === 12, `a valid row restores (${SRV._raidWeekFor("w6")})`);
}

// ---------------------------------------------------------------------------
sec("an UNLINKED net_id is not granted a server prize — it keeps its own local weekly gate");
{
  // A net_id has no server record to gate against. Answering "granted" here handed every unlinked
  // client an UNLIMITED weekly prize (worse than the client gate this replaced), because the
  // client trusts the server's answer over its own gate.
  const nid = "godot-deadbeef";
  await post("/world/move", { wallet: nid, x: 5, z: 5, dir: 0, handle: "Unlinked" });
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push((await post("/world/raid/claim", { wallet: nid })).body);
  chk(seen.every(r => r.ok === true), "the route still answers ok (never blocks an unlinked player)");
  chk(seen.every(r => r.granted === false), `and never grants (${seen.filter(r => r.granted).length}/6 granted)`);
  chk(seen.every(r => r.unmanaged === true), "it says so explicitly, so the client falls back to its local gate");
  chk(SRV._raidWeekFor(nid) === null, "no week is recorded for a net_id (nothing to keep)");
}

// ---------------------------------------------------------------------------
sec("eviction never hands back a CURRENT-week claim");
{
  // The bound used to drop the oldest rows blindly, so an evicted wallet was granted its prize
  // again in the same week — the eviction itself became the re-claim. Only spent weeks may go.
  SRV._clearRaidClaims();
  const wk = Math.floor(Date.now() / 604800000);
  // fill past the bound: half stale weeks, half current
  for (let i = 0; i < 12000; i++) SRV._setRaidWeekForTest("stale" + i, wk - 5);
  for (let i = 0; i < 9000; i++) SRV._setRaidWeekForTest("cur" + i, wk);
  const before = SRV._raidClaimSize();
  const shed = SRV._evictRaidClaims();
  const after = SRV._raidClaimSize();
  chk(after < before, `eviction shed ${shed} rows (${before} -> ${after})`);
  let curKept = 0;
  for (let i = 0; i < 9000; i++) if (SRV._raidWeekFor("cur" + i) === wk) curKept++;
  chk(curKept === 9000, `every CURRENT-week claim survived eviction (${curKept}/9000)`);
  let staleGone = 0;
  for (let i = 0; i < 12000; i++) if (SRV._raidWeekFor("stale" + i) === null) staleGone++;
  chk(staleGone === shed, `and exactly the spent-week rows were the ones dropped (${staleGone})`);
  SRV._clearRaidClaims();
}

// ---------------------------------------------------------------------------
console.log(`\nRAID_CLAIM_SIM pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
