// world_terrain.js — THE SERVER LEARNS THE SHAPE OF THE ISLAND.
//
// Server-authoritative movement needs the server to know where the ground is; until now only the
// client did. The terrain is not arbitrary geometry — it is a HEIGHTFIELD baked into
// island_data.bin, which makes this tractable: the same lookup the client's ChikoriaGen.surface_height
// performs, performed here, byte-for-byte against the same file.
//
// FORMAT (read from ChikoriaGen.gd:63-76, verified against the file size):
//   uint32 LE  w                     (1472)
//   uint32 LE  h                     (1664)
//   int16  LE  heights[w*h]          (row-major, z*w + x; negative = below the sea floor)
//   uint8      colours[w*h]          (palette indices — not needed for collision, skipped)
//   8 + 2*w*h + w*h  ==  7,348,232 bytes, which is exactly the file's size.
//
// The client's rule, mirrored exactly (ChikoriaGen.surface_height):
//   outside the grid            -> SEA - 14
//   height value below zero     -> SEA - 14
//   otherwise                   -> the stored height
//
// This module is PURE: no server state, no I/O after load. It exists so movement validation and the
// physics tick can ask "how high is the ground here?" and get the same answer the player's own
// client would give — because a server that disagrees with the client about the floor will fight
// every honest player forever.
import fs from "node:fs";
import path from "node:path";

// must match ChikoriaGen.gd:11 EXACTLY. A guess of 18.0 put every off-island point 12 units wrong
// (server 4 vs client -8) — 186 of 405 sample points — while every on-island height matched, which
// is precisely how a wrong constant hides: the common case looks perfect.
export const SEA = 6.0;
const DEEP = SEA - 14.0;

let _w = 0, _h = 0, _heights = null, _loaded = false, _source = "";

// The island lives in the CLIENT project; the server reads it from there in dev and from its own
// copy in production. Both paths are tried so a deploy that vendors the file just works.
const CANDIDATES = [
  process.env.CHIK_ISLAND_BIN,
  path.join(process.cwd(), "island_data.bin"),
  path.join(process.env.HOME || "", "Downloads/ChikoriaSmooth/island_data.bin"),
].filter(Boolean);

export function loadTerrain(explicitPath) {
  const tries = explicitPath ? [explicitPath, ...CANDIDATES] : CANDIDATES;
  for (const p of tries) {
    try {
      if (!fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      if (buf.length < 8) continue;
      const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
      const need = 8 + 2 * w * h + w * h;
      if (w <= 0 || h <= 0 || buf.length < 8 + 2 * w * h) continue;
      // int16 heights, row-major. Read as a typed view for O(1) lookups and no per-cell allocation.
      const heights = new Int16Array(w * h);
      for (let i = 0; i < w * h; i++) heights[i] = buf.readInt16LE(8 + i * 2);
      _w = w; _h = h; _heights = heights; _loaded = true; _source = p;
      return { ok: true, w, h, bytes: buf.length, expected: need, source: p };
    } catch (e) { /* try the next candidate */ }
  }
  _loaded = false;
  return { ok: false, tried: tries };
}

export function terrainReady() { return _loaded; }
export function terrainInfo() { return { ready: _loaded, w: _w, h: _h, source: _source }; }

// the client's _cell(x, z): world coords -> grid index, centred on the island
function cellIndex(x, z) {
  const cx = Math.floor(x + _w * 0.5);
  const cz = Math.floor(z + _h * 0.5);
  if (cx < 0 || cz < 0 || cx >= _w || cz >= _h) return -1;
  return cz * _w + cx;
}

// THE ANSWER THE CLIENT WOULD GIVE. Mirrors ChikoriaGen.surface_height exactly.
export function surfaceHeight(x, z) {
  if (!_loaded) return SEA;          // unknown terrain must never refuse a player — fail permissive
  const c = cellIndex(x, z);
  if (c < 0) return DEEP;
  const hv = _heights[c];
  if (hv < 0) return DEEP;
  return hv;
}

// Is this a place a player could BE? Used by movement validation: a position far above the ground is
// a flying cheat, far below is a clip-through. The bands are generous because the game legitimately
// launches players upward (jumps, the griffin's flight, boats on the sea surface).
export function groundedness(x, y, z) {
  const g = surfaceHeight(x, z);
  return { ground: g, above: y - g };
}
