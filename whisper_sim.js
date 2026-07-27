// WHISPER-FROM-WORLD-CHAT check: does clicking a name in World chat produce a recipient id the
// /world/dm route will accept? Boots the REAL server in-process. Throwaway keypairs, memory store,
// dummy RPC — nothing here touches the live backend or any chain.
import nacl from "tweetnacl";
import bs58 from "bs58";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39241";
delete process.env.DATABASE_URL;

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { code: r.status, body: await r.json().catch(() => ({})) };
};
const get = async (p) => {
  const r = await fetch(BASE + p);
  return { code: r.status, body: await r.json().catch(() => ({})) };
};

await import("./server.js");
await new Promise(r => setTimeout(r, 1400));

const alice = wallet(), bob = wallet();

console.log("— what a world-chat line actually carries —");
await post("/world/chat", { wallet: alice, handle: "Chiki dev", text: "Heyy!!" });
const feed = await get("/world/chat?since=0");
const line = (feed.body.messages || []).at(-1);
console.log("  server line:", JSON.stringify(line));
chk(!!line && line.text === "Heyy!!", "Alice's line is in the world log");
chk(!!line && !("wallet" in line), `no 'wallet' key on the message (keys = ${JSON.stringify(Object.keys(line || {}))})`);

console.log("— Chat.gd:507  var fromid := String(m.get(\"wallet\", m.get(\"short\", \"\"))) —");
// EXACT client expression: wallet if present, else short. This value is what gets baked into the
// clickable [url=fid|name] at Chat.gd:672 and stored as _wtarget at Chat.gd:683.
const fromid = String(line.wallet ?? line.short ?? "");
console.log("  fromid the client derives:", JSON.stringify(fromid));
chk(fromid === line.short, "the client falls back to the ellipsised short id");
chk(fromid !== alice, `fromid is NOT Alice's real presence id (${alice.slice(0, 8)}…)`);

console.log("— Bob clicks her name and whispers (Chat.gd:706 POSTs to=_wtarget) —");
const dm = await post("/world/dm", { wallet: bob, handle: "Bob", to: fromid, text: "hi there" });
console.log("  server said:", dm.code, JSON.stringify(dm.body));
chk(dm.code === 400, `whisper to the clicked name is REJECTED (HTTP ${dm.code})`);

const inboxA = await get(`/world/dm?wallet=${encodeURIComponent(alice)}&since=0`);
chk((inboxA.body.messages || []).length === 0,
    `Alice's inbox is empty — nothing was delivered (got ${(inboxA.body.messages || []).length} msgs)`);
const inboxB = await get(`/world/dm?wallet=${encodeURIComponent(bob)}&since=0`);
chk((inboxB.body.messages || []).length === 0,
    `Bob has no self-echo either, so his own client shows NOTHING (got ${(inboxB.body.messages || []).length})`);

console.log("— control: the same whisper with the FULL id works —");
const dm2 = await post("/world/dm", { wallet: bob, handle: "Bob", to: alice, text: "hi there" });
chk(dm2.code === 200, `full-id whisper accepted (HTTP ${dm2.code})`);
const inboxA2 = await get(`/world/dm?wallet=${encodeURIComponent(alice)}&since=0`);
chk((inboxA2.body.messages || []).length === 1, "…and it lands in Alice's inbox");
// reply path (Chat.gd:527/531 takes `from`, which the DM route DOES send)
const rep = (inboxA2.body.messages || [])[0];
chk(rep && rep.from === bob, "the DM route sends a FULL `from`, so replying to a whisper works");

console.log("— demo / no-wallet players (presence id = net_id) fare the same —");
const netid = "netid_abc123XYZ";
await post("/world/chat", { wallet: netid, handle: "Demo", text: "yo" });
const feed2 = await get("/world/chat?since=0");
const dline = (feed2.body.messages || []).at(-1);
const dfromid = String(dline.wallet ?? dline.short ?? "");
const dm3 = await post("/world/dm", { wallet: bob, handle: "Bob", to: dfromid, text: "yo back" });
chk(dm3.code === 400, `short id ${JSON.stringify(dfromid)} rejected too (HTTP ${dm3.code})`);

console.log("— the unread-badge side effect (Chat.gd:509 `fromid != mine`) —");
// Alice's own echoed line: the comment says it must never badge World unread.
const mine = alice;
chk(fromid !== mine, `Alice's own line evaluates alert = (fromid != mine) = ${fromid !== mine} — always true, so her own message badges World unread`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
