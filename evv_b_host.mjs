// evv_b_host.mjs — local REAL-backend host for the dev_evv_b_gate client probe.
// Boots the actual server.js in-process (memory store, dead RPC, throwaway admin key + balance
// seams — NEVER the live backend) on :39296, plus a tiny control server on :39297 the Godot
// probe drives:
//   GET /cred      -> {wallet, authMsg, authSig}  (throwaway keypair, balance seeded 0)
//   GET /ev/start  -> owner curls: open_gates 7d + fishing_festival 5d x4 + founder_drop 7d
//   GET /ev/stop   -> stops all three
//   GET /bal?v=N   -> re-seed the cred wallet's balance
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto";
import http from "node:http";
process.env.RPC_URL = "http://127.0.0.1:59993";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
process.env.VERIFY_HOLDERS = "true"; process.env.NETWORK = "devnet"; process.env.PORT = "39296";
process.env.CHIKI_MINT = bs58.encode(nacl.sign.keyPair().publicKey);
process.env.ADMIN_KEY = "evv-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1"; process.env.CHIK_NFT_HANDOVER = "1";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return r.json().catch(() => ({})); };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1200));

const kp = nacl.sign.keyPair();
const wallet = bs58.encode(kp.publicKey);
const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
SRV._setBalanceForTest(wallet, 0);

const ctl = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname === "/cred") { SRV._setBalanceForTest(wallet, 0); return send({ wallet, authMsg, authSig }); }
    if (u.pathname === "/ev/start") {
      const g = await post("/admin/event/start", { key: KEY, event: "open_gates", days: 7 });
      const f = await post("/admin/event/start", { key: KEY, event: "fishing_festival", days: 5, mult: 4 });
      const d = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7 });
      console.log("CTL ev/start", JSON.stringify({ g: g.ends, f: f.ends, d: d.ends }));
      return send({ ok: true, g, f, d });
    }
    if (u.pathname === "/ev/stop") {
      for (const e of ["open_gates", "fishing_festival", "founder_drop"]) await post("/admin/event/stop", { key: KEY, event: e });
      console.log("CTL ev/stop all");
      return send({ ok: true });
    }
    if (u.pathname === "/bal") { const v = Number(u.searchParams.get("v")) || 0; SRV._setBalanceForTest(wallet, v); return send({ ok: true, v }); }
    send({ error: "unknown" });
  } catch (e) { send({ error: String(e?.message || e) }); }
});
ctl.listen(39297, "127.0.0.1", () => console.log("EVV_HOST ready: server :39296, control :39297, wallet " + wallet));
