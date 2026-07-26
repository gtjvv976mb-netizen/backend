// Does the world REMEMBER what was taken from it across a restart?
// There is no Postgres here, so this round-trips the REAL serialize/restore functions in one
// process: claim -> serialize -> wipe (simulating the restart) -> restore -> assert the world came
// back exactly as it was. Throwaway wallets, memory store, dummy RPC.
import nacl from "tweetnacl";
import bs58 from "bs58";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39141";
delete process.env.DATABASE_URL;

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const post = async (p, b) => (await fetch(BASE + p, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
const get = async (p) => (await fetch(BASE + p)).json();
const move = (w, x, z) => post("/world/move", { wallet: w, x, z, dir: 0, handle: "T" });

const srv = await import("./server.js");
await new Promise(r => setTimeout(r, 1400));

console.log("— take things from the world —");
const A = wallet(), B = wallet();
await move(A, 500, 500); await move(B, 700, -700);
await post("/world/node/claim", { wallet: A, id: "stone:500:500", cd: 600 });      // a spent rock
await post("/world/node/claim", { wallet: B, id: "wood:700:-700", cd: 600, uses: 3 }); // a part-chopped trunk
const before = await get("/world/nodes");
chk(before.nodes["stone:500:500"] > 0, "the rock is spent");
chk(before.uses["wood:700:-700"] === 2, `the trunk is part-worked (${before.uses["wood:700:-700"]} loads left)`);

console.log("— RESTART: serialise, wipe, restore (exactly what a Render deploy does) —");
const blob = JSON.parse(JSON.stringify(srv.serializeWorldNodes()));   // through JSON, as the DB would
srv._clearWorldNodes();
const wiped = await get("/world/nodes");
chk(Object.keys(wiped.nodes).length === 0 && Object.keys(wiped.uses).length === 0,
    "the in-memory world is empty — this is the state every deploy used to leave behind");
const r = srv.restoreWorldNodes(blob);
chk(r.nodes === 1 && r.uses === 1, `restored ${r.nodes} spent + ${r.uses} part-worked`);

const after = await get("/world/nodes");
chk(after.nodes["stone:500:500"] > 0, "the rock is STILL spent after the restart — it does not pop back");
chk(after.uses["wood:700:-700"] === 2, "the trunk still has exactly its 2 remaining loads, not a fresh 3");
chk(Math.abs(after.nodes["stone:500:500"] - before.nodes["stone:500:500"]) < 3000,
    "and its respawn timer survived rather than restarting");

console.log("— a respawn that came due while the server was down stays expired —");
{
  srv._clearWorldNodes();
  const past = { nodes: [["stone:1:1", Date.now() - 5000]], uses: [] };
  const r2 = srv.restoreWorldNodes(past);
  chk(r2.nodes === 0, "an already-expired node is dropped, not resurrected");
  const s = await get("/world/nodes");
  chk(!s.nodes["stone:1:1"], "so the rock is available again, as it should be");
}

console.log("— a corrupted / hostile blob cannot poison the world —");
{
  srv._clearWorldNodes();
  const evil = {
    nodes: [["../../etc/passwd", Date.now() + 60000], ["ok:2:2", Date.now() + 60000],
            ["bad:3:3", "not-a-number"], "not-an-array", null],
    uses: [["tree:4:4", { left: 9999, ts: Date.now() }],          // absurd load count
           ["tree:5:5", { left: 2, ts: Date.now() - 60 * 60 * 1000 }], // long abandoned
           ["tree:6:6", { left: 2, ts: Date.now() }],             // the one good row
           ["tree:7:7", null], ["tree:8:8", "nope"]],
  };
  const r3 = srv.restoreWorldNodes(evil);
  const s = await get("/world/nodes");
  chk(!s.nodes["../../etc/passwd"], "a path-traversal id does not survive restore verbatim");
  chk(!!s.nodes["ok:2:2"], "the legitimate row alongside it still loads");
  chk(!s.nodes["bad:3:3"], "a non-numeric timestamp is dropped");
  chk(s.uses["tree:4:4"] === undefined, "an absurd load count is refused");
  chk(s.uses["tree:5:5"] === undefined, "a trunk abandoned past the TTL is refused (it regrows)");
  chk(s.uses["tree:6:6"] === 2, "and the one good trunk loads correctly");
  chk(r3.nodes >= 1 && r3.uses === 1, `restore survived the hostile blob (${r3.nodes} nodes, ${r3.uses} uses)`);
}

console.log("— an empty / missing saved blob is not an error —");
chk(srv.restoreWorldNodes(null).nodes === 0, "null blob restores nothing, no throw");
chk(srv.restoreWorldNodes({}).nodes === 0, "empty object restores nothing, no throw");
chk(srv.restoreWorldNodes({ nodes: "garbage", uses: 7 }).nodes === 0, "garbage fields restore nothing, no throw");

console.log(`NODEPERSIST_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
