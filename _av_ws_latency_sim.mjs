// THE HEADLINE CLAIM, measured: end-to-end propagation latency, WS push vs HTTP polling.
// Server in its OWN child process. The receiver runs on the SHIPPED cadence (a free-running 280 ms
// poll, Net.gd MOVE_DT) because the term the socket deletes is the wait for the next scheduled
// poll — a receiver that polls the instant the mover posts measures one RTT and nothing else.
// Both legs keep the mover INSIDE the 260-unit interest radius of the receiver.
import { spawn } from "node:child_process";
import WS from "ws";

const PORT = Number(process.env.AVPORT || 41907);
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
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch {} });
for (let i = 0; i < 80; i++) { await sleep(250); try { const r = await fetch(BASE + "/stats"); if (r.ok) break; } catch {} }
await sleep(700);

const CYCLES = 60, MOVE_DT = 280;
console.log(`\n— PROPAGATION LATENCY, ${CYCLES} cycles each, receiver on the shipped 280ms cadence —`);

async function measureHttp() {
  const O = netid(), MOVER = netid();
  await post("/world/move", mvBody(O, 0, 0, { dl: 0 }));
  await post("/world/move", mvBody(MOVER, 10, 0, { dl: 0 }));
  const seenAt = new Map(); let stop = false;
  (async () => {
    let n = 0;
    while (!stop) {
      const t = performance.now();
      const r = await post("/world/move", mvBody(O, 0, 0, { dl: 1, seq: 100000 + (n++) }));
      const p = (r.body?.players || []).find(q => q.wallet === MOVER);
      if (p && !seenAt.has(p.x)) seenAt.set(p.x, performance.now());
      await sleep(Math.max(0, MOVE_DT - (performance.now() - t)));
    }
  })();
  await sleep(700);
  const lat = [];
  for (let c = 0; c < CYCLES; c++) {
    const target = 20 + c;                       // 20..79 — well inside INTEREST_ENTER (260)
    await sleep(60 + Math.random() * MOVE_DT);   // random phase against the poll cadence
    const t0 = performance.now();
    await post("/world/move", mvBody(MOVER, target, 0, { dl: 1, seq: 200000 + c }));
    const dl = performance.now() + 3000;
    while (performance.now() < dl && !seenAt.has(target)) await sleep(3);
    if (seenAt.has(target)) lat.push(seenAt.get(target) - t0);
  }
  stop = true; await sleep(400);
  return lat;
}

async function measureWs() {
  const O = netid(), MOVER = netid();
  await post("/world/move", mvBody(MOVER, 10, 0, { dl: 0 }));
  const ws = new WS(WSURL);
  const seenAt = new Map();
  ws.on("message", (d) => {
    const now = performance.now();
    try { const j = JSON.parse(String(d)); const p = (j.players || []).find(q => q.wallet === MOVER); if (p && !seenAt.has(p.x)) seenAt.set(p.x, now); } catch {}
  });
  ws.on("error", () => {});
  await new Promise(r => ws.on("open", r));
  ws.send(JSON.stringify(mvBody(O, 0, 0, { dl: 0 })));
  await sleep(500);
  const keep = setInterval(() => { try { ws.send(JSON.stringify(mvBody(O, 0, 0, { dl: 1 }))); } catch {} }, MOVE_DT);
  await sleep(500);
  const lat = [];
  for (let c = 0; c < CYCLES; c++) {
    const target = 20 + c;                       // same range, same distance, same row size
    await sleep(60 + Math.random() * MOVE_DT);
    const t0 = performance.now();
    await post("/world/move", mvBody(MOVER, target, 0, { dl: 1, seq: 300000 + c }));
    const dl = performance.now() + 3000;
    while (performance.now() < dl && !seenAt.has(target)) await sleep(3);
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
chk(hl.length >= 50 && wl.length >= 50, `>=50 cycles landed on both legs (http=${hl.length} ws=${wl.length})`);
chk(pct(wl, 0.5) < pct(hl, 0.5), `WS p50 beats HTTP (${pct(wl, 0.5).toFixed(1)} vs ${pct(hl, 0.5).toFixed(1)} ms)`);
chk(pct(wl, 0.95) < pct(hl, 0.95), `WS p95 beats HTTP (${pct(wl, 0.95).toFixed(1)} vs ${pct(hl, 0.95).toFixed(1)} ms)`);
console.log(`    p50 ${(pct(hl, 0.5) - pct(wl, 0.5)).toFixed(0)}ms faster (${(100 * (1 - pct(wl, 0.5) / pct(hl, 0.5))).toFixed(0)}%) · p95 ${(pct(hl, 0.95) - pct(wl, 0.95)).toFixed(0)}ms faster (${(100 * (1 - pct(wl, 0.95) / pct(hl, 0.95))).toFixed(0)}%)`);
console.log(`    theory check — 20Hz push predicts a uniform 0..50ms wait (p50 25, p95 47.5); a 280ms poll predicts p50 140, p95 266`);

console.log(`\nAVWSLAT_DONE pass=${pass} fail=${fail}`);
try { srv.kill("SIGKILL"); } catch {}
process.exit(0);
