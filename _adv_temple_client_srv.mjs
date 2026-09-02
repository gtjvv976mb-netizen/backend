#!/usr/bin/env node
// LOCAL, THROWAWAY backend for dev_temple_attack.gd. Boots the REAL server.js in-process on
// 127.0.0.1:39190 with CHIK_TEMPLE=1, a dummy RPC, a throwaway treasury and the MEMORY store.
// It cannot reach the live backend: no DATABASE_URL, no real key, no outbound RPC.
//
// It also writes the throwaway wallets the Godot probe will use, and exposes two probe-only
// control routes on a SEPARATE port so the probe can read the server's book and clear the
// 90 s pace gate between attacks without waiting.
import http from "node:http";
import nacl from "tweetnacl";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";

const SRVDIR = "/Users/michaelkennethbrillantes/Downloads/chiki-backend";
const OUT = "/private/tmp/claude-502/-Users-michaelkennethbrillantes-Downloads-chiki-monsters-github/af3679f8-9bd4-4f61-b5ce-8d086a78fa4b/scratchpad";
const PORT = "39190", CTL = 39191;

const kps = {};
const mk = (t) => { const k = nacl.sign.keyPair(); kps[t] = k; return bs58.encode(k.publicKey); };
const W = { a: mk("a"), b: mk("b"), c: mk("c"), d: mk("d"), e: mk("e"), f: mk("f"), g: mk("g") };
fs.writeFileSync(path.join(OUT, "temple_attack_wallets.json"), JSON.stringify(W, null, 1));

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = PORT;
process.env.CHIK_TEMPLE = "1";
process.env.CHIK_CHRONICLE = "1";
delete process.env.DATABASE_URL;
for (const k of ["TEMPLE_CHIKI_PER", "TEMPLE_DAILY_CHIKI", "TEMPLE_DAILY_RUNS", "TEMPLE_MIN_GAP_MS"])
  delete process.env[k];

const SRV = await import("./server.js");
await new Promise((r) => setTimeout(r, 1500));
console.log("TEMPLE_ATTACK_SRV_READY on " + PORT + " ctl " + CTL);
console.log("wallets " + JSON.stringify(W));

// probe control plane — book reads and gate clears, never on the game port
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("content-type", "application/json");
  if (u.pathname === "/row") {
    res.end(JSON.stringify(SRV._templeRowForTest(u.searchParams.get("w") || "") || { day: 0, runs: 0, chiki: 0 }));
  } else if (u.pathname === "/cleargap") {
    res.end(JSON.stringify({ cleared: SRV._templeClearGapForTest(u.searchParams.get("w") || "") }));
  } else if (u.pathname === "/state") {
    res.end(JSON.stringify(SRV._templeStateForTest()));
  } else { res.statusCode = 404; res.end("{}"); }
}).listen(CTL, "127.0.0.1");
