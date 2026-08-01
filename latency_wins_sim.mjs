// LATENCY WINS — proves the two shipped server-side changes, measures what each one buys, and
// proves that a client which does NOT advertise the new capability is unaffected.
//
// Every server here is a REAL server.js booted OUT OF PROCESS (env flags are read at module load, so
// each flag combination needs its own load). Throwaway nacl keypair -> TREASURY_SECRET, dummy
// RPC_URL, memory store, VERIFY_HOLDERS=false, unique ports, no DATABASE_URL. Nothing touches the
// live backend. Peers are REAL 44-char base58 wallets (a `godot-xxxx` net_id understates every byte
// budget by ~24 B/row — ledger trap 2026-08-01).
//
// PHASES (argv: a b c d, default all)
//   A  flags OFF == the pre-change server, field for field, both doors
//   B  permessage-deflate: real TCP bytes on the wire, latency, the RAM ceiling, the inflate bomb,
//      and an old client that offers nothing getting the identical JSON
//   C  tick dedupe: suppression rate by occupancy, and the reconstructed world view proven identical
//   D  egress amplification at WS_MAX_SOCKETS with each flag
import WS from "ws";
import zlib from "node:zlib";
import { boot, post, proven, peerBody, sleep, ok, tally, quant, fq, B, pad, lpad, pct } from "./_lw_lib.mjs";

const WANT = (process.argv.slice(2).join("") || "abcd").toLowerCase();
const BASELINE = "/private/tmp/claude-502/-Users-michaelkennethbrillantes-Downloads-chiki-monsters-github/af3679f8-9bd4-4f61-b5ce-8d086a78fa4b/scratchpad/lw_baseline/server.js";
const kids = [];
const bootK = async (o) => { const k = await boot(o); kids.push(k); return k; };
process.on("exit", () => kids.forEach(k => k.kill()));

// A ws client that records raw TCP bytes read on its own socket — the honest wire measurement,
// taken after any extension has been applied.
function sock(url, pmd, retain = true) {
  const ws = new WS(url, { perMessageDeflate: pmd });
  ws.raw = []; ws.tk = []; ws.ak = []; ws.n = 0;
  ws.on("error", () => {});
  ws.on("message", (d) => {
    ws.n++;
    if (!retain) return;                 // 250 sockets x 20 Hz x 11 s of retained JSON is ~165 MB
    const s = String(d);
    ws.raw.push(s);
    if (s.startsWith('{"t":"world"')) ws.tk.push(s); else if (s.startsWith('{"t":"move"')) ws.ak.push(s);
  });
  ws.opened = new Promise((res) => ws.on("open", () => res(true)));
  ws.tx = (o) => ws.send(JSON.stringify(o));
  ws.wire = () => (ws._socket ? ws._socket.bytesRead : 0);
  return ws;
}
const rk = (r) => `${r.x},${r.z},${r.y},${r.dir},${r.act||""},${r.handle||""}`;   // NEVER `handle + x`: on a dl:1 row handle is undefined and `undefined + 280.5` is NaN, so the comparator degenerates silently
const obsBody = (o, extra) => ({ wallet: o.w, mktToken: o.tok, x: o.cx, z: o.cz, y: 34, dir: 0.5, handle: "Observer",
  avatar: "classic", comp: "pepe", party: "pepe,doge,jellox", el: "Fire", leg: 4, br: 12, eggs: "normal", ...extra });

// Populate nPeers real proven wallets standing in one square around (cx,cz) and keep them reporting.
async function crowd(base, nPeers, cx, cz) {
  const peers = [];
  for (let i = 0; i < nPeers; i++) peers.push({ ...(await proven(base)), i });
  let t = 0;
  const drive = async () => { await Promise.all(peers.map(p => post(base, "/world/move", { wallet: p.w, mktToken: p.tok, ...peerBody(p.i, t, cx, cz) }))); };
  await drive();
  const iv = setInterval(() => { t += 0.28; drive(); }, 280);
  return { peers, stop: () => clearInterval(iv), still: () => clearInterval(iv) };
}

console.log("=== LATENCY WINS SIM ===");
console.log(`node ${process.version} · ws ${JSON.parse(await (await import("node:fs/promises")).readFile("./node_modules/ws/package.json", "utf8")).version}\n`);

// ============================================================ PHASE A — OFF == today
if (WANT.includes("a")) {
  console.log("---- PHASE A · flags OFF are the pre-change server -------------------------------");
  const cur = await bootK({ port: 39610, statPort: 39611, label: "current" });
  const old = await bootK({ port: 39612, statPort: 39613, srv: BASELINE, label: "baseline" });

  // ONE clock drives BOTH servers with the SAME bodies — two independent 280 ms intervals would
  // sample the peers' orbit at different t and the payloads would differ for a reason that has
  // nothing to do with the change.
  const pc = [], po = [];
  for (let i = 0; i < 8; i++) { pc.push({ ...(await proven(cur.base)), i }); po.push({ ...(await proven(old.base)), i }); }
  let ta = 0;
  const driveBoth = async () => {
    const b = pc.map((_, i) => peerBody(i, ta, 300, 300));
    await Promise.all([
      ...pc.map((p, i) => post(cur.base, "/world/move", { wallet: p.w, mktToken: p.tok, ...b[i] })),
      ...po.map((p, i) => post(old.base, "/world/move", { wallet: p.w, mktToken: p.tok, ...b[i] })),
    ]);
  };
  await driveBoth();
  const cc = { stop: () => {} }, co = { stop: () => {} };
  await sleep(400);
  const oc = await proven(cur.base), oo = await proven(old.base);
  oc.cx = 300; oc.cz = 300; oo.cx = 300; oo.cz = 300;

  // strip the fields that MUST differ between two independent processes: sample age, wallet
  // identity, feed timestamps.
  const norm = (o) => {
    const c = JSON.parse(JSON.stringify(o));
    if (Array.isArray(c.players)) { c.players.sort((a, b) => rk(a) < rk(b) ? -1 : 1); for (const r of c.players) { delete r.a; delete r.wallet; } }
    delete c.feed;
    return c;
  };
  const keysOf = (o) => Object.keys(o).join(",");

  let sameKeys = 0, sameShape = 0, rounds = 0, firstDiff = "";
  for (let s = 1; s <= 5; s++) {
    ta += 0.28; await driveBoth();                 // step the world, THEN sample — no interval racing the compare
    const bc = (await post(cur.base, "/world/move", obsBody(oc, { dl: 1, seq: s, fs: 0 }))).body;
    const bo = (await post(old.base, "/world/move", obsBody(oo, { dl: 1, seq: s, fs: 0 }))).body;
    rounds++;
    if (keysOf(bc) === keysOf(bo)) sameKeys++;
    const nc = JSON.stringify(norm(bc)), no = JSON.stringify(norm(bo));
    if (nc === no) sameShape++;
    else if (!firstDiff) firstDiff = `round ${s}\n      cur=${nc}\n      old=${no}`;
    await sleep(120);
  }
  if (firstDiff) console.log("    first diff: " + firstDiff);
  ok(sameKeys === rounds, "HTTP /world/move top-level key order identical to pre-change", `${sameKeys}/${rounds}`);
  ok(sameShape === rounds, "HTTP /world/move payload identical to pre-change (age/wallet/feed normalised)", `${sameShape}/${rounds}`);

  // the socket door
  const wc = sock(cur.wsurl, false), wo = sock(old.wsurl, false);
  await Promise.all([wc.opened, wo.opened]);
  ta += 0.28; await driveBoth();
  wc.tx({ t: "move", ...obsBody(oc, { dl: 0, seq: 20 }) });
  wo.tx({ t: "move", ...obsBody(oo, { dl: 0, seq: 20 }) });
  await sleep(900);
  const ackC = wc.ak[0] ? JSON.parse(wc.ak[0]) : null, ackO = wo.ak[0] ? JSON.parse(wo.ak[0]) : null;
  ok(!!ackC && !!ackO && keysOf(ackC) === keysOf(ackO), "WS move ack key order identical", ackC ? keysOf(ackC) : "none");
  ok(!!ackC && !!ackO && JSON.stringify(norm(ackC)) === JSON.stringify(norm(ackO)), "WS move ack payload identical");
  const tkC = wc.tk.length, tkO = wo.tk.length;
  ok(Math.abs(tkC - tkO) <= 2, "WS tick frame COUNT unchanged with dedupe off", `current=${tkC} baseline=${tkO}`);
  const sc = await cur.stats();
  ok(sc.deflate.on === false && sc.dedupe === false, "defaults: deflate off, dedupe off", JSON.stringify(sc.deflate) + " dedupe=" + sc.dedupe);
  ok(sc.max === 250, "WS_MAX_SOCKETS unchanged", sc.max);
  ok(sc.hz === 20, "WS_TICK_HZ unchanged", sc.hz);
  ok(sc.dupSkips === 0, "zero frames suppressed while dedupe is off", sc.dupSkips);
  wc.close(); wo.close(); cc.stop(); co.stop(); cur.kill(); old.kill();
  await sleep(200);
  console.log("");
}

// ============================================================ PHASE B — permessage-deflate
if (WANT.includes("b")) {
  console.log("---- PHASE B · permessage-deflate ------------------------------------------------");
  const off = await bootK({ port: 39620, statPort: 39621, label: "deflate-off" });
  const on  = await bootK({ port: 39622, statPort: 39623, label: "deflate-on", env: { CHIK_WS_DEFLATE: "1" } });

  const KS = (process.env.LW_KS || "1,12,60").split(",").map(Number);
  for (const K of KS) {
    process.stderr.write(`   [B] K=${K} building crowd…\n`);
    const cOff = await crowd(off.base, K, 700, 700);
    const cOn  = await crowd(on.base,  K, 700, 700);
    process.stderr.write(`   [B] K=${K} crowd up\n`);
    await sleep(400);
    // EVERY SERVER GETS THE SAME NUMBER OF OBSERVERS. Observers are themselves presence rows, so a
    // server with 2 of them shows every socket K+1 peers and a server with 1 shows K — comparing
    // across that difference measures the extra row, not the extension.
    const o0 = await proven(off.base); o0.cx = 700; o0.cz = 700;   // filler so `off` also holds 2 observers
    const o1 = await proven(off.base); o1.cx = 700; o1.cz = 700;
    const o2 = await proven(on.base);  o2.cx = 700; o2.cz = 700;
    const o3 = await proven(on.base);  o3.cx = 700; o3.cz = 700;   // the OLD CLIENT: offers no extension

    const sFill = sock(off.wsurl, false);
    const sOff = sock(off.wsurl, false);          // control, no extension available
    const sNew = sock(on.wsurl, true);            // browser-like: offers permessage-deflate
    const sOld = sock(on.wsurl, false);           // Godot native WebSocketPeer: offers nothing
    await Promise.all([sFill.opened, sOff.opened, sNew.opened, sOld.opened]);
    if (K === 1) {
      ok(String(sNew.extensions || "").includes("permessage-deflate"), "offering client negotiates permessage-deflate", JSON.stringify(sNew.extensions));
      ok(String(sOld.extensions || "") === "", "non-offering client negotiates NOTHING (unchanged wire)", JSON.stringify(sOld.extensions));
      ok(String(sOff.extensions || "") === "", "flag off: even an offering client gets nothing", JSON.stringify(sOff.extensions));
    }
    const keep = setInterval(() => {
      sFill.tx({ t: "move", ...obsBody(o0, { dl: 1, seq: Date.now() }) });
      sOff.tx({ t: "move", ...obsBody(o1, { dl: 1, seq: Date.now() }) });
      sNew.tx({ t: "move", ...obsBody(o2, { dl: 1, seq: Date.now() }) });
      sOld.tx({ t: "move", ...obsBody(o3, { dl: 1, seq: Date.now() }) });
    }, 280);
    await sleep(500);
    const w0 = [sOff.wire(), sNew.wire(), sOld.wire()];
    const f0 = [sOff.tk.length, sNew.tk.length, sOld.tk.length];
    await sleep(4000);
    const w1 = [sOff.wire(), sNew.wire(), sOld.wire()];
    const f1 = [sOff.tk.length, sNew.tk.length, sOld.tk.length];
    clearInterval(keep);

    const perTick = (i) => (f1[i] - f0[i]) ? (w1[i] - w0[i]) / (f1[i] - f0[i]) : 0;
    const jsonTick = (s) => s.tk.length ? B(s.tk[s.tk.length - 1]) : 0;
    console.log(`  K=${lpad(K, 2)} peers   JSON/tick ${lpad(jsonTick(sNew).toFixed(0), 5)} B`
      + ` | wire B/tick  off=${lpad(perTick(0).toFixed(0), 5)}  deflate=${lpad(perTick(1).toFixed(0), 5)}  non-offering=${lpad(perTick(2).toFixed(0), 5)}`
      + ` | saved ${pct(perTick(0) - perTick(1), perTick(0))}`);
    if (K === 60) {
      ok(perTick(1) < perTick(0) * 0.2, "60-peer frame costs <20% of the wire it costs today", `${perTick(0).toFixed(0)} -> ${perTick(1).toFixed(0)} B`);
      ok(Math.abs(perTick(2) - perTick(0)) / perTick(0) < 0.05, "NON-OFFERING client's wire cost is unchanged by the flag", `${perTick(0).toFixed(0)} vs ${perTick(2).toFixed(0)} B`);
      // decoded content must be identical between the compressing and the non-compressing client
      const strip = (s) => { const j = JSON.parse(s); (j.players || []).forEach(r => { delete r.a; delete r.wallet; }); delete j.online; delete j.feed;
        (j.players || []).sort((a, b) => rk(a) < rk(b) ? -1 : 1); return JSON.stringify(j); };
      const A = new Set(sNew.tk.slice(-40).map(strip)), Bset = new Set(sOld.tk.slice(-40).map(strip));
      let overlap = 0; for (const v of A) if (Bset.has(v)) overlap++;
      ok(overlap > 0, "compressing and non-compressing clients decode the SAME snapshots", `${overlap} identical frames of ${A.size}`);
    }
    sFill.close(); sOff.close(); sNew.close(); sOld.close(); cOff.stop(); cOn.stop();
    await sleep(300);
  }

  // ---- latency, honest one-frame-in-flight ping->pong on each transport
  process.stderr.write("   [B] ping-pong…\n");
  // PACED UNDER WS_MSG_BURST. The server drops (does not answer, does not close) the 41st inbound
  // message inside one second, so a back-to-back ping loop deadlocks on the 41st await — it hangs
  // forever with no error. 33 ms spacing keeps it at ~30/s, and the race is belt-and-braces.
  const pp = async (k, pmd, n = 120) => {
    const s = sock(k.wsurl, pmd); await s.opened;
    const d = [];
    for (let i = 0; i < n; i++) {
      await sleep(33);
      const t0 = process.hrtime.bigint();
      const got = new Promise(r => { const h = () => r(true); s.once("message", h); setTimeout(() => { s.off("message", h); r(false); }, 2000); });
      s.send(JSON.stringify({ t: "ping" }));
      if (await got) d.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    s.close();
    return quant(d.slice(20));
  };
  const lOff = await pp(off, false), lOn = await pp(on, true);
  console.log(`  ping->pong (26 B, UNDER the 256 B threshold so nothing is compressed — this measures the extension bookkeeping only)`);
  console.log(`    deflate off ${fq(lOff)} ms`);
  console.log(`    deflate ON  ${fq(lOn)} ms   (delta p50 ${(lOn.p50 - lOff.p50).toFixed(3)} ms)`);
  ok(Math.abs(lOn.p50 - lOff.p50) < 1.0, "extension bookkeeping costs under 1 ms", `${(lOn.p50 - lOff.p50).toFixed(3)} ms`);

  // ---- THE LATENCY QUESTION THAT ACTUALLY MATTERS: a REAL full snapshot (~17.7 KB measured),
  // compressed vs not.
  // move -> own ack, one frame in flight, A/B/A ordered because the ledger's Nagle probe proved a
  // single-order run reads JIT warm-up as a transport difference (it made Nagle-on look FASTER).
  process.stderr.write("   [B] big-frame move->ack A/B/A…\n");
  {
    const cOff = await crowd(off.base, 60, 2000, 2000);
    const cOn  = await crowd(on.base,  60, 2000, 2000);
    await sleep(600);
    const leg = async (k, pmd, n = 90) => {
      const o = await proven(k.base); o.cx = 2000; o.cz = 2000;
      const s = sock(k.wsurl, pmd); await s.opened;
      const d = []; let bytes = 0, seq = 1;
      for (let i = 0; i < n; i++) {
        await sleep(33);                                   // WS_MSG_BURST is 40/s and drops silently
        const t0 = process.hrtime.bigint();
        const got = new Promise(r => { const h = (m) => { if (String(m).startsWith('{"t":"move"')) { s.off("message", h); r(String(m).length); } };
                                       s.on("message", h); setTimeout(() => { s.off("message", h); r(0); }, 2000); });
        s.tx({ t: "move", ...obsBody(o, { dl: 0, seq: seq++ }) });   // dl:0 => FULL rows, the big frame
        const got_ = await got;
        if (got_) { d.push(Number(process.hrtime.bigint() - t0) / 1e6); bytes += got_; }
      }
      const w = s.wire(); s.close();
      return { q: quant(d.slice(15)), json: bytes / Math.max(1, d.length), wire: w };
    };
    const a1 = await leg(off, false), b1 = await leg(on, true), a2 = await leg(off, false);
    console.log(`  move -> own ack on a FULL 60-peer snapshot (dl:0), A/B/A:`);
    console.log(`    A1 deflate off ${fq(a1.q)} ms   ack JSON ${a1.json.toFixed(0)} B`);
    console.log(`    B  deflate ON  ${fq(b1.q)} ms   ack JSON ${b1.json.toFixed(0)} B`);
    console.log(`    A2 deflate off ${fq(a2.q)} ms   ack JSON ${a2.json.toFixed(0)} B`);
    const spread = Math.abs(a1.q.p50 - a2.q.p50);
    const delta = b1.q.p50 - (a1.q.p50 + a2.q.p50) / 2;
    console.log(`    A-to-A spread ${spread.toFixed(3)} ms · deflate delta ${delta.toFixed(3)} ms`);
    ok(delta < 1.0, "compressing a real full-snapshot ack costs under 1 ms of loopback latency", `${delta.toFixed(3)} ms (A-to-A spread ${spread.toFixed(3)} ms)`);
    cOff.stop(); cOn.stop();
    await sleep(300);
  }

  process.stderr.write("   [B] ceiling…\n");
  // ---- the RAM ceiling: past WS_DEFLATE_MAX a socket lands on the extension-less server
  const cap = await bootK({ port: 39624, statPort: 39625, label: "cap2", env: { CHIK_WS_DEFLATE: "1", CHIK_WS_DEFLATE_MAX: "2" } });
  const ss = [];
  for (let i = 0; i < 5; i++) { const s = sock(cap.wsurl, true); await s.opened; ss.push(s); }
  const negot = ss.filter(s => String(s.extensions || "").includes("permessage-deflate")).length;
  const st = await cap.stats();
  ok(negot === 2, "WS_DEFLATE_MAX=2 => exactly 2 sockets compress", `${negot}/5`);
  ok(st.deflate.negotiated === 2, "server's own counter agrees", st.deflate.negotiated);
  let alive = 0; for (const s of ss) { const g = new Promise(r => s.once("message", () => r(alive++))); s.send(JSON.stringify({ t: "ping" })); await g; }
  ok(alive === 5, "all 5 sockets still work — the ceiling declines an optimisation, never a connection", `${alive}/5`);
  ss[0].close(); ss[1].close(); await sleep(300);
  const st2 = await cap.stats();
  ok(st2.deflate.negotiated === 0, "counter released on close (no leak)", st2.deflate.negotiated);
  const s6 = sock(cap.wsurl, true); await s6.opened;
  ok(String(s6.extensions || "").includes("permessage-deflate"), "a freed slot is reusable", JSON.stringify(s6.extensions));
  s6.close();

  process.stderr.write("   [B] bomb…\n");
  // ---- the inflate bomb: maxPayload must be enforced on the DECOMPRESSED size
  const bomb = sock(cap.wsurl, true); await bomb.opened;
  ok(String(bomb.extensions || "").includes("permessage-deflate"), "bomb socket is compressing");
  let bombClosed = false;
  bomb.on("close", () => { bombClosed = true; });
  const huge = JSON.stringify({ t: "move", wallet: "x".repeat(4 * 1024 * 1024) });
  bomb.send(huge);
  await sleep(1200);
  ok(bombClosed, "4 MiB inbound frame that compresses small is REFUSED (maxPayload holds on the inflated size)", `closed=${bombClosed}`);
  const st3 = await cap.stats();
  ok(st3.rss < 400 * 1024 * 1024, "server RSS did not blow up on the bomb", `${(st3.rss / 1048576).toFixed(1)} MiB`);

  off.kill(); on.kill(); cap.kill();
  await sleep(200);
  console.log("");
}

// ============================================================ PHASE C — tick dedupe
if (WANT.includes("c")) {
  console.log("---- PHASE C · tick dedupe -------------------------------------------------------");
  const dOff = await bootK({ port: 39630, statPort: 39631, label: "dedupe-off" });
  const dOn  = await bootK({ port: 39632, statPort: 39633, label: "dedupe-on", env: { CHIK_WS_DEDUPE: "1" } });

  // The client's merge: peer -> newest row, statics carried forward across dl:1 rows. Reconstructing
  // it from the frames each observer ACTUALLY RECEIVED is the only honest way to say "the two clients
  // see the same thing". Keyed by the peer's INDEX, not its wallet: the two servers are separate
  // processes with separate keypairs, so wallets can never match and a wallet-keyed compare would
  // fail for a reason that has nothing to do with dedupe.
  function view(frames, w2i) {
    const m = new Map();
    for (const f of frames) {
      const j = JSON.parse(f);
      for (const r of (j.players || [])) {
        const k = w2i.get(r.wallet);
        if (k === undefined) continue;
        m.set(k, { ...(m.get(k) || {}), ...r, a: undefined, wallet: undefined });
      }
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0])
      .map(([i, r]) => `${i}|${r.handle}|${r.x}|${r.y}|${r.z}|${r.dir}|${r.act || ""}|${r.mount || ""}|${r.avatar || ""}|${r.party || ""}|${r.eggs || ""}|${r.spr}`);
  }

  const rows = [];
  let round = 0;
  for (const [K, moving] of [[1, true], [12, true], [60, true], [12, false], [60, false]]) {
    // EACH ROUND GETS ITS OWN CORNER OF THE ISLAND. Presence lives for WORLD_TTL_MS (12 s), so the
    // previous round's peers are still standing there — and once 73 of them share a square the
    // nearest-60 cap starts deciding which ones a snapshot carries, which is a completely different
    // experiment. 3000 units apart is ~10x the 320 interest radius.
    const CX = 900 + (round++) * 3000, CZ = 900;
    // REAL PLAYERS ARE NOT SYNCHRONISED. One 280 ms timer moving all K peers at the same instant
    // leaves 4.6 of every 5.6 ticks with literally nothing new, which flatters dedupe enormously
    // (measured 61.5% "saved" in a MOVING 60-peer square, which is not believable). Each peer here
    // has its own 280 ms phase, evenly spread — the same schedule on both servers.
    const pa = [], pb = [], w2iA = new Map(), w2iB = new Map();
    for (let i = 0; i < K; i++) {
      const a = await proven(dOff.base), b = await proven(dOn.base);
      pa.push(a); pb.push(b); w2iA.set(a.w, i); w2iB.set(b.w, i);
    }
    const t0 = Date.now();
    const due = new Array(K).fill(0).map((_, i) => t0 + Math.round((i * 280) / K));
    let master = null;
    const stepPeer = async (i, tsec) => {
      const body = peerBody(i, tsec, CX, CZ);
      await Promise.all([
        post(dOff.base, "/world/move", { wallet: pa[i].w, mktToken: pa[i].tok, ...body }),
        post(dOn.base,  "/world/move", { wallet: pb[i].w, mktToken: pb[i].tok, ...body }),
      ]);
    };
    for (let i = 0; i < K; i++) await stepPeer(i, 0);
    // STILL = still reporting, not gone. A standing player's client keeps POSTing every 280 ms with
    // an unchanged body; letting presence lapse instead would measure WORLD_TTL_MS, not dedupe.
    master = setInterval(() => {
      const now = Date.now();
      for (let i = 0; i < K; i++) if (now >= due[i]) { due[i] += 280; stepPeer(i, moving ? (now - t0) / 1000 : 0); }
    }, 15);
    await sleep(400);
    const oA = await proven(dOff.base); oA.cx = CX; oA.cz = CZ;
    const oB = await proven(dOn.base);  oB.cx = CX; oB.cz = CZ;
    const sA = sock(dOff.wsurl, false), sB = sock(dOn.wsurl, false);
    await Promise.all([sA.opened, sB.opened]);
    await dOff.reset(); await dOn.reset();
    let seq = 1;
    const keep = setInterval(() => {
      sA.tx({ t: "move", ...obsBody(oA, { dl: 1, seq: seq }) });
      sB.tx({ t: "move", ...obsBody(oB, { dl: 1, seq: seq }) });
      seq++;
    }, 280);
    await sleep(6000);
    clearInterval(keep); if (master) clearInterval(master);
    await sleep(300);
    const stB = await dOn.stats();
    const bytesA = sA.tk.reduce((s, f) => s + B(f), 0), bytesB = sB.tk.reduce((s, f) => s + B(f), 0);
    rows.push([K, moving, sA.tk.length, sB.tk.length, bytesA, bytesB, stB.dupSkips]);
    console.log(`  K=${lpad(K, 2)} ${moving ? "moving " : "STILL  "} ticks off=${lpad(sA.tk.length, 4)} on=${lpad(sB.tk.length, 4)}`
      + ` | tick bytes ${lpad(bytesA, 7)} -> ${lpad(bytesB, 7)}  (${pad(pct(bytesA - bytesB, bytesA), 6)} saved)`
      + ` | server dupSkips=${stB.dupSkips}`);
    const vA = view(sA.raw, w2iA), vB = view(sB.raw, w2iB);
    ok(vA.length === K && JSON.stringify(vA) === JSON.stringify(vB),
      `K=${K} ${moving ? "moving" : "still"}: reconstructed world view IDENTICAL with dedupe on`,
      `${vA.length} vs ${vB.length} peers`);
    sA.close(); sB.close();
    await sleep(300);
  }
  const mov60 = rows.find(r => r[0] === 60 && r[1]), still60 = rows.find(r => r[0] === 60 && !r[1]);
  console.log(`  MOVING 60-peer square saved ${pct(mov60[4] - mov60[5], mov60[4])} — dedupe is not a plaza fix, and was never expected to be`);
  ok(still60 && (still60[4] - still60[5]) / still60[4] > 0.5, "a STILL square is mostly suppressed", still60 ? pct(still60[4] - still60[5], still60[4]) : "n/a");

  // the watchdog: the client's WS_SILENCE is 0.6 s and is fed by the ACK, never by the tick.
  {
    const c = await crowd(dOn.base, 1, 1500, 1500); c.still();
    await sleep(300);
    const o = await proven(dOn.base); o.cx = 1500; o.cz = 1500;
    const s = sock(dOn.wsurl, false); await s.opened;
    const gaps = []; let last = Date.now();
    s.on("message", () => { const n = Date.now(); gaps.push(n - last); last = n; });
    let sq = 1;
    const keep = setInterval(() => { s.tx({ t: "move", ...obsBody(o, { dl: 1, seq: sq++ }) }); }, 280);
    await sleep(4000); clearInterval(keep);
    const g = quant(gaps.slice(2));
    console.log(`  frame gap with dedupe ON, idle world: ${fq(g, 1)} ms`);
    ok(g.max < 600, "longest silence stays under the client's WS_SILENCE 0.6 s", `${g.max.toFixed(0)} ms`);
    s.close(); c.stop();
  }
  dOff.kill(); dOn.kill();
  await sleep(200);
  console.log("");
}

// ============================================================ PHASE D — amplification
if (WANT.includes("d")) {
  console.log("---- PHASE D · egress amplification at WS_MAX_SOCKETS ----------------------------");
  console.log("  250 sockets, ONE ~300 B move every 3.5 s each (100% duty inside WS_MOVE_IDLE_MS 4 s)");
  const cases = [
    ["today          ", {}],
    ["deflate        ", { CHIK_WS_DEFLATE: "1", CHIK_WS_DEFLATE_MAX: "0" }],
    ["dedupe         ", { CHIK_WS_DEDUPE: "1" }],
    ["deflate+dedupe ", { CHIK_WS_DEFLATE: "1", CHIK_WS_DEFLATE_MAX: "0", CHIK_WS_DEDUPE: "1" }],
  ];
  const out = [];
  let port = 39640;
  for (const [label, env] of cases) {
    const k = await bootK({ port, statPort: port + 1, label, env }); port += 2;
    const N = 250;
    const socks = [];
    for (let i = 0; i < N; i++) {
      const s = sock(k.wsurl, !!env.CHIK_WS_DEFLATE, false);
      socks.push(s);
      if (i % 25 === 24) await sleep(60);
    }
    await Promise.all(socks.map(s => s.opened));
    const id = (i) => "godot-lwamp" + String(i).padStart(5, "0");
    const mv = (i, seq) => ({ t: "move", wallet: id(i), x: 1200 + (i % 8), y: 20, z: 1200 + (((i / 8) | 0) % 8),
                              dir: 1, handle: "A", leg: 1, el: "Fire", br: 1, dl: 1, seq });
    let seq = 1, up = 0;
    const fire = () => { seq++; for (let i = 0; i < N; i++) { const m = JSON.stringify(mv(i, seq)); up += B(m); socks[i].send(m); } };
    fire(); await sleep(1200);
    await k.reset();
    const w0 = socks.map(s => s.wire()); const up0 = up;
    const iv = setInterval(fire, 3500);
    const t0 = Date.now();
    await sleep(11000);
    clearInterval(iv);
    const ms = Date.now() - t0;
    const w1 = socks.map(s => s.wire());
    const st = await k.stats();
    let wire = 0; for (let i = 0; i < N; i++) wire += w1[i] - w0[i];
    const upB = up - up0;
    const egress = wire / (ms / 1000);
    const amp = upB ? wire / upB : 0;
    const snapsPerMsg = st.frames / Math.max(1, Math.round(ms / 3500) * N);
    out.push({ label, egress, amp, upB, wire, frames: st.frames, dupSkips: st.dupSkips, negot: st.deflate.negotiated, cpu: st.procCpuUs / (ms * 10) });
    console.log(`  ${label} egress ${lpad((egress / 1048576).toFixed(2), 6)} MiB/s | upload ${lpad((upB / (ms / 1000) / 1024).toFixed(1), 6)} KB/s`
      + ` | amplification x${lpad(amp.toFixed(0), 6)} | frames ${lpad(st.frames, 7)} | dupSkips ${lpad(st.dupSkips, 7)}`
      + ` | pmd ${lpad(st.deflate.negotiated, 3)} | cpu ${lpad((st.procCpuUs / (ms * 10)).toFixed(0), 3)}%`
      + ` | tick ${lpad((st.ticks / (ms / 1000)).toFixed(1), 5)}Hz jitter ${st.jitterAvgMs.toFixed(1)}/${st.jitterMaxMs.toFixed(0)}ms`);
    for (const s of socks) s.close();
    k.kill();
    await sleep(500);
  }
  const base = out[0];
  for (const r of out.slice(1)) {
    ok(r.amp <= base.amp * 1.02, `${r.label.trim()}: amplification is NOT worse than today`, `x${base.amp.toFixed(0)} -> x${r.amp.toFixed(0)}`);
  }
  console.log("");
}

const t = tally();
console.log(`==== ${t.PASS} passed / ${t.FAIL} failed ====`);
kids.forEach(k => k.kill());
process.exit(t.FAIL ? 1 : 0);
