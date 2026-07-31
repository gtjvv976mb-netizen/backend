// party_sim.js — PARTY REGISTRY verification, fully in-process. NEVER touches the live backend.
// Life cycle (invite->accept->chat->kick->leave->disband), every refusal, rate cap, kv round-trip,
// and the /world/move wire field (members island-wide, strangers none).
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();                                  // THROWAWAY, never a real key
process.env.RPC_URL = "http://127.0.0.1:59999";                  // dummy, never called
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39177";
delete process.env.DATABASE_URL;                                 // memory store
const srv = await import("./server.js");
await new Promise(r => setTimeout(r, 1400));

const BASE = "http://127.0.0.1:39177";
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("ok:", msg); } else { fail++; console.log("FAIL:", msg); } }
async function post(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
async function get(path) {
  const r = await fetch(BASE + path);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
const seam = srv._partySeam;
const nid = (n) => "godot-" + n.toString(16).padStart(8, "0");   // demo-style net_ids (the id IS the secret)
const A = nid(0xa11ce001), B = nid(0xb0b00002), C = nid(0xc4a70003), D = nid(0xd0d00004),
      E = nid(0xe66e0005), F = nid(0xf00d0006), G = nid(0x60a70007), S = nid(0x57a60008);
let seq = 1;
async function move(w, x, z, extra = {}) { return post("/world/move", { wallet: w, x, z, y: 0, dir: 0, handle: "H_" + w.slice(-4), seq: seq++, ...extra }); }

// establish presence for everyone (party wire reads worldPlayers)
for (const w of [A, B, C, D, E, F, G, S]) await move(w, 10, 10);

// ---- 1. invite -> typed DM delivery ----
let r = await post("/party/invite", { wallet: A, to: B, handle: "Alice" });
ok(r.status === 200 && r.body?.ok === true, `A invites B accepted (status=${r.status})`);
r = await get(`/world/dm?wallet=${B}`);
const pinv = (r.body?.messages || []).find(m => m.kind === "pinv" && m.from === A);
ok(!!pinv, `B's DM inbox has a typed invite kind="pinv" from A (got ${JSON.stringify(pinv || r.body?.messages)})`);

// ---- 2. refusal: uninvited join ----
r = await post("/party/accept", { wallet: C, from: A });
ok(r.status === 403, `uninvited join refused (status=${r.status} err="${r.body?.error}")`);

// ---- 3. refusal: self-invite ----
r = await post("/party/invite", { wallet: A, to: A });
ok(r.status === 400, `self-invite refused (status=${r.status} err="${r.body?.error}")`);

// ---- 4. rate cap: two invites back-to-back ----
seam.clearInviteCap();
await post("/party/invite", { wallet: A, to: C });
r = await post("/party/invite", { wallet: A, to: D });
ok(r.status === 429, `second invite inside 2000ms rate-capped (status=${r.status} err="${r.body?.error}")`);

// ---- 5. accept -> party of 2, server-minted id ----
r = await post("/party/accept", { wallet: B, from: A });
const pid1 = r.body?.party?.id || "";
ok(r.status === 200 && /^pty_[0-9a-f]{24}$/.test(pid1), `B accepts; server-minted unguessable id (got "${pid1}")`);
ok(r.body?.party?.m?.length === 2, `party wire shows 2 members after first accept (got ${r.body?.party?.m?.length})`);
ok(r.body?.party?.leader === A, `leader is the inviter A (got "${r.body?.party?.leader}")`);

// ---- 6. fill to 4 (C already invited above; invite D+E fresh, cap cleared each time) ----
r = await post("/party/accept", { wallet: C, from: A });
ok(r.status === 200 && r.body?.party?.m?.length === 3, `C joins -> 3 members (got ${r.body?.party?.m?.length})`);
seam.clearInviteCap();
await post("/party/invite", { wallet: A, to: D });
seam.clearInviteCap();
await post("/party/invite", { wallet: A, to: E });     // pending invite to E while there is still room
r = await post("/party/accept", { wallet: D, from: A });
ok(r.status === 200 && r.body?.party?.m?.length === 4, `D joins -> 4 members, full (got ${r.body?.party?.m?.length})`);

// ---- 7. refusal: 5th member via a pre-full invite ----
r = await post("/party/accept", { wallet: E, from: A });
ok(r.status === 409, `5th member refused at accept — party full (status=${r.status} err="${r.body?.error}")`);

// ---- 8. refusal: invite FROM a full party ----
seam.clearInviteCap();
r = await post("/party/invite", { wallet: A, to: F });
ok(r.status === 409, `invite from a full party refused (status=${r.status} err="${r.body?.error}")`);

// ---- 9. refusal: already partied accepter ----
seam.clearInviteCap();
await post("/party/invite", { wallet: S, to: B });     // stranger invites a current member
r = await post("/party/accept", { wallet: B, from: S });
ok(r.status === 409, `member of a party can't accept another invite (status=${r.status} err="${r.body?.error}")`);

// ---- 10. party chat: one POST fans out to every member's inbox ----
const t0 = Date.now();
r = await post("/world/dm", { wallet: B, to: "party", text: "rally at the mine", handle: "Bob" });
ok(r.status === 200 && r.body?.ok === true, `party chat POST accepted (status=${r.status})`);
let fan = 0;
for (const w of [A, B, C, D]) {
  const inb = await get(`/world/dm?wallet=${w}&since=${t0 - 1}`);
  if ((inb.body?.messages || []).some(m => m.to === "party" && m.text === "rally at the mine" && m.pid === pid1)) fan++;
}
ok(fan === 4, `party message delivered to all 4 member inboxes with pid (got ${fan}/4)`);
r = await get(`/world/dm?wallet=${S}&since=${t0 - 1}`);
ok(!(r.body?.messages || []).some(m => m.to === "party" && m.text === "rally at the mine"), `stranger's inbox does NOT get party chat (got ${JSON.stringify((r.body?.messages || []).map(m => m.text))})`);
r = await post("/world/dm", { wallet: S, to: "party", text: "let me in" });
ok(r.status === 409, `partyless to:"party" refused (status=${r.status} err="${r.body?.error}")`);

// ---- 11. the wire field: members island-wide, strangers none ----
await move(A, 0, 0); await move(B, 2000, 2000); await move(C, -1500, 900); await move(D, 30, 40);
r = await move(A, 0, 0);
const pw = r.body?.party;
ok(pw && pw.id === pid1, `A's /world/move reply carries party (id="${pw?.id}")`);
ok(pw?.m?.length === 4, `party rows = 4 members, max 4 (got ${pw?.m?.length})`);
const bRow = (pw?.m || []).find(e => e.w === B);
ok(!!bRow && bRow.x === 2000 && bRow.z === 2000, `B visible ISLAND-WIDE at 2828u via party (got ${JSON.stringify(bRow)})`);
ok(typeof bRow?.h === "string" && bRow.h.length > 0, `party row carries handle (got "${bRow?.h}")`);
ok(!(r.body?.players || []).some(p => p.wallet === B), `B at 2828u is NOT in the interest-filtered players list (players=${(r.body?.players || []).map(p => p.wallet.slice(-4)).join(",")})`);
r = await move(S, 5, 5);
ok(!("party" in (r.body || {})), `stranger's move reply has NO party field (keys=${Object.keys(r.body || {}).join(",")})`);

// ---- 12. refusal: non-leader kick; then leader kick works ----
r = await post("/party/kick", { wallet: B, who: C });
ok(r.status === 403, `non-leader kick refused (status=${r.status} err="${r.body?.error}")`);
r = await post("/party/kick", { wallet: A, who: nid(0x99999999) });
ok(r.status === 404, `kicking a non-member refused (status=${r.status} err="${r.body?.error}")`);
r = await post("/party/kick", { wallet: A, who: D });
ok(r.status === 200, `leader kicks D (status=${r.status})`);
r = await move(D, 30, 40);
ok(!("party" in (r.body || {})), `kicked D no longer gets the party field (keys=${Object.keys(r.body || {}).join(",")})`);

// ---- 13. persistence: ONE kv blob -> both maps reconstructed ----
const blob = JSON.parse(JSON.stringify(seam.serialize()));       // prove it is JSON/kv-safe
const before = seam.size();
seam.restore(null); const wiped = seam.size();
seam.restore(blob); const after = seam.size();
ok(before.parties === 1 && before.partyOf === 3, `pre-wipe registry: 1 party / 3 memberships (got ${JSON.stringify(before)})`);
ok(wiped.parties === 0 && wiped.partyOf === 0, `wipe emptied both maps (got ${JSON.stringify(wiped)})`);
ok(after.parties === 1 && after.partyOf === 3 && seam.pidOf(B) === pid1, `kv blob round-trip rebuilt BOTH maps, partyOf(B)="${seam.pidOf(B)}" === "${pid1}"`);
r = await move(A, 0, 0);
ok(r.body?.party?.id === pid1 && r.body.party.m.length === 3, `wire live again after restore (id="${r.body?.party?.id}" rows=${r.body?.party?.m?.length})`);

// ---- 14. stale invite after disband ----
seam.clearInviteCap();
await post("/party/invite", { wallet: A, to: G });               // invite issued while party pid1 lives
await post("/party/leave", { wallet: C });                       // 3 -> 2
r = await post("/party/leave", { wallet: B });                   // 2 -> auto-disband on last leave
ok(r.status === 200, `B's leave accepted (status=${r.status})`);
ok(seam.size().parties === 0, `last leave auto-disbanded the party (parties=${seam.size().parties})`);
r = await move(A, 0, 0);
ok(!("party" in (r.body || {})), `A partyless after disband — no party field (keys=${Object.keys(r.body || {}).join(",")})`);
r = await post("/party/accept", { wallet: G, from: A });
ok(r.status === 409, `stale invite after disband refused (status=${r.status} err="${r.body?.error}")`);

// ---- 15. leave with no party ----
r = await post("/party/leave", { wallet: S });
ok(r.status === 409, `leave with no party refused (status=${r.status} err="${r.body?.error}")`);

// ---- 16. malformed ids ----
r = await post("/party/invite", { wallet: A, to: "x" });
ok(r.status === 400, `malformed recipient id refused (status=${r.status} err="${r.body?.error}")`);
r = await post("/party/accept", { wallet: "bad id!", from: A });
ok(r.status === 400, `malformed accepter id refused (status=${r.status} err="${r.body?.error}")`);

// ---- 17. pubkey wallets need the market token (presenceOk, exactly like /world/dm) ----
const W = bs58.encode(nacl.sign.keyPair().publicKey);
r = await post("/party/invite", { wallet: W, to: B });
ok(r.status === 403, `bare PUBLIC wallet (no mktToken) refused on invite (status=${r.status} err="${r.body?.error}")`);
r = await post("/party/leave", { wallet: W });
ok(r.status === 403, `bare public wallet refused on leave (status=${r.status} err="${r.body?.error}")`);

console.log(`PARTY_SIM_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
