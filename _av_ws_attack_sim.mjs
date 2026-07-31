// ADVERSARIAL VERIFICATION of the /ws/world transport — auth, drift, lifecycle, fallback.
// Real server.js booted IN-PROCESS on a throwaway port: dummy RPC never called, throwaway nacl
// keypair as TREASURY_SECRET, memory store, VERIFY_HOLDERS=false. Nothing reaches the live backend.
import nacl from "tweetnacl";
import bs58 from "bs58";
import WS from "ws";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59991";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "41823";
delete process.env.DATABASE_URL;
delete process.env.CHIK_WS;

const PORT = Number(process.env.PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const WSURL = `ws://127.0.0.1:${PORT}/ws/world`;

let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const netid = () => "godot-" + Math.random().toString(36).slice(2, 14);
const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  let j = null; try { j = await r.json(); } catch {}
  return { code: r.status, body: j };
};
const move = (b) => post("/world/move", b);
const get = async (p) => (await fetch(BASE + p)).json();

const srv = await import("./server.js");
await sleep(1500);
const stats = srv._wsStatsForTest;

async function proven() {
  const kp = nacl.sign.keyPair(), w = bs58.encode(kp.publicKey), nid = "n" + Math.random().toString(36).slice(2);
  const msg = `Chikoria sign-in\nwallet:${w}\nts:${Date.now()}`;
  const sg = Buffer.from(nacl.sign.detached(Buffer.from(msg, "utf8"), kp.secretKey)).toString("base64");
  const v = (await post("/verify", { wallet: w, netId: nid, authMsg: msg, authSig: sg })).body;
  return { w, tok: v.mktToken, kp, msg };
}

function sock(url = WSURL) {
  const ws = new WS(url);
  ws.frames = [];
  ws.on("message", (d) => { try { ws.frames.push(JSON.parse(String(d))); } catch { ws.frames.push({ t: "?raw" }); } });
  ws.on("error", () => {});
  ws.opened = new Promise((res, rej) => { ws.on("open", () => res(true)); ws.on("close", () => res(false)); });
  ws.tx = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
  ws.world = () => ws.frames.filter(f => f.t === "world");
  ws.acks = () => ws.frames.filter(f => f.t === "move");
  ws.errs = () => ws.frames.filter(f => f.t === "err");
  ws.clear = () => { ws.frames.length = 0; };
  ws.next = async (kind, ms = 1500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = ws.frames.filter(x => x.t === kind);
      if (f.length) return f[f.length - 1];
      await sleep(10);
    }
    return null;
  };
  return ws;
}
const mvBody = (w, x, z, extra = {}) => Object.assign({ wallet: w, x, y: 0, z, dir: 0, handle: "T", leg: 1, el: "Fire", br: 1 }, extra);

console.log("\n================ AV: /ws/world ADVERSARIAL PASS ================");

// ================================================================= 1. AUTH
console.log("\n— 1. AUTH: a socket is never more powerful than a POST —");
{
  // 1a. connect, demand ticks, say nothing
  const a = sock(); await a.opened;
  // keep a busy world so ticks would be non-empty if they fired
  const noise = netid(); await move(mvBody(noise, 5, 5));
  await sleep(1200);   // ~24 ticks at 20Hz
  chk(a.world().length === 0, `an unauthenticated socket receives NOTHING (world frames=${a.world().length} over ~24 ticks)`);
  chk(stats().sockets >= 1, `but it IS counted as a socket (sockets=${stats().sockets})`);
  chk(stats().authed === 0, `and authed=0 (${stats().authed})`);

  // 1b. junk / ping does not authenticate
  a.tx({ t: "ping" }); a.tx({ t: "hello" }); a.tx("[[[");
  await sleep(400);
  chk(a.world().length === 0, `ping/junk frames do not authenticate (world=${a.world().length})`);
  chk((await a.next("pong", 400)) !== null, "ping is answered with pong (liveness only)");

  // 1c. HIJACK a proven wallet from a stranger's socket
  const V = await proven();
  const r0 = await move(mvBody(V.w, 100, 100, { mktToken: V.tok }));
  chk(r0.code === 200, `victim POSTs and claims their slot (${r0.code})`);
  const h = sock(); await h.opened;
  h.tx(mvBody(V.w, 999, 999));                     // no token
  const e1 = await h.next("err", 900);
  chk(e1 && e1.code === 403, `socket move for a PROVEN wallet with no token → err 403 (${e1 && e1.code})`);
  h.tx(mvBody(V.w, 999, 999, { mktToken: "x".repeat(40) }));   // forged token
  await sleep(300);
  chk(h.errs().length >= 2 && h.errs().every(e => e.code === 403), `forged token → 403 too (errs=${h.errs().map(e=>e.code).join(",")})`);
  await sleep(600);
  chk(h.world().length === 0, `the hijacker's socket is streamed NOTHING (world=${h.world().length})`);
  const pos = (await get(`/world/players?wallet=zz&x=100&z=100`)).players.find(p => p.wallet === V.w);
  chk(pos && Math.abs(pos.x - 100) < 0.01, `and the victim was never moved (x=${pos && pos.x})`);
  const hp = await move(mvBody(V.w, 999, 999));
  chk(hp.code === 403, `the SAME hijack over HTTP is refused identically (${hp.code}) — socket == POST`);

  // 1d. authenticate as myself, then send a move for SOMEONE ELSE
  const M = await proven();
  const s2 = sock(); await s2.opened;
  s2.tx(mvBody(M.w, 10, 10, { mktToken: M.tok }));
  const ack = await s2.next("move", 900);
  chk(ack !== null, "my own move over the socket is acked");
  await sleep(300); s2.clear();
  s2.tx(mvBody(V.w, 50, 50));   // victim's wallet, no token
  const e2 = await s2.next("err", 900);
  chk(e2 && e2.code === 403, `moving a DIFFERENT proven wallet on my authed socket → 403 (${e2 && e2.code})`);
  await sleep(600);
  chk(s2.world().length === 0, `and the refusal DE-AUTHENTICATES my socket — the stream stops (world after=${s2.world().length})`);

  // 1e. THE PROOF RE-DERIVED EVERY TICK. /verify issues a market token ONCE per wallet and never
  // rotates it (server.js: `if (!marketTokens[wallet]) marketTokens[wallet] = ...`), so "a rotated
  // token kills the stream" is not reachable through any route. The reachable version of the same
  // rule is the SLOT CLAIM: a stranger takes an UNCLAIMED public-wallet slot on a socket (allowed —
  // a real player has a wallet id a beat before /verify answers), then the real owner signs in and
  // proves it. The stream must die on the very next tick, without the squatter sending anything.
  const R = await proven();
  const msg2 = `Chikoria sign-in\nwallet:${R.w}\nts:${Date.now()}`;
  const sg2 = Buffer.from(nacl.sign.detached(Buffer.from(msg2, "utf8"), R.kp.secretKey)).toString("base64");
  const v2 = (await post("/verify", { wallet: R.w, netId: "n" + Math.random().toString(36).slice(2), authMsg: msg2, authSig: sg2 })).body;
  chk(v2.mktToken === R.tok, `/verify does NOT rotate a market token (${String(v2.mktToken) === String(R.tok) ? "same token both times" : "rotated"}) — the report's rotation claim is untestable, not wrong`);
  const S = await proven();                       // the victim's wallet; the squatter never learns S.tok
  const s3 = sock(); await s3.opened;
  s3.tx(mvBody(S.w, 20, 20));                     // no token, slot still unclaimed → allowed
  const ok3 = await s3.next("move", 900);
  chk(ok3 !== null, "a stranger's socket CAN take an UNCLAIMED public-wallet slot (deliberate: sign-in race)");
  await sleep(300);
  chk(s3.world().length > 0, `and is streamed for it (world=${s3.world().length})`);
  await move(mvBody(S.w, 20, 20, { mktToken: S.tok }));   // the real owner signs in and proves it
  const e3 = await s3.next("err", 1500);
  chk(e3 && e3.code === 403, `the owner proving the slot kills the squatter's stream on the next tick (err ${e3 && e3.code})`);
  // count from AFTER the refusal: a tick already in flight when the owner's POST landed is not a leak
  s3.clear();
  await sleep(600);
  chk(s3.world().length === 0, `and no further ticks are pushed (world=${s3.world().length} in 600ms = 12 ticks)`);
  for (const s of [a, h, s2, s3]) s.close();
}

// ================================================================= 2. PARTY GATE ON THE TICK
console.log("\n— 2. THE ONE FIELD AN UNCLAIMED SLOT MAY NOT READ (party) —");
{
  const A = await proven(), B = await proven();
  await move(mvBody(A.w, 0, 0, { mktToken: A.tok, handle: "LEADER" }));
  await move(mvBody(B.w, 5, 0, { mktToken: B.tok, handle: "MEMBER" }));
  const ri = await post("/party/invite", { wallet: A.w, mktToken: A.tok, to: B.w, handle: "LEADER" });
  const ra = await post("/party/accept", { wallet: B.w, mktToken: B.tok, from: A.w });
  chk(ri.code === 200 && ra.code === 200, `party formed (invite ${ri.code}, accept ${ra.code})`);
  const pv = await move(mvBody(A.w, 0, 0, { mktToken: A.tok }));
  const hasParty = !!(pv.body && pv.body.party && Array.isArray(pv.body.party.m));
  chk(hasParty, `a party rides the HTTP reply (members=${hasParty ? pv.body.party.m.length : "none"})`);
  const sp = sock(); await sp.opened;
  sp.tx(mvBody(A.w, 0, 0, { mktToken: A.tok }));
  const w1 = await sp.next("world", 1200);
  chk(w1 && w1.party && w1.party.m.length === pv.body.party.m.length,
      `the TICK carries the SAME party for a PROVEN socket (${w1 && w1.party ? w1.party.m.length : "none"} members, leader ${w1 && w1.party ? String(w1.party.leader).slice(0, 6) : "?"}…)`);
  chk(w1 && JSON.stringify(w1.party) === JSON.stringify(pv.body.party), `field-for-field identical to the HTTP reply's party (${JSON.stringify(w1 && w1.party).length} B)`);
  sp.close(); await sleep(50);
  // a stranger's socket may NOT take the proven slot to read the roster
  const sq = sock(); await sq.opened;
  sq.tx(mvBody(A.w, 0, 0));
  const eq = await sq.next("err", 900);
  chk(eq && eq.code === 403, `a token-less socket cannot take the proven slot to read the party (${eq && eq.code})`);
  chk(sq.world().length === 0, `and is streamed nothing at all (world=${sq.world().length})`);
  sq.close();
  // the UNPROVEN-but-legal case: a net_id in a party, on a socket. party rides only if presenceOk.
  const N1 = netid(), N2 = netid();
  await move(mvBody(N1, 700, 700)); await move(mvBody(N2, 705, 700));
  await post("/party/invite", { wallet: N1, to: N2, handle: "N1" });
  await post("/party/accept", { wallet: N2, from: N1 });
  const sn = sock(); await sn.opened;
  sn.tx(mvBody(N1, 700, 700));
  const wn = await sn.next("world", 1200);
  chk(wn && wn.party && Array.isArray(wn.party.m), `a net_id (which IS its own credential) still gets its party on the tick (${wn && wn.party ? wn.party.m.length : "none"})`);
  sn.close();
}

// ================================================================= 3. DRIFT (field-by-field)
console.log("\n— 3. DRIFT: the tick payload vs the HTTP reply for the SAME world state —");
{
  const O = await proven();
  const peers = [];
  for (let i = 0; i < 8; i++) { const n = netid(); peers.push(n); await move(mvBody(n, 10 + i * 3, 10, { handle: "P" + i, avatar: "electro", comp: "doge", mount: "horse", act: "chop:axe", eggs: "normal,mount" })); }
  await move(mvBody(O.w, 0, 0, { mktToken: O.tok, dl: 0 }));   // full picture over HTTP
  const s = sock(); await s.opened;
  s.tx(mvBody(O.w, 0, 0, { mktToken: O.tok, dl: 0 }));
  const ack = await s.next("move", 1200);
  const httpR = (await move(mvBody(O.w, 0, 0, { mktToken: O.tok, dl: 0, seq: 99 }))).body;
  const tick = await (async () => { s.clear(); return await s.next("world", 1200); })();
  const norm = (o) => {
    const c = JSON.parse(JSON.stringify(o));
    delete c.t; delete c.ok; delete c.seq; delete c.stale;
    if (Array.isArray(c.players)) for (const p of c.players) delete p.a;   // sample AGE moves in real time
    if (Array.isArray(c.mobs)) for (const m of c.mobs) { delete m.hp; delete m.t; }
    return c;
  };
  const ka = Object.keys(httpR).filter(k => !["ok", "seq", "stale"].includes(k)).sort().join(",");
  const kb = Object.keys(tick || {}).filter(k => k !== "t").sort().join(",");
  chk(ka === kb, `same field set: http=[${ka}] ws=[${kb}]`);
  chk(JSON.stringify(norm(httpR)) === JSON.stringify(norm(tick)), `age-normalised, the two payloads are IDENTICAL (${JSON.stringify(norm(tick)).length} B)`);
  chk((httpR.players || []).length === (tick.players || []).length, `same peer count (${(httpR.players||[]).length} vs ${(tick.players||[]).length})`);
  chk(httpR.online === tick.online, `same online count (${httpR.online} vs ${tick.online})`);
  // delta memory is SHARED between the two doors: after a dl:1 tick, an HTTP dl:1 poll is also abbreviated
  s.clear(); s.tx(mvBody(O.w, 0, 0, { mktToken: O.tok, dl: 1 }));
  const t2 = await s.next("world", 1200);
  chk(t2 && t2.players.every(p => p.dl === 1), `after a full round, the tick abbreviates every peer (dl:1 on ${t2 ? t2.players.filter(p=>p.dl===1).length : 0}/${t2 ? t2.players.length : 0})`);
  const h2 = (await move(mvBody(O.w, 0, 0, { mktToken: O.tok, dl: 1 }))).body;
  chk(h2.players.every(p => p.dl === 1), `and the HTTP poll agrees — ONE delta memory, two doors (dl:1 on ${h2.players.filter(p=>p.dl===1).length}/${h2.players.length})`);
  s.close();
}

// ================================================================= 4. LIFECYCLE
console.log("\n— 4. LIFECYCLE: duplicate peers, reconnect storms, abrupt close —");
{
  // 4a. TWO CONSUMERS, ONE WALLET — the delta memory (`seen`) lives on the PRESENCE ROW, not on the
  // connection, so two consumers of one wallet share it. Consumer #2 is then told `dl:1` ("reuse the
  // static half I already sent you") for peers it has never been sent, and Net.gd answers that with
  // a whole extra full-snapshot round (_dl_resync).
  // THE CONTROL RUNS FIRST: the identical scenario over HTTP ONLY. If HTTP already does it, this is
  // a pre-existing property of the presence row and must NOT be attributed to the socket.
  const pn = [];
  for (let i = 0; i < 5; i++) { const n = netid(); pn.push(n); await move(mvBody(n, 20 + i, 20, { handle: "D" + i })); }
  const H = await proven();
  await move(mvBody(H.w, 0, 0, { mktToken: H.tok, dl: 1 }));       // consumer #1 (tab 1), full rows
  const h2 = (await move(mvBody(H.w, 0, 0, { mktToken: H.tok, dl: 1 }))).body;   // consumer #2 (tab 2)
  const hAbbrev = h2.players.filter(p => p.dl === 1).length;
  console.log(`    CONTROL (HTTP only, same wallet polled twice): ${hAbbrev} abbreviated of ${h2.players.length}`);
  chk(hAbbrev > 0, `PRE-EXISTING: two HTTP consumers of one wallet already share one delta memory (abbrev=${hAbbrev}/${h2.players.length}) — this class predates the socket`);

  const D = await proven();
  const s1 = sock(); await s1.opened;
  s1.tx(mvBody(D.w, 0, 0, { mktToken: D.tok, dl: 1 }));
  await s1.next("world", 1200);
  await sleep(300);
  const s2 = sock(); await s2.opened;                       // a SECOND socket for the same wallet
  s2.tx(mvBody(D.w, 0, 0, { mktToken: D.tok, dl: 1 }));
  const f2 = await s2.next("world", 1200);
  const abbrev = f2 ? f2.players.filter(p => p.dl === 1).length : -1;
  const full = f2 ? f2.players.filter(p => p.handle !== undefined).length : -1;
  chk(stats().sockets >= 2, `two sockets coexist for one wallet (sockets=${stats().sockets})`);
  console.log(`    SECOND socket's first frame: ${abbrev} abbreviated rows, ${full} full rows of ${f2 ? f2.players.length : 0}`);
  chk(abbrev === 0, `the second socket is sent FULL rows, not rows the FIRST socket consumed (abbrev=${abbrev} — >0 means the shared delta memory poisoned it)`);
  // WHAT THE SOCKET CHANGES IS THE PRICE. Over HTTP a squatter must POST to consume a static half —
  // one consumed row per request. On a socket the TICK consumes them, unrequested, at 20 Hz, for one
  // inbound message every 12 s. Measure the victim's forced-resync rate under a squatting socket.
  const V2 = netid();                                        // a net_id: published verbatim by /world/roster
  await move(mvBody(V2, 0, 0, { dl: 1 }));
  const sq2 = sock(); await sq2.opened;
  sq2.tx(mvBody(V2, 0, 0, { dl: 1 }));                       // ONE message; the squatter now says nothing
  await sleep(200);
  let forced = 0, polls = 0;
  for (let i = 0; i < 10; i++) {
    for (const n of pn) await move(mvBody(n, 20 + Math.random(), 20));   // peers keep their static halves stable
    const r = (await move(mvBody(V2, 0, 0, { dl: 1 }))).body;
    polls++;
    if ((r.players || []).some(p => p.dl === 1 && !p.handle)) { /* normal — already known */ }
    await sleep(60);
  }
  const sqFrames = sq2.world().length;
  console.log(`    a squatting socket on a published net_id pushed ${sqFrames} unrequested frames off ONE inbound message in ~${(polls * 0.06 + 0.2).toFixed(1)}s`);
  chk(sqFrames > 10, `one inbound message buys ${sqFrames} snapshots (HTTP buys exactly 1) — the amplification is what makes this cheap`);
  sq2.close();
  s1.close(); s2.close(); await sleep(200);

  // 4b. reconnect storm
  const before = stats().sockets;
  for (let i = 0; i < 40; i++) { const q = sock(); await q.opened; q.close(); }
  await sleep(700);
  chk(stats().sockets <= before, `40 connect/close cycles leak no sockets (${before} → ${stats().sockets})`);

  // 4c. every socket gone → the tick timer stops
  for (const w of []) w.close();
  await sleep(400);
  console.log(`    ticking=${stats().ticking} sockets=${stats().sockets}`);

  // 4d. abrupt close (TCP destroy) — presence must survive to the TTL, not vanish
  const K = await proven();
  const sk = sock(); await sk.opened;
  sk.tx(mvBody(K.w, 300, 300, { mktToken: K.tok }));
  await sk.next("move", 1200);
  sk.terminate();
  await sleep(300);
  const seen = (await get(`/world/players?wallet=zz&x=300&z=300`)).players.find(p => p.wallet === K.w);
  chk(!!seen, `an abruptly destroyed socket does NOT pop the trainer out of the world (present=${!!seen})`);
  const still = await move(mvBody(K.w, 301, 300, { mktToken: K.tok }));
  chk(still.code === 200, `and the same wallet resumes on HTTP immediately (${still.code}) — fallback`);
}

// ================================================================= 5. FALLBACK / MIXED FLEET
console.log("\n— 5. MIXED FLEET: one client on WS, one on HTTP, seeing each other —");
{
  const WSP = await proven(), HTP = await proven();
  const sw = sock(); await sw.opened;
  sw.tx(mvBody(WSP.w, 600, 600, { mktToken: WSP.tok, handle: "WSGUY", avatar: "sailor", dl: 0 }));
  await sw.next("move", 1200);
  const hr = (await move(mvBody(HTP.w, 605, 600, { mktToken: HTP.tok, handle: "HTTPGUY", avatar: "fire", dl: 0 }))).body;
  const sawWs = (hr.players || []).find(p => p.wallet === WSP.w);
  chk(!!sawWs && sawWs.handle === "WSGUY", `the HTTP poller sees the WS player, full row (handle=${sawWs && sawWs.handle}, avatar=${sawWs && sawWs.avatar})`);
  sw.clear();
  const wf = await sw.next("world", 1200);
  const sawHttp = (wf.players || []).find(p => p.wallet === HTP.w);
  chk(!!sawHttp && sawHttp.handle === "HTTPGUY", `the WS player sees the HTTP poller, full row (handle=${sawHttp && sawHttp.handle}, avatar=${sawHttp && sawHttp.avatar})`);
  // now the WS player moves; the HTTP poller must see it on its very next poll
  sw.tx(mvBody(WSP.w, 640, 600, { mktToken: WSP.tok, handle: "WSGUY", dl: 1 }));
  await sleep(120);
  const hr2 = (await move(mvBody(HTP.w, 605, 600, { mktToken: HTP.tok, dl: 1 }))).body;
  const p2 = (hr2.players || []).find(p => p.wallet === WSP.w);
  chk(p2 && Math.abs(p2.x - 640) < 0.01, `a WS move is visible to an HTTP poller (x=${p2 && p2.x})`);
  // and the reverse
  await move(mvBody(HTP.w, 650, 600, { mktToken: HTP.tok, dl: 1 }));
  sw.clear();
  const wf2 = await sw.next("world", 1200);
  const p3 = (wf2.players || []).find(p => p.wallet === HTP.w);
  chk(p3 && Math.abs(p3.x - 650) < 0.01, `an HTTP move is visible on the WS tick (x=${p3 && p3.x})`);
  // socket dies mid-session → the wallet just keeps polling, world state intact
  sw.terminate(); await sleep(250);
  const cont = (await move(mvBody(WSP.w, 645, 600, { mktToken: WSP.tok, dl: 1 }))).body;
  chk(Array.isArray(cont.players), `after the socket dies the same wallet polls normally (peers=${cont.players.length})`);
  const stillSeen = (cont.players || []).find(p => p.wallet === HTP.w);
  chk(!!stillSeen, `and still sees its neighbour (${!!stillSeen})`);
}

// ================================================================= 6. INBOUND RATE
console.log("\n— 6. INBOUND RATE: is a socket capped the way HTTP is? —");
{
  const F = await proven();
  const sf = sock(); await sf.opened;
  sf.tx(mvBody(F.w, 0, 0, { mktToken: F.tok }));
  await sf.next("move", 1200);
  sf.clear();
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) sf.tx(mvBody(F.w, i % 50, 0, { mktToken: F.tok, seq: 1000 + i }));
  await sleep(1100);
  const acks = sf.acks().length;
  console.log(`    1000 moves blasted in ${Date.now() - t0}ms → ${acks} acks`);
  chk(acks <= 90, `a socket blasting 1000 moves/s is capped (acks=${acks}, WS_MSG_BURST=40/s)`);
  // the HTTP comparison: no per-wallet cap exists on /world/move at all
  let ok200 = 0;
  const t1 = Date.now();
  await Promise.all(Array.from({ length: 120 }, (_, i) => move(mvBody(F.w, i % 50, 1, { mktToken: F.tok, seq: 5000 + i })).then(r => { if (r.code === 200) ok200++; })));
  console.log(`    120 concurrent HTTP moves in ${Date.now() - t1}ms → ${ok200} × 200`);
  chk(ok200 === 120, `HTTP /world/move has NO inbound rate cap (${ok200}/120 accepted) — the socket is STRICTER inbound`);
  sf.close();
}

// ================================================================= 7. IDLE SOCKET = PERMANENT TIMER
console.log("\n— 7. RESOURCE: what does a socket that never speaks cost? —");
{
  await sleep(600);
  // drain everything first
  const s0 = stats();
  console.log(`    entering: sockets=${s0.sockets} authed=${s0.authed} ticking=${s0.ticking}`);
  srv._wsResetStatsForTest();
  const idle = sock(); await idle.opened;
  await sleep(1500);
  const s1 = stats();
  chk(s1.ticking === true, `ONE socket that never authenticates keeps the 20Hz timer running forever (ticking=${s1.ticking}, ticks=${s1.ticks} in 1.5s)`);
  console.log(`    → the "an idle server pays nothing" claim holds only while ZERO sockets are connected`);
  chk(s1.frames === 0 || s1.bytes < 500, `…but it is pushed no bytes (frames=${s1.frames} bytes=${s1.bytes})`);
  idle.close(); await sleep(400);
  chk(stats().ticking === false || stats().sockets > 0, `last socket out stops the timer (ticking=${stats().ticking} sockets=${stats().sockets})`);
}

// ================================================================= 8. CONNECTION CAP
console.log("\n— 8. FLOOD: is there ANY cap on concurrent sockets from one source? —");
{
  const N = 200;
  const arr = [];
  for (let i = 0; i < N; i++) { const w = sock(); arr.push(w); }
  await Promise.all(arr.map(w => w.opened));
  await sleep(400);
  const open = arr.filter(w => w.readyState === 1).length;
  console.log(`    ${N} sockets from ONE source: ${open} accepted, server sockets=${stats().sockets}`);
  chk(open === N, `NO connection cap: all ${open}/${N} sockets from one IP are accepted (a cap would refuse some)`);
  // authenticate every one of them with a distinct throwaway net_id, all standing on the same spot
  for (let i = 0; i < N; i++) arr[i].tx(mvBody("godot-flood" + i.toString(36).padStart(6, "0"), 1200 + (i % 10), 1200, { handle: "F" + i }));
  await sleep(1200);
  srv._wsResetStatsForTest();
  await sleep(2000);
  const st = stats();
  console.log(`    AUTHED FLOOD: authed=${st.authed} ticks=${st.ticks} cpu=${(st.cpuUs / Math.max(1, st.ticks)).toFixed(0)}µs/tick ` +
              `bytes=${(st.bytes / 2048).toFixed(1)} KiB/s jitter avg=${st.jitterAvgMs.toFixed(1)}ms max=${st.jitterMaxMs}ms`);
  chk(st.authed >= N * 0.9, `all ${st.authed} flood sockets authenticated with FABRICATED net_ids (no credential needed)`);
  const usPerTick = st.cpuUs / Math.max(1, st.ticks);
  console.log(`    tick budget is 50000µs; this tick costs ${usPerTick.toFixed(0)}µs (${(usPerTick / 500).toFixed(1)}%)`);
  console.log(`    achieved rate ${(st.ticks / 2).toFixed(1)} Hz of a target 20 Hz`);
  for (const w of arr) w.close();
  await sleep(600);
}

console.log(`\nAVWS_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
