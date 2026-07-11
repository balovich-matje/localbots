import express from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInput, buildTopGearInput, detectSpec } from './profileBuilder.js';
import { SimQueue, findSimc, simcVersion } from './simRunner.js';
import { parseGear, GEAR_SLOTS } from './gearParser.js';
import { loadLootDb, buildLootDb, downloadTables, cacheStatus } from './wagoData.js';
import { buildSourceTree, buildDroptimizerInput, seasonConfig as fullSeasonConfig } from './droptimizer.js';
import { probeKnownItems, loadProbeCache } from './simcProbe.js';
import { CLASS_IDS } from './lootFilter.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4747;

const simcPath = findSimc();
if (!simcPath) {
  console.error(
    '\n  Could not find the simc executable.\n' +
    '  Install SimulationCraft (see README) and either put simc on your PATH\n' +
    '  or set the SIMC_PATH environment variable to the full path of the binary.\n'
  );
  process.exit(1);
}
const version = simcVersion(simcPath);
const queue = new SimQueue(simcPath);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(ROOT, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, simcPath, simcVersion: version });
});

const seasonConfig = JSON.parse(readFileSync(join(ROOT, 'data', 'season.json'), 'utf8'));
app.get('/api/season', (req, res) => res.json(seasonConfig));

// ---------- droptimizer data state ----------
let lootDb = loadLootDb();
if (!lootDb && cacheStatus().present) {
  try { lootDb = buildLootDb(seasonConfig.droptimizer.mythicPlusDungeons); } catch { /* refresh will rebuild */ }
}
let knownItems = lootDb ? loadProbeCache(version, lootDb.builtAt) : null;
let probeProgress = null;
let probeRunning = false;
let probeError = null;
const refreshState = { running: false, step: null, error: null };

function uniqueLootItems() {
  const uniq = new Map();
  for (const s of lootDb.sources) for (const b of s.bosses) for (const it of b.items) {
    uniq.set(it.id, { id: it.id, invType: it.invType });
  }
  return [...uniq.values()];
}

function ensureProbe(profileText) {
  if (!lootDb || knownItems || probeRunning) return;
  probeRunning = true;
  probeError = null;
  probeKnownItems(simcPath, version, lootDb.builtAt, profileText, uniqueLootItems(),
    (p) => { probeProgress = p; })
    .then((set) => { knownItems = set; })
    .catch((err) => { probeError = err.message; })
    .finally(() => { probeRunning = false; probeProgress = null; });
}

function dataStatus() {
  return {
    cache: cacheStatus(),
    lootDb: lootDb ? { builtAt: lootDb.builtAt, sources: lootDb.sources.length } : null,
    probe: { ready: !!knownItems, running: probeRunning, progress: probeProgress, error: probeError },
    refresh: refreshState,
  };
}

app.get('/api/data/status', (req, res) => res.json(dataStatus()));

app.post('/api/data/refresh', (req, res) => {
  if (refreshState.running) return res.json({ started: false, reason: 'already running' });
  refreshState.running = true;
  refreshState.error = null;
  refreshState.step = 'downloading';
  (async () => {
    await downloadTables((p) => { refreshState.step = `downloading ${p.table} (${p.index}/${p.total})`; });
    refreshState.step = 'building loot database';
    lootDb = buildLootDb(seasonConfig.droptimizer.mythicPlusDungeons);
    knownItems = null; // probe cache is keyed on builtAt; it re-runs on next use
  })()
    .catch((err) => { refreshState.error = err.message; })
    .finally(() => { refreshState.running = false; refreshState.step = null; });
  res.json({ started: true });
});

// Source tree for the droptimizer tab. Kicks off the one-time simc item
// probe in the background on first call (needs a valid character profile).
app.post('/api/droptimizer/sources', (req, res) => {
  const { profile } = req.body ?? {};
  if (!lootDb) {
    return res.json({ needsData: true, status: dataStatus() });
  }
  const spec = detectSpec(profile ?? '');
  if (!spec.class || !spec.key) {
    return res.status(400).json({ error: 'Paste your /simc export first — the droptimizer filters loot for your class and spec.' });
  }
  ensureProbe(profile);
  const tree = buildSourceTree(lootDb, CLASS_IDS[spec.class], spec.key, knownItems);
  res.json({
    spec,
    tree,
    season: seasonConfig.droptimizer,
    status: dataStatus(),
  });
});

// Parse bagged/vault gear out of an export so the UI can offer checkboxes.
app.post('/api/gear', (req, res) => {
  const { profile } = req.body ?? {};
  if (!profile || typeof profile !== 'string') {
    return res.status(400).json({ error: 'No profile text supplied.' });
  }
  const { equipped, items } = parseGear(profile);
  res.json({ equippedSlots: Object.keys(equipped), items });
});

app.post('/api/sim', (req, res) => {
  const { profile, options, mode, items } = req.body ?? {};
  if (!profile || typeof profile !== 'string' || !profile.trim()) {
    return res.status(400).json({ error: 'No profile text supplied. Paste your /simc addon export.' });
  }
  const spec = detectSpec(profile);
  if (!spec.class) {
    return res.status(400).json({
      error: 'That does not look like a /simc export (no class line found). ' +
             'In game, type /simc, press Ctrl+C (Cmd+C on Mac) to copy, and paste the whole thing here.',
    });
  }

  if (mode === 'topgear') {
    const clean = validateItems(items);
    if (!clean.length) {
      return res.status(400).json({ error: 'No items selected to compare.' });
    }
    const { input, sets } = buildTopGearInput(profile, options ?? {}, clean);
    const job = queue.submit(input, { spec, sets });
    return res.json({ jobId: job.id });
  }

  if (mode === 'droptimizer') {
    if (!lootDb) return res.status(409).json({ error: 'Game data not downloaded yet — use "Refresh data" first.' });
    if (!knownItems) {
      ensureProbe(profile);
      return res.status(409).json({ error: 'Still checking which items your simc build supports — try again in a moment.' });
    }
    const { input, sets, profilesetCount, skippedUnknown } =
      buildDroptimizerInput(profile, options ?? {}, req.body.selection ?? {}, lootDb, spec, knownItems);
    if (!profilesetCount) {
      return res.status(400).json({ error: 'Nothing to sim — enable at least one source with usable items.' });
    }
    const job = queue.submit(input, { spec, sets });
    return res.json({ jobId: job.id, profilesetCount, skippedUnknown });
  }

  const input = buildInput(profile, options ?? {});
  const job = queue.submit(input, { spec });
  res.json({ jobId: job.id });
});

// Item lines get written into the simc input file — accept only clean
// single-line "slot=,id=..." strings for known slots.
function validateItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items.slice(0, 300)) {
    const line = String(it?.line ?? '').trim();
    const m = line.match(/^([a-z_0-9]+)=(\S*)$/);
    if (!m || !GEAR_SLOTS.includes(m[1]) || !m[2].includes('id=')) continue;
    const targetIlvl = Number(it?.targetIlvl);
    out.push({
      name: String(it?.name ?? '').slice(0, 120) || null,
      ilvl: Number.isFinite(Number(it?.ilvl)) ? Number(it.ilvl) : null,
      targetIlvl: Number.isInteger(targetIlvl) && targetIlvl >= 100 && targetIlvl <= 500 ? targetIlvl : null,
      section: String(it?.section ?? 'Bags').slice(0, 60),
      slot: m[1],
      line,
    });
  }
  return out;
}

// Server-Sent Events: progress stream for one job.
app.get('/api/sim/:id/events', (req, res) => {
  const job = queue.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job id' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const send = (j) => {
    const payload = {
      status: j.status,
      progress: j.progress,
      queuePosition: j.status === 'queued' ? queue.queuePosition(j.id) + 1 : 0,
      error: j.error,
      result: j.status === 'done' ? j.result : null,
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') {
      queue.off(`update:${j.id}`, send);
      res.end();
    }
  };

  queue.on(`update:${job.id}`, send);
  req.on('close', () => queue.off(`update:${job.id}`, send));
  send(job); // initial state right away
});

app.post('/api/sim/:id/cancel', (req, res) => {
  const ok = queue.cancel(req.params.id);
  res.json({ cancelled: ok });
});

app.listen(PORT, () => {
  console.log(`\n  Localbots running:  http://localhost:${PORT}\n`);
  console.log(`  simc: ${simcPath}`);
  console.log(`  ${version ?? 'version unknown'}\n`);
});
