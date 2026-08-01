// LATENCY-WINS child — boots a REAL server.js (this repo's, or a baseline copy given by argv[2])
// out of process so each env-flag combination gets its own module load, and exposes the server's own
// counters on a SECOND local port.
// Throwaway nacl keypair -> TREASURY_SECRET, dummy RPC_URL (never dialled), memory store,
// VERIFY_HOLDERS=false, unique PORT, no DATABASE_URL. NOTHING here touches the live backend.
import nacl from "tweetnacl";
import http from "node:http";

const SRV = process.argv[2] || "/Users/michaelkennethbrillantes/Downloads/chiki-backend/server.js";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59993";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
delete process.env.DATABASE_URL;

const mod = await import(SRV);

const statPort = Number(process.env.LWSTAT || 0);
let cpu0 = process.cpuUsage(), wall0 = performance.now();
http.createServer((req, res) => {
  const u = String(req.url || "");
  if (u.startsWith("/reset")) {
    mod._wsResetStatsForTest?.();
    cpu0 = process.cpuUsage(); wall0 = performance.now();
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return;
  }
  const c = process.cpuUsage(cpu0);
  const s = mod._wsStatsForTest ? mod._wsStatsForTest() : {};
  s.procCpuUs = c.user + c.system;
  s.windowMs = performance.now() - wall0;
  s.rss = process.memoryUsage().rss;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(s));
}).listen(statPort, "127.0.0.1", () => console.log("LWCHILD_READY stat=" + statPort));
