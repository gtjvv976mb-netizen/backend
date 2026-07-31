// OUT-OF-PROCESS load + latency measurement for /ws/world.
// The server runs in its own child process, the attacker in another, so nothing measured here is
// the sim's own CPU. Real server.js, throwaway keypair, dummy RPC, memory store — never the live
// backend and never a chain.
//
// THE CONTROL MATTERS: a socket flood also creates N presence rows, and presence-map growth is a
// PRE-EXISTING cost that every HTTP poller already pays. So every socket run is paired with a
// `rows` run that makes the identical rows over HTTP and opens no socket. Only the difference
// between the two is attributable to the WebSocket transport.
import { spawn } from "node:child_process";
import nacl from "tweetnacl";
import bs58 from "bs58";
import WS from "ws";

const PORT = Number(process.env.AVPORT || 41903);
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
const mvBody = (w, x, z, e = {}) => Object.assign({ wallet: w, x, y: 0, z, dir: 0, handle: "T", leg: 1, el: "Fire", br: 1 }, e);
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const srv = spawn(process.execPath, ["_av_ws_boot.mjs"], { cwd: process.cwd(), env: { ...process.env, AVPORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
srv.stdout.on("data", () => {}); srv.stderr.on("data", () => {});
const kids = [srv];
process.on("exit", () => { for (const k of kids) { try { k.kill("SIGKILL"); } catch {} } });
for (let i = 0; i < 80; i++) { await sleep(250); try { const r = await fetch(BASE + "/stats"); if (r.ok) break; } catch {} }
await sleep(700);
console.log("server child up on", PORT);

function startFlood(n, mode) {
  const c = spawn(process.execPath, ["_av_ws_flood_child.mjs", String(n), String(PORT), mode], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  c.last = ""; c.stdout.on("data", (d) => { const m = String(d).match(/FLOODSTAT frames=\d+ bytes=\d+/g); if (m) c.last = m[m.length - 1]; });
  c.stderr.on("data", () => {}); kids.push(c);
  return c;
}
const bytesOf = (c) => Number((String(c.last).match(/bytes=(\d+)/) || [0, 0])[1]);

// ---- the honest player whose experience we are protecting -------------------------------------
async function httpLatency(samples, tag) {
  const w = netid(); const lat = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    const r = await post("/world/move", mvBody(w, 40 + (i % 5), 40, { dl: 1, seq: i + 1 }));
    const dt = performance.now() - t0;
    if (r.code === 200) lat.push(dt);
    await sleep(40);
  }
  console.log(`    ${tag}: n=${lat.length} p50=${pct(lat, 0.5).toFixed(1)}ms p95=${pct(lat, 0.95).toFixed(1)}ms max=${Math.max(...lat).toFixed(1)}ms`);
  return lat;
}

console.log("\n================ AV: /ws/world LOAD + LATENCY ================");
console.log("\n— A. DOES A SOCKET FLOOD MAKE HTTP POLLING WORSE? (vs the rows-only control) —");
await httpLatency(30, "warm-up (discarded)");
const base = await httpLatency(90, "BASELINE      0 rows, 0 sockets");

// --- control: the same 200 presence rows, made over HTTP, no sockets
const ctl = startFlood(200, "rows");
await sleep(4000);
const rowsOnly = await httpLatency(90, "CONTROL     200 rows, 0 sockets");
ctl.kill("SIGKILL"); await sleep(13000);   // let the rows TTL out (12s)

const results = [];
for (const N of [50, 200, 400]) {
  const f = startFlood(N, "ws");
  await sleep(5000);
  const b0 = bytesOf(f);
  const lat = await httpLatency(90, `FLOOD       ${String(N).padStart(3)} rows, ${String(N).padStart(3)} sockets`);
  const b1 = bytesOf(f);
  const secs = 90 * 0.04 + 90 * (pct(lat, 0.5) / 1000);
  const mib = ((b1 - b0) / 1048576) / Math.max(1, secs);
  console.log(`      → attacker pulled ${mib.toFixed(1)} MiB/s of server egress for ${N} inbound messages / 10s (${(N * 0.3 / 10).toFixed(1)} KB/s in)`);
  results.push({ N, p50: pct(lat, 0.5), p95: pct(lat, 0.95), mib });
  f.kill("SIGKILL"); await sleep(13500);
}
const bp50 = pct(base, 0.5), bp95 = pct(base, 0.95), cp50 = pct(rowsOnly, 0.5), cp95 = pct(rowsOnly, 0.95);
console.log(`\n    honest-poller p95:  baseline ${bp95.toFixed(1)}ms · 200 rows only ${cp95.toFixed(1)}ms · ` +
            results.map(r => `${r.N} sockets ${r.p95.toFixed(1)}ms`).join(" · "));
const r200 = results.find(r => r.N === 200);
chk(cp95 < bp95 * 1.6, `CONTROL: 200 presence rows alone barely move HTTP p95 (${bp95.toFixed(1)} → ${cp95.toFixed(1)} ms) — so the flood cost is NOT presence-map growth`);
chk(r200.p95 < cp95 * 1.5, `200 SOCKETS do not degrade HTTP p95 beyond the rows-only control (${cp95.toFixed(1)} → ${r200.p95.toFixed(1)} ms)`);
chk(r200.mib < 2, `200 sockets do not pull an absurd amount of egress (${r200.mib.toFixed(1)} MiB/s)`);
const r400 = results.find(r => r.N === 400);
chk(r400.p95 < cp95 * 2, `400 SOCKETS still do not degrade HTTP p95 (${cp95.toFixed(1)} → ${r400.p95.toFixed(1)} ms)`);

console.log("\n— B. THE SAME ATTACKER OVER HTTP (what one POST buys) —");
const hf = startFlood(200, "http");
await sleep(12000);
const hb = bytesOf(hf);
console.log(`    HTTP attacker: ${(hb / 1048576 / 12).toFixed(2)} MiB/s for 200 POSTs / 10 s — one snapshot per message`);
const amp = r200.mib / Math.max(0.0001, hb / 1048576 / 12);
console.log(`    AMPLIFICATION of the socket over the POST, same message budget: x${amp.toFixed(0)}`);
chk(amp < 10, `a socket is not more than 10x more powerful than a POST per inbound message (x${amp.toFixed(0)})`);
hf.kill("SIGKILL"); await sleep(13500);

// ---- C. THE HEADLINE: propagation latency -----------------------------------------------------
// The receiver must run on the SHIPPED cadence (a free-running 280ms poll), not "poll the instant
// the mover posts" — the whole term the socket deletes is the WAIT for the next scheduled poll.
console.log("\n— C. END-TO-END PROPAGATION LATENCY: WS vs HTTP (60 cycles each, free-running receiver) —");
const CYCLES = 60, MOVE_DT = 280;
const MOVER = netid();

async function measureHttp() {
  const O = netid();
  await post("/world/move", mvBody(O, 0, 0, { dl: 0 }));
  await post("/world/move", mvBody(MOVER, 10, 0, { dl: 0 }));
  const seenAt = new Map();          // x -> performance.now() when the poller first reported it
  let stop = false;
  (async () => {                     // FREE-RUNNING poller, exactly like Net.gd's MOVE_DT gate
    let n = 0;
    while (!stop) {
      const t = performance.now();
      const r = await post("/world/move", mvBody(O, 0, 0, { dl: 1, seq: 100000 + (n++) }));
      const p = (r.body?.players || []).find(q => q.wallet === MOVER);
      if (p && !seenAt.has(p.x)) seenAt.set(p.x, performance.now());
      const spent = performance.now() - t;
      await sleep(Math.max(0, MOVE_DT - spent));
    }
  })();
  await sleep(600);
  const lat = [];
  for (let c = 0; c < CYCLES; c++) {
    const target = 10 + (c + 1);
    await sleep(60 + Math.random() * MOVE_DT);          // random phase vs the poll cadence
    const t0 = performance.now();
    await post("/world/move", mvBody(MOVER, target, 0, { dl: 1, seq: 200000 + c }));
    const dl = performance.now() + 3000;
    while (performance.now() < dl && !seenAt.has(target)) await sleep(4);
    if (seenAt.has(target)) lat.push(seenAt.get(target) - t0);
  }
  stop = true; await sleep(400);
  return lat;
}

async function measureWs() {
  const O = netid();
  const ws = new WS(WSURL);
  const seenAt = new Map();
  ws.on("message", (d) => {
    const now = performance.now();
    try { const j = JSON.parse(String(d)); const p = (j.players || []).find(q => q.wallet === MOVER); if (p && !seenAt.has(p.x)) seenAt.set(p.x, now); } catch {}
  });
  ws.on("error", () => {});
  await new Promise(r => ws.on("open", r));
  ws.send(JSON.stringify(mvBody(O, 0, 0, { dl: 0 })));
  await sleep(400);
  const keep = setInterval(() => { try { ws.send(JSON.stringify(mvBody(O, 0, 0, { dl: 1 }))); } catch {} }, MOVE_DT);
  await sleep(400);
  const lat = [];
  for (let c = 0; c < CYCLES; c++) {
    const target = 500 + (c + 1);
    await sleep(60 + Math.random() * MOVE_DT);
    const t0 = performance.now();
    await post("/world/move", mvBody(MOVER, target, 0, { dl: 1, seq: 300000 + c }));
    const dl = performance.now() + 3000;
    while (performance.now() < dl && !seenAt.has(target)) await sleep(4);
    if (seenAt.has(target)) lat.push(seenAt.get(target) - t0);
  }
  clearInterval(keep); ws.close();
  return lat;
}
const hl = await measureHttp();
const wl = await measureWs();
const fmt = (a) => `n=${a.length} p50=${pct(a, 0.5).toFixed(1)} p95=${pct(a, 0.95).toFixed(1)} max=${Math.max(...a).toFixed(1)}`;
console.log(`    HTTP (280ms free-running poll): ${fmt(hl)} ms`);
console.log(`    WS   (20Hz push)              : ${fmt(wl)} ms`);
chk(hl.length >= 50 && wl.length >= 50, `>=50 cycles measured on both (http=${hl.length} ws=${wl.length})`);
chk(pct(wl, 0.5) < pct(hl, 0.5), `WS p50 propagation beats HTTP (${pct(wl, 0.5).toFixed(1)} vs ${pct(hl, 0.5).toFixed(1)} ms)`);
chk(pct(wl, 0.95) < pct(hl, 0.95), `WS p95 propagation beats HTTP (${pct(wl, 0.95).toFixed(1)} vs ${pct(hl, 0.95).toFixed(1)} ms)`);
console.log(`    improvement: p50 ${(pct(hl, 0.5) - pct(wl, 0.5)).toFixed(0)}ms faster (${(100 * (1 - pct(wl, 0.5) / pct(hl, 0.5))).toFixed(0)}%), p95 ${(pct(hl, 0.95) - pct(wl, 0.95)).toFixed(0)}ms faster (${(100 * (1 - pct(wl, 0.95) / pct(hl, 0.95))).toFixed(0)}%)`);

console.log(`\nAVWSLOAD_DONE pass=${pass} fail=${fail}`);
for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }
process.exit(0);
