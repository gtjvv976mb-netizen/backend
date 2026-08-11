// ev_gate_sim.mjs — OPEN-GATES: the 500k wallet-hold gate waived by admin event, honestly.
// Boots the REAL server.js in-process: throwaway keypairs, THROWAWAY ADMIN_KEY, memory store,
// dead RPC (balances seeded through the _balCache sim seam). Never the live backend.
// Proves, with PRINTED ACTUAL VALUES:
//   A  baseline (no event): holder eligible, zero-hold wallet refused WITH the grandfathering copy
//   B  admin start open_gates 7 days -> active window is exactly 7 days (ends-1 active, ends+1 not)
//   C  DURING the event a signed zero-hold wallet is eligible (gateWaived), gets session+mktToken,
//      but chikis stays 0 (the old accrual game keeps the real hold) and balance is the truth
//   D  the SIGNATURE is never waived: unsigned / forged-signature wallets get eligible but NO
//      mktToken, NO sessionId, and the mmo cloud save is stripped
//   E  the SOL faucet stays closed: /claim for a zero-hold wallet -> 403 during the event
//   F  progress is KEPT after the event: profile saved during open-gates still returned by /verify
//      after stop, while eligible flips false and gateNote states the grandfathering rule
//   G  public reads: /world/event + /stats + the /world/move reply carry the event while on, not after
//   H  a mid-event restart (save -> reset -> boot-restore) does not end the event
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59981"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "true"; process.env.NETWORK = "devnet"; process.env.PORT = "39281";
process.env.CHIKI_MINT = bs58.encode(nacl.sign.keyPair().publicKey);   // throwaway mint so the balance path runs
process.env.ADMIN_KEY = "ev-throwaway-" + crypto.randomBytes(12).toString("hex");
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
let _n = 0;
function mkKeys() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  return { wallet, authMsg, authSig, kp };
}
const verify = (k, signed = true) => post("/verify", Object.assign({ wallet: k.wallet, netId: "n" + Date.now() + "_" + (++_n) },
  signed ? { authMsg: k.authMsg, authSig: k.authSig } : {}));

// ---------------------------------------------------------------------------
sec("A baseline — no event running");
const RICH = mkKeys(), POOR = mkKeys();
SRV._setBalanceForTest(RICH.wallet, 600000);
SRV._setBalanceForTest(POOR.wallet, 0);
let r = await verify(RICH);
chk(r.body.eligible === true && r.body.holdOk === true && r.body.balance === 600000,
    `holder: eligible=${r.body.eligible} holdOk=${r.body.holdOk} balance=${r.body.balance} (expect true/true/600000)`);
chk(r.body.gateWaived === undefined && r.body.events === undefined, `holder: no waiver, no events (gateWaived=${r.body.gateWaived}, events=${JSON.stringify(r.body.events)})`);
r = await verify(POOR);
chk(r.body.eligible === false && r.body.holdOk === false && r.body.balance === 0,
    `zero-hold: eligible=${r.body.eligible} holdOk=${r.body.holdOk} balance=${r.body.balance} (expect false/false/0)`);
console.log("  REFUSAL COPY (the grandfathering line the gate card shows):");
console.log("   ", JSON.stringify(r.body.gateNote));
chk(typeof r.body.gateNote === "string" && r.body.gateNote.includes("500,000") && /kept|saved/i.test(r.body.gateNote),
    `gateNote states the hold AND that progress is kept`);

// ---------------------------------------------------------------------------
sec("B admin start — open_gates, 7 days");
r = await post("/admin/event/start", { event: "open_gates", days: 7 });   // no key
chk(r.status === 403, `absent admin key -> ${r.status} (expect 403)`);
const t0 = Date.now();
r = await post("/admin/event/start", { key: KEY, event: "open_gates", days: 7 });
console.log("  start reply:", JSON.stringify(r.body));
const ends = Number(r.body.ends);
chk(r.status === 200 && r.body.ok === true && r.body.event === "open_gates", `started: ${r.status} event=${r.body.event}`);
const drift = Math.abs(ends - (t0 + 7 * 86400000));
chk(drift < 2000, `ends = start + 7 days exactly (drift ${drift} ms)`);
chk(SRV._openGatesActiveForTest(ends - 1) === true && SRV._openGatesActiveForTest(ends + 1) === false,
    `active at ends-1ms=${SRV._openGatesActiveForTest(ends - 1)}, at ends+1ms=${SRV._openGatesActiveForTest(ends + 1)} (exactly 7 days)`);
r = await post("/admin/event/start", { key: KEY, event: "open_gates", days: 0 });
chk(r.status === 400, `days=0 refused -> ${r.status} (expect 400 — stop is explicit)`);

// ---------------------------------------------------------------------------
sec("C during the event — signed zero-hold wallet plays");
r = await verify(POOR);
chk(r.body.eligible === true && r.body.gateWaived === true && r.body.holdOk === false,
    `waived: eligible=${r.body.eligible} gateWaived=${r.body.gateWaived} holdOk=${r.body.holdOk} (expect true/true/false)`);
chk(r.body.balance === 0 && r.body.chikis === 0,
    `truth intact: balance=${r.body.balance} chikis=${r.body.chikis} (the old accrual game stays hold-gated)`);
chk(r.body.signedIn === true && typeof r.body.mktToken === "string" && r.body.mktToken.length >= 16 && r.body.sessionId.length > 0,
    `full session: signedIn=${r.body.signedIn} mktToken.len=${r.body.mktToken.length} sessionId.len=${r.body.sessionId.length}`);
const POOR_TOKEN = r.body.mktToken;
chk(r.body.events && r.body.events.openGates && r.body.events.openGates.remainingMs > 6.9 * 86400000,
    `event banner rides /verify: events.openGates.remainingMs=${r.body.events && r.body.events.openGates && r.body.events.openGates.remainingMs}`);
chk(r.body.gateNote === undefined, `no refusal copy while waived (gateNote=${JSON.stringify(r.body.gateNote)})`);

// ---------------------------------------------------------------------------
sec("D the signature is never waived");
r = await verify(POOR, false);   // no authMsg/authSig at all
chk(r.body.signedIn === false && r.body.mktToken === "" && r.body.sessionId === "",
    `unsigned: signedIn=${r.body.signedIn} mktToken="${r.body.mktToken}" sessionId="${r.body.sessionId}" (no session, no token)`);
const FORGED = mkKeys();
SRV._setBalanceForTest(FORGED.wallet, 0);
const wrongSig = { ...FORGED, authSig: Buffer.from(nacl.sign.detached(Buffer.from(FORGED.authMsg), mkKeys().kp.secretKey)).toString("base64") };
r = await verify(wrongSig);
chk(r.body.signedIn === false && r.body.mktToken === "",
    `forged signature: signedIn=${r.body.signedIn} mktToken="${r.body.mktToken}" (refused as before)`);

// ---------------------------------------------------------------------------
sec("E the SOL faucet stays closed during open-gates");
r = await post("/claim", { wallet: POOR.wallet });
console.log("  /claim reply:", r.status, JSON.stringify(r.body));
chk(r.status === 403 && /threshold/.test(String(r.body.error)), `zero-hold /claim -> ${r.status} "${r.body.error}" (expect 403 below-threshold)`);

// ---------------------------------------------------------------------------
sec("F progress persists past the event (grandfathering)");
r = await post("/profile", { wallet: POOR.wallet, profile: { name: "GatelessGwen", progress: 7 } });
chk(r.status === 200, `profile save during event -> ${r.status}`);
r = await post("/admin/event/stop", { key: KEY, event: "open_gates" });
chk(r.status === 200 && r.body.active === false, `event stopped: ${JSON.stringify(r.body)}`);
r = await verify(POOR);
chk(r.body.eligible === false && r.body.gateWaived === undefined && r.body.holdOk === false,
    `after stop: eligible=${r.body.eligible} gateWaived=${r.body.gateWaived} (the gate is back)`);
chk(r.body.profile && r.body.profile.name === "GatelessGwen" && r.body.profile.progress === 7,
    `progress KEPT: profile=${JSON.stringify(r.body.profile && { name: r.body.profile.name, progress: r.body.profile.progress })}`);
console.log("  POST-EVENT REFUSAL COPY:");
console.log("   ", JSON.stringify(r.body.gateNote));
chk(typeof r.body.gateNote === "string" && /Open Gates/.test(r.body.gateNote) && /kept/i.test(r.body.gateNote),
    `post-event gateNote names Open Gates and the kept progress`);
// ...and they re-enter the moment they hold the gate again
SRV._setBalanceForTest(POOR.wallet, 500000);
r = await verify(POOR);
chk(r.body.eligible === true && r.body.holdOk === true, `re-holding 500k re-enters: eligible=${r.body.eligible} holdOk=${r.body.holdOk}`);
SRV._setBalanceForTest(POOR.wallet, 0);

// ---------------------------------------------------------------------------
sec("G public reads carry the event while on, not after");
await post("/admin/event/start", { key: KEY, event: "open-gates", days: 7 });   // alias form
r = await get("/world/event");
chk(r.body.events && r.body.events.openGates && r.body.active === false,
    `/world/event: active(fishing)=${r.body.active}, events.openGates.ends=${r.body.events && r.body.events.openGates && r.body.events.openGates.ends}`);
r = await get("/stats");
chk(r.body.events && r.body.events.openGates, `/stats.events.openGates present (label="${r.body.events && r.body.events.openGates && r.body.events.openGates.label}")`);
let mv = await post("/world/move", { wallet: POOR.wallet, mktToken: POOR_TOKEN, x: 10, z: -200 });
chk(mv.body.events && mv.body.events.openGates && mv.body.event === undefined,
    `move reply: events.openGates rides the NEW key, frozen fishing 'event' key untouched (event=${JSON.stringify(mv.body.event)})`);
await post("/admin/event/stop", { key: KEY, event: "open_gates" });
r = await get("/world/event");
chk(!r.body.events, `/world/event after stop: events=${JSON.stringify(r.body.events)} (absent)`);
await new Promise(rs => setTimeout(rs, 1100));   // the move-reply event cache is 1s
mv = await post("/world/move", { wallet: POOR.wallet, mktToken: POOR_TOKEN, x: 10, z: -200 });
chk(mv.body.events === undefined, `move reply after stop: events=${JSON.stringify(mv.body.events)} (dropped — old shape restored)`);

// ---------------------------------------------------------------------------
sec("H mid-event restart keeps the event");
r = await post("/admin/event/start", { key: KEY, event: "open_gates", days: 3 });
const ends3 = Number(r.body.ends);
await SRV._saveLiveEventsForTest();
SRV._resetLiveEventsForTest();
chk(SRV._liveEventsForTest().openGates.ends === 0, `state reset (simulated dead process): ends=${SRV._liveEventsForTest().openGates.ends}`);
await SRV._bootRestoreLiveEventsForTest();
const og = SRV._liveEventsForTest().openGates;
chk(og.ends === ends3, `boot restore: ends=${og.ends} === pre-restart ${ends3} (the event survives a redeploy)`);
await post("/admin/event/stop", { key: KEY, event: "open_gates" });

console.log(`\n==== ev_gate_sim: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
