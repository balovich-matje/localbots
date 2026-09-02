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

export function simcVersion(simcPath, ptr = false) {
  const args = ptr ? ['ptr=1', 'display_build=1'] : ['display_build=1'];
  try {
    const out = execFileSync(simcPath, args, { encoding: 'utf8', timeout: 15000 });
    const m = out.match(/SimulationCraft \S+ for World of Warcraft [^\n]+/);
    return m ? m[0] : out.split('\n')[0];
  } catch (e) {
    // simc exits non-zero with "Nothing to sim!" but still prints the banner
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const m = out.match(/SimulationCraft \S+ for World of Warcraft [^\n]+/);
    return m ? m[0] : null;
  }
}

// Progress lines come in two shapes:
//   "Generating Baseline: 1/1 [====>....] 1502/50000 307.147 1min 18sec\r"
//   "Generating Profileset: Item Name @finger1 3/5 [====>] 221/221 449.5 Mean=95526 Error=0.42% 61msec\r"
const PROFILESET_RE = /Generating\s+Profileset:\s+(.+?)\s+(\d+)\/(\d+)\s+\[[^\]]*\]\s+(\d+)\/(\d+)\s*(.*)$/;
const BASELINE_RE = /Generating\s+([^:]+):\s+(\d+)\/(\d+)\s+\[[^\]]*\]\s+(\d+)\/(\d+)\s*(.*)$/;

function parseProgressLine(line) {
  let m = line.match(PROFILESET_RE);
  if (m) {
    const [, item, phaseNum, phaseTotal, iterDone, iterTotal, tail] = m;
    return { phase: 'Profileset', item, phaseNum: +phaseNum, phaseTotal: +phaseTotal,
             iterDone: +iterDone, iterTotal: +iterTotal, tail };
  }
  m = line.match(BASELINE_RE);
  if (m) {
    const [, phase, phaseNum, phaseTotal, iterDone, iterTotal, tail] = m;
    return { phase: phase.trim(), item: null, phaseNum: +phaseNum, phaseTotal: +phaseTotal,
             iterDone: +iterDone, iterTotal: +iterTotal, tail };
  }
  return null;
}

// "Skibidk's Droptimizer" — enough for someone waiting to know what is ahead
// of them on a shared server.
function describe(job) {
  const name = job.meta?.spec?.name ?? null;
  const mode = { quick: 'Quick Sim', topgear: 'Top Gear', droptimizer: 'Droptimizer' }[job.meta?.mode]
    ?? 'sim';
  return name ? `${name}'s ${mode}` : mode;
}

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
      this.#finish(job, 'cancelled'); // #finish pumps, which re-broadcasts
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

  // What a waiting job needs to show someone: where they are in the line, and
  // what is actually happening in front of them.
  queueInfo(id) {
    const index = this.queue.findIndex((j) => j.id === id);
    const running = this.running;
    return {
      position: index < 0 ? 0 : index + 1,
      // the running sim counts as one ahead of you; a queued job is only
      // waiting because something is running
      ahead: index < 0 ? 0 : index + (running ? 1 : 0),
      waiting: this.queue.length,
      running: running ? {
        label: describe(running),
        percent: running.progress?.percent ?? null,
        eta: running.progress?.eta ?? null,
        mine: running.id === id,
      } : null,
    };
  }

  // The line moved, so everyone still in it needs to hear about it. Without
  // this a waiting job gets no events until it starts, and its position sits
  // frozen at whatever it was when it was submitted.
  #broadcastQueue() {
    for (const job of this.queue) this.emit(`update:${job.id}`, job);
  }

  #pump() {
    if (this.running || this.queue.length === 0) {
      this.#broadcastQueue();
      return;
    }
    const job = this.queue.shift();
    this.running = job;
    this.#run(job);
    this.#broadcastQueue();
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
        const p = parseProgressLine(line);
        if (p) {
          // Overall percent spans all phases (baseline + one per profileset).
          const iterFrac = p.iterDone / Math.max(1, p.iterTotal);
          const percent = Math.round(((p.phaseNum - 1 + iterFrac) / Math.max(1, p.phaseTotal)) * 100);
          const meanMatch = p.tail?.match(/Mean=([\d.]+)/) ?? p.tail?.match(/^([\d.]+)/);
          const etaMatch = p.phase === 'Profileset' ? null : p.tail?.match(/([\d]+(?:\.\d+)?\s*(?:min|sec|hr)[\w\s]*)$/);
          job.progress = {
            phase: p.phase,
            item: p.item,
            phaseNum: p.phaseNum,
            phaseTotal: p.phaseTotal,
            iterDone: p.iterDone,
            iterTotal: p.iterTotal,
            percent,
            meanDps: meanMatch ? +meanMatch[1] : null,
            eta: etaMatch ? etaMatch[1].trim() : null,
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
          const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
          job.result = extractResult(json);
          if (job.meta?.sets) {
            job.result.topgear = extractTopGear(json, job.meta.sets, job.result.dps);
            // what each slot currently wears — the results view shows
            // "equipped ilvl -> suggested ilvl" and the replaced item's name
            job.result.equipped = job.meta.gearBySlot ?? null;
          }
          if (job.meta?.mode === 'statweights') {
            job.result.statWeights = extractScaleFactors(json);
          }
          this.#finish(job, 'done');
        } catch (e) {
          job.error = `Could not parse simc JSON output: ${e.message}`;
          this.#finish(job, 'failed');
        }
      } else {
        job.error = pickErrorFromLog(job.logTail) ?? `simc exited with code ${code}`;
        // Self-heal: if one profileset failed to initialize (e.g. an item simc
        // rejects), drop it from the input and rerun instead of losing the run.
        // Match the failing profileset by looking the full known names up in
        // the error text (longest first) — a regex capture would truncate at
        // the first quote for names that themselves contain one.
        const bad = job.meta?.sets && Object.keys(job.meta.sets)
          .sort((a, b) => b.length - a.length)
          .find((n) => job.error.includes(`Profileset '${n}'`));
        // A baseline (equipped-gear) item simc can't load can't be dropped like a
        // profileset — turn the cryptic message into something actionable.
        if (!bad) job.error = humanizeInitError(job.error, job.meta?.gearBySlot);
        if (bad && (job.retries = (job.retries ?? 0) + 1) <= 5) {
          const inputPath = join(job.dir, 'input.simc');
          const kept = readFileSync(inputPath, 'utf8')
            .split('\n')
            .filter((l) => !l.startsWith(`profileset."${bad}"`))
            .join('\n');
          writeFileSync(inputPath, kept);
          delete job.meta.sets[bad];
          job.error = null;
          job.logTail.push(`--- dropped incompatible profileset "${bad}", retrying (${job.retries}/5) ---`);
          this.#run(job);
          return;
        }
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

// Turns raw profileset results into one ranked row per bag item,
// keeping only the best placement for rings/trinkets.
export function extractTopGear(json, sets, baselineDps) {
  const results = json.sim.profilesets?.results ?? [];
  const rawByName = new Map(results.map((r) => [r.name, r]));
  const byGroup = new Map();
  for (const r of results) {
    const info = sets[r.name];
    if (!info) continue;
    const row = {
      ...info, // itemName, ilvl, slot, placement, section, plus droptimizer labels (boss, sourceKind)
      origIlvl: info.origIlvl ?? info.ilvl,
      dps: r.mean,
      error: r.mean_stddev ?? 0,
      iterations: r.iterations ?? null,
    };
    delete row.group;
    const existing = byGroup.get(info.group);
    if (!existing || row.dps > existing.dps) byGroup.set(info.group, row);
  }
  return [...byGroup.values()]
    // reference rows (hidden) exist only as comparison points
    .filter((row) => !row.hidden)
    .map((row) => {
      // rebased rows rank against a named reference profileset (e.g. an
      // embellished item vs its plain twin) instead of the equipped baseline
      const base = (row.rebaseTo && rawByName.get(row.rebaseTo)?.mean) || baselineDps;
      const out = {
        ...row,
        delta: row.dps - base,
        deltaPct: base > 0 ? ((row.dps - base) / base) * 100 : 0,
      };
      delete out.rebaseTo;
      return out;
    })
    .sort((a, b) => b.delta - a.delta);
}

// simc reports an item it can't load as "Item 'inactive' Slot 'finger1':
// Cannot initialize data." — cryptic, and fatal for the baseline character.
// This almost always means the item is newer than the local simc build.
// Rewrite it to name the actual item and point at the fix.
function humanizeInitError(error, gearBySlot) {
  // A talent string that doesn't decode usually means a live export simmed
  // on the PTR patch (or vice versa) — talent trees changed between patches.
  if (/Hash '[^']*':.*(choice node|talent)/i.test(error ?? '') || /Invalid talent/i.test(error ?? '')) {
    return 'This character\'s talent build could not be read. Talent trees change with every ' +
      'game patch, so an export copied before the patch stops working: open the game, type ' +
      '/simc again, and paste the fresh export. (If you are simming a test-realm patch, the ' +
      'export has to come from that client.)';
  }
  const m = error?.match(/Slot '([^']+)':\s*Cannot initialize data/i);
  if (!m) return error;
  const slot = m[1];
  const info = gearBySlot?.[slot];
  const pretty = slot.replace(/(finger|trinket)(\d)/, '$1 $2').replace(/_/g, ' ');
  const which = info?.name
    ? `your equipped "${info.name}"${info.id ? ` (item ${info.id})` : ''} in the ${pretty} slot`
    : `your equipped ${pretty} item${info?.id ? ` (item ${info.id})` : ''}`;
  return `SimulationCraft couldn't load ${which}. This almost always means the item ` +
    `is from a game patch newer than your simc build. Check the "Simc" light in the ` +
    `header — if it's orange, update simc (git pull + rebuild, see the README) and try ` +
    `again. Until simc catches up with the patch, this item can't be simmed.`;
}

function pickErrorFromLog(logTail) {
  const lines = [...logTail].reverse();
  // real simc errors start with "Error:" — prefer those ("target_error=" in
  // the sim banner would otherwise match a generic /error/ search)
  const hard = lines.find((l) => /^\s*Error[: ]/i.test(l));
  if (hard) return hard.trim();
  const soft = lines.find((l) => !/^Simulating/i.test(l) && /invalid|unable to|could not/i.test(l));
  return soft?.trim() ?? null;
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

// simc's raw scale-factor keys, expanded to the labels the UI shows.
const STAT_LABELS = {
  Int: 'Intellect', Str: 'Strength', Agi: 'Agility', Stam: 'Stamina',
  SP: 'Spell Power', AP: 'Attack Power', Crit: 'Critical Strike',
  Haste: 'Haste', Mastery: 'Mastery', Vers: 'Versatility',
  Weapon_dps: 'Weapon DPS', Weapon_offhand_dps: 'Off-hand Weapon DPS',
  Armor: 'Armor', Bonus_armor: 'Bonus Armor', Dodge: 'Dodge', Parry: 'Parry',
  Expertise: 'Expertise', Hit: 'Hit',
};

// Reduce simc's scale_factors block (per-point DPS gain per stat, from a
// calculate_scale_factors=1 run) to a sorted, normalized table for the UI.
export function extractScaleFactors(json) {
  const player = json.sim?.players?.[0];
  const sf = player?.scale_factors;
  if (!sf) return null;
  const rows = Object.entries(sf).map(([stat, value]) => ({
    stat,
    label: STAT_LABELS[stat] ?? stat,
    value,
  }));
  rows.sort((a, b) => b.value - a.value);
  const max = rows[0]?.value || 0;
  for (const r of rows) r.normalized = max > 0 ? r.value / max : 0;
  return rows;
}
