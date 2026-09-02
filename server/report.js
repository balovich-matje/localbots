// Turns a finished sim into ONE self-contained HTML file you can hand to
// someone else — the whole point being that they need nothing installed and no
// access to this server. Everything except the item icons is inlined, and the
// icons come from Blizzard's public CDN, so a reader who is offline sees blank
// tiles and everything else intact.
//
// HTML rather than PDF: a droptimizer run is a 150-row table that a fixed page
// size would mangle, and any browser turns this into a PDF with Ctrl+P anyway.

const ICON_CDN = 'https://render.worldofwarcraft.com/us/icons/56';
// The game's own enchant data has no per-enchant icon (SpellItemEnchantment's
// IconFileDataID is 0 on every row), which is why Raidbots' Top Gear report —
// the reference for this UI — shows the exact same generic scroll icon next
// to every enchant rather than a distinct one each. This is that same asset,
// hosted by Raidbots.
const ENCHANT_ICON_URL = 'https://www.raidbots.com/static/images/icons/56/inv_misc_enchantedscroll.png';

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const num = (v) => Math.round(Number(v) || 0).toLocaleString('en-US');

const SLOT_LABELS = {
  head: 'Head', neck: 'Neck', shoulder: 'Shoulder', back: 'Back', chest: 'Chest',
  wrist: 'Wrist', hands: 'Hands', waist: 'Waist', legs: 'Legs', feet: 'Feet',
  finger1: 'Finger 1', finger2: 'Finger 2', trinket1: 'Trinket 1', trinket2: 'Trinket 2',
  main_hand: 'Main hand', off_hand: 'Off hand',
};
const prettySlot = (s) => SLOT_LABELS[s] ?? String(s ?? '').replace(/_/g, ' ');

// A share/uptime bar, drawn with a div so it survives a copy-paste anywhere.
function bar(label, pct) {
  const w = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="bar"><div class="bar-track"><div class="bar-fill" style="width:${w.toFixed(1)}%"></div></div>
    <span class="bar-label">${esc(label)}</span></div>`;
}

function iconImg(itemId, iconFileId) {
  if (!iconFileId) return '<span class="tile blank"></span>';
  // no loading="lazy": these are 56px tiles, and a lazy image that never
  // scrolls into view is a blank square when the reader prints the page
  return `<img class="tile" alt="" src="${ICON_CDN}/${encodeURIComponent(iconFileId)}.jpg">`;
}

// Small flask badge over an item's icon: this row shows the real Catalyst
// output item (t.itemId/itemName already are the tier piece's, not the
// looted item's — see profileBuilder.js), and the badge is what makes that
// visible at a glance without reading the row's text.
function catalystBadge(t, fromName) {
  if (!t.catalysed) return '';
  const title = `Catalyzed${fromName ? ` from ${fromName}` : ''} — shown as the tier piece it becomes, not the looted item`;
  return `<span class="catalyst-badge" title="${esc(title)}">
    <svg viewBox="0 0 24 24" width="10" height="10"><path d="M9 2v6.3L3.4 19a2 2 0 0 0 1.8 3h13.6a2 2 0 0 0 1.8-3L15 8.3V2M9 2h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>
  </span>`;
}

function iconTile(itemId, iconFileId, t) {
  const img = iconImg(itemId, iconFileId);
  return t?.catalysed ? `<span class="tile-wrap">${img}${catalystBadge(t, t.catalystFromName)}</span>` : img;
}

function settingsLine(entry) {
  const o = entry.options ?? {};
  const r = entry.result ?? {};
  return [
    o.fightStyle,
    r.targets ? `${r.targets} target${r.targets > 1 ? 's' : ''}` : null,
    r.fightLength ? `${Math.round(r.fightLength)}s fight` : null,
    o.targetError ? `target error ${o.targetError}%` : (o.iterations ? `${num(o.iterations)} iterations` : null),
    r.iterations ? `${num(r.iterations)} iterations run` : null,
    r.elapsedSeconds ? `simmed in ${Number(r.elapsedSeconds).toFixed(1)}s` : null,
  ].filter(Boolean).join(' · ');
}

// Comparison rows for a real gear slot carry no sourceKind (a plain item, a
// droptimizer drop, a crafted piece...); enchants/gems/consumables/folio/
// talents/track-upgrades are alternatives within a category, not a choice of
// what goes in a slot, so they never enter the "Your Top Gear" paperdoll.
const NON_SLOT_KINDS = new Set(['enchants', 'gems', 'upgrades', 'folio', 'consumables', 'talents']);

// slot -> the best row for it, if that row actually beats what's equipped
// there and clears its own margin of error -- mirrors the browser's "Best
// setup" tab (bucketFor/renderBestSetup in app.js) so the two agree.
function bestPicksBySlot(rows) {
  const best = new Map();
  for (const t of rows ?? []) {
    if (NON_SLOT_KINDS.has(t.sourceKind) || !t.placement) continue;
    const cur = best.get(t.placement);
    if (!cur || (Number(t.delta) || 0) > (Number(cur.delta) || 0)) best.set(t.placement, t);
  }
  for (const [slot, t] of best) {
    if (/\(current\)/.test(t.itemName ?? '') || !((Number(t.delta) || 0) > (Number(t.error) || 0))) {
      best.delete(slot);
    }
  }
  return best;
}

function comparisonTable(rows, icons, equipped, gemLabels, enchantLabels) {
  if (!rows?.length) return '';
  const maxAbs = Math.max(...rows.map((t) => Math.abs(Number(t.delta) || 0)), 1);
  const body = rows.map((t) => {
    const delta = Number(t.delta) || 0;
    const cls = delta > (Number(t.error) || 0) ? 'pos' : delta < -(Number(t.error) || 0) ? 'neg' : 'zero';
    const sign = delta > 0 ? '+' : '';
    const ilvl = t.origIlvl && t.ilvl && t.origIlvl !== t.ilvl
      ? `<span class="muted">(${esc(t.origIlvl)} → ${esc(t.ilvl)})</span>`
      : t.ilvl ? `<span class="muted">(${esc(t.ilvl)})</span>` : '';
    const tags = [
      t.catalysed
        ? `<span class="tag" title="Catalyzed${t.catalystFromName ? ` from ${esc(t.catalystFromName)}` : ''}">catalyzed</span>`
        : '',
      t.offHandLost ? '<span class="tag muted-tag">off-hand removed</span>' : '',
    ].join('');
    const source = [t.section, t.boss].filter(Boolean).map(esc).join(' → ');
    // this row's candidate is simmed with whatever's already carried in that
    // slot (see droptimizer.js) -- same source topGearGrid's enchGemLine uses
    const eq = equipped?.[t.placement];
    return `<tr>
      <td class="item">${iconTile(t.itemId, icons?.[t.itemId], t)}<span>${esc(t.itemName ?? '?')} ${ilvl}${tags}
        <span class="muted block">→ ${esc(prettySlot(t.placement))}</span>
        ${eq ? enchGemLine(eq, gemLabels, enchantLabels, icons) : ''}</span></td>
      <td>${source}</td>
      <td class="num">${num(t.dps)}</td>
      <td class="num ${cls}">${sign}${num(delta)}</td>
      <td class="pctcell">${bar(`${sign}${(Number(t.deltaPct) || 0).toFixed(2)}%`,
        (Math.abs(delta) / maxAbs) * 100)}</td>
    </tr>`;
  }).join('');
  return `<h2>Top Gear (DPS) <span class="muted">${rows.length} row${rows.length === 1 ? '' : 's'}</span></h2>
    <table class="wide"><thead><tr>
      <th>Item</th><th>Source</th><th class="num">DPS</th><th class="num">Change</th><th>vs equipped</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

function statWeightsTable(statWeights) {
  if (!statWeights?.length) return '';
  const max = Math.max(...statWeights.map((s) => s.value), 0.0001);
  const body = statWeights.map((s) => `<tr>
      <td>${esc(s.label)}</td>
      <td class="num">${num(s.value)}</td>
      <td class="pctcell">${bar(s.normalized.toFixed(2), (s.value / max) * 100)}</td>
    </tr>`).join('');
  return `<h2>Stat weights</h2>
    <table><thead><tr><th>Stat</th><th class="num">DPS per point</th><th>Relative to top stat</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function abilityTable(abilities, playerName) {
  if (!abilities?.length) return '';
  const max = Math.max(...abilities.map((a) => a.share), 0.0001);
  const body = abilities.slice(0, 25).map((a) => `<tr>
      <td>${esc(a.name)}${a.source && a.source !== playerName ? ` <span class="muted">${esc(a.source)}</span>` : ''}</td>
      <td class="num">${num(a.dps)}</td>
      <td class="num">${(Number(a.executes) || 0).toFixed(1)}</td>
      <td class="pctcell">${bar(`${((Number(a.share) || 0) * 100).toFixed(1)}%`, (a.share / max) * 100)}</td>
    </tr>`).join('');
  return `<h2>Damage breakdown</h2>
    <table><thead><tr><th>Ability</th><th class="num">DPS</th><th class="num">Casts</th><th>Share</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function buffTable(buffs) {
  if (!buffs?.length) return '';
  const body = buffs.slice(0, 20).map((b) => `<tr>
      <td>${esc(b.name)}</td>
      <td class="pctcell">${bar(`${(Number(b.uptime) || 0).toFixed(1)}%`, Math.min(100, b.uptime))}</td>
    </tr>`).join('');
  return `<h2>Buff uptimes</h2>
    <table><thead><tr><th>Buff</th><th>Uptime</th></tr></thead><tbody>${body}</tbody></table>`;
}

// a 14px icon for the enchant/gem subline -- same CDN, same file-id space as
// the full-size item tiles (see iconImg), just smaller and no border
function miniIconImg(iconFileId) {
  return iconFileId
    ? `<img class="mini-icon" alt="" src="${ICON_CDN}/${encodeURIComponent(iconFileId)}.jpg">`
    : '<span class="mini-icon blank"></span>';
}

// candidate items in the Comparison table carry this same slot's enchant and
// gems (see droptimizer.js), so listing them once here — against the
// currently-equipped item — is what every row above is actually simmed with.
// A gem gets its own icon (a real item); the enchant gets the fixed generic
// one (see ENCHANT_ICON_URL) -- same layout Raidbots' Top Gear report uses.
function enchGemLine(it, gemLabels, enchantLabels, icons) {
  const parts = [];
  if (it.enchantId) {
    parts.push(`<img class="mini-icon" alt="" src="${ENCHANT_ICON_URL}"> ${esc(enchantLabels?.[it.enchantId] ?? `enchant #${it.enchantId}`)}`);
  }
  for (const g of it.gemIds ?? []) {
    parts.push(`${miniIconImg(icons?.[g] ?? icons?.[Number(g)])} ${esc(gemLabels?.[g] ?? gemLabels?.[Number(g)] ?? `gem #${g}`)}`);
  }
  return parts.length
    ? `<span class="muted block enchgem">${parts.map((p) => `<span class="enchgem-item">${p}</span>`).join('')}</span>`
    : '';
}

// The paperdoll at the top of the report: every slot's equipped item, unless
// a row from the Top Gear (DPS) table below beats it (bestPicksBySlot) --
// that slot is then highlighted and shows the winning item plus its gain,
// the same "what changed" view Raidbots' Top Gear report leads with.
function topGearGrid(equipped, picksBySlot, icons, qualities, gemLabels, enchantLabels) {
  const slots = Object.keys(SLOT_LABELS).filter((s) => equipped?.[s]);
  if (!slots.length) return '';
  const cellFor = (slot) => {
    const eq = equipped[slot];
    const pick = picksBySlot?.get(slot);
    const itemId = pick ? pick.itemId : eq?.id;
    const name = pick ? pick.itemName : eq?.name;
    const ilvl = pick ? pick.ilvl : eq?.ilvl;
    const q = qualities?.[itemId];
    const nameClass = q != null ? ` q${esc(q)}` : '';
    const gain = pick
      ? `<span class="muted block">was ${esc(eq?.name ?? 'nothing')} <span class="pos">+${num(pick.delta)} DPS</span></span>`
      : '';
    return `<div class="pd-row${pick ? ' pd-changed' : ''}">
      <div class="pd-slot muted">${esc(prettySlot(slot))}</div>
      <div class="item">${iconTile(itemId, icons?.[itemId], pick)}<span>
        <span class="pd-name${nameClass}">${esc(name ?? '?')}</span>${ilvl ? ` <span class="muted">(${esc(ilvl)})</span>` : ''}
        ${pick?.catalysed ? `<span class="tag" title="Catalyzed${pick.catalystFromName ? ` from ${esc(pick.catalystFromName)}` : ''}">catalyzed</span>` : ''}
        ${enchGemLine(eq, gemLabels, enchantLabels, icons)}${gain}</span></div>
    </div>`;
  };
  const half = Math.ceil(slots.length / 2);
  return `<h2>Your Top Gear</h2>
    <p class="muted block">Highlighted slots beat what you have equipped — enchant &amp; gems shown for the rest carry over to every candidate in that slot below.</p>
    <div class="pd-grid">
      <div class="pd-col">${slots.slice(0, half).map(cellFor).join('')}</div>
      <div class="pd-col">${slots.slice(half).map(cellFor).join('')}</div>
    </div>`;
}

const CONSUMABLE_LABELS = {
  flask: 'Flask', food: 'Food', potion: 'Potion',
  augmentation: 'Augment rune', temporary_enchant: 'Weapon oil',
};

// simc's option values are ids ("flask_of_the_shattered_sun_2"); the season
// config knows what those are actually called, and the weapon oil arrives as
// "main_hand:oil/off_hand:oil" so each hand is named separately.
function consumableList(consumables, labels) {
  const name = (v) => labels?.[v] ?? String(v).replace(/_/g, ' ');
  const value = (v) => String(v).split('/')
    .map((part) => {
      const [slot, id] = part.includes(':') ? part.split(':') : [null, part];
      return slot ? `${prettySlot(slot)}: ${name(id)}` : name(part);
    })
    .join(', ');
  const rows = Object.entries(consumables ?? {})
    .filter(([, v]) => v && v !== 'disabled')
    .map(([k, v]) => `<tr><td class="muted">${esc(CONSUMABLE_LABELS[k] ?? k.replace(/_/g, ' '))}</td>
      <td>${esc(value(v))}</td></tr>`);
  if (!rows.length) return '';
  return `<h2>Consumables</h2><table><tbody>${rows.join('')}</tbody></table>`;
}

// icons: { [itemId]: iconFileId } — optional; without it the tiles are blank
export function buildReportHtml(entry, {
  icons = null, consumableLabels = null, gemLabels = null, enchantLabels = null, qualities = null,
  appUrl = 'https://github.com/balovich-matje/localbots',
} = {}) {
  const r = entry.result ?? {};
  const p = r.player ?? {};
  const when = new Date(entry.savedAt ?? Date.now());
  const title = `${p.name ?? 'Sim'} — ${entry.modeLabel ?? 'Localbots'}`;
  const picksBySlot = bestPicksBySlot(r.topgear);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    --bg:#0e1013; --panel:#171a20; --panel2:#1e222b; --border:#2a2f3a;
    --text:#e6e9ef; --muted:#8b93a3; --accent:#f2b135; --green:#4caf7d; --red:#e05f5f; --bar:#3d64a8;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:28px 20px 60px; }
  header { border-bottom:1px solid var(--border); padding-bottom:16px; margin-bottom:22px; }
  h1 { margin:0 0 4px; font-size:22px; }
  h1 .accent { color:var(--accent); }
  h2 { margin:30px 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.6px; color:var(--accent); font-weight:600; }
  .muted { color:var(--muted); font-weight:400; }
  .block { display:block; font-size:12px; }
  .hero { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-bottom:6px; }
  .hero .dps { font-size:34px; font-weight:600; letter-spacing:-.5px; }
  .hero .unit { color:var(--muted); font-size:13px; margin-left:6px; }
  .hero p { margin:6px 0 0; color:var(--muted); font-size:13px; }
  table { width:100%; border-collapse:collapse; margin-bottom:4px; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--border); vertical-align:middle; }
  th { color:var(--muted); font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.4px; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.pctcell { width:34%; min-width:170px; }
  .pos { color:var(--green); } .neg { color:var(--red); } .zero { color:var(--muted); }
  .item { display:flex; align-items:center; gap:9px; }
  .tile { width:28px; height:28px; border-radius:5px; border:1px solid var(--border); flex:none; }
  .tile.blank { display:inline-block; background:var(--panel2); }
  .tile-wrap { position:relative; display:inline-flex; flex:none; }
  .catalyst-badge {
    position:absolute; right:-4px; bottom:-4px; width:14px; height:14px;
    display:flex; align-items:center; justify-content:center; border-radius:50%;
    background:var(--accent); color:#1a1405; border:1.5px solid var(--bg);
  }
  .enchgem { display:flex; flex-direction:column; gap:2px; margin-top:2px; }
  .enchgem-item { display:inline-flex; align-items:center; gap:4px; }
  .mini-icon { width:14px; height:14px; border-radius:3px; flex:none; vertical-align:-3px; }
  .mini-icon.blank { display:inline-block; background:var(--panel2); }
  .bar { display:flex; align-items:center; gap:9px; }
  .bar-track { flex:1; height:7px; background:var(--panel2); border-radius:4px; overflow:hidden; }
  .bar-fill { height:100%; background:var(--bar); }
  .bar-label { font-variant-numeric:tabular-nums; font-size:12px; color:var(--muted); min-width:56px; text-align:right; }
  .tag { display:inline-block; font-size:11px; color:var(--accent); border:1px solid var(--accent);
         border-radius:10px; padding:0 6px; margin-left:5px; white-space:nowrap; }
  .tag.muted-tag { color:var(--muted); border-color:var(--border); }
  .scroll { overflow-x:auto; }
  .pd-grid { display:grid; grid-template-columns:1fr 1fr; gap:0 24px; margin-bottom:8px; }
  .pd-row { display:flex; align-items:center; gap:10px; padding:6px 8px; border-radius:6px; border:1px solid transparent; }
  .pd-row.pd-changed { border-color:var(--accent); background:rgba(242,177,53,.08); }
  .pd-slot { width:62px; flex:none; font-size:12px; }
  .pd-name { font-weight:600; }
  .pd-name.q1 { color:#fff; } .pd-name.q2 { color:#1eff00; } .pd-name.q3 { color:#0070dd; }
  .pd-name.q4 { color:#a335ee; } .pd-name.q5 { color:#ff8000; }
  @media (max-width:640px) { .pd-grid { grid-template-columns:1fr; } }
  footer { margin-top:34px; padding-top:14px; border-top:1px solid var(--border); color:var(--muted); font-size:12px; }
  footer a { color:var(--muted); }
  @media print {
    body { background:#fff; color:#111; }
    .hero, table, th, td { border-color:#ccc; }
    .bar-track { background:#eee; }
    h2 { color:#444; }
    .muted, .bar-label, footer { color:#555; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1><span class="accent">${esc(p.name ?? 'Character')}</span> — ${esc(entry.modeLabel ?? 'Sim')}</h1>
    <div class="muted">${[p.spec, p.race, p.level ? `level ${p.level}` : null]
      .filter(Boolean).map(esc).join(' · ')}</div>
    <div class="muted">${esc(when.toLocaleString())}</div>
  </header>

  <div class="hero">
    <div><span class="dps">${num(r.dps)}</span><span class="unit">DPS${r.dpsError ? ` ±${num(r.dpsError)}` : ''}</span></div>
    <p>${esc(settingsLine(entry))}</p>
  </div>

  ${topGearGrid(r.equipped, picksBySlot, icons, qualities, gemLabels, enchantLabels)}
  <div class="scroll">${comparisonTable(r.topgear, icons, r.equipped, gemLabels, enchantLabels)}</div>
  ${statWeightsTable(r.statWeights)}
  ${abilityTable(r.abilities, p.name)}
  ${buffTable(r.buffs)}
  ${consumableList(r.consumables, consumableLabels)}

  <footer>
    Generated by <a href="${esc(appUrl)}">Localbots</a>${r.simcVersion ? ` · SimulationCraft ${esc(r.simcVersion)}` : ''}${r.buildInfo ? ` · game build ${esc(r.buildInfo)}` : ''}
    <br>Item icons load from Blizzard's public image server, so they need an internet connection to show.
  </footer>
</div>
</body>
</html>
`;
}

// "localbots-droptimizer-Skibidk-2026-08-27.html"
export function reportFilename(entry) {
  const p = entry.result?.player ?? {};
  const date = new Date(entry.savedAt ?? Date.now()).toISOString().slice(0, 10);
  const safe = (v) => String(v ?? '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [`localbots`, safe(entry.mode), safe(p.name), date].filter(Boolean).join('-') + '.html';
}
