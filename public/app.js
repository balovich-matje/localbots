const $ = (id) => document.getElementById(id);

let currentJobId = null;
let eventSource = null;
let mode = 'quick';
let gearItems = []; // last parsed bag/vault items, indexes match checkboxes

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

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('gear-section').classList.toggle('hidden', mode !== 'topgear');
    $('sim-button').textContent = mode === 'topgear' ? 'Compare gear' : 'Sim it';
    if (mode === 'topgear') refreshGearList();
  });
});

let gearRefreshTimer = null;
$('profile').addEventListener('input', () => {
  if (mode !== 'topgear') return;
  clearTimeout(gearRefreshTimer);
  gearRefreshTimer = setTimeout(refreshGearList, 400);
});

$('gear-all').addEventListener('click', () => setAllGear(true));
$('gear-none').addEventListener('click', () => setAllGear(false));

function setAllGear(checked) {
  document.querySelectorAll('#gear-list input').forEach((cb) => { cb.checked = checked; });
  updateGearCount();
}

function updateGearCount() {
  const boxes = [...document.querySelectorAll('#gear-list input')];
  $('gear-count').textContent = boxes.length
    ? `${boxes.filter((b) => b.checked).length} of ${boxes.length} selected`
    : '';
}

async function refreshGearList() {
  const profile = $('profile').value;
  gearItems = [];
  if (!profile.trim()) {
    $('gear-list').innerHTML = '<p class="empty">Paste your /simc export above first.</p>';
    updateGearCount();
    return;
  }
  try {
    const resp = await fetch('/api/gear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    const body = await resp.json();
    gearItems = body.items ?? [];
  } catch {
    $('gear-list').innerHTML = '<p class="empty">Could not reach the server.</p>';
    return;
  }
  if (!gearItems.length) {
    $('gear-list').innerHTML =
      '<p class="empty">No bag items found in this export. Make sure you copied the WHOLE ' +
      '/simc text — the addon lists bag gear at the bottom as comment lines.</p>';
    updateGearCount();
    return;
  }
  const bySection = {};
  gearItems.forEach((item, i) => {
    (bySection[item.section] ??= []).push({ item, i });
  });
  $('gear-list').innerHTML = Object.entries(bySection).map(([section, entries]) => `
    <div class="gear-group">${esc(section)} (${entries.length})</div>
    ${entries.map(({ item, i }) => `
      <label>
        <input type="checkbox" data-gear-index="${i}" checked>
        <span>${esc(item.name)}<span class="slot-tag">${esc(prettySlot(item.slot))}</span></span>
        ${item.ilvl ? `<span class="ilvl">${item.ilvl}</span>` : ''}
      </label>`).join('')}
  `).join('');
  document.querySelectorAll('#gear-list input').forEach((cb) => {
    cb.addEventListener('change', updateGearCount);
  });
  updateGearCount();
}

function prettySlot(slot) {
  return slot.replace(/_/g, ' ').replace(/(finger|trinket)([12])/, '$1 $2');
}

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

  const payload = { profile, options };
  if (mode === 'topgear') {
    payload.mode = 'topgear';
    payload.items = [...document.querySelectorAll('#gear-list input')]
      .filter((cb) => cb.checked)
      .map((cb) => gearItems[Number(cb.dataset.gearIndex)])
      .filter(Boolean);
    if (!payload.items.length) {
      showError('Tick at least one item to compare (or paste an export that contains bag gear).');
      return;
    }
  }

  $('sim-button').disabled = true;

  let resp;
  try {
    resp = await fetch('/api/sim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
  $('topgear-area').classList.add('hidden');
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
      const phase = p.item
        ? `Item ${p.phaseNum - 1}/${p.phaseTotal - 1}: ${p.item.replace(/ @[a-z_0-9]+$/, '')}`
        : p.phaseTotal > 1 ? `${p.phase} ${p.phaseNum}/${p.phaseTotal}` : p.phase;
      const detail = [
        `${p.iterDone.toLocaleString()} / ${p.iterTotal.toLocaleString()} iterations`,
        p.meanDps ? `~${Math.round(p.meanDps).toLocaleString()} DPS` : null,
        p.eta ? `ETA ${p.eta}` : null,
      ].filter(Boolean).join(' · ');
      setProgress(phase, p.percent, detail);
    } else {
      setProgress('Initializing simc…', 2, '');
    }
  } else if (u.status === 'done') {
    finishStream();
    if (u.result?.topgear) renderTopGear(u.result);
    else renderResult(u.result);
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

function renderTopGear(r) {
  $('progress-area').classList.add('hidden');
  $('topgear-area').classList.remove('hidden');

  $('tg-baseline').textContent = Math.round(r.dps).toLocaleString();
  $('tg-meta').textContent = [
    r.player.name,
    r.player.spec,
    `${r.topgear.length} item${r.topgear.length === 1 ? '' : 's'} compared`,
    r.elapsedSeconds ? `simmed in ${r.elapsedSeconds.toFixed(1)}s` : null,
  ].filter(Boolean).join(' · ');

  const maxAbs = Math.max(...r.topgear.map((t) => Math.abs(t.delta)), 1);
  const rows = r.topgear.map((t) => {
    const cls = t.delta > t.error ? 'delta-pos' : t.delta < -t.error ? 'delta-neg' : 'delta-zero';
    const sign = t.delta > 0 ? '+' : '';
    const fill = (Math.abs(t.delta) / maxAbs) * 100;
    return `
    <tr>
      <td>${esc(t.itemName ?? '?')}${t.ilvl ? ` <span class="ilvl">(${t.ilvl})</span>` : ''}
          <span class="slot-tag">→ ${esc(prettySlot(t.placement))}</span></td>
      <td><span class="source-tag">${esc(t.section)}</span></td>
      <td class="num">${Math.round(t.dps).toLocaleString()}</td>
      <td class="num ${cls}">${sign}${Math.round(t.delta).toLocaleString()}</td>
      <td><div class="share-bar">
        <div class="track"><div class="fill" style="width:${fill.toFixed(1)}%; background:${t.delta >= 0 ? 'var(--green)' : 'var(--red)'}"></div></div>
        <span class="pct ${cls}">${sign}${t.deltaPct.toFixed(2)}%</span>
      </div></td>
    </tr>`;
  }).join('');
  document.querySelector('#topgear-table tbody').innerHTML =
    rows || '<tr><td colspan="5">No results.</td></tr>';
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
