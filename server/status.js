// Update checks for the header status bar:
//  - app:  is the local git checkout behind origin/main on GitHub?
//  - simc: does the local simc build match the live game version?
//    (latest live build comes from wago.tools — same source as the loot data)
// Both checks need the network, so results are cached for 30 minutes.

import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TTL_MS = 30 * 60 * 1000;

let cached = null;
let cachedAt = 0;
let pending = null;

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: ROOT, timeout: 10000, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

async function checkApp() {
  try {
    const local = await git(['rev-parse', 'HEAD']);
    const remote = (await git(['ls-remote', 'origin', '-h', 'refs/heads/main'])).split(/\s/)[0];
    if (!remote) throw new Error('no main branch on the remote');
    return {
      state: local === remote ? 'ok' : 'outdated',
      local: local.slice(0, 7),
      remote: remote.slice(0, 7),
    };
  } catch (e) {
    return { state: 'unknown', reason: e.message?.split('\n')[0] ?? 'git check failed' };
  }
}

async function checkSimc(versionString) {
  const m = versionString?.match(/World of Warcraft (\d+\.\d+\.\d+)\.(\d+)/);
  if (!m) return { state: 'unknown', reason: 'could not read the game version from simc' };
  const simcGame = `${m[1]}.${m[2]}`;
  const simcBuild = Number(m[2]);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch('https://wago.tools/api/builds', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`wago.tools answered HTTP ${resp.status}`);
    const builds = await resp.json();
    const live = builds.wow?.[0]?.version; // newest live build first
    if (!live) throw new Error('no live build in the wago.tools response');
    const liveBuild = Number(live.split('.').pop());
    return {
      state: simcBuild >= liveBuild ? 'ok' : 'outdated',
      simcGame,
      liveGame: live,
    };
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'wago.tools timed out'
      : e.message?.split('\n')[0] ?? 'check failed';
    return { state: 'unknown', simcGame, reason };
  }
}

export async function updateStatus(simcVersionString) {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  if (!pending) {
    pending = Promise.all([checkApp(), checkSimc(simcVersionString)])
      .then(([app, simc]) => {
        cached = {
          app,
          simc,
          simcVersion: simcVersionString ?? null,
          checkedAt: new Date().toISOString(),
        };
        cachedAt = Date.now();
        return cached;
      })
      .finally(() => { pending = null; });
  }
  return pending;
}
