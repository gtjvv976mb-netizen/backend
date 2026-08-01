// Shared helpers for the latency-wins sims. No server boots here.
import { spawn } from "node:child_process";
import nacl from "tweetnacl";
import bs58 from "bs58";

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const B = (s) => Buffer.byteLength(s, "utf8");
export const pad = (s, n) => String(s).padEnd(n);
export const lpad = (s, n) => String(s).padStart(n);
export const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "n/a");

let PASS = 0, FAIL = 0;
export function ok(cond, label, actual) {
  if (cond) { PASS++; console.log(`  PASS  ${label}${actual !== undefined ? `  [${actual}]` : ""}`); }
  else { FAIL++; console.log(`  FAIL  ${label}${actual !== undefined ? `  [${actual}]` : ""}`); }
  return cond;
}
export function tally() { return { PASS, FAIL }; }

export function quant(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const q = (p) => a.length ? a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))] : 0;
  return { n: a.length, min: a[0] || 0, p50: q(0.5), p95: q(0.95), max: a[a.length - 1] || 0,
           mean: a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0 };
}
export const fq = (q, d = 3) => `n=${q.n} p50=${q.p50.toFixed(d)} p95=${q.p95.toFixed(d)} max=${q.max.toFixed(d)}`;

// ---- boot a child server with a given env, wait for it to answer /health
export async function boot({ port, statPort, env = {}, srv, label = "child" }) {
  const child = spawn(process.execPath, ["/Users/michaelkennethbrillantes/Downloads/chiki-backend/_lw_child.mjs", srv || ""], {
    env: { ...process.env, PORT: String(port), LWSTAT: String(statPort), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  child.stdout.on("data", d => { for (const l of String(d).split("\n")) if (l.trim()) lines.push(l.trim()); });
  child.stderr.on("data", d => { for (const l of String(d).split("\n")) if (l.trim()) lines.push("ERR " + l.trim()); });
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) { await r.text(); break; }
    } catch {}
    await sleep(120);
  }
  return {
    child, lines, port, statPort, label,
    base: `http://127.0.0.1:${port}`,
    wsurl: `ws://127.0.0.1:${port}/ws/world`,
    stats: async () => (await fetch(`http://127.0.0.1:${statPort}/`)).json(),
    reset: async () => { await (await fetch(`http://127.0.0.1:${statPort}/reset`)).text(); },
    kill: () => { try { child.kill("SIGKILL"); } catch {} },
  };
}

export async function post(base, p, b) {
  const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  let j = null; try { j = await r.json(); } catch {}
  return { code: r.status, body: j };
}

// A REAL proven wallet: 44-char base58 pubkey + a /verify mktToken. Byte budgets taken with
// `godot-xxxx` net_ids understate every row by ~24 B (ledger trap, 2026-08-01).
export async function proven(base) {
  const kp = nacl.sign.keyPair(), w = bs58.encode(kp.publicKey), nid = "n" + Math.random().toString(36).slice(2);
  const msg = `Chikoria sign-in\nwallet:${w}\nts:${Date.now()}`;
  const sg = Buffer.from(nacl.sign.detached(Buffer.from(msg, "utf8"), kp.secretKey)).toString("base64");
  const v = (await post(base, "/verify", { wallet: w, netId: nid, authMsg: msg, authSig: sg })).body;
  return { w, tok: v && v.mktToken };
}

export const AVATARS = ["classic", "sailor", "fire", "electro", "ranger", "noble", "sage", "rogue"];
export const COMPS = ["dragonos", "pepe", "doge", "jellox", "shibbo", "wojak", "chonkers", "flarewing"];
export const MOUNTS = ["", "griffin", "wolf", "boar", "stag", "raptor", ""];
export const ACTS = ["", "chop:axe", "mine:drill", "fish:rod", "pick:sickle", "", "mine:pickaxe"];
export const ELS = ["Fire", "Water", "Earth", "Air", "Light", "Dark"];
export const EGGS = ["", "normal", "normal,meme", "legendary", "meme,mount", "normal,legendary,meme,mount"];
export const HANDLES = ["Trainer", "ChikiKing", "Volt", "Mirabella", "xX_Grimwick_Xx", "Sam", "AzulonFan99", "Nym"];
const wrapPi = (a) => { a = ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return Math.round(a * 1000) / 1000; };

// The same peer body shape wire_bytes_sim.mjs used, so the byte numbers are comparable.
export function peerBody(i, t, cx, cz) {
  const ang = (i / 12) * Math.PI * 2;
  const r = 20 + (i % 6) * 12;
  return {
    x: Math.round((cx + Math.cos(ang + t * 0.4) * r) * 100) / 100,
    y: Math.round((34 + Math.sin(t * 0.9 + i) * 2.5) * 100) / 100,
    z: Math.round((cz + Math.sin(ang + t * 0.4) * r) * 100) / 100,
    dir: wrapPi(ang + t * 0.4 + 1.5708),
    handle: HANDLES[i % HANDLES.length],
    avatar: AVATARS[i % AVATARS.length],
    comp: COMPS[i % COMPS.length],
    party: [COMPS[i % 8], COMPS[(i + 3) % 8], COMPS[(i + 5) % 8]].join(","),
    mount: MOUNTS[i % MOUNTS.length],
    act: ACTS[i % ACTS.length],
    eggs: EGGS[i % EGGS.length],
    el: ELS[i % ELS.length],
    leg: i % 20, br: 1 + (i * 3) % 50, spr: i % 3 === 0,
  };
}
