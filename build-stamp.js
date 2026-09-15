// Which commit is actually answering.
//
// Without this, a deploy can only be inferred from a restart blip — the service goes unavailable for
// a moment and comes back — which tells you SOMETHING restarted, not that it restarted onto your
// code. "Did my push go live?" then gets guessed at instead of checked. /health carries this so the
// answer is one curl.
//
// Resolved ONCE at boot and frozen. Never read on a request path.

import fs from "node:fs";

const SHA40 = /^[0-9a-f]{40}$/i;

/**
 * @param env  process.env, or a stub in tests.
 * @param readGitFile  (path) => string, reads `<repo>/.git/<path>`. Throws if absent.
 */
export function resolveBuild(env = process.env, readGitFile = defaultGitReader) {
  // Render injects RENDER_GIT_COMMIT on every deploy; the others cover other hosts.
  const fromEnv = String(env.RENDER_GIT_COMMIT || env.GIT_COMMIT || env.SOURCE_VERSION || "").trim();

  let commit = fromEnv;
  let source = fromEnv ? "env" : "unknown";

  if (!commit) {
    // Local or bare-metal run: read .git directly rather than shelling out to git, so this cannot
    // hang, cannot inherit a shell, and cannot fail because git is not installed.
    try {
      const head = readGitFile("HEAD").trim();
      if (!head.startsWith("ref:")) {
        commit = head;                                     // detached HEAD
      } else {
        const ref = head.slice(4).trim();
        try {
          commit = readGitFile(ref).trim();                // loose ref
        } catch {
          // Fresh clone: refs are packed into one file, "<sha> refs/heads/main" per line.
          const line = readGitFile("packed-refs")
            .split("\n")
            .find((l) => !l.startsWith("#") && l.endsWith(" " + ref));
          commit = line ? line.split(" ")[0] : "";
        }
      }
      if (commit) source = "git";
    } catch {
      commit = "";
    }
  }

  // Anything that is not a full sha is not a build id. Report null rather than echo a stray value —
  // a wrong stamp is worse than no stamp, because it is believed.
  const valid = SHA40.test(commit);
  if (!valid) source = "unknown";

  return Object.freeze({
    commit: valid ? commit.toLowerCase() : null,
    short: valid ? commit.toLowerCase().slice(0, 10) : null,
    branch: env.RENDER_GIT_BRANCH || env.GIT_BRANCH || null,
    // "env"  — the host told us, trust it
    // "git"  — read from a .git directory beside the code
    // "unknown" — neither worked; commit is null and nothing here should be trusted as a build id
    source,
  });
}

function defaultGitReader(p) {
  return fs.readFileSync(new URL(".git/" + p, import.meta.url), "utf8");
}

export const BUILD = resolveBuild();
export const BOOTED_AT = Date.now();

/** The `build` block as /health reports it, including live uptime. */
export function buildHealth(now = Date.now()) {
  return { ...BUILD, bootedAt: BOOTED_AT, uptimeSeconds: Math.round((now - BOOTED_AT) / 1000) };
}
