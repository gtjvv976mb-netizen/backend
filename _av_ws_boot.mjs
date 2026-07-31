// Boots the REAL server.js in a child process for out-of-process load measurement.
// Throwaway nacl keypair, dummy RPC (never called), memory store, VERIFY_HOLDERS=false.
import nacl from "tweetnacl";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59992";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = process.env.AVPORT || "41901";
delete process.env.DATABASE_URL;
await import("./server.js");
setTimeout(() => console.log("AVBOOT_READY"), 1200);
