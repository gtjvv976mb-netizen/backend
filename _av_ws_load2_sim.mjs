// THE FIX, MEASURED — the same attack as _av_ws_load_sim.mjs, now against the bounded server, and
// against an ADAPTED attacker that talks just often enough to stay inside WS_MOVE_IDLE_MS.
// Server in its own child process, attacker in another, so nothing here is the sim's own CPU.
// AV_WSMAX / AV_WSIDLE let the same file measure the PRE-FIX behaviour (caps disabled) for the
// before/after pair, so the comparison is one build and one machine, not two runs of two builds.
import { spawn } from "node:child_process";

const PORT = Number(process.env.AVPORT || 41961);
const BASE = `http://127.0.0.1:${PORT}`;
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
const kids = [];
process.on("exit", () => { for (const k of kids) { try { k.kill("SIGKILL"); } catch {} } });

function bootServer(env) {
  const c = spawn(process.execPath, ["_av_ws_boot.mjs"], { cwd: process.cwd(), env: { ...process.env, AVPORT: String(PORT), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout.on("data", () => {}); c.stderr.on("data", () => {}); kids.push(c); return c;
}
function startFlood(n, mode, cadence) {
  const c = spawn(process.execPath, ["_av_ws_flood_child.mjs", String(n), String(PORT), mode, String(cadence)], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  c.last = ""; c.stdout.on("data", (d) => { const m = String(d).match(/FLOODSTAT frames=\d+ bytes=\d+/g); if (m) c.last = m[m.length - 1]; });
  c.stderr.on("data", () => {}); kids.push(c); return c;
}
const bytesOf = (c) => Number((String(c.last).match(/bytes=(\d+)/) || [0, 0])[1]);
async function waitUp() { for (let i = 0; i < 80; i++) { await sleep(250); try { if ((await fetch(BASE + "/stats")).ok) return true; } catch {} } return false; }
async function httpLatency(samples, tag) {
  const w = netid(); const lat = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    const r = await post("/world/move", mvBody(w, 40 + (i % 5), 40, { dl: 1, seq: i + 1 }));
    const dt = performance.now() - t0;
    if (r.code === 200) lat.push(dt);
    await sleep(40);
  }
  console.log(`      ${tag}: p50=${pct(lat, 0.5).toFixed(1)}ms p95=${pct(lat, 0.95).toFixed(1)}ms`);
  return lat;
}

async function scenario(label, srvEnv, n, cadence) {
  const srv = bootServer(srvEnv);
  await waitUp(); await sleep(700);
  const base = await httpLatency(60, "baseline (no flood)");
  const f = startFlood(n, "ws", cadence);
  await sleep(6000);
  const b0 = bytesOf(f);
  const lat = await httpLatency(90, `under ${n} sockets @ ${cadence}ms`);
  const b1 = bytesOf(f);
  const secs = 90 * 0.04 + 90 * (pct(lat, 0.5) / 1000);
  const mib = ((b1 - b0) / 1048576) / Math.max(1, secs);
  const inKB = (n * 0.3) / (cadence / 1000);
  console.log(`      → egress ${mib.toFixed(1)} MiB/s from ${inKB.toFixed(1)} KB/s of attacker upload  (x${(mib * 1024 / Math.max(0.01, inKB)).toFixed(0)} amplification)`);
  f.kill("SIGKILL"); await sleep(300); srv.kill("SIGKILL"); await sleep(1200);
  return { label, bp95: pct(base, 0.95), p95: pct(lat, 0.95), p50: pct(lat, 0.5), mib, inKB };
}

console.log("\n================ AV: THE FIX, MEASURED ================");
console.log("\n— PRE-FIX (caps disabled: CHIK_WS_MAX=0, idle bound pushed past the attack) —");
const preNaive = await scenario("pre/200@10s", { CHIK_WS_MAX: "0", CHIK_WS_IDLE_MS: "60000" }, 200, 10000);
const pre400 = await scenario("pre/400@10s", { CHIK_WS_MAX: "0", CHIK_WS_IDLE_MS: "60000" }, 400, 10000);

console.log("\n— POST-FIX (shipped defaults: max 250, idle 4s, grace 30s) —");
const postNaive = await scenario("post/200@10s", {}, 200, 10000);
const postAdapt = await scenario("post/400@3.5s", {}, 400, 3500);

console.log("\n— RESULT —");
for (const r of [preNaive, pre400, postNaive, postAdapt])
  console.log(`    ${r.label.padEnd(14)} honest p95 ${r.bp95.toFixed(1)} → ${r.p95.toFixed(1)} ms · egress ${r.mib.toFixed(1)} MiB/s from ${r.inKB.toFixed(1)} KB/s`);

chk(postNaive.mib < preNaive.mib * 0.6, `the naive attacker's egress is cut by the idle bound (${preNaive.mib.toFixed(1)} → ${postNaive.mib.toFixed(1)} MiB/s)`);
chk(postNaive.p95 < preNaive.p95, `and the honest poller's p95 improves with it (${preNaive.p95.toFixed(1)} → ${postNaive.p95.toFixed(1)} ms)`);
chk(postAdapt.mib < pre400.mib, `400 sockets can no longer all connect, so the ADAPTED attacker is bounded too (${pre400.mib.toFixed(1)} → ${postAdapt.mib.toFixed(1)} MiB/s)`);
chk(postAdapt.p95 < pre400.p95 * 1.1, `the honest poller's p95 under the adapted 400-socket attack (${pre400.p95.toFixed(1)} → ${postAdapt.p95.toFixed(1)} ms)`);
console.log(`\n    WORST CASE AT THE SHIPPED CAP: ${postAdapt.mib.toFixed(1)} MiB/s. That is the ceiling an operator buys with`);
console.log(`    CHIK_WS_MAX=250; it scales linearly, so halving the cap halves it. Over-cap clients poll HTTP.`);

console.log(`\nAVWSLOAD2_DONE pass=${pass} fail=${fail}`);
for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }
process.exit(0);
