const $ = (id) => document.getElementById(id);

let currentJobId = null;
let eventSource = null;
let mode = 'quick';
let gearItems = []; // last parsed bag/vault items, indexes match checkboxes
let season = null; // upgrade tracks + voidcore info from data/season.json

fetch('/api/season').then((r) => r.json()).then((s) => { season = s; }).catch(() => {});

// Upgrade levels this specific item can actually reach.
// Crafted items (marked by crafted_stats= in the export): max craft, then
// Voidcore for weapons/trinkets. Dropped items: every track step above the
// current ilvl (we don't know the item's track, so we offer the union),
// then the Myth Voidcore level for weapons/trinkets.
function upgradeOptionsFor(item) {
  if (!season || !item.ilvl) return [];
  const isVoidcoreSlot = season.voidcore?.slots?.includes(item.slot);
  const opts = [];

  if (item.crafted) {
    const maxCraft = season.crafted?.maxIlvl;
    if (maxCraft && maxCraft > item.ilvl) opts.push({ ilvl: maxCraft, label: `${maxCraft} — max craft` });
    const vc = season.voidcore?.craftedIlvl;
    if (isVoidcoreSlot && vc && vc > item.ilvl) opts.push({ ilvl: vc, label: `${vc} — Voidcore (crafted)` });
    return opts;
  }

  const steps = new Set();
  for (const track of Object.values(season.tracks ?? {})) {
    for (const ilvl of track) if (ilvl > item.ilvl) steps.add(ilvl);
  }
  opts.push(...[...steps].sort((a, b) => a - b).map((ilvl) => ({ ilvl, label: String(ilvl) })));
  const vc = season.voidcore?.mythIlvl;
  if (isVoidcoreSlot && vc && vc > item.ilvl) {
    opts.push({ ilvl: vc, label: `${vc} — Voidcore (Myth 6/6)` });
  }
  return opts;
}

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
const SIM_LABELS = { quick: 'Sim it', topgear: 'Compare gear', droptimizer: 'Run droptimizer' };
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('gear-section').classList.toggle('hidden', mode !== 'topgear');
    $('dropt-section').classList.toggle('hidden', mode !== 'droptimizer');
    $('sim-button').textContent = SIM_LABELS[mode];
    if (mode === 'topgear') refreshGearList();
    if (mode === 'droptimizer') refreshDroptimizer();
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
        ${ilvlControl(item, i)}
      </label>`).join('')}
  `).join('');
  document.querySelectorAll('#gear-list input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', updateGearCount);
  });
  document.querySelectorAll('#gear-list select.ilvl-select').forEach((sel) => {
    sel.addEventListener('click', (e) => e.preventDefault()); // don't toggle the row checkbox
    sel.addEventListener('change', () => {
      const i = Number(sel.dataset.gearIndex);
      if (sel.value === 'custom') {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'ilvl-custom';
        input.min = 100; input.max = 500;
        input.value = gearItems[i].targetIlvl ?? gearItems[i].ilvl ?? 289;
        input.dataset.gearIndex = i;
        input.addEventListener('click', (e) => e.preventDefault());
        input.addEventListener('input', () => {
          gearItems[i].targetIlvl = Number(input.value) || null;
        });
        sel.replaceWith(input);
        input.focus();
        gearItems[i].targetIlvl = Number(input.value);
      } else {
        gearItems[i].targetIlvl = Number(sel.value) || null;
      }
    });
  });
  updateGearCount();
}

function prettySlot(slot) {
  return slot.replace(/_/g, ' ').replace(/(finger|trinket)([12])/, '$1 $2');
}

// ---------- droptimizer ----------
let droptTree = null;
let droptPoll = null;

$('dropt-all').addEventListener('click', () => setAllDropt(true));
$('dropt-none').addEventListener('click', () => setAllDropt(false));
$('dropt-refresh').addEventListener('click', async () => {
  await fetch('/api/data/refresh', { method: 'POST' });
  refreshDroptimizer();
});

function setAllDropt(on) {
  document.querySelectorAll('#dropt-sources input[type="checkbox"]').forEach((cb) => {
    if (!cb.disabled) cb.checked = on;
  });
}

async function refreshDroptimizer() {
  clearTimeout(droptPoll);
  const profile = $('profile').value;
  if (!profile.trim()) {
    $('dropt-status').textContent = 'Paste your /simc export above first.';
    $('dropt-sources').innerHTML = '';
    return;
  }
  let r;
  try {
    r = await (await fetch('/api/droptimizer/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    })).json();
  } catch {
    $('dropt-status').textContent = 'Could not reach the server.';
    return;
  }
  if (r.error) {
    $('dropt-status').textContent = r.error;
    $('dropt-sources').innerHTML = '';
    return;
  }
  if (r.needsData || r.status?.refresh?.running) {
    const step = r.status?.refresh?.running
      ? `Downloading game data: ${r.status.refresh.step ?? '…'}`
      : 'Game data not downloaded yet — hit "Refresh data" (one-time, ~60 MB from wago.tools).';
    $('dropt-status').textContent = step;
    $('dropt-sources').innerHTML = '';
    if (r.status?.refresh?.running) droptPoll = setTimeout(refreshDroptimizer, 2500);
    return;
  }

  const probe = r.status.probe;
  if (!probe.ready) {
    $('dropt-status').textContent = probe.error
      ? `Item check failed: ${probe.error}`
      : 'One-time check: finding which items your simc build can sim… (~30s)';
    if (!probe.error) droptPoll = setTimeout(refreshDroptimizer, 3000);
    if (!droptTree) $('dropt-sources').innerHTML = '';
    if (!probe.error && !droptTree) return;
    if (!probe.ready && !probe.error) return;
  } else {
    const age = r.status.cache?.downloadedAt
      ? `game data from ${new Date(r.status.cache.downloadedAt).toLocaleDateString()}`
      : '';
    $('dropt-status').textContent = `Filtering loot for ${r.spec.key.replace('_', ' ')} · ${age}`;
  }

  droptTree = r.tree;
  renderDroptSources(r.tree, r.season);
}

function renderDroptSources(tree, season) {
  const html = [];
  const hidden = []; // unreleased sources (in game data, not in simc yet)
  const avail = (list) => list.filter((s) => (s.available ? true : (hidden.push(s.name), false)));

  const raids = avail(tree.raids);
  if (raids.length) {
    html.push('<div class="dropt-group"><h3>Raids</h3>');
    for (const raid of raids) {
      const diffs = Object.keys(season.raidDifficulties);
      html.push(`<div class="dropt-row">
        <span class="src-name">${esc(raid.name)} <span class="hint-inline">${raid.usable} items</span></span>
        <span class="diff-boxes">${diffs.map((d) => `
          <label><input type="checkbox" data-raid="${raid.instanceId}" data-diff="${d}"
            ${d === 'Heroic' ? 'checked' : ''}> ${d}</label>`).join('')}
        </span></div>`);
    }
    html.push('</div>');
  }

  const dungeons = avail(tree.dungeons);
  if (dungeons.length) {
    const keys = Object.keys(season.mythicPlus.endOfDungeon);
    html.push(`<div class="dropt-group"><h3>Mythic+</h3>
      <div class="dropt-row">
        <label>Key level
          <select id="dropt-keylevel">${keys.map((k) => `<option value="${k}" ${k === '10' ? 'selected' : ''}>${k === '0' ? 'M0' : '+' + k}</option>`).join('')}</select>
        </label>
        <label><input type="radio" name="dropt-reward" value="end"> End of dungeon</label>
        <label><input type="radio" name="dropt-reward" value="vault" checked> Great Vault</label>
      </div>`);
    for (const d of dungeons) {
      html.push(`<div class="dropt-row">
        <label><input type="checkbox" data-dungeon="${d.instanceId}" checked>
          ${esc(d.name)} <span class="hint-inline">${d.usable} items</span></label></div>`);
    }
    html.push('</div>');
  }

  const worldBosses = avail(tree.worldBosses);
  if (worldBosses.length) {
    const wb = worldBosses[0];
    html.push(`<div class="dropt-group"><h3>World bosses</h3>
      <div class="dropt-row">
        <label><input type="checkbox" id="dropt-wb" checked>
          ${esc(wb.name)} <span class="hint-inline">${wb.usable} items</span></label>
        <label>ilvl <input type="number" id="dropt-wb-ilvl" value="${season.worldBossIlvl}" min="200" max="320"></label>
      </div></div>`);
  }

  const outdoor = avail(tree.outdoor);
  if (outdoor.length) {
    html.push('<div class="dropt-group"><h3>Outdoor / events</h3>');
    html.push(`<div class="dropt-row"><label>ilvl <input type="number" id="dropt-outdoor-ilvl" value="${season.outdoorIlvl}" min="200" max="320"></label></div>`);
    for (const o of outdoor) {
      html.push(`<div class="dropt-row">
        <label><input type="checkbox" data-outdoor="${o.instanceId}" checked>
          ${esc(o.name)} <span class="hint-inline">${o.usable} items</span></label></div>`);
    }
    html.push('</div>');
  }

  if (hidden.length) {
    html.push(`<p class="hint">Not yet released (found in game data, but not live): ${hidden.map(esc).join(', ')} — these appear automatically once the patch drops and simc is updated.</p>`);
  }

  html.push('<div class="dropt-group"><h3>Delves</h3>');
  if (tree.delves.length) {
    const tiers = Object.keys(season.delves.endOfDelve);
    html.push(`<div class="dropt-row">
      <label><input type="checkbox" id="dropt-delves" checked> Bountiful pool <span class="hint-inline">${tree.delves[0].usable} items</span></label>
      <label>Tier <select id="dropt-delve-tier">${tiers.map((t) => `<option value="${t}" ${t === '8' ? 'selected' : ''}>T${t}</option>`).join('')}</select></label>
      <label><input type="radio" name="dropt-delve-reward" value="end" checked> Coffer</label>
      <label><input type="radio" name="dropt-delve-reward" value="vault"> Vault</label>
    </div>`);
  } else {
    html.push('<p class="hint">Delve loot pools are not in the game\'s client data — add items to <code>data/delve-loot.json</code> and hit Refresh data to enable this source.</p>');
  }
  html.push('</div>');

  $('dropt-sources').innerHTML = html.join('');
}

function collectDroptSelection() {
  const selection = { raids: {}, dungeons: null, worldBoss: null, outdoor: null, delves: null };
  document.querySelectorAll('#dropt-sources input[data-raid]:checked').forEach((cb) => {
    (selection.raids[cb.dataset.raid] ??= []).push(cb.dataset.diff);
  });
  const dungeonIds = [...document.querySelectorAll('#dropt-sources input[data-dungeon]:checked')]
    .map((cb) => cb.dataset.dungeon);
  if (dungeonIds.length) {
    selection.dungeons = {
      instanceIds: dungeonIds,
      keyLevel: $('dropt-keylevel')?.value ?? '10',
      reward: document.querySelector('input[name="dropt-reward"]:checked')?.value ?? 'vault',
    };
  }
  if ($('dropt-wb')?.checked) {
    selection.worldBoss = { enabled: true, ilvl: Number($('dropt-wb-ilvl')?.value) || undefined };
  }
  const outdoorIds = [...document.querySelectorAll('#dropt-sources input[data-outdoor]:checked')]
    .map((cb) => cb.dataset.outdoor);
  if (outdoorIds.length) {
    selection.outdoor = { instanceIds: outdoorIds, ilvl: Number($('dropt-outdoor-ilvl')?.value) || undefined };
  }
  if ($('dropt-delves')?.checked) {
    selection.delves = {
      enabled: true,
      tier: $('dropt-delve-tier')?.value ?? '8',
      reward: document.querySelector('input[name="dropt-delve-reward"]:checked')?.value ?? 'end',
    };
  }
  return selection;
}

function ilvlControl(item, i) {
  const opts = upgradeOptionsFor(item);
  if (!opts.length) {
    // no known upgrades (or no parsed ilvl) — still allow custom editing
    return `<select class="ilvl-select" data-gear-index="${i}">
      <option value="">${item.ilvl ?? '?'}</option>
      <option value="custom">custom…</option>
    </select>`;
  }
  return `<select class="ilvl-select" data-gear-index="${i}" title="Sim this item at a higher upgrade level">
    <option value="">${item.ilvl} (as looted)</option>
    ${opts.map((o) => `<option value="${o.ilvl}">${esc(o.label)}</option>`).join('')}
    <option value="custom">custom…</option>
  </select>`;
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
  } else if (mode === 'droptimizer') {
    payload.mode = 'droptimizer';
    payload.selection = collectDroptSelection();
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
        ? `Item ${p.phaseNum - 1}/${p.phaseTotal - 1}: ${p.item.replace(/ @[a-z_0-9]+$/, '').replace(/ \[\d+\]$/, '')}`
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

let tgRows = [];
let tgActiveChip = null;

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

  tgRows = r.topgear;
  tgActiveChip = null;
  $('tg-search').value = '';

  // filter chips (droptimizer runs have many sections; top gear has few)
  const sections = [...new Set(tgRows.map((t) => t.section))];
  const showFilters = sections.length > 2 || tgRows.length > 30;
  $('tg-filters').classList.toggle('hidden', !showFilters);
  if (showFilters) {
    $('tg-chips').innerHTML = ['All', ...sections].map((s, i) =>
      `<button class="chip ${i === 0 ? 'active' : ''}" data-chip="${i === 0 ? '' : esc(s)}">${esc(s)}</button>`).join('');
    document.querySelectorAll('#tg-chips .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        tgActiveChip = chip.dataset.chip || null;
        document.querySelectorAll('#tg-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
        renderTopGearRows();
      });
    });
  }
  renderTopGearRows();
}

$('tg-search').addEventListener('input', renderTopGearRows);

function renderTopGearRows() {
  const q = $('tg-search').value.toLowerCase();
  const visible = tgRows.filter((t) =>
    (!tgActiveChip || t.section === tgActiveChip) &&
    (!q || `${t.itemName} ${t.section} ${t.boss ?? ''}`.toLowerCase().includes(q)));

  const maxAbs = Math.max(...visible.map((t) => Math.abs(t.delta)), 1);
  const rows = visible.map((t) => {
    const cls = t.delta > t.error ? 'delta-pos' : t.delta < -t.error ? 'delta-neg' : 'delta-zero';
    const sign = t.delta > 0 ? '+' : '';
    const fill = (Math.abs(t.delta) / maxAbs) * 100;
    return `
    <tr>
      <td>${esc(t.itemName ?? '?')}${ilvlBadge(t)}
          <span class="slot-tag">→ ${esc(prettySlot(t.placement))}${t.boss ? ` · ${esc(t.boss)}` : ''}</span></td>
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
    rows || '<tr><td colspan="5">No results match the filter.</td></tr>';
}

function ilvlBadge(t) {
  if (!t.ilvl) return '';
  if (t.origIlvl && t.origIlvl !== t.ilvl) {
    return ` <span class="ilvl upgraded">(${t.origIlvl} → ${t.ilvl})</span>`;
  }
  return ` <span class="ilvl">(${t.ilvl})</span>`;
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
