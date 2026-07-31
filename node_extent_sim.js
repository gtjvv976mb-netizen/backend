// NODE EXTENT PARITY — every node the shipped client can actually gather must survive the server's
// island-plausibility gate. This exists because it did not: ISLAND_NODE_R was sized from Gather.gd's
// 240..640 placement ring, but TREES come from the authored trees_meta.json and reach 927.8 units,
// so four real trunks answered 400 "no such node" and an honest 16-second chop paid nothing.
//
// Reads the CLIENT's own data (ChikoriaSmooth/trees_meta.json) and the CLIENT's placement bounds,
// then drives the REAL /world/node/claim route. In-process server, throwaway keypair, dummy RPC,
// memory store, unique port — nothing here touches the live backend or any chain.
import nacl from "tweetnacl";
import fs from "node:fs";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39913";
delete process.env.DATABASE_URL;
const BASE = `http://127.0.0.1:${process.env.PORT}`;

let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const post = async (p, b) => { const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { code: r.status, j: await r.json().catch(() => ({})) }; };
const move = (w, x, z) => post("/world/move", { wallet: w, x, z, y: 20 });

const CLIENT = "/Users/michaelkennethbrillantes/Downloads/ChikoriaSmooth";
const CX = 2, CZ = -204;                       // Gather.gd:9-10

await import("./server.js");
await new Promise(r => setTimeout(r, 1500));

console.log("=== A. every TREE in the shipped trees_meta.json is claimable ===");
let trees = [];
try {
  const tj = JSON.parse(fs.readFileSync(CLIENT + "/trees_meta.json", "utf8"));
  // Gather.gd:333-335 — Vector3(inst[0], inst[1], inst[2]); node_id rounds x and z
  trees = (tj.instances || []).map(i => ({ x: Math.round(Number(i[0])), z: Math.round(Number(i[2])) }));
} catch (e) { console.log("  (client data unreadable: " + e.message + ")"); }
if (!trees.length) {
  console.log("  SKIP — no client trees_meta.json on this machine");
} else {
  let maxR = 0, worst = null;
  for (const t of trees) { const r = Math.hypot(t.x - CX, t.z - CZ); if (r > maxR) { maxR = r; worst = t; } }
  console.log(`  ${trees.length} trees · max radius from (${CX},${CZ}) = ${maxR.toFixed(1)} at (${worst.x},${worst.z})`);
  // claim the 8 widest — the gate is a radius, so the extremes are the whole test
  const wide = [...trees].sort((a, b) => Math.hypot(b.x - CX, b.z - CZ) - Math.hypot(a.x - CX, a.z - CZ)).slice(0, 8);
  let served = 0;
  for (const [i, t] of wide.entries()) {
    const W = "godot-tree" + i;
    await move(W, t.x, t.z);
    const r = await post("/world/node/claim", { wallet: W, id: `wood:${t.x}:${t.z}` });
    const ok = r.code === 200 && Array.isArray(r.j?.drop) && r.j.drop.length === 1 && r.j.drop[0] === "wood";
    if (ok) served++;
    console.log(`    wood:${t.x}:${t.z}  r=${Math.hypot(t.x - CX, t.z - CZ).toFixed(1).padStart(6)}  HTTP ${r.code}  drop=${JSON.stringify(r.j?.drop)} ${r.j?.error || ""}`);
  }
  chk(served === wide.length, `the ${wide.length} widest real trees all pay exactly one wood (${served}/${wide.length})`);
}

console.log("\n=== B. the widest ring node, the widest mine, and a wandered cow ===");
{
  const cases = [
    ["stone", Math.round(CX + 640), CZ, "the placement ring's outer edge (rad 640)"],
    ["iron", -388, 340, "the iron mine, the farthest of the three"],
    ["cow", Math.round(CX + 640 + 13), CZ, "a cow that wandered the full 13 units outward"],
  ];
  let served = 0;
  for (const [k, x, z, why] of cases) {
    const W = "godot-ext" + k;
    await move(W, x, z);
    const r = await post("/world/node/claim", { wallet: W, id: `${k}:${x}:${z}` });
    const ok = r.code === 200 && Array.isArray(r.j?.drop) && r.j.drop.length > 0;
    if (ok) served++;
    console.log(`    ${k}:${x}:${z}  r=${Math.hypot(x - CX, z - CZ).toFixed(1)}  HTTP ${r.code}  drop=${JSON.stringify(r.j?.drop)}  — ${why}`);
  }
  chk(served === cases.length, `all ${cases.length} extreme honest nodes are served (${served}/${cases.length})`);
}

console.log("\n=== C. and the gate still refuses what it exists to refuse ===");
{
  const W = "godot-far";
  await move(W, 20000, 0);
  const r = await post("/world/node/claim", { wallet: W, id: "wood:20000:0" });
  chk(r.code === 400, `a node 20000 units off the island is refused (HTTP ${r.code} "${r.j?.error}")`);
  const W2 = "godot-edge";
  await move(W2, 2, -204 + 1400);
  const r2 = await post("/world/node/claim", { wallet: W2, id: "wood:2:1196" });
  chk(r2.code === 400, `1400 units out — well past every real node — is refused (HTTP ${r2.code} "${r2.j?.error}")`);
  const W3 = "godot-kind";
  await move(W3, 400, 100);
  const r3 = await post("/world/node/claim", { wallet: W3, id: "essence:400:100" });
  chk(r3.code === 400, `a fabricated KIND on the island is still refused (HTTP ${r3.code} "${r3.j?.error}")`);
}

console.log(`\nNODEEXTENT_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
