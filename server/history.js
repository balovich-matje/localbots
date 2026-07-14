// Saved sim results for the History page: one JSON file per finished job
// in data/history/ (gitignored — results are personal to this machine).

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HISTORY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'history');

const MODE_LABELS = { quick: 'Quick Sim', topgear: 'Top Gear', droptimizer: 'Droptimizer' };

export function saveHistoryEntry(job, mode, options) {
  if (!job.result) return;
  const entry = {
    id: job.id,
    savedAt: new Date(job.finishedAt ?? Date.now()).toISOString(),
    mode,
    modeLabel: MODE_LABELS[mode] ?? mode,
    options: {
      fightStyle: options?.fightStyle ?? null,
      numEnemies: options?.numEnemies ?? null,
      fightLength: options?.fightLength ?? null,
      targetError: options?.targetError ?? null,
      iterations: options?.iterations ?? null,
    },
    result: job.result,
  };
  mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(join(HISTORY_DIR, `${safeId(job.id)}.json`), JSON.stringify(entry));
}

// Lightweight summaries for the list view, newest first.
export function listHistory() {
  if (!existsSync(HISTORY_DIR)) return [];
  const out = [];
  for (const f of readdirSync(HISTORY_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const e = JSON.parse(readFileSync(join(HISTORY_DIR, f), 'utf8'));
      const r = e.result ?? {};
      const best = r.topgear?.[0] ?? null; // topgear rows are sorted by delta desc
      out.push({
        id: e.id,
        savedAt: e.savedAt,
        mode: e.mode,
        modeLabel: e.modeLabel,
        player: r.player ?? null,
        dps: r.dps ?? null,
        targets: r.targets ?? null,
        fightLength: r.fightLength ?? null,
        fightStyle: e.options?.fightStyle ?? null,
        compared: r.topgear?.length ?? 0,
        best: best ? { name: best.itemName, delta: best.delta } : null,
      });
    } catch { /* skip unreadable entries */ }
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

export function getHistoryEntry(id) {
  const file = join(HISTORY_DIR, `${safeId(id)}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function deleteHistoryEntry(id) {
  const file = join(HISTORY_DIR, `${safeId(id)}.json`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

// Entry ids become filenames — strip anything that isn't a job-id character.
function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}
