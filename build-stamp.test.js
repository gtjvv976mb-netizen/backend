// The build stamp exists so a deploy can be VERIFIED rather than inferred. That only holds if a
// stamp it reports is right and a stamp it cannot determine reads as null — a confidently wrong
// commit is worse than no commit, because it gets believed. These tests pin both halves.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveBuild, buildHealth, BUILD } from "./build-stamp.js";

const SHA = "1eb49808160f1a2b3c4d5e6f708192a3b4c5d6e7";
const OTHER = "abcdef0123456789abcdef0123456789abcdef01";
const noGit = () => { throw new Error("no .git here"); };

test("Render's injected commit is used verbatim, and marked as coming from the host", () => {
  const b = resolveBuild({ RENDER_GIT_COMMIT: SHA, RENDER_GIT_BRANCH: "main" }, noGit);
  assert.equal(b.commit, SHA);
  assert.equal(b.short, SHA.slice(0, 10));
  assert.equal(b.branch, "main");
  assert.equal(b.source, "env");
});

test("the env stamp wins over .git — the host knows what it deployed", () => {
  const b = resolveBuild({ GIT_COMMIT: SHA }, () => OTHER);
  assert.equal(b.commit, SHA);
  assert.equal(b.source, "env");
});

test("a loose ref is followed from HEAD", () => {
  const files = { HEAD: "ref: refs/heads/main\n", "refs/heads/main": SHA + "\n" };
  const b = resolveBuild({}, (p) => {
    if (!(p in files)) throw new Error("ENOENT " + p);
    return files[p];
  });
  assert.equal(b.commit, SHA);
  assert.equal(b.source, "git");
});

test("a fresh clone's packed-refs is read when the loose ref is absent", () => {
  const files = {
    HEAD: "ref: refs/heads/main\n",
    "packed-refs": `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/other\n${SHA} refs/heads/main\n`,
  };
  const b = resolveBuild({}, (p) => {
    if (!(p in files)) throw new Error("ENOENT " + p);
    return files[p];
  });
  assert.equal(b.commit, SHA, "must pick the line for refs/heads/main, not the first line");
  assert.equal(b.source, "git");
});

test("a packed-refs comment line is never mistaken for a ref", () => {
  const files = {
    HEAD: "ref: refs/heads/main\n",
    "packed-refs": "# pack-refs with: peeled refs/heads/main\n",   // ends with the ref name, but is a comment
  };
  const b = resolveBuild({}, (p) => {
    if (!(p in files)) throw new Error("ENOENT " + p);
    return files[p];
  });
  assert.equal(b.commit, null);
  assert.equal(b.source, "unknown");
});

test("a detached HEAD holds the sha directly", () => {
  const b = resolveBuild({}, (p) => (p === "HEAD" ? SHA + "\n" : (() => { throw new Error("ENOENT"); })()));
  assert.equal(b.commit, SHA);
  assert.equal(b.source, "git");
});

test("no env and no .git reports null, not a guess", () => {
  const b = resolveBuild({}, noGit);
  assert.equal(b.commit, null);
  assert.equal(b.short, null);
  assert.equal(b.source, "unknown");
});

test("a value that is not a full sha is refused rather than echoed", () => {
  for (const junk of ["main", "1eb49808", "", "   ", "not-a-sha-at-all", SHA + "extra", "zzz" + SHA.slice(3)]) {
    const b = resolveBuild({ RENDER_GIT_COMMIT: junk }, noGit);
    assert.equal(b.commit, null, `refused: ${JSON.stringify(junk)}`);
    assert.equal(b.source, "unknown", `refused: ${JSON.stringify(junk)}`);
  }
});

test("shas are normalised to lower case so string comparison against git output works", () => {
  const b = resolveBuild({ RENDER_GIT_COMMIT: SHA.toUpperCase() }, noGit);
  assert.equal(b.commit, SHA);
  assert.equal(b.short, SHA.slice(0, 10));
});

test("the stamp is frozen — nothing downstream can rewrite what the service reports", () => {
  const b = resolveBuild({ RENDER_GIT_COMMIT: SHA }, noGit);
  assert.ok(Object.isFrozen(b));
  try { b.commit = OTHER; } catch {}
  assert.equal(b.commit, SHA);
});

test("buildHealth carries the stamp plus a boot time and a non-negative uptime", () => {
  const h = buildHealth();
  for (const k of ["commit", "short", "branch", "source"]) {
    assert.deepEqual(h[k], BUILD[k], `carries ${k}`);
  }
  assert.equal(typeof h.bootedAt, "number");
  assert.ok(h.uptimeSeconds >= 0);
  assert.equal(buildHealth(h.bootedAt + 90_000).uptimeSeconds, 90);
});

test("resolving the real repo yields either a real sha or an honest null", () => {
  // Whichever branch runs here, the contract is the same: a full 40-hex sha, or null. Never junk.
  assert.ok(BUILD.commit === null || /^[0-9a-f]{40}$/.test(BUILD.commit));
  assert.ok(["env", "git", "unknown"].includes(BUILD.source));
  assert.equal(BUILD.commit === null, BUILD.source === "unknown");
});
