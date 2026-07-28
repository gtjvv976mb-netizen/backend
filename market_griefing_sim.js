// Can one player destroy another player's goods?
// Exercises the REAL auth path: Ed25519 sign-in -> /verify -> market token -> /market/op.
// Throwaway keypairs, memory store, dummy RPC. The live backend is never touched.
import nacl from "tweetnacl";
import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39179";
delete process.env.DATABASE_URL;
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const post = async (p, b) => (await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
const get = async (p) => (await fetch(BASE + p)).json();
// sending a whisper AS a public wallet now needs proof (wallets are published in /world/roster,
// so a bare one cannot authorise anything). Sign in properly, as a real client does.
async function provenW(){
  const kp=nacl.sign.keyPair(), w=bs58.encode(kp.publicKey), nid="n"+Math.random().toString(36).slice(2);
  const msg=`Chikoria sign-in\nwallet:${w}\nts:${Date.now()}`;
  const sg=Buffer.from(nacl.sign.detached(Buffer.from(msg,"utf8"),kp.secretKey)).toString("base64");
  const v=await post("/verify",{wallet:w,netId:nid,authMsg:msg,authSig:sg});
  return {w,tok:v.mktToken};
}
await import("./server.js");
await new Promise(r => setTimeout(r, 1400));

// a fully signed-in trader: keypair -> signed message -> /verify -> {sid, wallet, mktToken}
let nid = 0;
async function trader(name) {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const netId = `net${++nid}${Date.now().toString(36)}`;
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { name, wallet, sid: netId, tok: v.mktToken, signedIn: v.signedIn };
}
const op = (t, o, listing) => post("/market/op", { sid: t.sid, op: o, listing, wallet: t.wallet, mktToken: t.tok });
const onBoard = async (id) => ((await get("/market/list")).listings || []).some(x => x.id === id);

const A = await trader("griefer"), B = await trader("honest");
chk(!!A.tok && A.signedIn, `sign-in mints a market token (${A.tok ? "yes" : "NO"}) — the auth path is real`);

console.log("— the fix: cancelling an id you never owned must not blacklist it —");
for (const id of ["L3", "L4", "L5", "L6"]) await op(A, "cancel", { id });
for (const id of ["L3", "L4"]) {
  await op(B, "list", { id, item: "wood", kind: "mat", qty: 5, price: 100, seller: B.name });
}
chk(await onBoard("L3"), "honest seller's L3 reaches the board despite the griefer's pre-cancel");
chk(await onBoard("L4"), "and L4 too — their goods are no longer vaporised");

console.log("— a stranger still cannot remove a listing they do not own —");
await op(A, "cancel", { id: "L3" });
chk(await onBoard("L3"), "the griefer's cancel does not delete someone else's live listing");

console.log("— the owner's own cancel still works, and still blocks resurrection —");
await op(B, "list", { id: "M1", item: "stone", kind: "mat", qty: 1, price: 10, seller: B.name });
chk(await onBoard("M1"), "owner lists M1");
await op(B, "cancel", { id: "M1" });
chk(!(await onBoard("M1")), "owner cancels it and it leaves the board");
await op(B, "list", { id: "M1", item: "stone", kind: "mat", qty: 1, price: 10, seller: B.name });
chk(!(await onBoard("M1")), "re-pushing the SAME id is still refused — no double-sale resurrection");

console.log("— world chat carries the wallet, so a name is whisperable —");
{
  await post("/world/chat", { wallet: A.wallet, handle: "Alice", text: "hello world" });
  const last = ((await get("/world/chat?since=0")).messages || []).slice(-1)[0];
  chk(!!last && last.wallet === A.wallet, "the message now carries the full wallet");
  chk(!!last && String(last.short).includes("…"), "and still carries the short id for display");
  const dm = await post("/world/dm", { wallet: B.wallet, mktToken: B.tok, handle: "Bob", to: last.wallet, text: "psst" });
  chk(!dm.error, `whispering the clicked name is accepted (${dm.error || "ok"})`);
  // reading an inbox is proof-gated too, so read it as its owner
  const rcv = await get(`/world/dm?wallet=${last.wallet}&since=0&mktToken=${encodeURIComponent(A.tok)}`);
  chk(((rcv.messages) || []).length > 0, "and the whisper actually arrives");
  const bad = await post("/world/dm", { wallet: B.wallet, mktToken: B.tok, handle: "Bob", to: last.short, text: "x" });
  chk(!!bad.error, `the ellipsised short id is still rejected (${bad.error}) — exactly what the client used to send`);
}

console.log(`MKTGRIEF_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
