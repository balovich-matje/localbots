const $ = (id) => document.getElementById(id);

let currentJobId = null;
let eventSource = null;

// ---------- boot ----------
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => { $('simc-version').textContent = h.simcVersion ?? 'simc found'; })
  .catch(() => { $('simc-version').textContent = 'server unreachable'; });

// restore last session
const saved = JSON.parse(localStorage.getItem('localbots') ?? '{}');
if (saved.profile) $('profile').value = saved.profile;
if (saved.options) restoreOptions(saved.options);

$('precision').addEventListener('change', () => {
  $('iterations-label').classList.toggle('hidden', $('precision').value !== 'iterations');
});
$('fight-style').addEventListener('change', () => {
  const style = $('fight-style').value;
  const fixedTargets = style === 'Patchwerk' || style === 'Dummy';
  $('num-enemies').disabled = !fixedTargets;
  // Defaults that match Raidbots: 5 min Patchwerk, 6 min DungeonSlice, long dummy parse
  $('fight-length').value = style === 'Dummy' ? 600 : style === 'DungeonSlice' ? 360 : 300;
});

$('sim-button').addEventListener('click', startSim);
$('cancel-button').addEventListener('click', cancelSim);

// ---------- options ----------
function collectOptions() {
  const opts = {
    fightStyle: $('fight-style').value,
    numEnemies: Number($('num-enemies').value),
    fightLength: Number($('fight-length').value),
    buffs: {},
    consumables: {},
  };
  if ($('precision').value === 'iterations') {
    opts.iterations = Number($('iterations').value);
  } else {
    opts.targetError = Number($('precision').value);
  }
  document.querySelectorAll('#buffs input').forEach((cb) => {
    opts.buffs[cb.dataset.buff] = cb.checked;
  });
  document.querySelectorAll('#consumables input').forEach((cb) => {
    opts.consumables[cb.dataset.consumable] = cb.checked;
  });
  return opts;
}

function restoreOptions(opts) {
  if (opts.fightStyle) $('fight-style').value = opts.fightStyle;
  if (opts.numEnemies) $('num-enemies').value = opts.numEnemies;
  if (opts.fightLength) $('fight-length').value = opts.fightLength;
  if (opts.iterations) {
    $('precision').value = 'iterations';
    $('iterations').value = opts.iterations;
    $('iterations-label').classList.remove('hidden');
  } else if (opts.targetError) {
    $('precision').value = String(opts.targetError);
  }
  for (const [k, v] of Object.entries(opts.buffs ?? {})) {
    const cb = document.querySelector(`#buffs input[data-buff="${k}"]`);
    if (cb) cb.checked = v;
  }
  for (const [k, v] of Object.entries(opts.consumables ?? {})) {
    const cb = document.querySelector(`#consumables input[data-consumable="${k}"]`);
    if (cb) cb.checked = v;
  }
}

// ---------- sim lifecycle ----------
async function startSim() {
  const profile = $('profile').value;
  const options = collectOptions();
  localStorage.setItem('localbots', JSON.stringify({ profile, options }));

  hideError();
  $('sim-button').disabled = true;

  let resp;
  try {
    resp = await fetch('/api/sim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, options }),
    });
  } catch {
    showError('Could not reach the Localbots server. Is it still running?');
    $('sim-button').disabled = false;
    return;
  }
  const body = await resp.json();
  if (!resp.ok) {
    showError(body.error ?? 'The server rejected the request.');
    $('sim-button').disabled = false;
    return;
  }

  currentJobId = body.jobId;
  $('cancel-button').classList.remove('hidden');
  $('empty-state').classList.add('hidden');
  $('results-area').classList.add('hidden');
  $('progress-area').classList.remove('hidden');
  setProgress('Starting…', 0, '');

  eventSource = new EventSource(`/api/sim/${currentJobId}/events`);
  eventSource.onmessage = (ev) => handleUpdate(JSON.parse(ev.data));
  eventSource.onerror = () => {
    // stream closes normally at job end; only report if we never finished
    if (currentJobId) {
      showError('Lost connection to the sim progress stream.');
      resetControls();
    }
  };
}

function handleUpdate(u) {
  if (u.status === 'queued') {
    setProgress(`Queued (position ${u.queuePosition})`, 0, 'Another sim is running — yours starts automatically.');
  } else if (u.status === 'running') {
    const p = u.progress;
    if (p) {
      const phase = p.phaseTotal > 1 ? `${p.phase} ${p.phaseNum}/${p.phaseTotal}` : p.phase;
      const detail = [
        `${p.iterDone.toLocaleString()} / ${p.iterTotal.toLocaleString()} iterations`,
        p.meanDps ? `~${Math.round(p.meanDps).toLocaleString()} DPS so far` : null,
        p.eta ? `ETA ${p.eta}` : null,
      ].filter(Boolean).join(' · ');
      setProgress(phase, p.percent, detail);
    } else {
      setProgress('Initializing simc…', 2, '');
    }
  } else if (u.status === 'done') {
    finishStream();
    renderResult(u.result);
  } else if (u.status === 'failed') {
    finishStream();
    showError(`Sim failed:\n${u.error ?? 'unknown error'}`);
    $('progress-area').classList.add('hidden');
    $('empty-state').classList.remove('hidden');
  } else if (u.status === 'cancelled') {
    finishStream();
    $('progress-area').classList.add('hidden');
    $('empty-state').classList.remove('hidden');
  }
}

function finishStream() {
  currentJobId = null;
  eventSource?.close();
  eventSource = null;
  resetControls();
}

function resetControls() {
  $('sim-button').disabled = false;
  $('cancel-button').classList.add('hidden');
}

async function cancelSim() {
  if (!currentJobId) return;
  await fetch(`/api/sim/${currentJobId}/cancel`, { method: 'POST' });
}

// ---------- rendering ----------
function setProgress(phase, percent, detail) {
  $('progress-phase').textContent = phase;
  $('progress-bar').style.width = `${percent}%`;
  $('progress-detail').textContent = detail;
}

function renderResult(r) {
  $('progress-area').classList.add('hidden');
  $('results-area').classList.remove('hidden');

  $('dps-value').textContent = Math.round(r.dps).toLocaleString();
  const meta = [
    r.player.name,
    r.player.spec,
    `±${Math.round(r.dpsError).toLocaleString()} DPS error`,
    `${r.targets} target${r.targets > 1 ? 's' : ''}`,
    `${Math.round(r.fightLength)}s fight`,
    r.iterations ? `${r.iterations.toLocaleString()} iterations` : null,
    r.elapsedSeconds ? `simmed in ${r.elapsedSeconds.toFixed(1)}s` : null,
  ].filter(Boolean).join(' · ');
  $('dps-meta').textContent = meta;

  const maxShare = Math.max(...r.abilities.map((a) => a.share), 0.0001);
  const abilityRows = r.abilities.slice(0, 25).map((a) => `
    <tr>
      <td>${esc(a.name)}${a.source !== r.player.name ? `<span class="pet-tag">${esc(a.source)}</span>` : ''}</td>
      <td class="num">${Math.round(a.dps).toLocaleString()}</td>
      <td class="num">${a.executes.toFixed(1)}</td>
      <td>${shareBar(a.share * 100, (a.share / maxShare) * 100)}</td>
    </tr>`).join('');
  document.querySelector('#abilities-table tbody').innerHTML =
    abilityRows || '<tr><td colspan="4">No damage abilities recorded.</td></tr>';

  const buffRows = r.buffs.slice(0, 20).map((b) => `
    <tr>
      <td>${esc(b.name)}</td>
      <td>${shareBar(b.uptime, Math.min(100, b.uptime))}</td>
    </tr>`).join('');
  document.querySelector('#buffs-table tbody').innerHTML =
    buffRows || '<tr><td colspan="2">No notable buffs.</td></tr>';
}

function shareBar(pct, fillPct) {
  return `<div class="share-bar">
    <div class="track"><div class="fill" style="width:${fillPct.toFixed(1)}%"></div></div>
    <span class="pct">${pct.toFixed(1)}%</span>
  </div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function showError(msg) {
  $('error-box').textContent = msg;
  $('error-box').classList.remove('hidden');
}
function hideError() {
  $('error-box').classList.add('hidden');
}
