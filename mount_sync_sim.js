// mount_sync_sim.js — Step 3 of server authority: the registry becomes the CANONICAL stable.
// POST /assets/mounts/sync adopts what the ledger already knows into registry property (carrying
// the ledger's own origin, never laundering), and answers with the wallet's true species list.
//
// The promises under test:
//   1. sync adopts a ledger-known mount into a permanent registry row
//   2. the ledger's verdict rides along — an unverified mount stays unverified, never upgraded
//   3. adoption is idempotent — running it twice does not clone the mount
//   4. a species the ledger has never seen cannot be adopted (the body names nothing)
//   5. only catalog species are adopted — junk in the ledger is ignored
//   6. the answer is the canonical list the client replaces its save with
//   7. a bare wallet with no token is refused (same gate as every /assets route)
//   8. a mount already minted by a hatch is not double-counted
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39288";
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
async function mkWallet(firstSeen) {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "n" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  const w = { wallet, authMsg, authSig, sid: netId, mktToken: v.body.mktToken };
  if (firstSeen) SRV._setWalletFirstSeenForTest(wallet, firstSeen);
  return w;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// a signed save is what feeds auditAssets — the only way a mount enters the LEDGER
const save = (w, mmo) => { return wait(700).then(() => post("/profile", { wallet: w.wallet, authMsg: w.authMsg, authSig: w.authSig, profile: { mmo } })); };
const sync = (w) => post("/assets/mounts/sync", { wallet: w.wallet, mktToken: w.mktToken });
const mine = (w) => get(`/assets/mine?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`);
const claim = (w, kind) => post("/assets/egg/claim", { wallet: w.wallet, mktToken: w.mktToken, kind });
const hatch = (w, id) => post("/assets/egg/hatch", { wallet: w.wallet, mktToken: w.mktToken, id });

// ---------------------------------------------------------------------------
sec("a mount the ledger knows is adopted into permanent registry property");
{
  // a pre-ledger player: their existing stable is grandfathered 'legacy' by the audit
  const A = await mkWallet(Date.UTC(2025, 0, 1));
  await save(A, { onboarded: true, units: { u1: { species: "dragonos", kind: "legendary", level: 20 } }, mounts: ["horse"], eggs: [] });
  const before = (await mine(A)).body.mounts || [];
  chk(before.length === 0, `before sync the registry has no mount rows (${before.length})`);

  const r = await sync(A);
  chk(r.status === 200 && r.body.ok, `sync answers ok (${r.status})`);
  chk(Array.isArray(r.body.adopted) && r.body.adopted.includes("horse"), `it reports adopting the horse (${JSON.stringify(r.body.adopted)})`);
  chk(Array.isArray(r.body.species) && r.body.species.includes("horse"), `and returns it in the canonical species list (${JSON.stringify(r.body.species)})`);

  const after = (await mine(A)).body.mounts || [];
  chk(after.length === 1 && after[0].sp === "horse", `the registry now owns the horse as a real asset (${after.map(m => m.sp)})`);
  chk(after[0].origin === "legacy", `and it carries the ledger's own origin — legacy, not laundered (${after[0].origin})`);
  chk(after[0].id && after[0].id[0] === "m", `with a server-minted mount id (${after[0].id})`);

  sec("running sync again does not clone the mount");
  const r2 = await sync(A);
  chk(r2.body.adopted.length === 0, `the second sync adopts nothing (${JSON.stringify(r2.body.adopted)})`);
  const after2 = (await mine(A)).body.mounts || [];
  chk(after2.length === 1, `still exactly one horse row (${after2.length})`);
  chk(after2[0].id === after[0].id, `and it is the SAME row, not a fresh mint`);
}

// ---------------------------------------------------------------------------
sec("the ledger's verdict rides along — an unverified mount stays unverified");
{
  // fresh wallet (no grandfather): a mount appearing from nowhere is flagged 'unverified' by audit
  const C = await mkWallet();
  await save(C, { onboarded: true, units: {}, mounts: ["wolf"], eggs: [] });   // grandfathered (first mount)
  await save(C, { onboarded: true, units: {}, mounts: ["wolf", "griffin"], eggs: [] });   // 2nd, beyond grandfather -> unverified
  const r = await sync(C);
  const rows = (await mine(C)).body.mounts || [];
  const wolf = rows.find(m => m.sp === "wolf"), grif = rows.find(m => m.sp === "griffin");
  chk(!!wolf && wolf.origin === "legacy", `the grandfathered wolf is adopted as legacy (${wolf && wolf.origin})`);
  chk(!!grif && grif.origin === "unverified", `the conjured griffin is adopted as UNVERIFIED — the flag is preserved (${grif && grif.origin})`);
  // the summary must still count it against the wallet — adoption is not amnesty
  const sum = (await get(`/assets/summary?key=test-admin-key`)).body;
  chk(sum.byOrigin && sum.byOrigin.unverified >= 1, `and the game-wide view still counts an unverified mount (${sum.byOrigin && sum.byOrigin.unverified})`);
}

// ---------------------------------------------------------------------------
sec("the request names no mount — a species the ledger never saw cannot be adopted");
{
  const D = await mkWallet(Date.UTC(2025, 0, 1));
  await save(D, { onboarded: true, units: {}, mounts: ["boar"], eggs: [] });
  // the body carries only wallet + token; there is nowhere to name 'griffin', but prove it anyway:
  // a hand-built body with an extra field changes nothing
  const r = await post("/assets/mounts/sync", { wallet: D.wallet, mktToken: D.mktToken, mounts: ["griffin"], sp: "griffin", species: ["griffin"] });
  chk(r.body.species.includes("boar") && !r.body.species.includes("griffin"),
    `only the ledger-known boar is returned; the injected griffin is ignored (${JSON.stringify(r.body.species)})`);
  const rows = (await mine(D)).body.mounts || [];
  chk(rows.length === 1 && rows[0].sp === "boar", `and only the boar was minted (${rows.map(m => m.sp)})`);
}

// ---------------------------------------------------------------------------
sec("only catalog species are adopted — a junk ledger key is ignored, never minted");
{
  const E = await mkWallet(Date.UTC(2025, 0, 1));
  // a real client can only ever save catalog ids, but the ledger key is clamped attacker text —
  // seed a plausible junk mount alongside a real one and confirm only the real one survives
  await save(E, { onboarded: true, units: {}, mounts: ["gator", "notarealmount", "chicken"], eggs: [] });
  const r = await sync(E);
  chk(r.body.species.includes("gator") && r.body.species.includes("chicken"), `the two catalog mounts are adopted (${JSON.stringify(r.body.species)})`);
  chk(!r.body.species.includes("notarealmount"), `the junk key is not in the canonical list`);
  const rows = (await mine(E)).body.mounts || [];
  chk(rows.every(m => m.sp !== "notarealmount"), `and no junk row was minted (${rows.map(m => m.sp)})`);
}

// ---------------------------------------------------------------------------
sec("a bare wallet with no proven token is refused — same gate as every /assets route");
{
  const F = await mkWallet(Date.UTC(2025, 0, 1));
  await save(F, { onboarded: true, units: {}, mounts: ["horse"], eggs: [] });
  const bad = await post("/assets/mounts/sync", { wallet: F.wallet, mktToken: "" });
  chk(bad.status === 403, `no token → 403 (${bad.status})`);
  const wrong = await post("/assets/mounts/sync", { wallet: F.wallet, mktToken: "0000000000000000wrong" });
  chk(wrong.status === 403, `a wrong token → 403 (${wrong.status})`);
  const rows = (await mine(F)).body.mounts || [];
  chk(rows.length === 0, `and nothing was minted for the unproven caller (${rows.length})`);
}

// ---------------------------------------------------------------------------
sec("a mount already hatched through the registry is not double-counted by sync");
{
  const G = await mkWallet(Date.UTC(2025, 0, 1));
  // claim + age + hatch a mount egg → a registry mount row exists BEFORE any sync
  const ce = await claim(G, "mount");
  chk(ce.status === 200, `mount egg claimed (${ce.status})`);
  SRV._ageAsset(ce.body.egg.id, 7 * HOUR);   // mount egg is 6h
  const h = await hatch(G, ce.body.egg.id);
  chk(h.status === 200 && h.body.hatched?.sp, `it hatches into a registry mount (${h.body.hatched?.sp})`);
  const hatchedSp = h.body.hatched.sp;
  // now the SAVE also reports that mount (the client appended it locally) → ledger sees it too
  await save(G, { onboarded: true, units: {}, mounts: [hatchedSp], eggs: [] });
  const r = await sync(G);
  const rows = (await mine(G)).body.mounts || [];
  const same = rows.filter(m => m.sp === hatchedSp);
  chk(same.length === 1, `the hatched mount exists as exactly ONE row after sync, not two (${same.length})`);
  chk(!r.body.adopted.includes(hatchedSp), `sync does not re-adopt what the registry already owns (${JSON.stringify(r.body.adopted)})`);
  // the canonical list must be unique even if it were ever duplicated
  chk(new Set(r.body.species).size === r.body.species.length, `the species list has no duplicates (${JSON.stringify(r.body.species)})`);
}

// ---------------------------------------------------------------------------
console.log(`\nMOUNT_SYNC_SIM pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
