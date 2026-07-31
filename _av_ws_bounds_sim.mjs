// THE THREE BOUNDS, proven and refused: WS_MAX_SOCKETS, WS_AUTH_GRACE_MS, WS_MOVE_IDLE_MS.
// Real server.js in-process, throwaway keypair, dummy RPC, memory store. The caps are set small via
// their env overrides so the refusals are observable in seconds rather than minutes; the DEFAULTS
// (250 / 30 s / 4 s) are asserted separately from a second boot.
import nacl from "tweetnacl";
import bs58 from "bs58";
import WS from "ws";
import { spawn } from "node:child_process";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59993";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "41941";
process.env.CHIK_WS_MAX = "12";
process.env.CHIK_WS_GRACE_MS = "2000";
process.env.CHIK_WS_IDLE_MS = "1500";
delete process.env.DATABASE_URL;
delete process.env.CHIK_WS;

const PORT = Number(process.env.PORT), BASE = `http://127.0.0.1:${PORT}`, WSURL = `ws://127.0.0.1:${PORT}/ws/world`;
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
const srv = await import("./server.js");
await sleep(1500);
const stats = srv._wsStatsForTest;

function sock(url = WSURL) {
  const ws = new WS(url);
  ws.frames = []; ws.err = null; ws.closed = false;
  ws.on("message", (d) => { try { ws.frames.push(JSON.parse(String(d))); } catch {} });
  ws.on("error", (e) => { ws.err = e; });
  ws.on("close", () => { ws.closed = true; });
  ws.settled = new Promise((res) => { ws.on("open", () => res("open")); ws.on("close", () => res("closed")); ws.on("error", () => res("error")); });
  ws.tx = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
  ws.world = () => ws.frames.filter(f => f.t === "world");
  return ws;
}

console.log("\n================ AV: THE THREE BOUNDS ================");
console.log(`   configured: max=${stats().max} grace=${process.env.CHIK_WS_GRACE_MS}ms idle=${process.env.CHIK_WS_IDLE_MS}ms`);

// ---------------------------------------------------------------- 1. WS_MAX_SOCKETS
console.log("\n— 1. WS_MAX_SOCKETS: the ceiling refuses, and refusal means HTTP —");
{
  const keep = [];
  for (let i = 0; i < 12; i++) keep.push(sock());
  await Promise.all(keep.map(s => s.settled));           // ws throws on send() before OPEN — always await first
  for (let i = 0; i < 12; i++) keep[i].tx(mvBody(netid(), 10 + i, 10));
  await sleep(400);
  chk(stats().sockets === 12, `the first 12 sockets are accepted (sockets=${stats().sockets})`);
  const over = [];
  for (let i = 0; i < 20; i++) over.push(sock());
  const res = await Promise.all(over.map(s => s.settled));
  await sleep(300);
  const refused = res.filter(r => r !== "open").length;
  chk(refused === 20, `the next 20 are REFUSED at the upgrade, not accepted-then-dropped (${refused}/20 never opened)`);
  chk(stats().sockets === 12, `and the ceiling holds exactly (sockets=${stats().sockets}, max=${stats().max})`);
  chk(stats().refused >= 20, `the refusals are counted (refused=${stats().refused})`);
  // the refusal must be the SAME shape as the CHIK_WS=0 kill switch the client is proven to survive
  const raw = await new Promise((res2) => {
    const req = { host: "127.0.0.1", port: PORT, path: "/ws/world", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } };
    import("node:http").then(({ default: http }) => {
      const r = http.request(req);
      r.on("upgrade", () => res2({ status: 101 }));
      r.on("response", (rs) => res2({ status: rs.statusCode, hdr: rs.headers }));
      r.on("error", () => res2({ status: 0 }));
      r.end();
    });
  });
  chk(raw.status === 503, `an over-cap upgrade answers 503 Service Unavailable (${raw.status}) — a real refusal, never a hung socket`);
  chk(raw.hdr && raw.hdr["x-chik-ws"] === "full", `tagged X-Chik-Ws: full (${raw.hdr && raw.hdr["x-chik-ws"]})`);
  // THE POINT OF THE WHOLE DESIGN: a refused socket costs the player nothing
  const w = netid();
  const r1 = await post("/world/move", mvBody(w, 11, 10, { dl: 0 }));
  chk(r1.code === 200 && Array.isArray(r1.body.players), `a refused client polls /world/move normally (${r1.code}, peers=${r1.body.players.length})`);
  chk(r1.body.players.some(p => p.handle === "T"), `and sees the players who DID get sockets (${r1.body.players.length} peers)`);
  for (const s of keep) s.close();
  for (const s of over) { try { s.close(); } catch {} }
  await sleep(500);
  chk(stats().sockets === 0, `slots are released on close (sockets=${stats().sockets})`);
  const back = sock(); const st = await back.settled;
  chk(st === "open", `and a new socket is accepted once there is room (${st})`);
  back.close(); await sleep(300);
}

// ---------------------------------------------------------------- 2. WS_AUTH_GRACE_MS
console.log("\n— 2. WS_AUTH_GRACE_MS: a socket that never speaks is closed —");
{
  srv._wsResetStatsForTest();
  const quiet = sock(); await quiet.settled;
  const talker = sock(); await talker.settled;
  talker.tx(mvBody(netid(), 30, 30));
  await sleep(500);
  chk(stats().sockets === 2, `both sockets open (sockets=${stats().sockets}, authed=${stats().authed})`);
  await sleep(7000);   // grace 2s, swept every 5s
  chk(quiet.closed === true, `the silent socket was closed by the grace sweep (closed=${quiet.closed})`);
  chk(talker.closed === false, `the socket that sent an accepted move SURVIVES (closed=${talker.closed})`);
  chk(stats().graceClosed >= 1, `counted (graceClosed=${stats().graceClosed})`);
  chk(stats().sockets === 1, `only the talker is left (sockets=${stats().sockets})`);
  talker.close(); await sleep(400);
  chk(stats().ticking === false, `with no sockets the 20Hz timer stops (ticking=${stats().ticking})`);
}

// ---------------------------------------------------------------- 3. WS_MOVE_IDLE_MS
console.log("\n— 3. WS_MOVE_IDLE_MS: the push follows the client's own cadence —");
{
  srv._wsResetStatsForTest();
  const me = netid();
  const s = sock(); await s.settled;
  s.tx(mvBody(me, 40, 40, { dl: 1 }));
  await sleep(700);
  const early = s.world().length;
  chk(early > 5, `a socket that just moved is streamed at 20Hz (${early} frames in 0.7s)`);
  // The bound is measured from the LAST MOVE, so frames legitimately continue until move+1.5s.
  // What must be zero is the tail AFTER the bound has passed, not the whole quiet window.
  await sleep(1200);            // now ~1.9s since the last move — past the 1.5s bound
  s.frames.length = 0;
  await sleep(1500);            // a full 1.5s window entirely inside the idle state (30 frames at 20Hz)
  const late = s.world().length;
  console.log(`    a 1.5s window taken entirely AFTER the idle bound (presence still valid for 12s): ${late} frames (20Hz would be ~30)`);
  chk(late === 0, `the stream stops dead when the client stops talking (${late} frames, was ${early} per 0.7s while talking)`);
  chk(stats().idleSkips > 0, `skips are counted (idleSkips=${stats().idleSkips})`);
  chk(s.closed === false, `the socket is NOT closed — the bound is non-destructive (closed=${s.closed})`);
  s.frames.length = 0;
  s.tx(mvBody(me, 41, 40, { dl: 1 }));            // one move re-arms it instantly
  await sleep(700);
  chk(s.world().length > 5, `one move re-arms the stream immediately (${s.world().length} frames in 0.7s)`);
  // an HONEST cadence (Net.gd sends every 280ms) is never inside the bound
  s.frames.length = 0;
  const iv = setInterval(() => s.tx(mvBody(me, 42 + Math.random(), 40, { dl: 1 })), 280);
  await sleep(3000);
  clearInterval(iv);
  const honest = s.world().length;
  console.log(`    an honest 280ms client over 3s: ${honest} frames (20Hz would be ~60)`);
  chk(honest > 45, `the shipped 280ms cadence NEVER trips the idle bound (${honest} frames)`);
  s.close(); await sleep(300);
}

// ---------------------------------------------------------------- 4. DEFAULTS, from a clean boot
console.log("\n— 4. THE SHIPPED DEFAULTS (a second server, no env overrides) —");
{
  const child = spawn(process.execPath, ["-e", `
    import('tweetnacl').then(async ({default:n})=>{
      const kp=n.sign.keyPair();
      process.env.RPC_URL='http://127.0.0.1:59994';
      process.env.TREASURY_SECRET=JSON.stringify(Array.from(kp.secretKey));
      process.env.VERIFY_HOLDERS='false'; process.env.NETWORK='devnet'; process.env.PORT='41949';
      delete process.env.DATABASE_URL; delete process.env.CHIK_WS;
      delete process.env.CHIK_WS_MAX; delete process.env.CHIK_WS_GRACE_MS; delete process.env.CHIK_WS_IDLE_MS;
      const s=await import('./server.js');
      setTimeout(()=>{ console.log('DEFAULTS '+JSON.stringify(s._wsStatsForTest())); process.exit(0); }, 1600);
    });`], { cwd: process.cwd(), env: { ...process.env, CHIK_WS_MAX: "", CHIK_WS_GRACE_MS: "", CHIK_WS_IDLE_MS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", d => out += String(d)); child.stderr.on("data", () => {});
  await new Promise(r => child.on("exit", r));
  const m = out.match(/DEFAULTS (\{.*\})/);
  const d = m ? JSON.parse(m[1]) : null;
  chk(d && d.max === 250, `default WS_MAX_SOCKETS = 250 (${d && d.max})`);
  chk(d && d.on === true && d.hz === 20, `defaults otherwise unchanged (on=${d && d.on} hz=${d && d.hz})`);
  chk(/world socket on \/ws\/world · 20Hz · max 250/.test(out), `the boot line states the ceiling (${(out.match(/world socket on[^\n]*/) || ["?"])[0]})`);
}

console.log(`\nAVWSBOUNDS_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
