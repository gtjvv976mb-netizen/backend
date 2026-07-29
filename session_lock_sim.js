// session_lock_sim.js — ONE LIVE SESSION PER WALLET.
// Cloud saves resolve newest-saved_at wholesale with no field merge, so two devices on one wallet
// meant the loser's entire session was silently discarded. A sign-in now mints a session id; an
// older session is refused on its next save (409 superseded) and stops, instead of playing on into
// saves that can never land.
//
// The safety questions this must answer, not just the happy path:
//   - does a takeover ever LOCK A PLAYER OUT of their own wallet? (it must not — newest always wins)
//   - does an OLDER CLIENT that sends no session id still work? (it must — deploy order is free)
//   - is the loser's already-saved progress preserved, and the winner's save untouched?
//   - can a refused session recover simply by signing in again?
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39301";
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

// one wallet, signed in from as many "devices" as we like
function mkKeys() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  return { kp, wallet };
}
async function signIn(k) {
  const authMsg = `Chikoria sign-in\nwallet:${k.wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), k.kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet: k.wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg, authSig });
  return { authMsg, authSig, sessionId: v.body.sessionId, mktToken: v.body.mktToken };
}
const save = (k, s, mmo, opts = {}) => wait(700).then(() => post("/profile", {
  wallet: k.wallet, authMsg: s.authMsg, authSig: s.authSig, profile: { mmo },
  ...("sessionId" in opts ? { sessionId: opts.sessionId } : { sessionId: s.sessionId }),
}));
// GET /profile answers {wallet, profile}, and strips mmo unless ownership is proven
const readMmo = async (k, s) => (await get(`/profile?wallet=${k.wallet}&authMsg=${encodeURIComponent(s.authMsg)}&authSig=${encodeURIComponent(s.authSig)}`)).body?.profile?.mmo;

// ---------------------------------------------------------------------------
sec("a sign-in mints a session id, and a single device saves normally");
{
  const k = mkKeys();
  const A = await signIn(k);
  chk(typeof A.sessionId === "string" && A.sessionId.length >= 16, `/verify returns a session id (${(A.sessionId || "").slice(0, 10)}…)`);
  const r = await save(k, A, { onboarded: true, chiki: 10, saved_at: 1 });
  chk(r.status === 200 && r.body.ok, `the only device saves fine (${r.status})`);
  chk(SRV._liveSessionFor(k.wallet)?.sid === A.sessionId, "and it holds the live session");
}

// ---------------------------------------------------------------------------
sec("THE FIX: a second device takes over, and the FIRST is refused before it can clobber");
{
  const k = mkKeys();
  const A = await signIn(k);
  await save(k, A, { onboarded: true, chiki: 100, note: "deviceA", saved_at: 1 });

  const Bdev = await signIn(k);                       // same wallet, second device
  chk(Bdev.sessionId !== A.sessionId, "the second sign-in mints a DIFFERENT session id");
  chk(SRV._liveSessionFor(k.wallet)?.sid === Bdev.sessionId, "the newest sign-in becomes the live session");

  const bSave = await save(k, Bdev, { onboarded: true, chiki: 500, note: "deviceB", saved_at: 2 });
  chk(bSave.status === 200, `the new device saves normally (${bSave.status})`);

  const aSave = await save(k, A, { onboarded: true, chiki: 999999, note: "deviceA-stale", saved_at: 3 });
  chk(aSave.status === 409 && aSave.body.superseded === true,
    `the older device is refused with superseded (${aSave.status} ${JSON.stringify(aSave.body.superseded)})`);

  const stored = await readMmo(k, Bdev);
  chk(stored && stored.note === "deviceB", `and the live device's save is INTACT — the stale one could not clobber it (note=${stored && stored.note})`);
  chk(stored && stored.chiki === 500, `with its own values, not the stale device's (chiki=${stored && stored.chiki})`);
}

// ---------------------------------------------------------------------------
sec("NOBODY IS LOCKED OUT: the refused device recovers by signing in again");
{
  const k = mkKeys();
  const A = await signIn(k);
  await save(k, A, { onboarded: true, chiki: 1, saved_at: 1 });
  const Bdev = await signIn(k);
  await save(k, Bdev, { onboarded: true, chiki: 2, saved_at: 2 });
  const refused = await save(k, A, { onboarded: true, chiki: 3, saved_at: 3 });
  chk(refused.status === 409, `device A is refused while B holds the session (${refused.status})`);

  const A2 = await signIn(k);                          // A simply signs in again (a reload)
  const back = await save(k, A2, { onboarded: true, chiki: 4, saved_at: 4 });
  chk(back.status === 200, `after signing in again it saves normally (${back.status}) — takeover, never lockout`);
  const nowB = await save(k, Bdev, { onboarded: true, chiki: 5, saved_at: 5 });
  chk(nowB.status === 409, `and now the OTHER one is the stale session (${nowB.status}) — the newest always wins`);
}

// ---------------------------------------------------------------------------
sec("BACK-COMPAT: a client that sends no session id is unaffected");
{
  const k = mkKeys();
  const A = await signIn(k);
  await save(k, A, { onboarded: true, chiki: 10, saved_at: 1 });
  const Bdev = await signIn(k);                        // someone else takes the session
  const old = await save(k, A, { onboarded: true, chiki: 20, saved_at: 2 }, { sessionId: undefined });
  chk(old.status === 200, `an older client sending NO session id still saves (${old.status})`);
  const blank = await save(k, A, { onboarded: true, chiki: 30, saved_at: 3 }, { sessionId: "" });
  chk(blank.status === 200, `an empty session id is treated as an older client too (${blank.status})`);
  chk(SRV._liveSessionFor(k.wallet)?.sid === Bdev.sessionId, "and the live session is unchanged by those writes");
}

// ---------------------------------------------------------------------------
sec("a forgotten session (redeploy) fails OPEN, never closed");
{
  const k = mkKeys();
  const A = await signIn(k);
  await save(k, A, { onboarded: true, chiki: 7, saved_at: 1 });
  SRV._clearSessions();                                // simulate a redeploy losing in-memory state
  chk(SRV._liveSessionFor(k.wallet) === null, "after a restart no session is remembered");
  const r = await save(k, A, { onboarded: true, chiki: 8, saved_at: 2 });
  chk(r.status === 200, `the player keeps saving — a forgotten session never locks anyone out (${r.status})`);
}

// ---------------------------------------------------------------------------
sec("the lock applies to MMO saves only, and a wrong session cannot grief a stranger");
{
  const k = mkKeys();
  const A = await signIn(k);
  await save(k, A, { onboarded: true, chiki: 1, saved_at: 1 });
  await signIn(k);                                     // take the session away from A
  // a legacy (non-mmo) write is not gated by the session lock
  const legacy = await post("/profile", { wallet: k.wallet, authMsg: A.authMsg, authSig: A.authSig,
                                          profile: { glory: 5 }, sessionId: A.sessionId });
  chk(legacy.status !== 409, `a non-mmo write is not blocked by the session lock (${legacy.status})`);
  // and a stranger cannot claim someone's session: the save still needs their signature
  const k2 = mkKeys();
  const evil = await post("/profile", { wallet: k.wallet, profile: { mmo: { onboarded: true } },
                                        sessionId: A.sessionId });
  chk(evil.status === 401, `an unsigned save is still refused for signature, not session (${evil.status})`);
}

// ---------------------------------------------------------------------------
console.log(`\nSESSION_LOCK_SIM pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
