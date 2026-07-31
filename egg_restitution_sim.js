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
async function mkWallet(firstSeen = Date.UTC(2026, 6, 20)) {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "n" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  // AN ACCOUNT THE SERVER FIRST SAW AFTER THE WIPE CANNOT HAVE BEEN WIPED (2026-07-31).
  // `prog` rides in the client-authored save, so a crafted push on a wallet created seconds ago used
  // to be answered owed:["normal","legendary","meme","mount"] and minted four registry eggs — one a
  // capped Meme edition, one a capped mount. The claim is now gated on players.first_seen, a clock
  // the server writes at /verify. Every wallet here is a GENUINE pre-wipe victim, so it is backdated.
  if (firstSeen) SRV._setWalletFirstSeenForTest(wallet, firstSeen);
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


// THE SEAM. Chain.gd _claim_egg_restitution() reads exactly three things off this response:
// j["granted"], and per entry .kind and .id. Renaming any of them server-side would not fail any
// test — it would just silently stop delivering eggs to players. Pin them.
sec("the response carries exactly the fields the client reads");
{
  const W = await mkWallet();
  await save(W, { eggs: [], units: {}, mounts: [], prog: { eggmake_legendary: 1 } });
  const c = await claim(W);
  chk(Array.isArray(c.body.granted), `"granted" is an array (${typeof c.body.granted})`);
  const g = c.body.granted[0];
  chk(g && typeof g.kind === "string" && g.kind.length > 0, `each entry has a string "kind" (${g?.kind})`);
  chk(g && typeof g.id === "string" && g.id.length > 0, `each entry has a string "id" (${String(g?.id).slice(0, 12)}…)`);
  // the kind must be one the client can label and nest — an unknown string would toast "Egg" and
  // put an unrecognised egg in the nest
  chk(["normal", "legendary", "meme", "mount"].includes(g.kind), `and the kind is one the client knows (${g.kind})`);
  // the empty case must still be an array, or `got.is_empty()` in GDScript would error on null
  const empty = await claim(await (async () => { const X = await mkWallet(); await save(X, { eggs: [], units: {}, mounts: [], prog: {} }); return X; })());
  chk(Array.isArray(empty.body.granted), `"granted" is an array even when nothing is owed (${JSON.stringify(empty.body.granted)})`);
}


sec("the counter-less STARTER egg is covered too");
{
  const W = await mkWallet();
  // onboarded, nest empty, nothing ever hatched, no chikimon — only an emptied nest looks like this
  await save(W, { onboarded: true, eggs: [], units: {}, mounts: [], prog: {} });
  const q = await owedOf(W);
  chk(q.body.owed.length === 1 && q.body.owed[0] === "normal",
      `a wiped starter egg is owed back (${JSON.stringify(q.body.owed)})`);
  const c = await claim(W);
  chk(c.body.granted.length === 1 && c.body.granted[0].kind === "normal",
      `and granted (${c.body.granted[0]?.kind})`);

  // CONTROLS — each of the four conditions alone must stop it being owed
  const still = await mkWallet();
  await save(still, { onboarded: true, eggs: [{ kind: "normal", started: 1 }], units: {}, mounts: [], prog: {} });
  chk((await claim(still)).body.granted.length === 0, `someone still holding their starter gets nothing`);

  const hatchedIt = await mkWallet();
  await save(hatchedIt, { onboarded: true, eggs: [], units: { u1: { species: "firix", kind: "normal", level: 3 } },
                          mounts: [], prog: { hatch_normal: 1 } });
  chk((await claim(hatchedIt)).body.granted.length === 0, `someone who hatched theirs gets nothing`);

  const fresh = await mkWallet();
  await save(fresh, { onboarded: false, eggs: [], units: {}, mounts: [], prog: {} });
  chk((await claim(fresh)).body.granted.length === 0, `someone who never onboarded gets nothing`);

  const veteran = await mkWallet();
  await save(veteran, { onboarded: true, eggs: [], units: {}, mounts: [], prog: { eggmake_meme: 1, hatch_meme: 1 } });
  const v = await claim(veteran);
  chk(!v.body.granted.some(g => g.kind === "normal"),
      `a veteran who has hatched before is not handed a second starter (${JSON.stringify(v.body.granted.map(g=>g.kind))})`);
}

sec("a wallet the server first saw AFTER the wipe is refused — the counters are client-authored");
{
  const N = await mkWallet(0);                       // no backdate: first_seen is right now
  await save(N, { onboarded: true, eggs: [], units: {}, mounts: [],
                  prog: { eggmake_normal: 9, eggmake_legendary: 9, eggmake_meme: 9, eggmake_mount: 9 } });
  const q = await owedOf(N);
  chk(Array.isArray(q.body.owed) && q.body.owed.length === 0, `it is not even shown a debt (${JSON.stringify(q.body.owed)})`);
  const c = await claim(N);
  chk(c.status === 403, `the claim is refused (${c.status} ${JSON.stringify(c.body.error || "").slice(0, 80)})`);
  const held = await mine(N);
  chk((held.eggs || []).length === 0, `and nothing was minted to it (${(held.eggs || []).length})`);
}

console.log(`\nEGGRESTITUTION_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
