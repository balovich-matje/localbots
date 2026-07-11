// Runs simc as a subprocess: one job at a time, with a FIFO queue,
// live progress parsing, cancellation, and json2 result extraction.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import os from 'node:os';

const JOBS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'jobs');

export function findSimc() {
  if (process.env.SIMC_PATH && existsSync(process.env.SIMC_PATH)) return process.env.SIMC_PATH;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(probe, ['simc'], { encoding: 'utf8' }).split('\n')[0].trim();
    if (out) return out;
  } catch { /* not on PATH */ }
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\SimulationCraft\\simc.exe']
    : ['/opt/homebrew/bin/simc', '/usr/local/bin/simc', '/usr/bin/simc',
       '/Applications/SimulationCraft.app/Contents/MacOS/simc'];
  return candidates.find(existsSync) ?? null;
}

export function simcVersion(simcPath) {
  try {
    const out = execFileSync(simcPath, ['display_build=1'], { encoding: 'utf8', timeout: 15000 });
    const m = out.match(/SimulationCraft \S+ for World of Warcraft [^\n]+/);
    return m ? m[0] : out.split('\n')[0];
  } catch (e) {
    // simc exits non-zero with "Nothing to sim!" but still prints the banner
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const m = out.match(/SimulationCraft \S+ for World of Warcraft [^\n]+/);
    return m ? m[0] : null;
  }
}

// Progress lines look like:
// "Generating Baseline: 1/1 [====>....] 1502/50000 307.147 1min 18sec\r"
const PROGRESS_RE = /Generating\s+([^:]+):\s+(\d+)\/(\d+)\s+\[[^\]]*\]\s+(\d+)\/(\d+)(?:\s+([\d.]+))?(?:\s+(.*))?$/;

export class SimQueue extends EventEmitter {
  constructor(simcPath) {
    super();
    this.simcPath = simcPath;
    this.jobs = new Map();
    this.queue = [];
    this.running = null;
    this.counter = 0;
    mkdirSync(JOBS_DIR, { recursive: true });
  }

  submit(inputText, meta = {}) {
    const id = `job-${Date.now()}-${++this.counter}`;
    const job = {
      id,
      meta,
      status: 'queued',
      progress: null,
      result: null,
      error: null,
      logTail: [],
      proc: null,
      createdAt: Date.now(),
    };
    const dir = join(JOBS_DIR, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'input.simc'), inputText);
    job.dir = dir;
    this.jobs.set(id, job);
    this.queue.push(job);
    this.#pump();
    return job;
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      this.queue = this.queue.filter((j) => j.id !== id);
      this.#finish(job, 'cancelled');
      return true;
    }
    if (job.status === 'running' && job.proc) {
      job.cancelRequested = true;
      job.proc.kill('SIGKILL'); // simc has no graceful-stop signal handling
      return true;
    }
    return false;
  }

  queuePosition(id) {
    return this.queue.findIndex((j) => j.id === id);
  }

  #pump() {
    if (this.running || this.queue.length === 0) return;
    const job = this.queue.shift();
    this.running = job;
    this.#run(job);
  }

  #run(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    this.emit(`update:${job.id}`, job);

    const jsonPath = join(job.dir, 'result.json');
    const threads = Math.max(1, os.cpus().length - 1);
    const args = [
      join(job.dir, 'input.simc'),
      `json2=${jsonPath}`,
      `threads=${threads}`,
      'report_details=1',
    ];

    const proc = spawn(this.simcPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.proc = proc;

    let buffer = '';
    const onChunk = (chunk) => {
      buffer += chunk.toString();
      // simc updates progress with \r; treat \r and \n both as line breaks
      const parts = buffer.split(/[\r\n]/);
      buffer = parts.pop();
      for (const line of parts) {
        if (!line.trim()) continue;
        job.logTail.push(line);
        if (job.logTail.length > 40) job.logTail.shift();
        const m = line.match(PROGRESS_RE);
        if (m) {
          const [, phase, phaseNum, phaseTotal, iterDone, iterTotal, meanDps, eta] = m;
          job.progress = {
            phase: phase.trim(),
            phaseNum: +phaseNum,
            phaseTotal: +phaseTotal,
            iterDone: +iterDone,
            iterTotal: +iterTotal,
            percent: Math.round((+iterDone / Math.max(1, +iterTotal)) * 100),
            meanDps: meanDps ? +meanDps : null,
            eta: eta?.trim() || null,
          };
          this.emit(`update:${job.id}`, job);
        }
      }
    };
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);

    proc.on('error', (err) => {
      job.error = `Failed to start simc: ${err.message}`;
      this.#finish(job, 'failed');
    });

    proc.on('close', (code) => {
      if (job.status !== 'running') return; // already finished via error handler
      if (job.cancelRequested) {
        this.#finish(job, 'cancelled');
      } else if (code === 0 && existsSync(jsonPath)) {
        try {
          job.result = extractResult(JSON.parse(readFileSync(jsonPath, 'utf8')));
          this.#finish(job, 'done');
        } catch (e) {
          job.error = `Could not parse simc JSON output: ${e.message}`;
          this.#finish(job, 'failed');
        }
      } else {
        job.error = pickErrorFromLog(job.logTail) ?? `simc exited with code ${code}`;
        this.#finish(job, 'failed');
      }
    });
  }

  #finish(job, status) {
    job.status = status;
    job.finishedAt = Date.now();
    job.proc = null;
    if (this.running?.id === job.id) this.running = null;
    this.emit(`update:${job.id}`, job);
    // Clean up job dir on success; keep failures around for debugging.
    if (status === 'done' || status === 'cancelled') {
      setTimeout(() => rmSync(job.dir, { recursive: true, force: true }), 5000);
    }
    this.#pump();
  }
}

function pickErrorFromLog(logTail) {
  const errLine = [...logTail].reverse().find((l) => /error|invalid|unable to|could not/i.test(l));
  return errLine ?? null;
}

// Reduce simc's giant json2 report to what the UI needs.
export function extractResult(json) {
  const sim = json.sim;
  const player = sim.players?.[0];
  if (!player) throw new Error('no player in report');

  const cd = player.collected_data;
  const totalDamage = cd.dmg?.mean ?? 0;
  const fightLength = cd.fight_length?.mean ?? 0;

  const abilities = (player.stats ?? [])
    .filter((s) => s.type === 'damage' && (s.compound_amount ?? 0) > 0)
    .map((s) => ({
      name: s.spell_name ?? s.name,
      id: s.id ?? null,
      source: player.name,
      damage: s.compound_amount,
      share: totalDamage > 0 ? s.compound_amount / totalDamage : 0,
      dps: fightLength > 0 ? s.compound_amount / fightLength : 0,
      executes: s.num_executes?.mean ?? 0,
    }));

  // Pet damage lives under stats_pets: { petName: [stats...] }
  for (const [petName, statsList] of Object.entries(player.stats_pets ?? {})) {
    for (const s of statsList) {
      if (s.type !== 'damage' || !(s.compound_amount > 0)) continue;
      abilities.push({
        name: s.spell_name ?? s.name,
        id: s.id ?? null,
        source: petName,
        damage: s.compound_amount,
        share: totalDamage > 0 ? s.compound_amount / totalDamage : 0,
        dps: fightLength > 0 ? s.compound_amount / fightLength : 0,
        executes: s.num_executes?.mean ?? 0,
      });
    }
  }
  abilities.sort((a, b) => b.damage - a.damage);

  const buffs = (player.buffs ?? [])
    .filter((b) => (b.uptime ?? 0) >= 1)
    .map((b) => ({
      name: b.spell_name ?? b.name,
      id: b.spell ?? null,
      uptime: b.uptime, // already in percent
    }))
    .sort((a, b) => b.uptime - a.uptime);

  return {
    player: {
      name: player.name,
      spec: player.specialization,
      race: player.race,
      level: player.level,
    },
    dps: cd.dps?.mean ?? 0,
    dpsError: cd.dps?.mean_std_dev ?? 0,
    dpsStdDev: cd.dps?.std_dev ?? 0,
    priorityDps: cd.prioritydps?.mean || null,
    fightLength,
    targets: (sim.targets ?? []).length || 1,
    iterations: cd.dps?.count ?? null,
    elapsedSeconds: sim.statistics?.elapsed_time_seconds ?? null,
    simcVersion: json.version ?? null,
    buildInfo: sim.options?.dbc?.Live?.wow_version ?? null,
    consumables: {
      flask: player.flask || null,
      food: player.food || null,
      potion: player.potion || null,
      augmentation: player.augmentation || null,
      temporary_enchant: player.temporary_enchant || null,
    },
    abilities,
    buffs,
  };
}
