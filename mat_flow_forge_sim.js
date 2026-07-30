// mat_flow_forge_sim.js — ADVERSARIAL probe of POST /world/mat/flow (server-authority Step 6).
//
// I am the attacker. Every claim below is printed with the ACTUAL observed value, and every
// "this is blocked" has a CONTROL showing the same operation succeeding when it should.
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
//
// Model: mat_flow_sim.js (passes 21/21). This one tries to break what that one asserts.
import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39311";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); let j; try { j = await r.json(); } catch { j = null; } return { status: r.status, body: j }; };
// RAW TEXT post — the only way a "__proto__" key survives to the wire (obj["__proto__"]=v is a setter)
const postRaw = async (p, text) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: text }); let j; try { j = await r.json(); } catch { j = null; } return { status: r.status, body: j }; };
const get = async (p) => { const r = await fetch(B + p); let j; try { j = await r.json(); } catch { j = null; } return { status: r.status, body: j }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

  // PREDATES THE ACQUISITION BOUND, and tests a different layer: these assertions need the listing to
  // reach the board so the observe-only oversold signal can be examined. Turn enforcement off for this
  // run rather than rewrite the assertions to match it — the bound has its own sim.
  SRV._setOwnEnforceForTest(false);

let pass = 0, fail = 0; const holes = [];
const chk = (c, m) => { c ? (pass++, console.log("  ok  :", m)) : (fail++, console.log("  FAIL:", m)); };
const hole = (m) => { holes.push(m); console.log("  HOLE:", m); };
const sec = (s) => console.log(`\n———— ${s} ————`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let _n = 0;
async function mkWallet(handle = "Trainer") {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "n" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { wallet, sid: netId, mktToken: v.body && v.body.mktToken, handle };
}
const move = (w, extra = {}) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, x: 5, z: 5, dir: 0, handle: w.handle, ...extra });
const flow = (w, ev, extra = {}) => post("/world/mat/flow", { wallet: w.wallet, mktToken: w.mktToken, ev, ...extra });
const spent = (w) => (SRV._flowFor(typeof w === "string" ? w : w.wallet).spent) || {};
const gained = (w) => (SRV._flowFor(typeof w === "string" ? w : w.wallet).gained) || {};
const gath = (w) => SRV._gatheredFor(typeof w === "string" ? w : w.wallet) || {};
const summary = async () => (await get(`/assets/summary?key=test-admin-key`)).body;
const listMat = (w, item, qty, id) => post("/market/op", { sid: w.sid, op: "list", wallet: w.wallet, mktToken: w.mktToken,
  listing: { id: id || ("L" + Date.now() + "_" + (++_n)), item, kind: "mat", qty, price: 10, seller: w.handle } });
const oversoldFor = (sum, w, item) => (sum.oversoldMaterials || []).find(o => o.w === w.wallet.slice(0, 8) && o.item === item);

// =========================================================================================
sec("CONTROL 0 — the probe's auth and the route both actually work (else everything below is vacuous)");
{
  const A = await mkWallet("Control");
  chk(typeof A.mktToken === "string" && A.mktToken.length >= 16, `/verify issued a real market token (len ${A.mktToken ? A.mktToken.length : "NONE"})`);
  const mv = await move(A);
  chk(mv.status === 200, `/world/move accepted the proven wallet (status ${mv.status})`);
  const r = await flow(A, [{ k: "craft", m: { wood: 7 } }, { k: "chest", m: { crystal: 3 } }]);
  chk(r.status === 200 && r.body.counted === true, `a legitimate flow batch counts (status ${r.status}, body ${JSON.stringify(r.body)})`);
  chk(spent(A).wood === 7, `control spend landed (matSpent.wood = ${spent(A).wood})`);
  chk(gained(A).crystal === 3, `control gain landed (matGained.crystal = ${gained(A).crystal})`);
  // negative control: a wallet that never posted has no row at all
  const Z = await mkWallet("Never");
  chk(SRV._flowFor(Z.wallet).spent === null && SRV._flowFor(Z.wallet).gained === null,
    `a wallet that never posted has NO row (spent=${SRV._flowFor(Z.wallet).spent}, gained=${SRV._flowFor(Z.wallet).gained})`);
}

// =========================================================================================
sec("ATTACK 1 — THE LAUNDERING GUARD: can a declared GAIN ever become evidence?");
{
  const C = await mkWallet("Launderer");
  await move(C);
  // 1a. straight enormous gain declaration across every gain kind, capped-max per event, 32 events
  const ev = [];
  for (let i = 0; i < 8; i++) for (const k of ["chest", "task", "raid", "milestone"]) ev.push({ k, m: { crystal: 600 } });
  const r1 = await flow(C, ev);
  chk(r1.body.counted === true, `32 max-quantity gain events counted (${JSON.stringify(r1.body)})`);
  console.log(`     declared crystal gain this batch = ${gained(C).crystal}`);
  chk((gath(C).crystal || 0) === 0, `gatherCount.crystal is STILL 0 after ${gained(C).crystal} declared gain (actual ${gath(C).crystal || 0})`);

  // 1b. every weird kind shape the brief names — case variants, arrays, objects, __proto__, dupes
  await wait(3100);
  const weird = [
    { k: "Chest", m: { crystal: 500 } }, { k: "CHEST", m: { crystal: 500 } }, { k: "chEsT", m: { crystal: 500 } },
    { k: ["chest"], m: { crystal: 500 } },              // Array -> String() coerces to "chest"
    { k: ["chest", "task"], m: { crystal: 500 } },      // -> "chest,task"
    { k: { a: 1 }, m: { crystal: 500 } },               // -> "[object Object]"
    { k: 0, m: { crystal: 500 } }, { k: null, m: { crystal: 500 } }, { k: true, m: { crystal: 500 } },
    { k: "chest ", m: { crystal: 500 } }, { k: " chest", m: { crystal: 500 } },
    { k: "chest", m: { crystal: 500 } }, { k: "chest", m: { crystal: 500 } },  // duplicate kinds
    { k: "craft", m: { crystal: 500 } },                // mix a spend in with the gains
  ];
  const before = gained(C).crystal, beforeS = spent(C).crystal;
  const r2 = await flow(C, weird);
  const dGain = (gained(C).crystal || 0) - before, dSpend = (spent(C).crystal || 0) - (beforeS || 0);
  console.log(`     weird-kind batch: matGained.crystal +${dGain}, matSpent.crystal +${dSpend} (body ${JSON.stringify(r2.body)})`);
  // only the two exact "chest" strings count: case variants and padded kinds were always ignored,
  // and an ARRAY kind (["chest"]) is no longer String()-coerced into a valid one either
  chk(dGain === 1000, `only the two exact "chest" kinds counted: +${dGain} (expected 2 x 500 = 1000 — case variants, padded kinds and array kinds all ignored)`);
  chk(dSpend === 500, `the mixed-in spend went to matSpent, not matGained (+${dSpend})`);
  chk((gath(C).crystal || 0) === 0, `gatherCount.crystal STILL 0 (actual ${gath(C).crystal || 0})`);

  // 1c. the money shot: list a forged stockpile and see whether the oversold flag survives
  const L = await listMat(C, "crystal", 19000);
  chk(L.status === 200, `the 19,000-crystal listing was accepted by the market (status ${L.status})`);
  const sum = await summary();
  const row = oversoldFor(sum, C, "crystal");
  chk(!!row, `the listing is STILL flagged oversold — declared gains bought nothing (row ${JSON.stringify(row)})`);
  chk(row && row.everGathered === 0, `the flag reports everGathered=${row && row.everGathered} despite ${gained(C).crystal} declared "chest" gain`);

  // 1d. does declaring a SPEND of the same material change the flag? (the other direction)
  await wait(3100);
  await flow(C, [{ k: "craft", m: { crystal: 600 } }]);
  const sum2 = await summary();
  const row2 = oversoldFor(sum2, C, "crystal");
  chk(!!row2, `still flagged after declaring a spend too (row ${JSON.stringify(row2)})`);

  // 1e. can a gain reach gatherCount through ANY material id? sweep all 14
  await wait(3100);
  const MATS = ["wood", "stone", "iron", "gold", "crystal", "seashell", "hide", "fish", "honey", "berries", "flower", "pork", "beef", "essence"];
  const allEv = MATS.map(m => ({ k: "chest", m: { [m]: 600 } }));
  await flow(C, allEv);
  const leaked = MATS.filter(m => (gath(C)[m] || 0) > 0);
  chk(leaked.length === 0, `after declaring 600 gain of all 14 materials, gatherCount = ${JSON.stringify(gath(C))} (leaked: ${JSON.stringify(leaked)})`);
  console.log(`     final matGained for this wallet = ${JSON.stringify(gained(C))}`);

  // 1f. attack the OVERSOLD SIGNAL itself with a prototype-named item id.
  //     server.js:3412 `(gatherCount.get(row.wallet) || {})[row.item] || 0` — the `|| {}` fallback is
  //     a PLAIN object, so for a wallet with NO gather record, item "toString" resolves a function.
  const X = await mkWallet("ProtoItem");
  chk(SRV._gatheredFor(X.wallet) === null, `the evader has no gatherCount row at all (${SRV._gatheredFor(X.wallet)})`);
  await listMat(X, "toString", 19000);
  await listMat(X, "constructor", 19000);
  await listMat(X, "wood", 19000);        // control: a REAL material must still be flagged
  const sx = await summary();
  const rTo = oversoldFor(sx, X, "toString"), rCo = oversoldFor(sx, X, "constructor"), rWo = oversoldFor(sx, X, "wood");
  console.log(`     JS: ({})["toString"] is ${typeof ({})["toString"]}; Math.max(50, that*10) = ${Math.max(50, ({}).toString * 10)}; 19000 > NaN = ${19000 > Math.max(50, ({}).toString * 10)}`);
  chk(!!rWo, `CONTROL: the same wallet's 19,000 WOOD listing IS flagged (${JSON.stringify(rWo)})`);
  if (!rTo || !rCo) {
    hole(`server.js:3412 oversold check — the \`|| {}\` fallback is a PLAIN object, so a prototype-named item id escapes the flag entirely for any wallet with no gatherCount row: item "toString" flagged=${!!rTo}, item "constructor" flagged=${!!rCo}, while item "wood" flagged=${!!rWo} at the same qty (19000).`);
  } else {
    chk(true, `prototype-named item ids are still flagged (toString ${JSON.stringify(rTo)})`);
  }
}

// =========================================================================================
sec("ATTACK 2b — UNCOERCIBLE VALUES: can one event abort the whole request?");
{
  const U = await mkWallet("Crasher"); await move(U);
  // String({toString: 1}) throws: valueOf returns the object, toString is not callable.
  console.log(`     JS check: String({toString:1}) -> ${(() => { try { return String({ toString: 1 }); } catch (e) { return "THROWS " + e.constructor.name + ": " + e.message; } })()}`);
  const poison = [{ k: "craft", m: { wood: 111 } },                 // before the poison
                  { k: { toString: 1, valueOf: 1 }, m: { stone: 1 } },  // String(ev.k) at server.js:3345
                  { k: "craft", m: { iron: 222 } }];                // after the poison — does it survive?
  const rp = await flow(U, poison);
  console.log(`     response status ${rp.status}, body ${JSON.stringify(rp.body)}, matSpent = ${JSON.stringify(spent(U))}`);
  if (rp.status >= 500) {
    hole(`server.js:3345 \`String(ev.k || "")\` throws an UNCAUGHT TypeError on {"k":{"toString":1,"valueOf":1}} — the request 500s (status ${rp.status}). The batch is aborted MID-LOOP: wood=${spent(U).wood} (recorded, before the poison) but iron=${spent(U).iron} (LOST, after it). _lastFlowRec was already set at 3340, so the wallet's 3s window is burnt too. Every hit writes a full stack trace to the server log.`);
  } else {
    chk(true, `an uncoercible kind does not 500 (status ${rp.status})`);
  }
  // the same primitive-coercion trap on a QUANTITY: Number({toString:1}) also throws
  await wait(3100);
  const U2 = await mkWallet("Crasher2"); await move(U2);
  console.log(`     JS check: Number({toString:1,valueOf:1}) -> ${(() => { try { return Number({ toString: 1, valueOf: 1 }); } catch (e) { return "THROWS " + e.constructor.name; } })()}`);
  const rq = await flow(U2, [{ k: "craft", m: { wood: 111, stone: { toString: 1, valueOf: 1 }, iron: 222 } }]);
  console.log(`     response status ${rq.status}, body ${JSON.stringify(rq.body)}, matSpent = ${JSON.stringify(spent(U2))}`);
  if (rq.status >= 500) hole(`server.js:3352 \`Number(m[mat])\` throws the same uncaught TypeError on an uncoercible quantity: status ${rq.status}, matSpent = ${JSON.stringify(spent(U2))} (iron after it was lost).`);

  // does the process survive? (express catches SYNC throws — prove the server still serves)
  const alive = await get("/world/nodes");
  chk(alive.status === 200, `the server is still up after the 500s (GET /world/nodes -> ${alive.status}) — a per-request 500, not a process kill`);
  await wait(3100);
  const ok = await flow(U, [{ k: "craft", m: { gold: 9 } }]);
  chk(ok.body && ok.body.counted === true, `CONTROL: a clean batch from the same wallet still counts afterwards (${JSON.stringify(ok.body)}, gold ${spent(U).gold})`);
}

// =========================================================================================
sec("ATTACK 1b — CONTROL: the oversold flag CAN clear, so the assertion above is not vacuous");
{
  // If the flag could never clear, "still flagged" would prove nothing. Real gathers clear it.
  const H = await mkWallet("Honest");
  await move(H);
  // 60 real, position-authorised kill reports -> 6 essence each = 360 essence of real evidence
  let counted = 0;
  for (let i = 0; i < 60; i++) { const r = await post("/world/kill/report", { wallet: H.wallet, mktToken: H.mktToken }); if (r.body && r.body.counted) counted++; await wait(520); }
  console.log(`     real evidence accrued: ${counted} counted kill reports -> gatherCount = ${JSON.stringify(gath(H))}`);
  await listMat(H, "essence", 100);   // 100 < max(50, 360*10=3600) -> must NOT be flagged
  const sum = await summary();
  chk(!oversoldFor(sum, H, "essence"), `a 100-essence listing backed by ${gath(H).essence} gathered essence is NOT flagged (control: the flag can clear)`);
  await listMat(H, "wood", 5000);     // no wood evidence at all -> MUST be flagged
  const sum2 = await summary();
  const w = oversoldFor(sum2, H, "wood");
  chk(!!w, `and the same wallet listing 5000 wood with 0 gathered IS flagged (${JSON.stringify(w)}) — the signal is live`);
}

// =========================================================================================
sec("ATTACK 2 — PROTOTYPE POLLUTION via RAW JSON TEXT (obj['__proto__']=v never reaches the wire)");
{
  const P = await mkWallet("Polluter");
  await move(P);
  const payload = JSON.stringify({ wallet: P.wallet, mktToken: P.mktToken, ev: [] })
    .replace('"ev":[]', '"ev":[' + [
      '{"k":"craft","m":{"__proto__":9991,"constructor":9992,"toString":9993,"hasOwnProperty":9994,"valueOf":9995,"wood":5}}',
      '{"k":"__proto__","m":{"wood":100}}',
      '{"k":"constructor","m":{"wood":100}}',
      '{"k":"toString","m":{"wood":100}}',
      '{"k":"hasOwnProperty","m":{"wood":100}}',
      '{"k":"chest","m":{"__proto__":{"pwned":true},"crystal":4}}',
      '{"__proto__":{"k":"chest"},"m":{"crystal":777}}',
      '{"k":"chest","m":{"__proto__":{"crystal":888}}}',
    ].join(",") + ']');
  // PROVE the payload really carries __proto__ as an own key BEFORE trusting the result
  const parsed = JSON.parse(payload);
  const k0 = Object.keys(parsed.ev[0].m);
  chk(k0.includes("__proto__"), `the raw payload really carries "__proto__" as an OWN key: ${JSON.stringify(k0)}`);
  const r = await postRaw("/world/mat/flow", payload);
  console.log(`     response ${r.status} ${JSON.stringify(r.body)}`);
  chk(spent(P).wood === 5, `only the real material was tallied (matSpent.wood = ${spent(P).wood})`);
  chk(gained(P).crystal === 4, `only the real gain was tallied (matGained.crystal = ${gained(P).crystal})`);
  const sKeys = Object.keys(spent(P)), gKeys = Object.keys(gained(P));
  chk(sKeys.length === 1 && gKeys.length === 1, `no junk key entered either tally (spent keys ${JSON.stringify(sKeys)}, gained keys ${JSON.stringify(gKeys)})`);
  // global pollution checks — every prototype name we sent, plus the tally value it carried
  const probe = {};
  chk(probe.pwned === undefined, `({}).pwned = ${probe.pwned}`);
  chk(probe.wood === undefined && probe.crystal === undefined, `({}).wood = ${probe.wood}, ({}).crystal = ${probe.crystal}`);
  chk(Object.prototype.pwned === undefined && Object.prototype.k === undefined, `Object.prototype.pwned = ${Object.prototype.pwned}, Object.prototype.k = ${Object.prototype.k}`);
  chk(({}).toString() === "[object Object]", `Object.prototype.toString still works: "${({}).toString()}"`);
  chk(typeof ({}).hasOwnProperty === "function", `Object.prototype.hasOwnProperty still a function: ${typeof ({}).hasOwnProperty}`);
  chk([].length === 0 && Array.prototype.k === undefined, `Array.prototype.k = ${Array.prototype.k}`);
  // the "__proto__ as a whole event" case: does an event whose k comes from the prototype count?
  chk(!("crystal" in spent(P)), `the {"__proto__":{"k":"chest"}} event contributed nothing to spent (${JSON.stringify(spent(P))})`);
  chk(gained(P).crystal === 4, `...and nothing to gained beyond the real 4 (${gained(P).crystal})`);
}

// =========================================================================================
sec("ATTACK 3 — QUANTITY / BATCH / RATE BYPASS: what can an attacker actually inflate per minute?");
{
  const Q = await mkWallet("Firehose");
  await move(Q);
  // 3a. split one material across all 32 events to beat FLOW_QTY_MAX=600
  const split = []; for (let i = 0; i < 32; i++) split.push({ k: "chest", m: { gold: 600 } });
  await flow(Q, split);
  chk(gained(Q).gold === 19200, `FLOW_QTY_MAX=600 is PER EVENT: 32x600 gold in one batch = ${gained(Q).gold}`);
  if (gained(Q).gold > 600) console.log(`     -> the per-event cap does not bound a batch: ${gained(Q).gold} = ${gained(Q).gold / 600}x the cap`);

  // 3b. beat FLOW_EV_MAX=32 by widening each event across all 14 materials
  await wait(3100);
  const MATS = ["wood", "stone", "iron", "gold", "crystal", "seashell", "hide", "fish", "honey", "berries", "flower", "pork", "beef", "essence"];
  const wide = []; const mObj = {}; for (const m of MATS) mObj[m] = 600;
  for (let i = 0; i < 64; i++) wide.push({ k: "chest", m: { ...mObj } });
  const before = MATS.reduce((s, m) => s + (gained(Q)[m] || 0), 0);
  await flow(Q, wide);
  const after = MATS.reduce((s, m) => s + (gained(Q)[m] || 0), 0);
  console.log(`     64 events x 14 materials x 600 in ONE batch added ${after - before} units (32 events survive the slice x 14 mats x 600 = ${32 * 14 * 600})`);
  chk(after - before === 32 * 14 * 600, `FLOW_EV_MAX truncates to 32 events but each carries 14 materials: ${after - before} units/batch`);

  // 3c. race the rate cap with concurrent requests (handler is synchronous — is it?)
  await wait(3100);
  const R = await mkWallet("Racer"); await move(R);
  const results = await Promise.all(Array.from({ length: 12 }, () => flow(R, [{ k: "chest", m: { honey: 100 } }])));
  const nCounted = results.filter(x => x.body && x.body.counted).length;
  chk(nCounted === 1, `12 CONCURRENT batches: ${nCounted} counted, matGained.honey = ${gained(R).honey} (a race would show >1)`);

  // 3d. rate cap is PER WALLET — how many wallets can one attacker drive?
  const swarm = [];
  for (let i = 0; i < 10; i++) { const w = await mkWallet("Sw" + i); await move(w); swarm.push(w); }
  await Promise.all(swarm.map(w => flow(w, split)));
  const swarmTotal = swarm.reduce((s, w) => s + (gained(w).gold || 0), 0);
  chk(swarmTotal === 10 * 19200, `the 3s cap is per-wallet: 10 wallets in one instant declared ${swarmTotal} gold`);

  // 3e. QUANTIFY the per-minute ceiling for ONE wallet, measured not assumed
  const M = await mkWallet("Meter"); await move(M);
  const t0 = Date.now(); let batches = 0;
  while (Date.now() - t0 < 12000) {
    const r = await flow(M, split);
    if (r.body && r.body.counted) batches++;
    await wait(250);
  }
  const el = (Date.now() - t0) / 1000;
  const perMin = Math.round((gained(M).gold || 0) / el * 60);
  console.log(`     MEASURED: ${batches} counted batches in ${el.toFixed(1)}s -> matGained.gold = ${gained(M).gold} = ~${perMin} units/min/wallet of ONE material`);
  console.log(`     ONE material, ONE wallet: ~${perMin}/min. All 14 materials: ~${perMin * 14}/min. x1000 sybil wallets: ~${perMin * 14 * 1000}/min.`);
  chk(batches > 1, `the rate cap admits ${batches} batches per 12s (FLOW_MIN_MS=3000 -> ceiling 4)`);
  chk((gath(M).gold || 0) === 0, `and after ${gained(M).gold} declared gold, gatherCount.gold = ${gath(M).gold || 0} — still not evidence`);

  // 3f. THE CLAMP: Math.min(FLOW_QTY_MAX, q|0) has no LOWER bound and q|0 is ToInt32
  await wait(3100);
  const N = await mkWallet("Wrap"); await move(N);
  console.log(`     JS check: (2147483648 | 0) = ${2147483648 | 0}; Math.min(600, that) = ${Math.min(600, 2147483648 | 0)}`);
  const rw = await flow(N, [{ k: "craft", m: { iron: 2147483648 } }, { k: "chest", m: { berries: 3000000000 } }]);
  console.log(`     response ${JSON.stringify(rw.body)} -> matSpent.iron = ${spent(N).iron}, matGained.berries = ${gained(N).berries}`);
  if (spent(N).iron < 0 || gained(N).berries < 0) {
    hole(`server.js:3354 Math.min(FLOW_QTY_MAX, q|0) — a POSITIVE client quantity 2147483648 wraps through ToInt32 to a NEGATIVE tally: matSpent.iron = ${spent(N).iron}, matGained.berries = ${gained(N).berries} (expected 0 < v <= 600)`);
  } else {
    chk(spent(N).iron > 0 && spent(N).iron <= 600, `huge quantities clamp into 1..600 (iron ${spent(N).iron}, berries ${gained(N).berries})`);
  }
  // can it be driven arbitrarily negative by repetition?
  await wait(3100);
  const b4 = spent(N).iron;
  await flow(N, [{ k: "craft", m: { iron: 2147483648 } }]);
  console.log(`     repeat: matSpent.iron ${b4} -> ${spent(N).iron} (delta ${spent(N).iron - b4})`);
}

// =========================================================================================
sec("ATTACK 4 — CROSS-WALLET: can a stranger write into a victim's tally?");
{
  const V = await mkWallet("Victim");            // an honest, PROVEN, online player
  await move(V);
  const A = await mkWallet("Attacker");          // a different wallet, with its own valid token
  await move(A);
  const vBefore = JSON.stringify(gained(V));

  // 4a. attacker posts the victim's wallet with NO token at all
  const r1 = await post("/world/mat/flow", { wallet: V.wallet, ev: [{ k: "chest", m: { crystal: 600 } }] });
  console.log(`     no-token post naming the victim: ${r1.status} ${JSON.stringify(r1.body)}`);
  console.log(`     victim matGained before=${vBefore} after=${JSON.stringify(gained(V))}`);
  if (r1.body && r1.body.counted) {
    hole(`server.js:3330-3358 POST /world/mat/flow never calls mktWallet()/presenceOk() — an UNAUTHENTICATED caller wrote ${gained(V).crystal} crystal into the victim's matGained (victim wallet ${V.wallet.slice(0, 8)}...). Sibling routes gate a wallet with presenceOk(); this one does not.`);
  } else {
    chk(true, `a no-token cross-wallet write is refused (${JSON.stringify(r1.body)})`);
  }

  // 4b. attacker posts victim's wallet with the ATTACKER's own valid token
  await wait(3100);
  const vB2 = gained(V).crystal || 0;
  const r2 = await post("/world/mat/flow", { wallet: V.wallet, mktToken: A.mktToken, ev: [{ k: "craft", m: { wood: 600 } }] });
  console.log(`     attacker-token post naming the victim: ${r2.status} ${JSON.stringify(r2.body)} -> victim matSpent = ${JSON.stringify(spent(V))}`);
  chk(true, `observed: victim matSpent.wood = ${spent(V).wood} (was undefined), victim matGained.crystal = ${gained(V).crystal} (was ${vB2})`);

  // 4c. can the attacker MANUFACTURE presence for an OFFLINE victim and then poison it?
  const O = await mkWallet("Offline");           // signs in, never moves -> no presence slot
  const noPres = await post("/world/mat/flow", { wallet: O.wallet, ev: [{ k: "chest", m: { gold: 600 } }] });
  chk(noPres.status === 403, `an offline wallet has no presence -> 403 (${noPres.status} ${JSON.stringify(noPres.body)})`);
  const seize = await post("/world/move", { wallet: O.wallet, x: 1, z: 1, handle: "Puppet" });   // no token
  console.log(`     unproven /world/move claiming the offline victim's slot: ${seize.status}`);
  const r3 = await post("/world/mat/flow", { wallet: O.wallet, ev: [{ k: "chest", m: { gold: 600 } }] });
  console.log(`     then flow: ${r3.status} ${JSON.stringify(r3.body)} -> offline victim matGained = ${JSON.stringify(gained(O))}`);
  if (r3.body && r3.body.counted) {
    hole(`a stranger can MANUFACTURE the required presence for any offline wallet (/world/move takes an unclaimed slot with no token, server.js:4511-4515) and then write its flow telemetry: matGained.gold = ${gained(O).gold} for a wallet that never played.`);
  }

  // 4d. does the poisoning consume the victim's OWN rate window (telemetry suppression)?
  await wait(3100);
  const V2 = await mkWallet("Victim2"); await move(V2);
  await post("/world/mat/flow", { wallet: V2.wallet, ev: [{ k: "chest", m: { honey: 600 } }] });   // attacker grabs the window
  const own = await flow(V2, [{ k: "craft", m: { stone: 42 } }]);                                   // victim's real report
  console.log(`     victim's own honest batch right after: ${JSON.stringify(own.body)} -> matSpent = ${JSON.stringify(spent(V2))}`);
  if (own.body && own.body.counted === false && spent(V2).stone === undefined) {
    hole(`an attacker holding a victim's 3s window SUPPRESSES the victim's own honest telemetry: victim's craft batch answered counted:false and matSpent.stone = ${spent(V2).stone}`);
  }

  // 4d-bis. WHERE DOES THE ATTACKER GET THE WALLET? Straight off the public roster — no secret needed.
  const V3 = await mkWallet("RosterVictim"); await move(V3);
  const roster = await get("/world/roster");
  const seen = (roster.body.users || []).find(u => u.wallet === V3.wallet);
  chk(!!seen, `GET /world/roster publishes the victim's full wallet, unauthenticated (${seen ? seen.wallet.slice(0, 12) + "... handle=" + seen.handle : "NOT FOUND"})`);
  const r4b = await post("/world/mat/flow", { wallet: seen.wallet, ev: [{ k: "raid", m: { crystal: 600, gold: 600 } }] });
  console.log(`     poisoned a wallet READ OFF THE PUBLIC ROSTER: ${JSON.stringify(r4b.body)} -> matGained = ${JSON.stringify(gained(V3))}`);
  chk(true, `attacker input required: the victim's public wallet string only (no token, no signature, no net_id)`);

  // 4e. can a net_id (unproven, non-pubkey) caller write anything?
  const nid = "netid_" + Date.now();
  await post("/world/move", { wallet: nid, x: 2, z: 2, handle: "Demo" });
  const r4 = await post("/world/mat/flow", { wallet: nid, ev: [{ k: "chest", m: { crystal: 600 } }] });
  console.log(`     net_id caller: ${r4.status} ${JSON.stringify(r4.body)}`);
  chk(r4.body && r4.body.counted === false, `a net_id caller records nothing (counted=${r4.body && r4.body.counted}, _flowFor = ${JSON.stringify(SRV._flowFor(nid))})`);
  chk(SRV._flowFor(nid).spent === null && SRV._flowFor(nid).gained === null, `and no row was created for it (spent=${SRV._flowFor(nid).spent})`);

  // 4f. body fields that NAME a victim while the caller is proven as themselves
  await wait(3100);
  const T = await mkWallet("Target"); await move(T);
  const S = await mkWallet("Selfish"); await move(S);
  const before = JSON.stringify(gained(T));
  const r5 = await post("/world/mat/flow", { wallet: S.wallet, mktToken: S.mktToken, target: T.wallet, w: T.wallet,
    owner: T.wallet, for: T.wallet, ev: [{ k: "chest", m: { pork: 600 } }] });
  console.log(`     alias body fields (target/w/owner/for): ${JSON.stringify(r5.body)}`);
  chk(JSON.stringify(gained(T)) === before, `no alias body field redirects the write: target matGained ${before} -> ${JSON.stringify(gained(T))}`);
  chk(gained(S).pork === 600, `the write landed on the CALLER's own wallet instead (matGained.pork = ${gained(S).pork})`);
}

// =========================================================================================
sec("ATTACK 6 — PERSISTENCE: can a corrupt/malicious blob poison the maps or crash restore?");
{
  const G = await mkWallet("Persist"); await move(G);
  await flow(G, [{ k: "craft", m: { iron: 12 } }, { k: "chest", m: { honey: 3 } }]);
  const blob = SRV.serializeAssetLedger();
  chk(Array.isArray(blob.spent) && Array.isArray(blob.gained), `serialize carries both tallies (spent ${blob.spent.length} rows, gained ${blob.gained.length} rows)`);

  // 6a. round-trip control
  SRV._clearAssetLedger();
  chk(SRV._flowFor(G.wallet).spent === null, `after clear the tally is gone (${SRV._flowFor(G.wallet).spent})`);
  SRV.restoreAssetLedger(blob);
  chk(spent(G).iron === 12 && gained(G).honey === 3, `CONTROL round-trip restores (iron ${spent(G).iron}, honey ${gained(G).honey})`);

  // 6b. does a NEGATIVE tally survive a restart? (links to the ToInt32 finding)
  SRV._clearAssetLedger();
  SRV.restoreAssetLedger({ w: [], spent: [["NEGWALLET", { iron: -2147483648, wood: 5 }]] });
  console.log(`     negative persisted value -> ${JSON.stringify(SRV._flowFor("NEGWALLET").spent)}`);
  chk((SRV._flowFor("NEGWALLET").spent || {}).iron === undefined, `restore DROPS non-positive values (iron = ${(SRV._flowFor("NEGWALLET").spent || {}).iron})`);

  // 6c. junk keys / wrong types via RAW JSON so "__proto__" is a real own key
  SRV._clearAssetLedger();
  const raw = '{"w":[],"spent":[["JUNKW",{"__proto__":{"pwned":1},"constructor":42,"toString":43,"notarealmat":7,"wood":"12","iron":-5,"gold":{},"crystal":[9],"stone":[],"fish":"abc","honey":true,"berries":null,"' + "x".repeat(200) + '":1}]],"gained":"notanarray"}';
  const parsedBlob = JSON.parse(raw);
  chk(Object.keys(parsedBlob.spent[0][1]).includes("__proto__"), `the blob really carries "__proto__" as an own key: ${Object.keys(parsedBlob.spent[0][1]).slice(0, 4).join(",")}...`);
  let crashed = null; try { SRV.restoreAssetLedger(parsedBlob); } catch (e) { crashed = e.message; }
  chk(crashed === null, `restore did not throw on the junk blob (${crashed})`);
  const jr = SRV._flowFor("JUNKW").spent || {};
  console.log(`     restored junk row = ${JSON.stringify(jr)}`);
  console.log(`     own keys = ${JSON.stringify(Object.keys(jr))}`);
  chk(jr.wood === 12 && typeof jr.wood === "number", `string "12" is re-typed to number (wood = ${jr.wood}, typeof ${typeof jr.wood})`);
  chk(jr.iron === undefined && jr.gold === undefined && jr.stone === undefined && jr.fish === undefined && jr.berries === undefined,
    `negative/object/empty-array/NaN/null values dropped (iron ${jr.iron}, gold ${jr.gold}, stone ${jr.stone}, fish ${jr.fish}, berries ${jr.berries})`);
  chk(typeof jr.crystal === "number", `array [9] coerced to number ${jr.crystal} (Number([9]) === 9)`);
  chk(({}).pwned === undefined && Object.prototype.pwned === undefined, `no Object.prototype pollution from restore (({}).pwned = ${({}).pwned})`);
  chk(Object.getPrototypeOf({}) === Object.prototype, `Object.prototype identity intact`);
  if (jr.notarealmat !== undefined || jr.constructor === 42) {
    hole(`server.js:4421-4430 restoreAssetLedger does NOT apply the MAT_IDS whitelist that the route enforces — a corrupt persisted blob reintroduces junk keys the route's comment says "never touch a map": restored keys ${JSON.stringify(Object.keys(jr))}`);
  } else {
    chk(true, `restore also enforces the material whitelist (keys ${JSON.stringify(Object.keys(jr))})`);
  }
  const longKey = Object.keys(jr).find(k => k.startsWith("xxxx"));
  chk(!longKey || longKey.length === 24, `long keys are truncated to 24 chars (${longKey ? longKey.length : "none survived"})`);
  chk(SRV._flowFor("JUNKW").gained === null, `a non-array "gained" is ignored, not thrown on (${SRV._flowFor("JUNKW").gained})`);

  // 6d. structurally wrong blobs must not crash
  const bad = [undefined, null, 0, "str", [], { w: [] }, { w: [], spent: null }, { w: [], spent: [null, 1, "x", [], [null, null], [{}, {}], [["a"], { wood: 1 }]] },
               { w: [], gained: [["W", []]] }, { w: [], gained: [["W", { wood: Infinity }]] }, { w: [], spent: [["W", { wood: 1e400 }]] }];
  let threw = 0;
  for (const bb of bad) { try { SRV.restoreAssetLedger(bb); } catch (e) { threw++; console.log(`     THREW on ${JSON.stringify(bb)}: ${e.message}`); } }
  chk(threw === 0, `${bad.length} malformed blobs restored without throwing (${threw} threw)`);
  const infv = (SRV._flowFor("W").gained || {}).wood;
  console.log(`     Infinity handling: gained["W"].wood = ${infv} (typeof ${typeof infv}); JSON.stringify -> ${JSON.stringify(SRV._flowFor("W").gained)}`);
  if (infv === Infinity) {
    hole(`server.js:4427 restore's re-typing guard is \`if (n > 0)\`, which is TRUE for Infinity — a persisted Infinity survives into the tally as ${infv} and JSON-serializes to \`null\` in /assets/audit (${JSON.stringify(SRV._flowFor("W").gained)}), so the human review view shows a null where a count should be.`);
  } else {
    chk(Number.isFinite(infv) || infv === undefined, `Infinity is rejected on restore (${infv})`);
  }

  // 6e. is the GATHER_WALLETS_MAX bound enforced on RESTORE?
  SRV._clearAssetLedger();
  const bigRows = []; for (let i = 0; i < 25000; i++) bigRows.push(["fake" + i, { wood: 1 }]);
  SRV.restoreAssetLedger({ w: [], spent: bigRows });
  const sizeAfter = (await summary()).matFlow.spendingWallets;
  console.log(`     restored a 25,000-row blob -> matSpent.size = ${sizeAfter} (GATHER_WALLETS_MAX = 20000)`);
  if (sizeAfter > 20000) hole(`server.js:4421-4430 restoreAssetLedger applies NO size bound — a 25,000-row persisted blob grew matSpent to ${sizeAfter}, past the GATHER_WALLETS_MAX=20000 the live path enforces (serialize re-slices to 20000 on the next save, so it self-heals, but restore itself is unbounded).`);
  else chk(true, `restore respects the bound (${sizeAfter})`);
  const reser = SRV.serializeAssetLedger();
  console.log(`     next serialize slices back to ${reser.spent.length} rows`);
  SRV._clearAssetLedger();
}

// =========================================================================================
sec("ATTACK 7 — INTERACTION: can the new tallies move any value-bearing decision?");
{
  // Static: every read of matSpent/matGained in server.js (grep-verified below at runtime)
  const src = await import("fs").then(fs => fs.promises.readFile(new URL("./server.js", import.meta.url), "utf8"));
  const lines = src.split("\n");
  const reads = [];
  lines.forEach((l, i) => { if (/matSpent|matGained/.test(l)) reads.push(`${i + 1}: ${l.trim().slice(0, 110)}`); });
  console.log("     every line mentioning matSpent/matGained:");
  for (const r of reads) console.log("       " + r);
  const consumerLines = reads.filter(r => !/^(3[23]1[0-9]|33[0-9][0-9])/.test(r));
  chk(reads.length > 0, `${reads.length} lines reference the tallies`);

  // Dynamic: the sale gate for a chikimon must be identical before and after a huge declaration
  const K = await mkWallet("SaleGate"); await move(K);
  const uid = "u" + Date.now() + "a";
  const before = await post("/market/op", { sid: K.sid, op: "list", wallet: K.wallet, mktToken: K.mktToken,
    listing: { id: "SG1_" + Date.now(), item: "flamimon", kind: "chikimon", uid, qty: 1, price: 100, seller: "K", lvl: 5 } });
  await flow(K, [{ k: "chest", m: { crystal: 600 } }, { k: "task", m: { gold: 600 } }, { k: "raid", m: { iron: 600 } }]);
  await wait(3100);
  const after = await post("/market/op", { sid: K.sid, op: "list", wallet: K.wallet, mktToken: K.mktToken,
    listing: { id: "SG2_" + Date.now(), item: "flamimon", kind: "chikimon", uid, qty: 1, price: 100, seller: "K", lvl: 5 } });
  chk(before.status === after.status, `chikimon sale gate unchanged by ${gained(K).crystal} declared gain (before ${before.status}, after ${after.status})`);

  // quest payout: declare a huge spend/gain then ask for quest state — payout must not move
  const q1 = await get(`/quest/state?wallet=${K.wallet}&mktToken=${K.mktToken}`);
  await wait(3100);
  await flow(K, [{ k: "refund", m: { crystal: 600 } }, { k: "milestone", m: { gold: 600 } }]);
  const q2 = await get(`/quest/state?wallet=${K.wallet}&mktToken=${K.mktToken}`);
  chk(JSON.stringify(q1.body) === JSON.stringify(q2.body), `quest state byte-identical across a declaration (${q1.status}/${q2.status}, len ${JSON.stringify(q1.body || "").length} vs ${JSON.stringify(q2.body || "").length})`);

  // asset audit: the tallies are DISPLAYED, and only to the proven owner / admin
  const aud = await get(`/assets/audit?wallet=${K.wallet}&mktToken=${K.mktToken}`);
  console.log(`     /assets/audit for a wallet with NO ledger record: status ${aud.status}, body ${JSON.stringify(aud.body)}`);
  console.log(`     ...but its tallies really exist: spent=${JSON.stringify(spent(K))}, gained=${JSON.stringify(gained(K))}`);
  // CONTROL: the same view for a wallet that HAS cloud-saved must show the tallies
  const kp2 = nacl.sign.keyPair(), W2 = bs58.encode(kp2.publicKey);
  const am = `Chikoria sign-in\nwallet:${W2}\nts:${Date.now()}`;
  const as = Buffer.from(nacl.sign.detached(Buffer.from(am, "utf8"), kp2.secretKey)).toString("base64");
  const v2 = await post("/verify", { wallet: W2, netId: "nctl" + Date.now(), authMsg: am, authSig: as });
  const K2 = { wallet: W2, sid: "nctl", mktToken: v2.body.mktToken, handle: "Saver" };
  await post("/profile", { wallet: W2, authMsg: am, authSig: as, profile: { mmo: { onboarded: true, units: {}, mounts: [], eggs: [] } } });
  await wait(750);
  await move(K2); await flow(K2, [{ k: "chest", m: { honey: 42 } }]);
  const aud2 = await get(`/assets/audit?wallet=${W2}&mktToken=${K2.mktToken}`);
  console.log(`     CONTROL /assets/audit for a wallet WITH a ledger record: spent=${JSON.stringify((aud2.body || {}).spent)}, gained=${JSON.stringify((aud2.body || {}).gained)}`);
  chk((aud2.body || {}).gained && aud2.body.gained.honey === 42, `the control wallet's tallies ARE visible (gained.honey = ${((aud2.body || {}).gained || {}).honey})`);
  if ((aud2.body || {}).gained && (aud.body || {}).gained === undefined && Object.keys(gained(K)).length > 0) {
    hole(`server.js:3378 /assets/audit early-returns \`{wallet, units:{}, mounts:{}, unverified:0}\` when \`assetLedger.get(w)\` is empty — it OMITS spent/gained/gathered entirely. A wallet with no cloud save (exactly the bot/never-played shape) had matGained=${JSON.stringify(gained(K))} recorded but the review view reports nothing at all, so the telemetry is invisible for the wallets most worth reviewing.`);
  }
  const audNoTok = await get(`/assets/audit?wallet=${K.wallet}`);
  chk(audNoTok.status === 403, `a stranger cannot READ the tallies (${audNoTok.status} ${JSON.stringify(audNoTok.body)}) — write is open, read is not`);
  const sumNoKey = await get(`/assets/summary`);
  chk(sumNoKey.status === 403, `/assets/summary is admin-only (${sumNoKey.status})`);
}

// =========================================================================================
sec("ATTACK 5 — MEMORY / CAPACITY: the bound holds, but is the bound itself a weapon?");
{
  // control first: a fresh wallet records normally right now
  const Pre = await mkWallet("PreFlood"); await move(Pre);
  await flow(Pre, [{ k: "chest", m: { crystal: 5 } }]);
  // an UNPROVEN kill report (no mktToken) must now be refused — this used to be the flood's ammunition
  const unproven = await post("/world/kill/report", { wallet: Pre.wallet });
  chk(unproven.status === 403, `an unproven kill report is refused (${unproven.status})`);
  chk((gath(Pre).essence || 0) === 0, `and writes nothing to gatherCount (${gath(Pre).essence || 0})`);
  await post("/world/kill/report", { wallet: Pre.wallet, mktToken: Pre.mktToken });   // the proven one counts
  chk(gained(Pre).crystal === 5, `CONTROL before the flood: matGained.crystal = ${gained(Pre).crystal}`);
  chk((gath(Pre).essence || 0) > 0, `CONTROL before the flood: gatherCount.essence = ${gath(Pre).essence}`);

  const FLOOD = 20000, CONC = 200;
  console.log(`     flooding with ${FLOOD} fabricated pubkeys (random 32 bytes — no keypair, no signature, no funding)...`);
  const t0 = Date.now();
  const fake = []; for (let i = 0; i < FLOOD; i++) fake.push(bs58.encode(crypto.randomBytes(32)));
  let done = 0;
  for (let i = 0; i < FLOOD; i += CONC) {
    const chunk = fake.slice(i, i + CONC);
    await Promise.all(chunk.map(async (w) => {
      await post("/world/move", { wallet: w, x: 5, z: 5, handle: "Bot" });          // no token needed
      await post("/world/mat/flow", { wallet: w, ev: [{ k: "chest", m: { crystal: 1 } }] });  // no token needed
      await post("/world/kill/report", { wallet: w });                              // no token needed
      done++;
    }));
    if ((i / CONC) % 20 === 0) process.stdout.write(`\r     ${done}/${FLOOD} @ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const el = (Date.now() - t0) / 1000;
  console.log(`\r     flood done: ${done} wallets in ${el.toFixed(1)}s (${Math.round(done / el)} wallets/s, 3 unauthenticated requests each)`);
  const sum = await summary();
  console.log(`     matFlow now: spendingWallets=${sum.matFlow.spendingWallets}, gainingWallets=${sum.matFlow.gainingWallets}`);
  chk(sum.matFlow.gainingWallets <= 20000, `matGained is BOUNDED at GATHER_WALLETS_MAX (size ${sum.matFlow.gainingWallets} <= 20000) — no unbounded growth`);

  // now the honest newcomer
  const New = await mkWallet("Newcomer"); await move(New);
  const fr = await flow(New, [{ k: "chest", m: { crystal: 5 } }]);
  await post("/world/kill/report", { wallet: New.wallet, mktToken: New.mktToken });
  console.log(`     honest newcomer AFTER the flood: flow response ${JSON.stringify(fr.body)}, matGained = ${JSON.stringify(gained(New))}, gatherCount = ${JSON.stringify(gath(New))}`);
  if (sum.matFlow.gainingWallets >= 20000 && Object.keys(gained(New)).length === 0) {
    hole(`server.js:3322-3324 (_flowAdd) + 3494-3496 (recordGather): once ${sum.matFlow.gainingWallets} wallet slots are taken, a NEW wallet is silently never recorded — and the route still answers counted:${fr.body && fr.body.counted}. The 20,000 slots cost an attacker ${el.toFixed(0)}s of UNAUTHENTICATED requests (no keypair, no signature).`);
  }
  if (Object.keys(gath(New)).length === 0) {
    // does that turn the honest newcomer into a false positive on the oversold signal?
    await listMat(New, "essence", 5000);
    const s2 = await summary();
    const row = oversoldFor(s2, New, "essence");
    if (row) hole(`FALSE POSITIVE: the flood also fills gatherCount (same bound, same unauthenticated /world/kill/report). The honest newcomer's real kills recorded NOTHING, so their listing is flagged oversold: ${JSON.stringify(row)}. Every player who arrives after the flood is permanently "suspicious".`);
  }
  const memMB = Math.round(process.memoryUsage().heapUsed / 1048576);
  console.log(`     heapUsed after the flood: ${memMB} MB; worldPlayers online = ${(await get("/world/players?x=0&z=0")).body.online}`);

  // 5b. does a RESTART clear the blackout, or does the persisted blob carry it across?
  const blob = SRV.serializeAssetLedger();
  console.log(`     serialized blob carries ${blob.gained.length} gained rows and ${blob.gather.length} gather rows`);
  SRV._clearAssetLedger();
  SRV.restoreAssetLedger(blob);
  const sum2 = await summary();
  console.log(`     after a simulated restart (serialize -> clear -> restore): gainingWallets = ${sum2.matFlow.gainingWallets}`);
  const New2 = await mkWallet("Newcomer2"); await move(New2);
  await flow(New2, [{ k: "chest", m: { crystal: 5 } }]);
  await post("/world/kill/report", { wallet: New2.wallet });
  console.log(`     honest newcomer after the restart: matGained = ${JSON.stringify(gained(New2))}, gatherCount = ${JSON.stringify(gath(New2))}`);
  if (Object.keys(gained(New2)).length === 0) {
    hole(`the capacity blackout is NOT self-healing: the junk rows are serialized and restored, so gainingWallets = ${sum2.matFlow.gainingWallets} after a restart and the honest newcomer is STILL never recorded (matGained ${JSON.stringify(gained(New2))}). There is no TTL, no eviction and no flagged-first sort on matSpent/matGained/gatherCount.`);
  } else {
    chk(true, `a restart clears the blackout (newcomer matGained = ${JSON.stringify(gained(New2))})`);
  }
}

// =========================================================================================
console.log(`\nMAT_FLOW_FORGE_SIM pass=${pass} fail=${fail} holes=${holes.length}`);
if (holes.length) { console.log("\nCONFIRMED HOLES:"); holes.forEach((h, i) => console.log(`  ${i + 1}. ${h}`)); }
process.exit(fail ? 1 : 0);
