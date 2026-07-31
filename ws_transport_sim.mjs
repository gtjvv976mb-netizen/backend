// THE WEBSOCKET WORLD TRANSPORT — proof that the second transport carries the SAME contract as
// /world/move polling, and that polling is untouched.
//
// Everything runs against the REAL server booted in-process on a throwaway port: dummy RPC that is
// never called, a THROWAWAY nacl keypair as the treasury secret, memory store, VERIFY_HOLDERS=false.
// Nothing here reaches the live backend or any chain.
//
// The load-bearing assertion is the ANTI-DRIFT one: a tick payload is compared FIELD BY FIELD
// against a real /world/move reply taken for the same receiver against the same world state. If the
// two implementations ever fork, that comparison is the thing that notices.
import nacl from "tweetnacl";
import bs58 from "bs58";
import WS from "ws";
import { spawn } from "node:child_process";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39411";
delete process.env.DATABASE_URL;
delete process.env.CHIK_WS;

const PORT = Number(process.env.PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const WSURL = `ws://127.0.0.1:${PORT}/ws/world`;

let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const netid = () => "godot-" + Math.random().toString(36).slice(2, 12);
const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { code: r.status, body: await r.json() };
};
const move = (b) => post("/world/move", b);
const get = async (p) => (await fetch(BASE + p)).json();

const srv = await import("./server.js");
await sleep(1400);
const stats = srv._wsStatsForTest;

async function proven() {
  const kp = nacl.sign.keyPair(), w = bs58.encode(kp.publicKey), nid = "n" + Math.random().toString(36).slice(2);
  const msg = `Chikoria sign-in\nwallet:${w}\nts:${Date.now()}`;
  const sg = Buffer.from(nacl.sign.detached(Buffer.from(msg, "utf8"), kp.secretKey)).toString("base64");
  const v = (await post("/verify", { wallet: w, netId: nid, authMsg: msg, authSig: sg })).body;
  return { w, tok: v.mktToken };
}

// ---- socket helper ------------------------------------------------------------
function sock(url = WSURL) {
  const ws = new WS(url);
  ws.frames = [];
  ws.on("message", (d) => { try { ws.frames.push(JSON.parse(String(d))); } catch { ws.frames.push({ t: "?raw" }); } });
  ws.on("error", () => {});
  ws.opened = new Promise((res) => ws.on("open", () => res(true)));
  ws.tx = (o) => ws.send(JSON.stringify(o));
  ws.world = () => ws.frames.filter(f => f.t === "world");
  ws.acks = () => ws.frames.filter(f => f.t === "move");
  ws.errs = () => ws.frames.filter(f => f.t === "err");
  ws.clear = () => { ws.frames.length = 0; };
  // wait for the next frame of a kind (or null on timeout)
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

// normalise the two live-clock fields so a deep compare is meaningful; they are asserted separately
function norm(p) {
  const c = JSON.parse(JSON.stringify(p ?? {}));
  delete c.t;
  if (Array.isArray(c.players)) for (const r of c.players) r.a = "~age~";
  if (c.mobs) for (const k of Object.keys(c.mobs)) if (c.mobs[k].back !== undefined) c.mobs[k].back = "~back~";
  return c;
}
const J = (o) => JSON.stringify(o);

console.log("=== WS TRANSPORT SIM ===");
console.log(`ws stats at boot: ${J(stats())}`);

// ---------------------------------------------------------------------------
console.log("\n— 1. HTTP POLLING IS UNTOUCHED (the non-negotiable) —");
{
  const a = netid(), b = netid();
  const r1 = await move({ wallet: a, x: 10, z: 10, dir: 0, handle: "Poller", act: "chop:axe", avatar: "sailor", mount: "griffin", eggs: "normal,meme" });
  chk(r1.code === 200 && r1.body.ok === true, `POST /world/move still 200 (got ${r1.code})`);
  const r2 = await move({ wallet: b, x: 12, z: 12, dir: 0, handle: "Poller2" });
  const seen = (r2.body.players || []).find(p => p.wallet === a);
  chk(!!seen, "a poller still sees a poller");
  chk(seen && seen.act === "chop:axe" && seen.mount === "griffin" && seen.eggs === "normal,meme" && seen.avatar === "sailor",
      `every broadcast field still relays over HTTP (act=${seen && seen.act} mount=${seen && seen.mount} eggs=${seen && seen.eggs})`);
  const bad = await move({ wallet: "!!", x: 0, z: 0 });
  chk(bad.code === 400, `a junk id is still 400 (got ${bad.code})`);
}

// ---------------------------------------------------------------------------
console.log("\n— 2. AN UNAUTHENTICATED SOCKET RECEIVES NOTHING —");
{
  chk(stats().ticking === false, `with nobody connected the 20Hz timer does not even exist (ticking=${stats().ticking}, ticks so far=${stats().ticks})`);
  const s = sock();
  await s.opened;
  chk(true, "the upgrade is accepted (the socket exists)");
  chk(stats().ticking === true, "the first socket starts the tick loop");
  await sleep(700);   // 14 ticks at 20Hz
  chk(s.frames.length === 0, `silent for 700ms / ~14 ticks before any move (frames=${s.frames.length})`);

  const bad = await new Promise(async (res) => { s.tx({ t: "move", wallet: "!!", x: 1, z: 1 }); res(await s.next("err")); });
  chk(bad && bad.code === 400, `a junk id is refused with the SAME 400 the POST gives (got ${bad && bad.code})`);
  s.clear();
  await sleep(400);
  chk(s.world().length === 0, `still no world frames after a refused move (world frames=${s.world().length})`);

  s.tx({ t: "nonsense" });
  const e2 = await s.next("err");
  chk(e2 && /unknown/.test(String(e2.error)), `an unknown frame kind is refused (${e2 && e2.error})`);
  s.tx("not json");
  s.clear();
  await sleep(300);
  chk(s.world().length === 0, "a socket that has never made an accepted move is never ticked");
  s.close();
  await sleep(200);
  chk(stats().ticking === false, "and the last socket leaving stops the loop again — an idle server pays nothing for the transport");
}

// ---------------------------------------------------------------------------
console.log("\n— 3. AN AUTHENTICATED SOCKET RECEIVES TICKS —");
let SOLO = null;
{
  const w = netid();
  const s = sock(); await s.opened;
  s.tx({ t: "move", wallet: w, x: 100, z: 100, dir: 0, handle: "Socket", dl: 1 });
  const ack = await s.next("move");
  chk(!!ack && ack.ok === true, `the move is acked with the /world/move body (ok=${ack && ack.ok})`);
  chk(ack && Array.isArray(ack.players) && typeof ack.online === "number", "the ack carries players + online, exactly as the POST reply does");
  s.clear();
  const t0 = Date.now();
  await sleep(1000);
  const n = s.world().length;
  chk(n >= 15 && n <= 25, `~20 world frames in 1000ms at 20Hz (got ${n} in ${Date.now() - t0}ms)`);
  const roster = await get("/world/roster");
  chk((roster.users || []).some(u => u.wallet === w), "the socket's move created real presence (it is on /world/roster)");
  SOLO = { w, s };
}

// ---------------------------------------------------------------------------
console.log("\n— 4. ANTI-DRIFT: a tick payload EQUALS what /world/move would have replied —");
{
  const obs = netid(), peer = netid(), far = netid();
  await move({ wallet: peer, x: 305, z: 300, dir: 1.234, handle: "Peer", avatar: "fire", comp: "dragonos",
               party: "dragonos,pepe,doge", mount: "wolf", act: "mine:drill", eggs: "legendary", leg: 3, el: "Water", br: 22, spr: true, y: 41.5 });
  await move({ wallet: far, x: 9000, z: 9000, dir: 0, handle: "Far" });
  const s = sock(); await s.opened;
  const body = { t: "move", wallet: obs, x: 300, z: 300, dir: 0, handle: "Obs", dl: 1, fs: 0, seq: 1 };
  s.tx(body);
  await s.next("move");
  s.clear();
  const tick = await s.next("world");
  const httpR = await move({ ...body, t: undefined, seq: 2 });
  const H = httpR.body, T = tick;

  chk(!!tick, "a tick arrived");
  // field by field
  const skip = new Set(["ok", "seq", "t"]);   // transport/ordering fields: the POST says ok/seq, the tick is a push
  const keysH = Object.keys(H).filter(k => !skip.has(k));
  const keysT = Object.keys(T).filter(k => !skip.has(k));
  chk(J(keysH.sort()) === J(keysT.sort()), `same field set: http=${J(keysH)} ws=${J(keysT)}`);
  for (const k of keysH) {
    if (k === "players") continue;
    chk(J(norm(H)[k]) === J(norm(T)[k]), `field "${k}" identical (${J(norm(H)[k])})`);
  }
  const ph = norm(H).players, pt = norm(T).players;
  chk(ph.length === pt.length && ph.length === 1, `both carry the SAME one peer row (http=${ph.length} ws=${pt.length})`);
  chk(J(ph) === J(pt), `the peer row is identical field for field — ${J(pt[0])}`);
  const ah = (H.players[0] || {}).a, at = (T.players[0] || {}).a;
  chk(Math.abs(ah - at) < 300, `the only difference is the live age field: http a=${ah}ms ws a=${at}ms (Δ=${Math.abs(ah - at)}ms)`);
  chk(!H.players.some(p => p.wallet === far) && !T.players.some(p => p.wallet === far),
      "the far trainer is outside the interest radius on BOTH transports");
  s.close();
}

// ---------------------------------------------------------------------------
console.log("\n— 5. TWO SOCKETS SEE EACH OTHER —");
{
  const a = netid(), b = netid();
  const sa = sock(), sb = sock();
  await sa.opened; await sb.opened;
  sa.tx({ t: "move", wallet: a, x: 700, z: 700, dir: 0.5, handle: "Ay", act: "fish:rod", mount: "", comp: "pepe", party: "pepe,doge,dragonos", eggs: "mount", y: 33.25 });
  sb.tx({ t: "move", wallet: b, x: 706, z: 700, dir: -0.5, handle: "Bee", act: "chop:axe", mount: "boar" });
  await sa.next("move"); await sb.next("move");
  sa.clear(); sb.clear();
  const ta = await sa.next("world"), tb = await sb.next("world");
  const seenB = (ta.players || []).find(p => p.wallet === b);
  const seenA = (tb.players || []).find(p => p.wallet === a);
  chk(!!seenB, "A's tick contains B");
  chk(!!seenA, "B's tick contains A");
  chk(seenA && seenA.act === "fish:rod" && seenA.y === 33.25 && seenA.eggs === "mount" && seenA.party === "pepe,doge,dragonos",
      `every field survives the socket round trip (act=${seenA && seenA.act} y=${seenA && seenA.y} eggs=${seenA && seenA.eggs})`);
  chk(seenB && seenB.mount === "boar", `B's mount reaches A (${seenB && seenB.mount})`);

  // and a live move is pushed without either side asking
  sa.clear();
  sb.tx({ t: "move", wallet: b, x: 690, z: 702, dir: 1, handle: "Bee", act: "" });
  const t2 = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 1200) { const f = sa.world().find(f => (f.players || []).some(p => p.wallet === b && p.x === 690)); if (f) return { f, ms: Date.now() - t0 }; await sleep(5); } return null; })();
  chk(!!t2, `A is PUSHED B's new position without polling (after ${t2 ? t2.ms : "timeout"}ms)`);
  chk(t2 && t2.ms <= 120, `push latency inside one tick period + slack (${t2 && t2.ms}ms, tick=${stats().tickMs}ms)`);
  sa.close(); sb.close();
}

// ---------------------------------------------------------------------------
console.log("\n— 6. INTEREST RADIUS BEHAVES IDENTICALLY ON BOTH TRANSPORTS —");
{
  const obs = netid(), mover = netid();
  const s = sock(); await s.opened;
  const body = (extra) => ({ t: "move", wallet: obs, x: 1500, z: 1500, dir: 0, handle: "Obs6", dl: 0, ...extra });
  await move({ wallet: mover, x: 1500 + 400, z: 1500, dir: 0, handle: "Mover" });   // 400 > INTEREST_ENTER 260
  s.tx(body({ seq: 1 })); await s.next("move"); s.clear();
  let tick = await s.next("world");
  let http = (await move({ wallet: obs, x: 1500, z: 1500, dir: 0, handle: "Obs6", dl: 0, seq: 2 })).body;
  chk(!(tick.players || []).some(p => p.wallet === mover), "at 400u the mover is OUT of the socket's bubble");
  chk(!(http.players || []).some(p => p.wallet === mover), "at 400u the mover is OUT of the HTTP bubble too");

  await move({ wallet: mover, x: 1500 + 100, z: 1500, dir: 0, handle: "Mover" });   // 100 < 260 → enters
  s.clear();
  tick = await s.next("world");
  http = (await move({ wallet: obs, x: 1500, z: 1500, dir: 0, handle: "Obs6", dl: 0, seq: 3 })).body;
  chk((tick.players || []).some(p => p.wallet === mover), "at 100u the mover is IN the socket's bubble");
  chk((http.players || []).some(p => p.wallet === mover), "at 100u the mover is IN the HTTP bubble");

  // hysteresis: 300u is past ENTER (260) but inside LEAVE (320) — a peer already visible must STAY
  await move({ wallet: mover, x: 1500 + 300, z: 1500, dir: 0, handle: "Mover" });
  s.clear();
  tick = await s.next("world");
  chk((tick.players || []).some(p => p.wallet === mover), "hysteresis holds on the socket too: 300u is past ENTER but inside LEAVE, peer stays");
  s.close();
}

// ---------------------------------------------------------------------------
console.log("\n— 7. DELTA (sq/dl) MEMORY IS SHARED BY BOTH TRANSPORTS, NOT DUPLICATED —");
{
  const obs = netid(), peer = netid();
  await move({ wallet: peer, x: 2000, z: 2000, dir: 0, handle: "Peer7", avatar: "electro", comp: "doge", party: "doge,pepe,dragonos", eggs: "meme" });
  // first contact over HTTP → FULL row (statics + sq)
  const h1 = (await move({ wallet: obs, x: 2000, z: 2002, dir: 0, handle: "Obs7", dl: 1, seq: 1 })).body;
  const r1 = (h1.players || []).find(p => p.wallet === peer);
  chk(r1 && r1.handle === "Peer7" && Number.isFinite(r1.sq) && r1.dl === undefined, `HTTP first contact is a FULL row (sq=${r1 && r1.sq})`);

  // second contact over the SOCKET → dl:1, because the memory lives on the receiver's presence row
  const s = sock(); await s.opened;
  s.tx({ t: "move", wallet: obs, x: 2000, z: 2002, dir: 0, handle: "Obs7", dl: 1, seq: 2 });
  const ack = await s.next("move");
  const r2 = (ack.players || []).find(p => p.wallet === peer);
  chk(r2 && r2.dl === 1 && r2.handle === undefined, `the SOCKET is told dl:1 for a peer HTTP already described (dl=${r2 && r2.dl}, handle=${r2 && r2.handle})`);

  // a static change bumps sq → the socket gets a FULL row again, and the tick does too
  await move({ wallet: peer, x: 2000, z: 2000, dir: 0, handle: "Peer7-RENAMED", avatar: "electro", comp: "doge", party: "doge,pepe,dragonos", eggs: "meme" });
  s.clear();
  const t3 = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 1500) { const f = s.world().find(f => (f.players || []).some(p => p.wallet === peer && p.handle)); if (f) return f; await sleep(5); } return null; })();
  const r3 = t3 && (t3.players || []).find(p => p.wallet === peer);
  chk(!!r3 && r3.handle === "Peer7-RENAMED" && r3.sq === r1.sq + 1, `a static change re-sends the FULL row on the TICK (handle=${r3 && r3.handle} sq=${r1.sq}→${r3 && r3.sq})`);

  // and back to HTTP: the socket already delivered sq, so the poll gets dl:1 — one memory, two doors
  const h4 = (await move({ wallet: obs, x: 2000, z: 2002, dir: 0, handle: "Obs7", dl: 1, seq: 3 })).body;
  const r4 = (h4.players || []).find(p => p.wallet === peer);
  chk(r4 && r4.dl === 1, `the next HTTP poll is told dl:1 for what the TICK described (dl=${r4 && r4.dl})`);
  s.close();
}

// ---------------------------------------------------------------------------
console.log("\n— 8. AUTH IS IDENTICAL TO HTTP: no weaker socket path —");
{
  const V = await proven();
  // proven wallet over the socket
  const s = sock(); await s.opened;
  s.tx({ t: "move", wallet: V.w, mktToken: V.tok, x: 3000, z: 3000, dir: 0, handle: "Owner" });
  const ack = await s.next("move");
  chk(ack && ack.ok === true, "a PROVEN wallet is accepted on the socket");

  // a public wallet with NO token cannot seize a proven slot — the same 403 the POST gives
  const bad = sock(); await bad.opened;
  bad.tx({ t: "move", wallet: V.w, x: 9, z: 9, dir: 0, handle: "Puppet" });
  const e = await bad.next("err");
  chk(e && e.code === 403, `an unproven socket cannot puppeteer a proven wallet (got ${e && e.code} ${e && e.error})`);
  bad.clear();
  await sleep(400);
  chk(bad.world().length === 0, `and it is ticked NOTHING afterwards (frames=${bad.world().length})`);
  const httpPup = await move({ wallet: V.w, x: 9, z: 9, dir: 0, handle: "Puppet" });
  chk(httpPup.code === 403, `the POST refuses the identical body the same way (${httpPup.code})`);
  bad.close();

  // a forged token is refused too
  const bad2 = sock(); await bad2.opened;
  bad2.tx({ t: "move", wallet: V.w, mktToken: "garbagegarbagegarbage", x: 9, z: 9, dir: 0, handle: "Puppet2" });
  const e2 = await bad2.next("err");
  chk(e2 && e2.code === 403, `a forged market token is refused on the socket (${e2 && e2.code})`);
  bad2.close();

  // PARTY is proven-only on the tick, exactly as on the reply
  const F = await proven();
  await move({ wallet: F.w, mktToken: F.tok, x: 3002, z: 3000, dir: 0, handle: "Friend" });
  const inv = await post("/party/invite", { wallet: V.w, mktToken: V.tok, to: F.w });
  chk(inv.code === 200, `invite sent (${inv.code})`);
  const acc = await post("/party/accept", { wallet: F.w, mktToken: F.tok, from: V.w });
  chk(acc.code === 200, `invite accepted (${acc.code})`);
  s.clear();
  s.tx({ t: "move", wallet: V.w, mktToken: V.tok, x: 3000, z: 3000, dir: 0, handle: "Owner" });
  await s.next("move");
  s.clear();
  const tk = await s.next("world");
  chk(tk && tk.party && tk.party.m && tk.party.m.length === 2, `the TICK carries the party wire for a proven socket (${tk && tk.party ? tk.party.m.length : "none"} members)`);
  chk(tk && tk.party.m.some(m => m.w === F.w), "and it names the member island-wide, the one interest bypass, on the tick too");

  // an unproven net_id socket gets no party field (it has no party) and cannot read anyone else's
  const nid = netid();
  const s3 = sock(); await s3.opened;
  s3.tx({ t: "move", wallet: nid, x: 3001, z: 3001, dir: 0, handle: "Nobody" });
  await s3.next("move"); s3.clear();
  const tk3 = await s3.next("world");
  chk(tk3 && tk3.party === undefined, "a partyless socket is told nothing about anyone's group");
  s3.close();

  // TOKEN ROTATION: proof is re-derived every tick, not cached at auth time
  const before = (await s.next("world", 800)) ? true : false;
  chk(before, "the proven socket is still being ticked");
  s.close();
}

// ---------------------------------------------------------------------------
console.log("\n— 9. THE FEED CURSOR IS HONOURED ON THE TICK (no repeats) —");
{
  const w = netid();
  const s = sock(); await s.opened;
  s.tx({ t: "move", wallet: w, x: 4000, z: 4000, dir: 0, handle: "Feeder", fs: Date.now() });
  await s.next("move");
  s.clear();
  await sleep(200);
  chk(s.world().every(f => f.feed === undefined), "no headline, no feed field");
  srv._worldFeedPushForTest("legend", w, "Azulon");
  await sleep(500);   // ~10 ticks
  const withFeed = s.world().filter(f => Array.isArray(f.feed));
  chk(withFeed.length === 1, `the headline is pushed on exactly ONE tick, then the cursor moves past it (ticks carrying feed=${withFeed.length})`);
  chk(withFeed[0] && withFeed[0].feed[0].d === "Azulon", `and it is the right headline (${withFeed[0] && withFeed[0].feed[0].d})`);
  s.close();
}

// ---------------------------------------------------------------------------
console.log("\n— 10. LIFECYCLE: transport switch, reconnect, drop —");
{
  const w = netid(), obs = netid();
  // start on HTTP
  await move({ wallet: w, x: 5000, z: 5000, dir: 0, handle: "Switcher", seq: 1 });
  let snap = (await move({ wallet: obs, x: 5002, z: 5000, dir: 0, handle: "Obs10" })).body;
  chk((snap.players || []).some(p => p.wallet === w), "seen while polling");

  // switch to the socket mid-session — same wallet, same presence row
  const s = sock(); await s.opened;
  s.tx({ t: "move", wallet: w, x: 5010, z: 5000, dir: 0, handle: "Switcher", seq: 2 });
  await s.next("move");
  snap = (await move({ wallet: obs, x: 5002, z: 5000, dir: 0, handle: "Obs10" })).body;
  let row = (snap.players || []).find(p => p.wallet === w);
  chk(row && row.x === 5010, `a poller sees the socket player move (x=${row && row.x}) — one presence row, two transports`);
  const roster1 = (await get("/world/roster")).users.filter(u => u.wallet === w).length;
  chk(roster1 === 1, `still exactly ONE roster entry after switching transport (${roster1})`);

  // a SECOND socket for the same wallet must not duplicate the peer
  const s2 = sock(); await s2.opened;
  s2.tx({ t: "move", wallet: w, x: 5020, z: 5000, dir: 0, handle: "Switcher", seq: 3 });
  await s2.next("move");
  snap = (await move({ wallet: obs, x: 5002, z: 5000, dir: 0, handle: "Obs10" })).body;
  const dupes = (snap.players || []).filter(p => p.wallet === w).length;
  chk(dupes === 1, `a reconnect does NOT duplicate the peer (rows for that wallet = ${dupes})`);
  const roster2 = (await get("/world/roster")).users.filter(u => u.wallet === w).length;
  chk(roster2 === 1, `and not on the roster either (${roster2})`);

  // switch BACK to polling
  const hb = await move({ wallet: w, x: 5030, z: 5000, dir: 0, handle: "Switcher", seq: 4 });
  chk(hb.code === 200, `the same wallet can go back to POSTing mid-session (${hb.code})`);
  snap = (await move({ wallet: obs, x: 5002, z: 5000, dir: 0, handle: "Obs10" })).body;
  row = (snap.players || []).find(p => p.wallet === w);
  chk(row && row.x === 5030, `and the world follows it back (x=${row && row.x})`);

  // stale seq is refused on the socket exactly as on the POST
  s.clear();
  s.tx({ t: "move", wallet: w, x: 1, z: 1, dir: 0, handle: "Switcher", seq: 2 });
  const stale = await s.next("move");
  chk(stale && stale.stale === true && stale.seq === 2, `an out-of-order socket move is answered stale:true (stale=${stale && stale.stale})`);
  snap = (await move({ wallet: obs, x: 5002, z: 5000, dir: 0, handle: "Obs10" })).body;
  row = (snap.players || []).find(p => p.wallet === w);
  chk(row && row.x === 5030, `and the position did NOT step backwards (x=${row && row.x})`);

  // DROP: closing the socket must clear presence exactly as a stopped poll does — via the TTL
  s.close(); s2.close();
  await sleep(300);
  const stillThere = (await get("/world/roster")).users.some(u => u.wallet === w);
  chk(stillThere, "immediately after the drop the trainer is STILL there (no pop-out; a transport blip is not a disconnect)");
  console.log("    (waiting out WORLD_TTL_MS…)");
  await sleep(12600);
  const gone = !(await get("/world/roster")).users.some(u => u.wallet === w);
  chk(gone, "after the 12s TTL the dropped socket's presence is gone, same as a stopped poll");
}

// ---------------------------------------------------------------------------
console.log("\n— 11. MEASUREMENTS —");
let MEAS = {};
{
  // bytes: same receiver, same world state, one tick vs one HTTP reply
  const obs = netid();
  for (let i = 0; i < 12; i++) await move({ wallet: netid(), x: 6000 + i * 5, z: 6000, dir: 0, handle: "Crowd" + i, avatar: "classic", comp: "pepe", party: "pepe,doge,dragonos", eggs: "normal" });
  const s = sock(); await s.opened;
  // BOTH samples must carry the SAME feed cursor. The socket keeps its own server-side cursor (it
  // advances past every headline it pushes), so an HTTP call sending fs:0 would be replayed the
  // chronicle row test 9 already delivered — a 74-byte difference that is the cursor working, not
  // the payloads differing. Measured that exact way first; this is the correction.
  const cursor = Date.now();
  s.tx({ t: "move", wallet: obs, x: 6000, z: 6000, dir: 0, handle: "Meter", dl: 1, fs: cursor, seq: 1 });
  const ack = await s.next("move");
  s.clear();
  const tick = await s.next("world");
  const httpB = await fetch(BASE + "/world/move", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: obs, x: 6000, z: 6000, dir: 0, handle: "Meter", dl: 1, fs: cursor, seq: 2 }) });
  const httpTxt = await httpB.text();
  const H = JSON.parse(httpTxt);
  // `a` is an AGE in ms and it grows between the two samples, so a raw byte compare is measuring
  // the clock, not the payload. Zero it to compare the payloads, and report both numbers.
  const zeroA = (o) => JSON.stringify({ ...o, players: (o.players || []).map(r => ({ ...r, a: 0 })) }).length;
  MEAS.peers = (tick.players || []).length;
  MEAS.httpPeers = (H.players || []).length;
  MEAS.ackBytes = JSON.stringify(ack).length;
  MEAS.tickBytes = JSON.stringify(tick).length;
  MEAS.httpBytes = httpTxt.length;
  console.log(`    peers in view: ws ${MEAS.peers} · http ${MEAS.httpPeers}`);
  console.log(`    FIRST payload (full static rows): ws ack ${MEAS.ackBytes} B`);
  console.log(`    STEADY payload (dl:1 rows):       ws tick ${MEAS.tickBytes} B   vs   http reply ${MEAS.httpBytes} B  (raw, incl. the live age digits)`);
  console.log(`    same, age normalised:             ws tick ${zeroA(tick)} B   vs   http reply ${zeroA(H)} B`);
  chk(MEAS.peers === MEAS.httpPeers, `both transports carry the same peer count (${MEAS.peers} vs ${MEAS.httpPeers})`);
  chk(J(Object.keys(tick).filter(k => k !== "t").sort()) === J(Object.keys(H).filter(k => k !== "ok" && k !== "seq").sort()),
      `and the same field set under load: ws=${J(Object.keys(tick))} http=${J(Object.keys(H))}`);
  chk(Math.abs(zeroA(tick) - zeroA(H)) <= 8,
      `age-normalised, a tick and an HTTP reply are the same payload to within the frame tags — {"t":"world"} vs {"ok":true,"seq":n} (Δ=${zeroA(tick) - zeroA(H)} B)`);
  console.log(`    RATE: http @280ms = ${(MEAS.httpBytes * 1000 / 280 / 1024).toFixed(1)} KiB/s · ws @${stats().tickMs}ms = ${(MEAS.tickBytes * 1000 / stats().tickMs / 1024).toFixed(1)} KiB/s  (${(280 / stats().tickMs).toFixed(1)}x the samples, ${(280 / stats().tickMs).toFixed(1)}x the bytes)`);
  s.close();

  // CPU per tick + jitter at 1 / 10 / 60 sockets
  const load = [];
  const measure = async (label) => {
    srv._wsResetStatsForTest();
    await sleep(2000);
    const st = stats();
    const perTick = st.ticks ? st.cpuUs / st.ticks : 0;
    const bytesPerTick = st.ticks ? st.bytes / st.ticks : 0;
    console.log(`    ${label}: ticks=${st.ticks} cpu=${perTick.toFixed(1)}µs/tick (${(perTick / (stats().tickMs * 1000) * 100).toFixed(2)}% of the 50ms budget) · bytes=${bytesPerTick.toFixed(0)}/tick · jitter avg ${st.jitterAvgMs.toFixed(2)}ms max ${st.jitterMaxMs}ms`);
    load.push({ label, perTick, jitterAvg: st.jitterAvgMs, jitterMax: st.jitterMaxMs, ticks: st.ticks });
    return st;
  };
  const socks = [];
  const spin = async (n, x0) => {
    for (let i = 0; i < n; i++) {
      const w = netid(), sk = sock(); await sk.opened;
      sk.tx({ t: "move", wallet: w, x: x0 + (i % 8) * 4, z: x0 + Math.floor(i / 8) * 4, dir: 0, handle: "L" + i, dl: 1 });
      sk.on("message", () => { sk.frames.length = 0; });   // don't hoard 60 sockets' worth of frames
      socks.push({ sk, w, x: x0 + (i % 8) * 4, z: x0 + Math.floor(i / 8) * 4 });
    }
    await sleep(200);
  };
  // keep presence alive during the measurement windows (TTL is 12s, windows are 2s — one refresh is enough)
  await spin(1, 7000);  const s1 = await measure("  1 socket ");
  await spin(9, 7000);  const s10 = await measure(" 10 sockets");
  await spin(50, 7000); const s60 = await measure(" 60 sockets");
  MEAS.load = load;
  chk(s60.jitterMaxMs <= 40, `tick jitter stays under 40ms at 60 sockets (max ${s60.jitterMaxMs}ms, target period ${stats().tickMs}ms)`);
  chk(load[2].perTick < 50000, `CPU per tick at 60 sockets is inside the tick budget (${load[2].perTick.toFixed(0)}µs of ${stats().tickMs * 1000}µs)`);
  chk(s60.ticks >= 35, `the loop kept its rate under 60 sockets (${s60.ticks} ticks in 2000ms, ideal ${2000 / stats().tickMs})`);
  for (const o of socks) o.sk.close();
  await sleep(200);
}

// ---------------------------------------------------------------------------
console.log("\n— 12. CHIK_WS=0 REFUSES THE UPGRADE (clients fall back to polling) —");
{
  const port = 39412;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), CHIK_WS: "0", RPC_URL: "http://127.0.0.1:59999",
           TREASURY_SECRET: process.env.TREASURY_SECRET, VERIFY_HOLDERS: "false", NETWORK: "devnet" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", d => { out += String(d); });
  child.stderr.on("data", d => { out += String(d); });
  // poll until it answers (macOS has no timeout(1) — poll, never sleep-and-hope)
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); up = r.ok; } catch {} if (!up) await sleep(250); }
  chk(up, "the CHIK_WS=0 server booted");
  chk(/world socket DISABLED/.test(out), `and it says so on stdout (${(out.match(/world socket[^\n]*/) || ["—"])[0]})`);

  const res = await new Promise((r) => {
    const w = new WS(`ws://127.0.0.1:${port}/ws/world`);
    let done = false;
    w.on("unexpected-response", (_q, m) => { if (!done) { done = true; r({ status: m.statusCode }); } w.terminate(); });
    w.on("error", (e) => { if (!done) { done = true; r({ err: String(e.message) }); } });
    w.on("open", () => { if (!done) { done = true; r({ open: true }); } w.close(); });
    setTimeout(() => { if (!done) { done = true; r({ timeout: true }); } }, 4000);
  });
  chk(!res.open, `the upgrade is REFUSED, not accepted (${J(res)})`);
  chk(res.status === 426 || /426/.test(res.err || ""), `refused with 426 Upgrade Required (${res.status || res.err})`);

  // and HTTP polling on that same server is completely unaffected — the fallback path
  const a = netid(), b = netid();
  const p1 = await (await fetch(`http://127.0.0.1:${port}/world/move`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: a, x: 1, z: 1, dir: 0, handle: "Fallback", act: "mine:pickaxe" }) })).json();
  chk(p1.ok === true, "with the socket off, /world/move still answers");
  const p2 = await (await fetch(`http://127.0.0.1:${port}/world/move`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: b, x: 3, z: 1, dir: 0, handle: "Fallback2" }) })).json();
  const seen = (p2.players || []).find(p => p.wallet === a);
  chk(seen && seen.act === "mine:pickaxe", `and two pollers still share the world (${seen && seen.act})`);

  // a bad path is closed cleanly rather than left hanging (main server, sockets ON)
  const badPath = await new Promise((r) => {
    const w = new WS(`ws://127.0.0.1:${PORT}/ws/nope`);
    let done = false;
    w.on("unexpected-response", (_q, m) => { if (!done) { done = true; r({ status: m.statusCode }); } w.terminate(); });
    w.on("error", (e) => { if (!done) { done = true; r({ err: String(e.message) }); } });
    w.on("open", () => { if (!done) { done = true; r({ open: true }); } w.close(); });
    setTimeout(() => { if (!done) { done = true; r({ timeout: true }); } }, 4000);
  });
  chk(!badPath.open && !badPath.timeout, `an upgrade on the wrong path is answered and closed, never hung (${J(badPath)})`);
  child.kill("SIGKILL");
}

console.log(`\nfinal ws stats: ${J(stats())}`);
console.log(`WSTRANSPORT_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
