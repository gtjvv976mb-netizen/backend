// SECRET ISOLATION across the NEW door. RPC_URL is set to a canary and CLIENT_RPC is left unset:
// every byte the socket ever emits — ack, tick, err, pong — plus /stats, must contain zero canary
// bytes and no rpc-shaped key. Credentials have leaked twice in this codebase (TREASURY_SECRET, and
// /stats falling back CLIENT_RPC || RPC_URL), so a new response object gets swept the moment it exists.
import nacl from "tweetnacl";
import bs58 from "bs58";
import WS from "ws";

const CANARY = "https://mainnet.helius-rpc.com/?api-key=AV-CANARY-8f3a91d2-DO-NOT-LEAK";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = CANARY;
delete process.env.CLIENT_RPC;
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "41931";
delete process.env.DATABASE_URL;
delete process.env.CHIK_WS;

const PORT = Number(process.env.PORT), BASE = `http://127.0.0.1:${PORT}`, WSURL = `ws://127.0.0.1:${PORT}/ws/world`;
let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const netid = () => "godot-" + Math.random().toString(36).slice(2, 14);
await import("./server.js");
await sleep(1500);

const SECRETS = [CANARY, "AV-CANARY-8f3a91d2", "api-key", "helius", JSON.stringify(Array.from(_t.secretKey)).slice(1, 40), bs58.encode(_t.secretKey).slice(0, 20)];
const sweep = (label, text) => {
  const hits = SECRETS.filter(s => s && text.includes(s));
  chk(hits.length === 0, `${label}: zero secret bytes in ${text.length} B (${hits.length ? "LEAKED " + hits[0].slice(0, 24) : "clean"})`);
};

console.log("\n— SECRET ISOLATION ACROSS /ws/world —");
const raw = [];
const ws = new WS(WSURL);
ws.on("message", (d) => raw.push(String(d)));
ws.on("error", () => {});
await new Promise(r => ws.on("open", r));
const mv = (w, x, z, e = {}) => JSON.stringify(Object.assign({ wallet: w, x, y: 0, z, dir: 0, handle: "T", leg: 1, el: "Fire", br: 1 }, e));
const me = netid();
ws.send(mv(netid(), 3, 0));                                    // a peer, so rows are non-empty
ws.send(mv(me, 0, 0, { dl: 0 }));
ws.send(JSON.stringify({ t: "ping" }));
ws.send("{not json");
ws.send(JSON.stringify({ t: "nonsense" }));
ws.send(mv("!!!bad-id!!!", 0, 0));                              // a 400 err frame
await sleep(1500);
ws.close();
console.log(`    captured ${raw.length} frames, ${raw.reduce((a, b) => a + b.length, 0)} B (kinds: ${[...new Set(raw.map(r => { try { return JSON.parse(r).t; } catch { return "?"; } }))].join(",")})`);
chk(raw.length > 5, `the socket emitted frames to sweep (${raw.length})`);
sweep("every socket frame concatenated", raw.join("\n"));

const stats = await (await fetch(BASE + "/stats")).text();
sweep("GET /stats", stats);
const sj = JSON.parse(stats);
chk(sj.clientRpc === "", `/stats.clientRpc fails closed with CLIENT_RPC unset ("${sj.clientRpc}")`);
const keys = JSON.stringify(sj).match(/"[a-zA-Z]*[rR]pc[a-zA-Z]*"/g) || [];
chk(keys.every(k => k === '"clientRpc"'), `no rpc-shaped key under another name (${keys.join(",") || "none"})`);
for (const p of ["/world/roster", "/world/players?wallet=x&x=0&z=0"]) sweep(`GET ${p}`, await (await fetch(BASE + p)).text());

console.log(`\nAVWSSEC_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
