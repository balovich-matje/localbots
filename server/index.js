import express from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInput, buildTopGearInput, detectSpec } from './profileBuilder.js';
import { SimQueue, findSimc, simcVersion } from './simRunner.js';
import { parseGear, GEAR_SLOTS } from './gearParser.js';

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
