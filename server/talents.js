// Talent-loadout comparison: the /simc addon export carries the active build
// as a bare `talents=` line plus every saved loadout as a comment pair:
//   # Saved Loadout: <name>
//   # talents=<string>
// Each saved loadout becomes one profileset overriding talents= against the
// active build (the baseline). simc decodes/validates the strings itself, so
// no talent data tables are needed. omnium_talents stays with the baseline on
// purpose — in game, switching loadouts does not touch the Omnium Folio.

export function parseLoadouts(profileText) {
  const active = profileText.match(/^\s*talents\s*=\s*(\S+)/m)?.[1] ?? null;
  const lines = profileText.split('\n');
  const loadouts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*#\s*Saved Loadout:\s*(.+?)\s*$/);
    if (!m) continue;
    const t = lines[i + 1]?.match(/^\s*#\s*talents\s*=\s*(\S+)/);
    if (t) loadouts.push({ name: m[1], talents: t[1], isActive: t[1] === active });
  }
  return { active, loadouts };
}

const clean = (s) => String(s).replace(/["\r\n]/g, "'").replace(/[$\\]/g, ' ');

// One profileset per saved loadout. selection (array of names) narrows which
// loadouts get simmed; null means all. `custom` adds hand-added builds (pasted
// talent strings) alongside the export's own. Group ids 10000+ sit above every
// other variant family (items 0+, consumables 5000+, enchants/gems/folio/upgrades).
export function buildLoadoutVariants(profileText, selection = null, custom = [], startGroup = 10000) {
  const { loadouts } = parseLoadouts(profileText);
  const extra = (Array.isArray(custom) ? custom : [])
    .filter((c) => c && typeof c.name === 'string' && /^[A-Za-z0-9+/]+$/.test(String(c.talents ?? '')))
    .map((c) => ({ name: c.name, talents: c.talents, isActive: false }));
  // names arrive from JSON — force strings so a loadout named "2" still matches
  const wanted = Array.isArray(selection) ? new Set(selection.map(String)) : null;
  const lines = [];
  const sets = {};
  let group = startGroup;
  for (const lo of [...loadouts, ...extra]) {
    if (lo.isActive) continue; // identical to the baseline — nothing to compare
    if (wanted && !wanted.has(lo.name)) continue;
    const label = lo.name.replace(/^Class Codex:\s*/, '');
    // truncate the label only, so the [tN] uniquifier always survives
    const name = `${clean(label).slice(0, 60)} [t${++group}]`;
    lines.push(`profileset."${name}"=talents=${lo.talents}`);
    sets[name] = {
      group,
      itemName: label,
      ilvl: null,
      slot: 'talents',
      placement: 'loadout',
      section: 'Talent loadouts',
      boss: 'Loadouts',
      sourceKind: 'talents',
    };
  }
  return { lines, sets };
}
