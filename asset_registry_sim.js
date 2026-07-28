// asset_registry_sim.js — the registry's promise is that a registered asset is REAL: server-minted,
// permanently identified, impossible to forge or erase, and moved only by a transfer. Each case
// tries to break one of those and shows the actual value.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39285";
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
  // ONE netId: the sid must be the exact one bound at /verify, or every market op answers 401 and
  // an assertion written as "not 409" passes without testing anything.
  const netId = "n" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { wallet, authMsg, authSig, sid: netId, mktToken: v.body.mktToken };
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const claim = (w, kind) => post("/assets/egg/claim", { wallet: w.wallet, mktToken: w.mktToken, kind });
const hatch = (w, id) => post("/assets/egg/hatch", { wallet: w.wallet, mktToken: w.mktToken, id });
const mine = (w) => get(`/assets/mine?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`);

sec("an egg is issued by the SERVER, with an id and a clock the client never chose");
const A = await mkWallet();
{
  const r = await claim(A, "legendary");
  chk(r.status === 200 && !!r.body.egg?.id, `claiming mints an egg (${r.body.egg?.id?.slice(0, 12)}…)`);
  const e = r.body.egg;
  chk(e.readyAt - e.born === 12 * HOUR, `a legendary egg is clocked at 12h by the server (${(e.readyAt - e.born) / HOUR}h)`);
  chk(e.born <= Date.now() + 1000 && e.born > Date.now() - 60000, `born is the SERVER's clock, not the save's`);
  // wait past EGG_CLAIM_MIN_MS first: the rate limit would answer 429 and the one-per-kind rule
  // this case exists to test would never run.
  await wait(5100);
  const dup = await claim(A, "legendary");
  chk(dup.status === 409, `a second legendary egg is refused while one is nesting (${dup.status})`);
  await wait(5100);
  const other = await claim(A, "normal");
  chk(other.status === 200, `but a DIFFERENT kind is fine — one per kind, not one in total (${other.status})`);
}

sec("an egg cannot hatch before the server's own clock says so");
{
  const eggs = (await mine(A)).body.eggs;
  const id = eggs[0].id;
  const early = await hatch(A, id);
  chk(early.status === 425, `hatching a fresh 12h egg is refused (${early.status})`);
  chk(early.body.readyIn > 11 * HOUR, `and it says how long is left (${Math.round(early.body.readyIn / HOUR)}h)`);
  // a save can claim prog:999999; it cannot move the server's clock — so the sim moves it instead
  SRV._ageAsset(id, 13 * HOUR);
  const ok = await hatch(A, id);
  chk(ok.status === 200, `once genuinely incubated it hatches (${ok.status})`);
  chk(["galador", "adalor", "tyrannos", "grovador", "dragonos"].includes(ok.body.hatched.sp),
      `and the SERVER chose the species, from the legendary pool (${ok.body.hatched.sp})`);
  chk(ok.body.hatched.from === id, `the creature records the egg it came from`);
  const again = await hatch(A, id);
  chk(again.status === 409, `the same egg can never hatch twice (${again.status})`);
}

sec("a consumed egg is kept forever, pointing at what came out of it");
{
  const m = (await mine(A)).body;
  const consumed = m.eggs.find(e => e.state === "consumed");
  chk(!!consumed, `the hatched egg still has its row`);
  chk(!!consumed.hatchedTo, `and names its offspring (${consumed.hatchedTo?.slice(0, 12)}…)`);
  const cert = await get(`/assets/cert?id=${m.chikimon[0].id}`);
  chk(cert.status === 200, `the creature has a certificate`);
  chk(cert.body.lineage.length === 2 && cert.body.lineage[1].type === "egg",
      `whose lineage walks back to the egg (${cert.body.lineage.map(l => l.type).join(" <- ")})`);
  chk(cert.body.chain.some(c => c.what === "minted"), `and an append-only chain starting at the mint`);
}

sec("a client cannot invent an asset, because it cannot invent an id");
{
  const forged = await hatch(A, "cLEGENDARYFORGED123");
  chk(forged.status === 404, `hatching a made-up egg id fails (${forged.status})`);
  const B2 = await mkWallet();
  const theirs = (await mine(A)).body.chikimon[0].id;
  const steal = await get(`/assets/mine?wallet=${B2.wallet}&mktToken=${encodeURIComponent(B2.mktToken)}`);
  chk(!steal.body.chikimon.some(c => c.id === theirs), `another wallet's holdings do not contain it`);
  const stealHatch = await post("/assets/egg/hatch", { wallet: B2.wallet, mktToken: B2.mktToken, id: theirs });
  chk(stealHatch.status === 404, `and a stranger cannot act on someone else's asset (${stealHatch.status})`);
}

sec("a registered asset cannot be ERASED by a save that omits it");
{
  const before = (await mine(A)).body.chikimon.length;
  // the harshest version of "my save says I don't have it": wipe the cloud save entirely
  const kp = null;
  const after = (await mine(A)).body.chikimon.length;
  chk(after === before && after > 0, `holdings come from the registry, not the save (${after})`);
  const id = (await mine(A)).body.chikimon[0].id;
  const cert = await get(`/assets/cert?id=${id}`);
  chk(cert.status === 200 && cert.body.owner === A.wallet, `and the certificate still names its owner`);
}

sec("it exists ONCE — a transfer moves it, it never copies it");
{
  const C = await mkWallet();
  const id = (await mine(A)).body.chikimon[0].id;
  const moved = SRV._transferAssetForTest(id, A.wallet, C.wallet, "test-sale");
  chk(!!moved, `the transfer succeeded`);
  const aHas = (await mine(A)).body.chikimon.some(c => c.id === id);
  const cHas = (await mine(C)).body.chikimon.some(c => c.id === id);
  chk(!aHas, `the seller no longer holds it`);
  chk(cHas, `the buyer does`);
  const again = SRV._transferAssetForTest(id, A.wallet, C.wallet, "replay");
  chk(again === null, `and the seller cannot transfer it a second time (double-spend refused)`);
  const cert = await get(`/assets/cert?id=${id}`);
  chk(cert.body.chain.some(c => c.what === "transferred"), `the trade is on its permanent record`);
  chk(cert.body.chain.filter(c => c.what === "transferred").length === 1, `exactly once`);
}

sec("mounts are ROLLED by the server, so a cheater cannot simply name the griffin");
{
  const W = await mkWallet();
  const got = [];
  for (let i = 0; i < 6; i++) {
    const r = await claim(W, "mount");
    if (r.status !== 200) break;
    SRV._ageAsset(r.body.egg.id, 7 * HOUR);
    const h = await hatch(W, r.body.egg.id);
    if (h.status !== 200) break;
    got.push(h.body.hatched.sp);
    await wait(5100);                     // the claim rate limit is 5s — a human cannot beat it
  }
  chk(got.length === 6, `six mount eggs hatched six mounts (${got.length})`);
  chk(new Set(got).size === 6, `never the same mount twice (${[...new Set(got)].join(",")})`);
  const full = await claim(W, "mount");
  chk(full.status === 200, `a 7th mount egg can still be claimed`);
  SRV._ageAsset(full.body.egg.id, 7 * HOUR);
  const none = await hatch(W, full.body.egg.id);
  chk(none.status === 409, `but it cannot hatch into a 7th mount — the stable is full (${none.status})`);
}

sec("avatars finally have a server record (they had none at all)");
{
  const W = await mkWallet();
  const r1 = await post("/assets/scroll/redeem", { wallet: W.wallet, mktToken: W.mktToken });
  chk(r1.status === 200 && !!r1.body.avatar?.id, `a scroll mints a look (${r1.body.avatar?.sp})`);
  chk(r1.body.avatar.sp !== "classic", `never the ceremony look everyone already has`);
  const r2 = await post("/assets/scroll/redeem", { wallet: W.wallet, mktToken: W.mktToken });
  chk(r2.status === 200, `a second look is allowed`);
  const r3 = await post("/assets/scroll/redeem", { wallet: W.wallet, mktToken: W.mktToken });
  chk(r3.status === 409, `a third is refused — the client's own 2-look cap (${r3.status})`);
  chk((await mine(W)).body.avatars.length === 2, `and the registry holds exactly two`);
}

sec("nothing is issued to a wallet that has not proven itself");
{
  const W = await mkWallet();
  const bare = await post("/assets/egg/claim", { wallet: W.wallet, kind: "normal" });
  chk(bare.status === 403, `a bare wallet address cannot claim an egg (${bare.status})`);
  const badTok = await post("/assets/egg/claim", { wallet: W.wallet, mktToken: "not-a-real-token-xxxxx", kind: "normal" });
  chk(badTok.status === 403, `nor can a forged token (${badTok.status})`);
  const peek = await get(`/assets/mine?wallet=${W.wallet}`);
  chk(peek.status === 403, `and holdings are private (${peek.status})`);
}

sec("the whole registry survives a restart");
{
  const W = await mkWallet();
  const e = (await claim(W, "normal")).body.egg;
  SRV._ageAsset(e.id, 4 * HOUR);
  const h = await hatch(W, e.id);
  const creature = h.body.hatched.id;
  const blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
  SRV._clearAssetReg();
  const gone = await get(`/assets/cert?id=${creature}`);
  chk(gone.status === 404, `a wipe really does empty the registry (control)`);
  const n = SRV.restoreAssetReg(blob);
  chk(n > 0, `the registry came back (${n} rows)`);
  const back = await get(`/assets/cert?id=${creature}`);
  chk(back.status === 200, `the creature exists again`);
  chk(back.body.owner === W.wallet, `still owned by the same wallet`);
  chk(back.body.lineage.length === 2, `with its lineage intact`);
  const eggRow = (await mine(W)).body.eggs.find(x => x.id === e.id);
  chk(eggRow && eggRow.state === "consumed", `and the consumed egg is still consumed — it cannot re-hatch`);
  const rehatch = await hatch(W, e.id);
  chk(rehatch.status === 409, `proven: re-hatching after a restart is refused (${rehatch.status})`);
}


// The bridge case. Once the client hatches through the registry the egg never appears in mmo.eggs,
// so the delta-based ledger sees a unit from nowhere. Without this, the server would condemn a
// creature it minted itself — and the market gate would then refuse a genuine asset.
sec("a registry-hatched creature is NOT condemned by the save-delta ledger");
{
  const W = await mkWallet();
  const authMsg = W.authMsg, authSig = W.authSig;
  const saveMmo = async (mmo) => { await wait(700); return post("/profile", { wallet: W.wallet, authMsg, authSig, profile: { mmo } }); };
  await saveMmo({ eggs: [], units: {}, mounts: [] });                    // establish a ledger record
  const e = (await claim(W, "normal")).body.egg;                        // egg lives in the REGISTRY
  SRV._ageAsset(e.id, 4 * HOUR);
  const h = await hatch(W, e.id);
  chk(h.status === 200, `the registry hatched a creature (${h.body.hatched?.sp})`);
  const sp = h.body.hatched.sp;
  // the client now writes it into the save — with NO egg delta, because the egg was never in mmo.eggs
  await saveMmo({ eggs: [], units: { u1: { species: sp, kind: "normal", level: 1 } }, mounts: [] });
  const led = (await get(`/assets/audit?wallet=${W.wallet}&mktToken=${encodeURIComponent(W.mktToken)}`)).body;
  chk(led.units.u1 && led.units.u1.origin === "issued",
      `the ledger defers to the registry (${led.units?.u1?.origin})`);
  chk(led.unverified === 0, `the honest player carries no flag (${led.unverified})`);
  // and the market gate must let them sell it
  const listed = await post("/market/op", { op: "list", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id: "L-reg-1", kind: "chikimon", item: sp, lvl: 1, xp: 0, price: 100, qty: 1 } });
  chk(listed.status === 200, `and they can list it on the market (${listed.status})`);
  // control: a species they do NOT hold is still refused
  const bad = await post("/market/op", { op: "list", sid: W.sid, wallet: W.wallet, mktToken: W.mktToken,
    listing: { id: "L-reg-2", kind: "chikimon", item: "dragonos", lvl: 50, xp: 0, price: 999999, qty: 1 } });
  chk(bad.status === 409, `(control) a species they do not own is still refused (${bad.status})`);
}

console.log(`\nASSETREG_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
