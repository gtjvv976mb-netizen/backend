// _rv_secrets_probe.mjs — key discipline across every route this pass touched.
// RPC_URL is set to a CANARY and CLIENT_RPC is left UNSET, then every response body the fishing and
// action changes can reach is scanned for the canary, for the treasury key and for any rpc-shaped key.
// The rule (ledger, 2026-07-26): RPC_URL is server-only and must never appear in a response;
// CLIENT_RPC is public by design and must fail CLOSED ("" — never a fallback to RPC_URL).
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
const CANARY = "https://mainnet.helius-rpc.com/?api-key=RV-CANARY-b3f19d2a-DO-NOT-LEAK";
process.env.RPC_URL = CANARY;                       // server-only; must never be echoed
delete process.env.CLIENT_RPC;                      // public; must fail closed to ""
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet";
process.env.PORT = "44431"; process.env.ADMIN_KEY = "local-sim-admin";
process.env.CHIK_ACTIONS = "1";
delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, text: await r.text() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, text: await r.text() }; };
await import("/Users/michaelkennethbrillantes/Downloads/chiki-backend/server.js");
await sleep(1500);

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const SECRETS = [CANARY, "RV-CANARY", "helius", JSON.stringify(Array.from(_t.secretKey)).slice(1, 60), bs58.encode(_t.secretKey).slice(0, 24)];

const kp = nacl.sign.keyPair();
const wallet = bs58.encode(kp.publicKey);
const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
const v = await post("/verify", { wallet, netId: "nrv1", authMsg, authSig });
const mktToken = JSON.parse(v.text).mktToken;
await post("/world/move", { wallet, mktToken, x: -684, z: 156, dir: 0 });

const probes = [
  ["POST /world/fish/report", await post("/world/fish/report", { wallet, mktToken, tier: 3, rod: 10, lvl: 20 })],
  ["POST /world/fish/report (dry, refused)", await post("/world/fish/report", { wallet: "godot-rvsecr01", tier: 3, rod: 10 })],
  ["POST /world/node/claim", await post("/world/node/claim", { wallet, mktToken, id: "stone:120:-260", cd: 60 })],
  ["POST /world/node/claim (wrong tool)", await post("/world/node/claim", { wallet, mktToken, id: "stone:120:-260", cd: 60, tool: "axe" })],
  ["POST /world/mob/hit", await post("/world/mob/hit", { wallet, mktToken, idx: 0, dmg: 1 })],
  ["POST /world/kill/report", await post("/world/kill/report", { wallet, mktToken })],
  ["POST /world/move", await post("/world/move", { wallet, mktToken, x: -684, z: 156, dir: 0 })],
  ["GET /world/feed", await get("/world/feed")],
  ["GET /world/event", await get("/world/event")],
  ["GET /stats", await get("/stats")],
  ["GET /world/roster", await get("/world/roster")],
  ["GET /world/players?wallet", await get(`/world/players?wallet=${wallet}&x=0&z=0`)],
  ["GET /assets/summary (unkeyed)", await get("/assets/summary")],
  ["GET /assets/summary (keyed)", await get("/assets/summary?key=local-sim-admin")],
  ["GET /health", await get("/health")],
];
for (const [name, r] of probes) {
  const hit = SECRETS.find((s) => s && r.text.includes(s));
  chk(!hit, `${name}: ${r.status}, ${r.text.length} B, zero secret bytes${hit ? ` — LEAKED ${hit.slice(0, 40)}` : ""}`);
}
const stats = JSON.parse((await get("/stats")).text);
chk(stats.clientRpc === "", `/stats.clientRpc fails CLOSED with CLIENT_RPC unset (value=${JSON.stringify(stats.clientRpc)}) — no fallback to RPC_URL`);
const rpcKeys = Object.keys(stats).filter((k) => /rpc|endpoint|url|node/i.test(k));
chk(rpcKeys.every((k) => !String(stats[k]).includes("RV-CANARY")),
  `no rpc-shaped key on /stats carries the canary under another name (keys checked: ${JSON.stringify(rpcKeys)})`);

console.log(`\nRV_SECRETS_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
