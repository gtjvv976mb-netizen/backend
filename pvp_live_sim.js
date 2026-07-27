// Does the SERVER-AUTHORITATIVE duel actually work for two real players?
// Challenge -> accept -> both poll their own state -> both submit cards -> a turn resolves ->
// someone wins. Throwaway wallets, memory store, nothing touches the live backend.
import nacl from "tweetnacl";
import bs58 from "bs58";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39121";
delete process.env.DATABASE_URL;

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const post = async (p, b) => (await fetch(BASE + p, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
const get = async (p) => (await fetch(BASE + p)).json();

await import("./server.js");
await new Promise(r => setTimeout(r, 1400));

const A = wallet(), B = wallet();
const snapA = { element: "Fire",  name: "Alice", br: 8, cardTier: 1, arenaSkills: [] };
const snapB = { element: "Water", name: "Bob",   br: 8, cardTier: 1, arenaSkills: [] };

console.log("— matchmaking —");
const ch = await post("/pvp/challenge", { from: A, fromName: "Alice", to: B, snap: snapA });
chk(ch.ok === true, "Alice challenges Bob");
const inbox = await post("/pvp/available", { wallet: B, name: "Bob", snap: snapB });
const mine = (inbox.challenges || []).find(c => c.from === A);
chk(!!mine, "Bob sees the challenge in his inbox");
const acc = await post("/pvp/challenge/accept", { wallet: B, challengeId: mine && mine.id, snap: snapB });
// per-match secrets: /pvp/move and /pvp/forfeit now require them (the wallet alone is public, so it
// could never have authorised a mutation). The accepter gets theirs here; the challenger gets
// theirs from /pvp/available when they discover the match.
const secB = acc.sec;
const availA = await post("/pvp/available", { wallet: A, name: "Alice", snap: snapA });
const secA = availA.matched && availA.matched.sec;
const secOf = (w) => (w === A ? secA : secB);
chk(acc.ok === true && !!acc.matchId, `Bob accepts -> a live match exists (${acc.matchId})`);
const mid = acc.matchId;

console.log("— both players see the SAME battle, each with only their own hand —");
const sa = await get(`/pvp/state?matchId=${mid}&wallet=${A}`);
const sb = await get(`/pvp/state?matchId=${mid}&wallet=${B}`);
chk(!!sa && !sa.error, "Alice can read her battle state");
chk(!!sb && !sb.error, "Bob can read his battle state");
chk(sa.turn !== undefined && sa.turn === sb.turn, `both are on the same turn (${sa.turn})`);
chk(Array.isArray(sa.you && sa.you.hand) && sa.you.hand.length > 0, `Alice is dealt a hand (${sa.you && sa.you.hand && sa.you.hand.length} cards)`);
chk((sa.foe && sa.foe.hand) === undefined && (sb.foe && sb.foe.hand) === undefined, "neither view exposes the opponent's hand");

const stranger = wallet();
const sneak = await get(`/pvp/state?matchId=${mid}&wallet=${stranger}`);
chk(!!sneak.error, "a stranger is refused the battle state");

console.log("— a turn RESOLVES only when both have committed —");
const m1 = await post("/pvp/move", { matchId: mid, wallet: A, sec: secA, cards: [0] });
chk(!m1.error, "Alice locks in a card");
const midTurn = await get(`/pvp/state?matchId=${mid}&wallet=${B}`);
chk(midTurn.turn !== undefined && midTurn.turn === sa.turn, "the turn has NOT advanced on one player alone");
const m2 = await post("/pvp/move", { matchId: mid, wallet: B, sec: secB, cards: [0] });
chk(!m2.error, "Bob locks in a card");
await new Promise(r => setTimeout(r, 250));
const after = await get(`/pvp/state?matchId=${mid}&wallet=${A}`);
chk(after.turn > sa.turn || after.status === "finished",
    `the turn resolved once both committed (turn ${sa.turn} -> ${after.turn}, status ${after.status})`);

console.log("— spectators can watch, without seeing hands —");
const spec = await get(`/pvp/spectate?matchId=${mid}`);
chk(!spec.error, "anyone can spectate");
chk(!spec.error && !(spec.a && spec.a.hand) && !(spec.b && spec.b.hand), "the spectator view exposes no hands");

console.log("— play it to the end —");
let turns = 0, done = null, stalls = 0;
// a legal bot: try a card, and if the engine rejects it (not enough energy) PASS instead, so the
// turn always resolves. A player who submits nothing is valid; a player who submits garbage is
// not, and the engine correctly makes that side wait for its 30s deadline.
const commit = async (wal, v) => {
  if (v.youSubmitted) return true;
  const hand = (v.you && v.you.hand) || [];
  for (const idx of [0, 1, 2]) {
    if (idx >= hand.length) break;
    const r = await post("/pvp/move", { matchId: mid, wallet: wal, sec: secOf(wal), cards: [idx] });
    if (!r.error) return true;
  }
  const p = await post("/pvp/move", { matchId: mid, wallet: wal, sec: secOf(wal), cards: [] });   // pass
  return !p.error;
};
for (let i = 0; i < 900; i++) {
  const s = await get(`/pvp/state?matchId=${mid}&wallet=${A}`);
  if (s.status === "finished") { done = s; break; }
  if (s.between) { await new Promise(r => setTimeout(r, 100)); continue; }
  const ha = await get(`/pvp/state?matchId=${mid}&wallet=${A}`);
  const hb = await get(`/pvp/state?matchId=${mid}&wallet=${B}`);
  const okA = await commit(A, ha), okB = await commit(B, hb);
  if (!okA || !okB) stalls++;
  turns++;
  await new Promise(r => setTimeout(r, 25));
}
chk(!!done, `the duel played out to a real conclusion (${turns} loops, ${stalls} rejected commits)`);
chk(done && (done.result === "win" || done.result === "loss"), `it has a real win/loss result (${done && done.result}, score ${done && JSON.stringify(done.score)})`);

console.log("— walking out is an instant loss, not a hang —");
{
  const C = wallet(), D = wallet();
  await post("/pvp/challenge", { from: C, fromName: "Cara", to: D, snap: { ...snapA, name: "Cara" } });
  const inb = await post("/pvp/available", { wallet: D, name: "Dev", snap: { ...snapB, name: "Dev" } });
  const c2 = (inb.challenges || []).find(x => x.from === C);
  const a2 = await post("/pvp/challenge/accept", { wallet: D, challengeId: c2 && c2.id, snap: { ...snapB, name: "Dev" } });
  const availC = await post("/pvp/available", { wallet: C, name: "Cara", snap: { ...snapA, name: "Cara" } });
  const secC = availC.matched && availC.matched.sec;
  const ff = await post("/pvp/forfeit", { matchId: a2.matchId, wallet: C, sec: secC });
  chk(ff.ok === true, "the quitter's forfeit is accepted");
  const end = await get(`/pvp/state?matchId=${a2.matchId}&wallet=${D}`);
  chk(end.status === "finished", "the match ends immediately for the player who stayed");
}

console.log(`PVPLIVE_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
