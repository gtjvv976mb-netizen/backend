// egg_hatch_authority_sim.js — Step 4 of server authority: the SERVER rolls what a registered egg
// becomes, and the client (Chain.hatch_registered) depends on this exact contract:
//   - POST /assets/egg/hatch returns { hatched: { sp } } with sp a valid species of the egg's pool
//   - the species is the SERVER's weighted roll, respecting dedup (owning 5/6 forces the 6th)
//   - a repeat hatch of the same egg is 409  -> client falls back to a harmless local roll
//   - a hatch before the server's clock is 425 -> client falls back to a local roll
//   - an unknown/unowned egg id is 404          -> client falls back to a local roll
//   - the egg is CONSUMED exactly once, and a registry creature row is minted
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39291";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
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
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const claim = (w, kind) => post("/assets/egg/claim", { wallet: w.wallet, mktToken: w.mktToken, kind });
const hatch = (w, id) => post("/assets/egg/hatch", { wallet: w.wallet, mktToken: w.mktToken, id });
const mine = (w) => get(`/assets/mine?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`);
const MOUNTS = ["chicken", "boar", "gator", "horse", "wolf", "griffin"];

// ---------------------------------------------------------------------------
sec("a registered mount egg is rolled and consumed by the server");
{
  const A = await mkWallet();
  const ce = await claim(A, "mount");
  chk(ce.status === 200 && ce.body.egg?.id, `mount egg claimed (${ce.body.egg?.id?.slice(0, 10)}…)`);
  const early = await hatch(A, ce.body.egg.id);
  chk(early.status === 425, `hatching before the server clock is 425 — client falls back to local (${early.status})`);

  SRV._ageAsset(ce.body.egg.id, 7 * HOUR);   // mount egg = 6h
  const h = await hatch(A, ce.body.egg.id);
  chk(h.status === 200, `after the clock the hatch is 200 (${h.status})`);
  chk(h.body.hatched && typeof h.body.hatched.sp === "string", `the response carries hatched.sp — the field the client reads`);
  chk(MOUNTS.includes(h.body.hatched.sp), `and it is a valid mount species: ${h.body.hatched.sp}`);

  const rows = (await mine(A)).body.mounts || [];
  chk(rows.length === 1 && rows[0].sp === h.body.hatched.sp, `a registry mount row was minted matching the roll (${rows.map(m => m.sp)})`);

  const again = await hatch(A, ce.body.egg.id);
  chk(again.status === 409, `hatching the SAME egg again is 409 — client falls back, no double creature (${again.status})`);
}

// ---------------------------------------------------------------------------
sec("a normal egg rolls a normal-pool species");
{
  const C = await mkWallet();
  const ce = await claim(C, "normal");
  SRV._ageAsset(ce.body.egg.id, 4 * HOUR);   // normal = 3h
  const h = await hatch(C, ce.body.egg.id);
  chk(h.status === 200 && h.body.hatched?.type === "chikimon", `a normal egg hatches a chikimon (${h.body.hatched?.type})`);
  chk(typeof h.body.hatched.sp === "string" && h.body.hatched.sp.length > 0, `with a species: ${h.body.hatched.sp}`);
  const roster = (await mine(C)).body.chikimon || [];
  chk(roster.length === 1 && roster[0].sp === h.body.hatched.sp, `and a registry chikimon row matching it (${roster.map(m => m.sp)})`);
}

// ---------------------------------------------------------------------------
sec("the roll respects dedup — owning 5 of 6 mounts forces the 6th");
{
  const D = await mkWallet();
  // hatch five mount eggs; each dedups against what D already owns, so after five, one species remains
  const owned = new Set();
  for (let i = 0; i < 5; i++) {
    await wait(5100);                                  // EGG_CLAIM_MIN_MS between claims
    const ce = await claim(D, "mount");
    SRV._ageAsset(ce.body.egg.id, 7 * HOUR);
    const h = await hatch(D, ce.body.egg.id);
    if (h.status === 200) owned.add(h.body.hatched.sp);
  }
  chk(owned.size === 5, `five distinct mounts hatched (${[...owned].join(",")})`);
  await wait(5100);
  const ce6 = await claim(D, "mount");
  SRV._ageAsset(ce6.body.egg.id, 7 * HOUR);
  const h6 = await hatch(D, ce6.body.egg.id);
  const remaining = MOUNTS.filter(m => !owned.has(m));
  chk(h6.status === 200 && h6.body.hatched.sp === remaining[0], `the 6th egg is forced to the only species left: ${h6.body.hatched?.sp} (expected ${remaining[0]})`);
  await wait(5100);
  const ce7 = await claim(D, "mount");
  SRV._ageAsset(ce7.body.egg.id, 7 * HOUR);
  const h7 = await hatch(D, ce7.body.egg.id);
  chk(h7.status === 409, `a 7th mount hatch with a full stable is 409, egg NOT consumed — client shows "stable full" (${h7.status})`);
  const still = await mine(D);
  chk((still.body.eggs || []).some(e => e.id === ce7.body.egg.id && e.state === "active"), `and that egg is still active (unspent)`);
}

// ---------------------------------------------------------------------------
sec("an unknown egg id is 404 — the client falls back to a local roll");
{
  const E = await mkWallet();
  const bad = await hatch(E, "e000000000notarealegg");
  chk(bad.status === 404, `an id this wallet never owned is 404 (${bad.status})`);
}

// ---------------------------------------------------------------------------
console.log(`\nEGG_HATCH_AUTHORITY_SIM pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
