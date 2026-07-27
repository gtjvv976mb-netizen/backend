// MMO sync check: boot the REAL server in-process and prove a trainer's action + steed +
// party survive the round trip to another player's snapshot. Throwaway wallets, memory store,
// nothing touches the live backend.
import nacl from "tweetnacl";
import bs58 from "bs58";

// throwaway local server: dummy RPC that is never called, a THROWAWAY keypair as the treasury
// secret (never a real one), memory store. Nothing here reaches the live backend or any chain.
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39117";
delete process.env.DATABASE_URL;

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const post = async (p, b) => (await fetch(BASE + p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();

await import("./server.js");
await new Promise(r => setTimeout(r, 1400));

const alice = wallet(), bob = wallet();

console.log("— a trainer's ACTION reaches the other player —");
await post("/world/move", { wallet: alice, x: 10, z: 10, dir: 0, handle: "Alice",
  avatar: "sailor", comp: "dragonos", party: "dragonos,pepe,doge", mount: "", act: "chop:axe" });
let snap = await post("/world/move", { wallet: bob, x: 12, z: 12, dir: 0, handle: "Bob" });
let a = (snap.players || []).find(p => p.wallet === alice);
chk(!!a, "Bob sees Alice at all");
chk(a && a.act === "chop:axe", `her action relays verbatim (got ${a && JSON.stringify(a.act)})`);
chk(a && a.avatar === "sailor", "her avatar look relays");
chk(a && a.party === "dragonos,pepe,doge", "her FULL 3-chikimon party relays");

console.log("— it updates live as she changes what she's doing —");
for (const act of ["mine:pickaxe", "mine:drill", "fish:rod", ""]) {
  await post("/world/move", { wallet: alice, x: 10, z: 10, dir: 0, handle: "Alice", act });
  snap = await post("/world/move", { wallet: bob, x: 12, z: 12, dir: 0, handle: "Bob" });
  a = (snap.players || []).find(p => p.wallet === alice);
  chk(a && a.act === act, `"${act || "(idle)"}" relays`);
}

console.log("— riding relays too, and clears —");
await post("/world/move", { wallet: alice, x: 10, z: 10, dir: 0, handle: "Alice", mount: "griffin", act: "" });
snap = await post("/world/move", { wallet: bob, x: 12, z: 12, dir: 0, handle: "Bob" });
a = (snap.players || []).find(p => p.wallet === alice);
chk(a && a.mount === "griffin", "her steed relays");
await post("/world/move", { wallet: alice, x: 10, z: 10, dir: 0, handle: "Alice", mount: "" });
snap = await post("/world/move", { wallet: bob, x: 12, z: 12, dir: 0, handle: "Bob" });
a = (snap.players || []).find(p => p.wallet === alice);
chk(a && a.mount === "", "dismounting relays");

console.log("— hostile input is still sanitised —");
await post("/world/move", { wallet: alice, x: 10, z: 10, dir: 0, handle: "Alice",
  act: "<script>alert(1)</script>chop" });
snap = await post("/world/move", { wallet: bob, x: 12, z: 12, dir: 0, handle: "Bob" });
a = (snap.players || []).find(p => p.wallet === alice);
chk(a && !String(a.act).includes("<"), `act is tag-stripped (got ${a && JSON.stringify(a.act)})`);
chk(a && String(a.act).length <= 24, "act is length-capped");


console.log("— ONE WORLD: a node taken by one player is gone for everyone —");
{
  const id = "stone:120:-340";
  // both trainers WALK to the rock first - claims are position-authorised now, so a real client
  // is always standing next to what it takes
  await post("/world/move", { wallet: alice, x: 120, z: -340, dir: 0, handle: "Alice" });
  await post("/world/move", { wallet: bob, x: 122, z: -338, dir: 0, handle: "Bob" });
  const c1 = await post("/world/node/claim", { wallet: alice, id, cd: 60 });
  chk(c1.ok === true && c1.taken === false, "Alice claims a fresh rock she is standing at");
  const c2 = await post("/world/node/claim", { wallet: bob, id, cd: 60 });
  chk(c2.ok === false && c2.taken === true, "Bob is REFUSED the same rock (no duplicate harvest)");
  const list = await (await fetch(BASE + "/world/nodes")).json();
  chk(!!list.nodes[id], "the world reports it spent, so every client hides it");
  chk(list.nodes[id] > 0 && list.nodes[id] <= 60000, "with a sane respawn countdown");
  await post("/world/move", { wallet: bob, x: 999, z: 999, dir: 0, handle: "Bob" });
  await new Promise(r => setTimeout(r, 1900));      // respect the per-wallet claim interval
  const other = await post("/world/node/claim", { wallet: bob, id: "stone:999:999", cd: 60 });
  chk(other.ok === true, "a DIFFERENT rock is still free (claims are per-node)");
  await post("/world/move", { wallet: alice, x: 1, z: 1, dir: 0, handle: "Alice" });
  await new Promise(r => setTimeout(r, 1900));
  const quick = await post("/world/node/claim", { wallet: alice, id: "berries:1:1", cd: 1 });
  chk(quick.ok === true, "a normal node claims");
  // The respawn window belongs to the SERVER now — `cd` from the request body used to be honoured
  // up to a full hour, so a griefer could lock a node for everyone. Asking for 1s (as this sim used
  // to, and as a griefer would ask for 3600) no longer changes anything.
  const back = await (await fetch(BASE + "/world/nodes")).json();
  const left = Math.round((back.nodes["berries:1:1"] || 0) / 1000);
  chk(left > 1 && left <= 60, `the server picked the window, not the caller (${left}s, asked for 1s)`);
  const bad = await post("/world/node/claim", { wallet: alice, id: "../../etc/passwd<script>" });
  chk(bad.ok !== true, "hostile node id is refused, not fatal");
}

console.log("— jump height reaches other players —");
await post("/world/move", { wallet: alice, x: 10, y: 31.5, z: 10, dir: 0, handle: "Alice" });
snap = await post("/world/move", { wallet: bob, x: 12, z: 12, dir: 0, handle: "Bob" });
a = (snap.players || []).find(p => p.wallet === alice);
chk(a && Math.abs(a.y - 31.5) < 0.01, `her height relays (got ${a && a.y}) -> jumps are visible`);
await post("/world/move", { wallet: alice, x: 10, y: 22, z: 10, dir: 0, handle: "Alice" });
snap = await post("/world/move", { wallet: bob, x: 12, z: 12, dir: 0, handle: "Bob" });
a = (snap.players || []).find(p => p.wallet === alice);
chk(a && Math.abs(a.y - 22) < 0.01, "and updates as she lands");


console.log("— node claims are AUTHORISED against where you actually are —");
{
  const cheat = wallet(), honest = wallet();
  // a client that never entered the world
  const ghost = await post("/world/node/claim", { wallet: cheat, id: "stone:10:10", cd: 60 });
  chk(ghost.ok === false, "a client with NO presence is refused");

  // present, but claiming a node on the far side of the island
  await post("/world/move", { wallet: cheat, x: 0, z: 0, dir: 0, handle: "Cheat" });
  const far = await post("/world/node/claim", { wallet: cheat, id: "stone:900:-900", cd: 60 });
  chk(far.ok === false && far.error === "out of reach",
      `remote claim refused (${far.error}, ${far.dist} away) - cannot strip-mine the island from spawn`);

  // honest play: standing next to the node
  await post("/world/move", { wallet: honest, x: 200, z: -140, dir: 0, handle: "Honest" });
  const near = await post("/world/node/claim", { wallet: honest, id: "stone:203:-142", cd: 60 });
  chk(near.ok === true, "a node you are STANDING AT still claims normally");

  // just outside reach
  const edge = await post("/world/node/claim", { wallet: honest, id: "stone:230:-140", cd: 60 });
  chk(edge.ok === false && edge.error === "out of reach", "a node 30 units away is refused");

  // spam
  await post("/world/move", { wallet: cheat, x: 0, z: 0, dir: 0, handle: "Cheat" });
  const a1 = await post("/world/node/claim", { wallet: cheat, id: "stone:2:2", cd: 60 });
  const a2 = await post("/world/node/claim", { wallet: cheat, id: "stone:3:3", cd: 60 });
  chk(a1.ok === true, "first in-reach claim lands");
  chk(a2.ok === false && a2.error === "too fast", "an instant second claim is rate-limited");

  // malformed ids don't crash or bypass
  const bad = await post("/world/node/claim", { wallet: honest, id: "notanode", cd: 60 });
  chk(bad.ok === false, "a malformed id is refused, not fatal");
}

console.log(`MMOSYNC_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
