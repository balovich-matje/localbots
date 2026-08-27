// Turns a finished sim into ONE self-contained HTML file you can hand to
// someone else — the whole point being that they need nothing installed and no
// access to this server. Everything except the item icons is inlined, and the
// icons come from Blizzard's public CDN, so a reader who is offline sees blank
// tiles and everything else intact.
//
// HTML rather than PDF: a droptimizer run is a 150-row table that a fixed page
// size would mangle, and any browser turns this into a PDF with Ctrl+P anyway.

const ICON_CDN = 'https://render.worldofwarcraft.com/us/icons/56';

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

function comparisonTable(rows, icons) {
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
      t.catalysed ? '<span class="tag">catalysed</span>' : '',
      t.offHandLost ? '<span class="tag muted-tag">off-hand removed</span>' : '',
    ].join('');
    const source = [t.section, t.boss].filter(Boolean).map(esc).join(' → ');
    return `<tr>
      <td class="item">${iconImg(t.itemId, icons?.[t.itemId])}<span>${esc(t.itemName ?? '?')} ${ilvl}${tags}
        <span class="muted block">→ ${esc(prettySlot(t.placement))}</span></span></td>
      <td>${source}</td>
      <td class="num">${num(t.dps)}</td>
      <td class="num ${cls}">${sign}${num(delta)}</td>
      <td class="pctcell">${bar(`${sign}${(Number(t.deltaPct) || 0).toFixed(2)}%`,
        (Math.abs(delta) / maxAbs) * 100)}</td>
    </tr>`;
  }).join('');
  return `<h2>Comparison <span class="muted">${rows.length} row${rows.length === 1 ? '' : 's'}</span></h2>
    <table class="wide"><thead><tr>
      <th>Item</th><th>Source</th><th class="num">DPS</th><th class="num">Change</th><th>vs equipped</th>
    </tr></thead><tbody>${body}</tbody></table>`;
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

function gearTable(equipped, icons) {
  const slots = Object.entries(equipped ?? {});
  if (!slots.length) return '';
  const body = slots.map(([slot, it]) => `<tr>
      <td class="muted">${esc(prettySlot(slot))}</td>
      <td class="item">${iconImg(it.id, icons?.[it.id])}<span>${esc(it.name ?? '')}</span></td>
      <td class="num">${it.ilvl ? esc(it.ilvl) : ''}</td>
    </tr>`).join('');
  return `<h2>Gear simmed</h2>
    <table><thead><tr><th>Slot</th><th>Item</th><th class="num">ilvl</th></tr></thead><tbody>${body}</tbody></table>`;
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
export function buildReportHtml(entry, { icons = null, consumableLabels = null, appUrl = 'https://github.com/balovich-matje/localbots' } = {}) {
  const r = entry.result ?? {};
  const p = r.player ?? {};
  const when = new Date(entry.savedAt ?? Date.now());
  const title = `${p.name ?? 'Sim'} — ${entry.modeLabel ?? 'Localbots'}`;

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
  .bar { display:flex; align-items:center; gap:9px; }
  .bar-track { flex:1; height:7px; background:var(--panel2); border-radius:4px; overflow:hidden; }
  .bar-fill { height:100%; background:var(--bar); }
  .bar-label { font-variant-numeric:tabular-nums; font-size:12px; color:var(--muted); min-width:56px; text-align:right; }
  .tag { display:inline-block; font-size:11px; color:var(--accent); border:1px solid var(--accent);
         border-radius:10px; padding:0 6px; margin-left:5px; white-space:nowrap; }
  .tag.muted-tag { color:var(--muted); border-color:var(--border); }
  .scroll { overflow-x:auto; }
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

  <div class="scroll">${comparisonTable(r.topgear, icons)}</div>
  ${abilityTable(r.abilities, p.name)}
  ${buffTable(r.buffs)}
  ${consumableList(r.consumables, consumableLabels)}
  ${gearTable(r.equipped, icons)}

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
