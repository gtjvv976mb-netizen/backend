// egg_restitution_sim.js — returning the v8 eggs mints real assets, so every property that keeps
// this from becoming a faucet is asserted here, with the actual value printed.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39287";
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
  return { wallet, authMsg, authSig, sid: netId, mktToken: v.body.mktToken };
}
const save = async (w, mmo) => { await wait(700); return post("/profile", { wallet: w.wallet, authMsg: w.authMsg, authSig: w.authSig, profile: { mmo } }); };
const owedOf = (w) => get(`/assets/egg/restitution?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`);
const claim = (w) => post("/assets/egg/restitution", { wallet: w.wallet, mktToken: w.mktToken });
const mine = async (w) => (await get(`/assets/mine?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`)).body;

sec("a player who conjured a legendary egg and never hatched it gets exactly that egg back");
{
  const W = await mkWallet();
  // the wipe cleared d["eggs"] but NOT d["prog"] — this is the surviving evidence
  await save(W, { eggs: [], units: {}, mounts: [], prog: { eggmake_legendary: 1, eggmake: 1 } });
  const q = await owedOf(W);
  chk(q.body.owed.length === 1 && q.body.owed[0] === "legendary", `owed exactly one legendary (${JSON.stringify(q.body.owed)})`);
  const c = await claim(W);
  chk(c.status === 200 && c.body.granted.length === 1, `the claim granted it (${c.body.granted?.length})`);
  chk(c.body.granted[0].kind === "legendary", `of the right kind (${c.body.granted[0].kind})`);
  const held = await mine(W);
  chk(held.eggs.length === 1 && held.eggs[0].origin === "restitution",
      `it is a REGISTRY egg with restitution provenance (${held.eggs[0]?.origin})`);
  chk(held.eggs[0].readyAt - held.eggs[0].born === 12 * 3600 * 1000,
      `on a proper 12h legendary clock (${(held.eggs[0].readyAt - held.eggs[0].born) / 3600000}h)`);
}

sec("it cannot be claimed twice — not by retrying, not across a restart");
{
  const W = await mkWallet();
  await save(W, { eggs: [], units: {}, mounts: [], prog: { eggmake_mount: 1 } });
  const first = await claim(W);
  chk(first.body.granted.length === 1, `first claim pays (${first.body.granted.length})`);
  const second = await claim(W);
  chk(second.status === 409, `an immediate retry is refused (${second.status})`);
  chk((await mine(W)).eggs.length === 1, `and only one egg exists (${(await mine(W)).eggs.length})`);
  // a deploy must not re-open the claim for everyone who already took it
  const blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
  SRV._clearAssetReg();
  SRV.restoreAssetReg(blob);
  const afterRestart = await claim(W);
  chk(afterRestart.status === 409, `and it is still refused after a full restart (${afterRestart.status})`);
}

sec("it is a make-good, not a faucet");
{
  const A = await mkWallet();
  await save(A, { eggs: [], units: {}, mounts: [], prog: {} });
  const none = await claim(A);
  chk(none.body.granted.length === 0, `a wallet that never made an egg gets nothing (${none.body.granted.length})`);

  const Bw = await mkWallet();
  // made one, HATCHED it — nothing was lost
  await save(Bw, { eggs: [], units: { u1: { species: "galador", kind: "legendary", level: 1 } }, mounts: [],
                   prog: { eggmake_legendary: 1, hatch_legendary: 1 } });
  const hatched = await claim(Bw);
  chk(hatched.body.granted.length === 0, `an egg that was hatched is not owed (${hatched.body.granted.length})`);

  const C = await mkWallet();
  // made one and STILL HOLDS it — nothing was lost
  await save(C, { eggs: [{ kind: "meme", started: 1 }], units: {}, mounts: [], prog: { eggmake_meme: 1 } });
  const stillHas = await claim(C);
  chk(stillHas.body.granted.length === 0, `an egg still in the nest is not owed (${stillHas.body.granted.length})`);

  const D = await mkWallet();
  // an INFLATED counter must not buy a stack — the client nests one per kind, so one is the ceiling
  await save(D, { eggs: [], units: {}, mounts: [], prog: { eggmake_legendary: 50, eggmake_meme: 50 } });
  const capped = await claim(D);
  chk(capped.body.granted.length === 2, `a claimed 100 eggs pays at most one per kind (${capped.body.granted.length})`);
  chk(new Set(capped.body.granted.map(g => g.kind)).size === 2, `one legendary, one meme (${capped.body.granted.map(g => g.kind).join(",")})`);
}

sec("the counters come from the STORED save, never from the request");
{
  const W = await mkWallet();
  await save(W, { eggs: [], units: {}, mounts: [], prog: {} });
  const spoof = await post("/assets/egg/restitution", { wallet: W.wallet, mktToken: W.mktToken,
    prog: { eggmake_legendary: 4 }, owed: ["legendary", "meme", "mount", "normal"], granted: 4 });
  chk(spoof.body.granted.length === 0, `a request body claiming to be owed four gets nothing (${spoof.body.granted.length})`);
}

sec("only the proven owner can see or claim");
{
  const W = await mkWallet();
  await save(W, { eggs: [], units: {}, mounts: [], prog: { eggmake_normal: 1 } });
  const bare = await post("/assets/egg/restitution", { wallet: W.wallet });
  chk(bare.status === 403, `a bare wallet address cannot claim (${bare.status})`);
  const peek = await get(`/assets/egg/restitution?wallet=${W.wallet}`);
  chk(peek.status === 403, `nor read what someone else is owed (${peek.status})`);
  // CONTROL: the owner themself can
  const own = await owedOf(W);
  chk(own.status === 200 && own.body.owed.length === 1, `(control) the owner sees their own (${own.body.owed?.length})`);
}

sec("the window is real and it closes");
{
  const W = await mkWallet();
  await save(W, { eggs: [], units: {}, mounts: [], prog: { eggmake_normal: 1 } });
  const open = await owedOf(W);
  chk(open.body.open === true, `the window is open today`);
  chk(open.body.closesAt === Date.UTC(2026, 7, 4), `and closes 2026-08-04 — 7 days (${new Date(open.body.closesAt).toISOString().slice(0, 10)})`);
}

console.log(`\nEGGRESTITUTION_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
