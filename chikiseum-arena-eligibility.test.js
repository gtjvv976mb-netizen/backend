// Guards the two invariants behind "every Chikimon you own can enter the Chikiseum".
//
// The arena refused almost every creature because registry rows carried a `kind` that disagreed
// with the canonical catalogue's class, and ownedAssets required them to be equal. Four mint paths
// each decided `kind` independently: a grant hard-coded "normal", and the gift/restitution paths
// had no "meme" branch, so `isLegend = sp >= 10` stamped "legendary" onto the six meme species.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const CATALOGUE = JSON.parse(readFileSync(new URL('./chikiseum-profiles.json', import.meta.url), 'utf8'));

const classOf = new Map();
for (const c of CATALOGUE.cards) if (!classOf.has(c.species)) classOf.set(c.species, c.class);

const list = (name) => {
  const m = SRC.match(new RegExp(`${name}\\s*=\\s*Object\\.freeze\\(\\[(.*?)\\]\\)`, 's'));
  assert.ok(m, `${name} not found in server.js`);
  return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map(x => x[1]);
};
const NORMAL = list('SPECIES_NORMAL'), LEGEND = list('SPECIES_LEGEND'), MEME = list('SPECIES_MEME');

// mirrors kindForSpecies() in server.js
const kindForSpecies = (n) =>
  MEME.includes(n) ? 'meme' : LEGEND.includes(n) ? 'legendary' : NORMAL.includes(n) ? 'normal' : 'normal';

test('every server species has a canonical arena kit, and its kind matches that kit', () => {
  const missing = [], mismatched = [];
  for (const sp of [...NORMAL, ...LEGEND, ...MEME]) {
    if (!classOf.has(sp)) { missing.push(sp); continue; }
    if (classOf.get(sp) !== kindForSpecies(sp)) mismatched.push(`${sp}: kind=${kindForSpecies(sp)} catalogue=${classOf.get(sp)}`);
  }
  assert.deepEqual(missing, [], `species with no arena kit — these cannot be admitted at all: ${missing.join(', ')}`);
  assert.deepEqual(mismatched, [], `kind disagrees with the canonical catalogue: ${mismatched.join('; ')}`);
});

test('the legacy 0-20 index mapping agrees with the catalogue for all 21 species', () => {
  const spFromChikiIndex = (i) =>
    i <= 9 ? NORMAL[i] : i <= 14 ? LEGEND[i - 10] : i <= 20 ? MEME[i - 15] : null;
  for (let i = 0; i <= 20; i++) {
    const sp = spFromChikiIndex(i);
    assert.ok(sp, `index ${i} maps to nothing`);
    assert.equal(kindForSpecies(sp), classOf.get(sp), `index ${i} (${sp}) would mint the wrong kind`);
  }
});

test('no mint path derives kind independently of the species', () => {
  // The exact shapes that caused this: a hard-coded kind, and a two-way isLegend ternary with no
  // meme branch. Every chikimon mint must go through kindForSpecies().
  const offenders = [
    /kind: *"normal", *lvl/,
    /kind: *[A-Za-z_.]*isLegend *\? *"legendary" *: *"normal"/,
  ];
  const CODE = SRC.replace(/^\s*\/\/.*$/gm, '');
  for (const re of offenders) {
    assert.equal(re.test(CODE), false, `a mint path still decides kind on its own: ${re}`);
  }
  assert.ok(/function kindForSpecies\(/.test(SRC), 'kindForSpecies() must exist');
});

test('ownedAssets does not gate entry on the stored kind', () => {
  // `kind` never reaches the engine (admit() takes species + level) and the engine derives rarity,
  // HP and damage from the catalogue, so requiring equality only rejected legitimate owners.
  const block = SRC.slice(SRC.indexOf('ownedAssets: (wallet)'), SRC.indexOf('leaseFactory:'));
  assert.ok(block.length > 0, 'ownedAssets block not found');
  // Strip // comments first: the fix documents the old condition in prose, and prose is not a gate.
  const code = block.replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/canonical\.class *=== *row\.kind/.test(code), false,
    'ownedAssets must not require canonical.class === row.kind');
  // the genuine bars stay
  for (const guard of ['row.owner === wallet', 'row.state === "active"', 'ORIGIN_CLEAN.has(row.origin)',
                       'listedOffchain', 'pendingHandover', 'mintPending', '_nftBoardListed']) {
    assert.ok(block.includes(guard), `ownership/escrow guard removed: ${guard}`);
  }
});
