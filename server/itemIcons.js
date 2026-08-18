// Item icon ids, resolved entirely from the game tables we already download —
// no API key and no third-party image host.
//
// Two sources are needed. Item.IconFileDataID covers things that are not
// transmoggable (rings, necks, trinkets), but modern gear leaves it at 0 and
// keeps its icon on the appearance record instead, so ItemModifiedAppearance ->
// ItemAppearance.DefaultIconFileDataID fills the rest. Together they cover the
// whole season's loot.
//
// The number is a file id on Blizzard's render CDN:
//   https://render.worldofwarcraft.com/<region>/icons/56/<id>.jpg

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv.js';

const FILE = 'icons.json';

export function buildIconMap(cacheDir) {
  const itemPath = join(cacheDir, 'Item.csv');
  if (!existsSync(itemPath)) return null;

  const icons = new Map();
  for (const r of parseCsv(readFileSync(itemPath, 'utf8'), ['ID', 'IconFileDataID'])) {
    const f = Number(r.IconFileDataID);
    if (f) icons.set(Number(r.ID), f);
  }

  const imaPath = join(cacheDir, 'ItemModifiedAppearance.csv');
  const iaPath = join(cacheDir, 'ItemAppearance.csv');
  if (existsSync(imaPath) && existsSync(iaPath)) {
    const byAppearance = new Map();
    for (const r of parseCsv(readFileSync(iaPath, 'utf8'), ['ID', 'DefaultIconFileDataID'])) {
      const f = Number(r.DefaultIconFileDataID);
      if (f) byAppearance.set(Number(r.ID), f);
    }
    // an item can have several appearances; OrderIndex 0 is the base one
    const best = new Map();
    for (const r of parseCsv(readFileSync(imaPath, 'utf8'), ['ItemID', 'ItemAppearanceID', 'OrderIndex'])) {
      const id = Number(r.ItemID);
      const order = Number(r.OrderIndex);
      const cur = best.get(id);
      if (!cur || order < cur.order) best.set(id, { order, appearance: Number(r.ItemAppearanceID) });
    }
    for (const [id, { appearance }] of best) {
      if (icons.has(id)) continue; // the direct icon wins — it is the item's own
      const f = byAppearance.get(appearance);
      if (f) icons.set(id, f);
    }
  }

  const out = {};
  for (const [id, f] of icons) out[id] = f;
  writeFileSync(join(cacheDir, FILE), JSON.stringify(out));
  return icons;
}

export function loadIconMap(cacheDir) {
  const path = join(cacheDir, FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const m = new Map();
    for (const [id, f] of Object.entries(raw)) m.set(Number(id), f);
    return m;
  } catch {
    return null;
  }
}
