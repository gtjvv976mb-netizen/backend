// _rv_fish_attack_sim.mjs — ADVERSARIAL re-verification of the "one die" fishing change.
// Attacks the four questions the hand-off report did NOT ask:
//   A. can the bite-time report be SPAMMED to buy extra rolls, and what is the real ceiling?
//   B. does a DROPPED reply lose a catch or award two?
//   C. is the chronicle row ALWAYS the species the player was shown?  (report is sent at the BITE)
//   D. can a client still show/sell itself a legend the server did not roll — and does it MATTER?
// Boots the real server in-process: throwaway keypair, memory store, dead RPC, unique port.
// Nothing touches the live backend or any chain.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();                                   // THROWAWAY, never a real key
process.env.RPC_URL = "http://127.0.0.1:59999";                   // dummy, never called
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet";
process.env.PORT = "44401"; process.env.ADMIN_KEY = "local-sim-admin";
delete process.env.DATABASE_URL; delete process.env.CHIK_ACTIONS; delete process.env.CHIK_PHYS;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); let j = null; try { j = JSON.parse(await r.text()); } catch (e) {} return { status: r.status, body: j }; };
const get = async (p) => { const r = await fetch(B + p); let j = null; try { j = JSON.parse(await r.text()); } catch (e) {} return { status: r.status, body: j }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SRV = await import("/Users/michaelkennethbrillantes/Downloads/chiki-backend/server.js");
await sleep(1500);

let pass = 0, fail = 0, findings = [];
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const note = (m) => { findings.push(m); console.log("  FINDING:", m); };
const sec = (s) => console.log(`\n== ${s} ==`);
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "n" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { wallet, netId, mktToken: v.body.mktToken };
}
const move = (w, x = 5, z = 5, handle) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, x, z, dir: 0, handle });
const fish = (w, extra = {}) => post("/world/fish/report", { wallet: w.wallet, mktToken: w.mktToken, tier: 3, rod: 10, lvl: 20, ...extra });
const feedRows = async () => ((await get("/world/feed")).body || {}).feed || [];
// WORLD_TTL_MS is 12 s, so any loop longer than that MUST re-ping presence or every cast 403s.
const cast = async (w, extra = {}) => { await move(w, 5, 5, extra.handle); return fish(w, extra); };
const festival = (mult, hours) => post("/admin/fishing-event", { key: "local-sim-admin", mult, hours, label: "RV" });

// ============================================================= A. SPAM FOR EXTRA ROLLS
sec("A. can the bite report be spammed to buy extra rolls?");
{
  const W = await mkWallet(); await move(W);
  // A1 — no inbound rate cap on the ROUTE: how many requests does the server accept per second?
  const t0 = Date.now();
  const burst = await Promise.all(Array.from({ length: 200 }, () => fish(W)));
  const dtB = Date.now() - t0;
  const accepted = burst.filter((r) => r.status === 200).length;
  const counted = burst.filter((r) => r.body && r.body.counted === true).length;
  chk(accepted === 200 && counted === 1,
    `200 concurrent casts: ${accepted} accepted HTTP-200, exactly ${counted} COUNTED (the 800 ms floor binds the roll, not the request) in ${dtB} ms`);

  // A2 — how many ROLLS an hour does the floor really buy, and how many legends does that mint?
  const capBefore = SRV._ffishDayStatsForTest(W.wallet);
  let rolls = 0, legends = 0;
  for (let i = 0; i < 40; i++) {
    const r = await cast(W);
    if (r.body && r.body.counted) { rolls++; if (r.body.legend) legends++; }
    await sleep(810);
  }
  const perHour = Math.round(rolls / (40 * 0.81 / 3600));
  chk(rolls >= 38, `spaced casts all roll: ${rolls}/40 counted -> ${perHour} rolls/hour from ONE wallet at tier3/rod10 (legends=${legends}, day row before=${JSON.stringify(capBefore.row)})`);
  note(`SPAM CEILING (measured, pre-existing): the 800 ms floor is the ONLY per-cast bound, so a bot buys ${perHour} rolls/hour/wallet; the daily legend cap (FFISH_DAILY_MAX) is what actually bounds the mint.`);

  // A3 — the daily cap really stops crediting AND chronicling
  SRV._setFfishDayForTest(W.wallet, 100000);
  const feedBefore = (await feedRows()).length;
  let capLegends = 0;
  for (let i = 0; i < 12; i++) { const r = await cast(W); if (r.body && r.body.legend) capLegends++; await sleep(810); }
  const feedAfter = (await feedRows()).length;
  const st = SRV._ffishDayStatsForTest(W.wallet);
  chk(capLegends === 0, `over the daily cap NOTHING is minted: legends=${capLegends} in 12 casts, capped counter=${st.capped}`);
  chk(feedAfter === feedBefore, `...and no chronicle row is pushed over the cap (feed ${feedBefore} -> ${feedAfter})`);
}

// ============================================================= B. DROPPED REPLY
sec("B. does a dropped reply LOSE a catch or award two?");
{
  const W = await mkWallet(); await move(W);
  // The server's credit is written BEFORE the reply is serialised, so a lost reply = a credit the
  // client never learns about. Prove the credit exists with the reply discarded.
  await festival(10, 1);                     // x10 so a legend rolls inside a sim-length loop
  SRV._setFfishAuthorityForTest(true);       // put ffish in OWN_KINDS so the book is READABLE
  const before = SRV._ownAvailFor(W.wallet, "ffish", "golden_chikifish");
  let got = "", tries = 0;
  while (!got && tries < 60) { const r = await cast(W); if (r.body && r.body.legend) got = r.body.legend; tries++; await sleep(810); }
  chk(!!got, `a legend was rolled to test the credit path (legend="${got}" after ${tries} casts)`);
  const afterAvail = got ? SRV._ownAvailFor(W.wallet, "ffish", got) : null;
  const row = SRV._ownFor(W.wallet);
  chk(got ? (afterAvail >= 1) : false,
    `the server BANKED its own roll with no ack from anybody: ownAvailable(ffish,${got}) before=${before} after=${afterAvail}, cred row=${JSON.stringify(row && row.cred)}`);
  note("A LOST REPLY IS A SILENT CREDIT: ownCredit + worldFeedPush both run before res.json, and there is no ack, no idempotency key and no cancel route — so the server's roll is banked whether or not the client ever hears it. It cannot LOSE a catch (the client falls back to its local die) and it cannot award two (one report = one roll), but the two sides can disagree.");
  SRV._setFfishAuthorityForTest(false);

  // B2 — a RETRY of the same cast buys a SECOND roll (no idempotency key on a cast)
  const W2 = await mkWallet(); await move(W2);
  const r1 = await fish(W2);
  await sleep(810);
  const r2 = await fish(W2);        // identical body — a client retrying a lost reply
  chk(r1.body.counted === true && r2.body.counted === true,
    `an identical retried body 810 ms later is a WHOLE NEW ROLL (r1.counted=${r1.body.counted} r2.counted=${r2.body.counted}) — a cast has no idempotency key`);
  note("RETRY = EXTRA ROLL: /world/fish/report carries no cast id, so a client that retried a lost report would buy a second lottery ticket. The SHIPPED client never retries (Net.report_fish is fire-and-forget and _land_catch only falls back when the bite send returned seq 0), so this is reachable only by a modified client — and a modified client can already spam (case A).");
}

// ============================================================= C. IS THE CHRONICLE WHAT WAS SHOWN?
sec("C. is the chronicle row always the species the player was shown?");
{
  // C1 — there is no route that can cancel or amend a chronicle row once the cast is reported
  const src = (await import("node:fs")).readFileSync("/Users/michaelkennethbrillantes/Downloads/chiki-backend/server.js", "utf8");
  const pushes = (src.match(/worldFeedPush\(/g) || []).length;
  const cancels = (src.match(/worldFeedCancel|feedRetract|fish\/landed|fish\/cancel/g) || []).length;
  chk(cancels === 0, `no retraction route exists: worldFeedPush call sites=${pushes}, cancel/landed routes=${cancels}`);

  // C2 — THE LEVEL GATE. The ROD decides what is hooked; the TRAINER LEVEL decides what is LANDED.
  //      Player.gd snaps the line on a legend above Econ.FFISH_LEVEL (golden 5, koi 10, eel 15,
  //      rainbow 20) and the player banks NOTHING. The server used to credit and chronicle it anyway.
  const W = await mkWallet(); await move(W, 5, 5, "LowLevel");
  let leg = "", casts = 0;
  while (!leg && casts < 60) { const r = await cast(W, { lvl: 1, handle: "LowLevel" }); casts++; if (r.body && r.body.legend) leg = r.body.legend; await sleep(810); }
  const feedLow = (await feedRows()).filter((r) => r.h === "LowLevel");
  const stLow = SRV._ffishDayStatsForTest(W.wallet);
  chk(leg === "" && feedLow.length === 0,
    `a wallet declaring lvl:1 got NO legend in ${casts} tier3/rod10 casts (legend="${leg}") and NO chronicle row (rows=${feedLow.length}); outlevelled counter=${stLow.outlevelled}`);
  chk(stLow.outlevelled > 0,
    `...and the server really did roll legends it then withheld: outlevelled=${stLow.outlevelled} (a vacuous pass would read 0)`);

  // the SAME wallet, telling the truth about a seasoned trainer, still catches
  const W2 = await mkWallet(); await move(W2, 5, 5, "HighLevel");
  let leg2 = "", casts2 = 0;
  while (!leg2 && casts2 < 60) { const r = await cast(W2, { lvl: 20, handle: "HighLevel" }); casts2++; if (r.body && r.body.legend) leg2 = r.body.legend; await sleep(810); }
  chk(leg2 !== "", `a lvl:20 angler is UNAFFECTED: legend="${leg2}" after ${casts2} casts`);
  const feedHigh = (await feedRows()).filter((r) => r.h === "HighLevel");
  chk(feedHigh.length > 0 && feedHigh[feedHigh.length - 1].d === leg2,
    `...and their chronicle row IS the species the reply named (row="${feedHigh.length ? feedHigh[feedHigh.length - 1].d : "none"}" reply="${leg2}")`);

  // an OLD client that sends no lvl at all is byte-identically unchanged (no assertion = no gate)
  const W3 = await mkWallet(); await move(W3, 5, 5, "OldClient");
  let leg3 = "", casts3 = 0;
  while (!leg3 && casts3 < 60) {
    await move(W3, 5, 5, "OldClient");
    const r = await post("/world/fish/report", { wallet: W3.wallet, mktToken: W3.mktToken, tier: 3, rod: 10 });  // NO lvl key
    casts3++; if (r.body && r.body.legend) leg3 = r.body.legend; await sleep(810);
  }
  chk(leg3 !== "", `a client that sends NO lvl key is ungated, exactly as today: legend="${leg3}" after ${casts3} casts`);

  // C3 — the report is sent at the BITE, so a duel the player LOSES is still chronicled. Server-side
  //      half: the row is pushed inside the report handler, with nothing downstream of it.
  const idx = src.indexOf('worldFeedPush("ffish"');
  const after = src.slice(idx, src.indexOf("});", idx));
  chk(/res\.json\(/.test(after) && !/landed|await |confirm/.test(after),
    `the chronicle row is the LAST thing before the handler answers — nothing between the bite report and the row (${after.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length} live lines to res.json, no landing confirmation)`);
  note("BITE-TIME CHRONICLE (design cost, stated): Player.gd reports at the BITE (_update_fishing cast->bite). Every way a bite fails afterwards — the 1.8-2.8 s strike window expiring, the line snapping at tension>=99, 6 s of not reeling — leaves a chronicle row and an ffish credit for a fish that got away.");
}

// ============================================================= D. A LEGEND THE SERVER DID NOT ROLL
sec("D. can a client show/SELL itself a legend the server did not roll?");
{
  // D1 — with FFISH_AUTHORITY off (the deployed state), ffish is NOT in OWN_KINDS, so the market
  //      listing bound does not read the book at all: a fabricated fantasy fish lists for real value.
  const W = await mkWallet(); await move(W);
  const avail = SRV._ownAvailFor(W.wallet, "ffish", "rainbow_fish");
  const lst = await post("/market/op", { sid: W.netId, wallet: W.wallet, mktToken: W.mktToken, op: "list",
    listing: { id: "RVF1", kind: "ffish", item: "rainbow_fish", qty: 5, price: 1000, seller: "Cheat", wallet: W.wallet } });
  const board = (await get("/market/list")).body;
  const onBoard = JSON.stringify(board).includes("RVF1");
  chk(lst.status === 200 && onBoard,
    `a wallet the server rolled ZERO Rainbow Fish for (ownAvailable=${avail}) LISTS 5 of them: status=${lst.status} onBoard=${onBoard}`);
  note("FFISH_AUTHORITY IS OFF, so the one-die change grants the server NO refusal power today: OWN_KINDS = {mat}, the market listing bound skips ffish entirely, and a client-declared legend still converts to real $CHIKI. The change makes the BOOK true; it does not yet make the BOOK binding.");

  // D2 — but the CHRONICLE is already binding: only a server roll can enter it
  const feedBefore = (await feedRows()).length;
  await post("/market/op", { sid: W.netId, wallet: W.wallet, mktToken: W.mktToken, op: "list", listing: { id: "RVF2", kind: "ffish", item: "rainbow_fish", qty: 1, price: 1, seller: "Cheat", wallet: W.wallet } });
  const feedAfter = (await feedRows()).length;
  chk(feedAfter === feedBefore, `declaring a Rainbow Fish on the market pushes NO chronicle row (feed ${feedBefore} -> ${feedAfter}) — the world feed is server-rolled only`);
}

// ====================================================== E. THE CHRONICLE IS NO LONGER FLOODABLE
sec("E. who may write the chronicle?");
{
  // HISTORY: this case used to assert `flood > 0` — it RECORDED the hole rather than refusing it,
  // because at 8 rolling rows the flood was cosmetic griefing and the fix sat in the deferred
  // sid-auth class. Raising retention to 400 persisted rows turned that same flood into permanent
  // destruction of the island's history, so worldFeedPush now demands a proven wallet. Bisected:
  // the deployed baseline (server_chron_baseline.mjs == git HEAD:server.js) still scores
  // "24 net_ids wrote 8 of the 8 chronicle rows"; the patched server scores 0. The assertion is
  // inverted deliberately — the old expectation was a vulnerability, not a contract.
  const feed0 = await feedRows();
  const ids = Array.from({ length: 24 }, (_, i) => `godot-fl${String(i).padStart(6, "0")}`);
  for (const w of ids) await post("/world/move", { wallet: w, x: 5, z: 5, dir: 0, handle: "Legit Angler" });
  let rows = 0;
  for (let round = 0; round < 6 && rows < 8; round++) {
    await Promise.all(ids.map((w) => post("/world/move", { wallet: w, x: 5, z: 5, dir: 0, handle: "Legit Angler" })));
    const rs = await Promise.all(ids.map((w) => post("/world/fish/report", { wallet: w, tier: 3, rod: 10 })));
    rows += rs.filter((r) => r.body && r.body.legend).length;
    await sleep(810);
  }
  const feed1 = await feedRows();
  const flood = feed1.filter((r) => r.h === "Legit Angler").length;
  chk(flood === 0, `${ids.length} FABRICATED net_ids (no wallet, no signature, no token) wrote ${flood} of the ${feed1.length} chronicle rows in ${rows} legend rolls; feed was ${feed0.length} rows before (deployed HEAD scores 8 of 8 here)`);
  chk(feed1.length >= feed0.length, `and no genuine row was evicted by the attempt (feed ${feed0.length} -> ${feed1.length})`);
  note("CHRONICLE FLOOD (CLOSED by the chronicle-retention change): worldFeedPush now refuses any author that is not a proven pubkey, so an unauthenticated presence row can no longer put its handle next to a legend. The floodable behaviour is still live on the deployed HEAD — this only ships with the new server.js.");
}

console.log(`\nRV_FISH_ATTACK_DONE pass=${pass} fail=${fail} findings=${findings.length}`);
findings.forEach((f, i) => console.log(`  F${i + 1}. ${f}`));
process.exit(fail ? 1 : 0);
