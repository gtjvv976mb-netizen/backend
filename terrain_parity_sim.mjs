import fs from "node:fs";
import { loadTerrain, surfaceHeight, terrainInfo } from "/Users/michaelkennethbrillantes/Downloads/chiki-backend/world_terrain.js";
const r = loadTerrain();
console.log("load:", JSON.stringify(r).slice(0, 160));
console.log("info:", JSON.stringify(terrainInfo()));
const dump = JSON.parse(fs.readFileSync(process.env.HOME + "/Library/Application Support/Godot/app_userdata/Chikoria (Smooth Voxel)/terrain_dump.json", "utf8"));
let match = 0, off = 0, worst = 0, worstAt = null;
for (const [x, z, clientH] of dump) {
  const mine = surfaceHeight(x, z);
  const d = Math.abs(mine - clientH);
  if (d < 0.001) match++;
  else { off++; if (d > worst) { worst = d; worstAt = { x: +x.toFixed(1), z: +z.toFixed(1), client: clientH, server: mine }; } }
}
console.log(`points ${dump.length}: MATCH ${match}, differ ${off}, worst delta ${worst}`);
if (worstAt) console.log("worst case:", JSON.stringify(worstAt));
console.log(`TERRAIN_CHECK_DONE match=${match} differ=${off}`);
