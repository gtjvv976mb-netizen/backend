#!/usr/bin/env node
// Local-only host for dev_serverrun.gd. Boots the real server with every authority enabled,
// proxies and records the client wire, and exposes narrow test-only controls on loopback.
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Keypair } from "@solana/web3.js";

const REAL = 47701, CTL = 47702, PROXY = 47703;
const treasury = Keypair.generate();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = String(REAL);
process.env.ADMIN_KEY = "serverrun-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_PHYS = "1";
process.env.CHIK_ACTIONS = "1";
process.env.FFISH_AUTHORITY = "1";
process.env.CHIK_CLAIM_TOKEN = "strict";
process.env.CHIK_CUP_AUTH = "strict";
process.env.CHIK_QUEST_AUTH = "strict";
process.env.CHIK_WS_DEFLATE = "1";
process.env.CHIK_WS_DEDUPE = "1";
delete process.env.DATABASE_URL;

const srv = await import("./server.js");
const W = { reqs: 0, moves: 0, movesCv: 0, movesInputs: 0, wsUpgrades: 0,
  claims: [], fish: [], quest: [], cup: [], refusals: [], lastMove: "" };
const cap = (a, v, n = 120) => { a.push(v); if (a.length > n) a.splice(0, a.length - n); };
const bodyText = (chunks) => Buffer.concat(chunks).toString("utf8");

function recordReq(path, body) {
  W.reqs++;
  let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
  if (path === "/world/move") {
    W.moves++; W.lastMove = body.slice(0, 800);
    if (j.cv) W.movesCv++;
    if (Array.isArray(j.inputs) && j.inputs.length) W.movesInputs++;
  }
  return j;
}
function recordRes(path, reqBody, code, resBody) {
  const row = { path, code, reqBody, resBody };
  if (path === "/world/node/claim") cap(W.claims, row);
  if (path === "/world/fish/report") cap(W.fish, row);
  if (path === "/quest/complete") cap(W.quest, row);
  if (path === "/cup/register" || path === "/cup/ready") cap(W.cup, row);
  if (code === 401 || code === 403) cap(W.refusals, { path, code, body: resBody.slice(0, 1000) });
}

const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", b => chunks.push(b));
  req.on("end", () => {
    const rb = bodyText(chunks);
    const path = new URL(req.url, "http://x").pathname;
    recordReq(path, rb);
    const headers = { ...req.headers, host: `127.0.0.1:${REAL}` };
    delete headers["content-length"];
    const up = http.request({ host: "127.0.0.1", port: REAL, method: req.method, path: req.url,
      headers: { ...headers, "content-length": Buffer.byteLength(rb) } }, ur => {
      const out = [];
      ur.on("data", b => { out.push(b); res.write(b); });
      ur.on("end", () => { const txt = bodyText(out); recordRes(path, rb, ur.statusCode || 0, txt); res.end(); });
      res.writeHead(ur.statusCode || 502, ur.headers);
    });
    up.on("error", e => { if (!res.headersSent) res.writeHead(502); res.end(String(e.message || e)); });
    if (rb) up.write(rb);
    up.end();
  });
});

proxy.on("upgrade", (req, socket, head) => {
  W.wsUpgrades++;
  const up = net.connect(REAL, "127.0.0.1", () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(raw + "\r\n");
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  const close = () => { try { socket.destroy(); } catch {} try { up.destroy(); } catch {} };
  up.on("error", close); socket.on("error", close);
});

const player = Keypair.generate();
const wallet = player.publicKey.toBase58();
const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
const seed = Buffer.from(player.secretKey.slice(0, 32));
const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const authSig = crypto.sign(null, Buffer.from(authMsg), crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" })).toString("base64");
let cred = null;
for (let i = 0; i < 100 && !cred; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${REAL}/verify`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet, authMsg, authSig, netId: "godot-serverrun" }) });
    if (r.ok) cred = { wallet, authMsg, authSig, mktToken: (await r.json()).mktToken };
  } catch {}
  if (!cred) await new Promise(r => setTimeout(r, 100));
}
if (!cred?.mktToken) throw new Error("serverrun could not mint the local credential");

http.createServer((req, res) => {
  const send = o => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/ctl/cred") return send(cred);
  if (u.pathname === "/ctl/wire") return send(W);
  if (u.pathname === "/ctl/reset") {
    W.reqs = W.moves = W.movesCv = W.movesInputs = W.wsUpgrades = 0;
    W.claims.length = W.fish.length = W.quest.length = W.cup.length = W.refusals.length = 0;
    W.lastMove = "";
    return send({ ok: true });
  }
  if (u.pathname === "/ctl/state") {
    const s = srv._physStateForTest?.(u.searchParams.get("w"));
    return send(s ? { ok: true, x: s.x, y: s.y, z: s.z, ack: s.lastInputSeq || 0,
      driven: !!s.driven, corrections: s.corrections || 0 } : { ok: false });
  }
  if (u.pathname === "/ctl/tp") {
    const s = srv._physGrantTeleportForTest?.(u.searchParams.get("w"), +u.searchParams.get("x"),
      +u.searchParams.get("y"), +u.searchParams.get("z"), "serverrun");
    return send(s ? { ok: true, x: s.x, y: s.y, z: s.z } : { ok: false });
  }
  send({ ok: true });
}).listen(CTL, "127.0.0.1");

proxy.listen(PROXY, "127.0.0.1", () => console.log(`SERVERRUN_HOST_UP real=${REAL} proxy=${PROXY} ctl=${CTL}`));
process.on("SIGTERM", () => process.exit(0));
