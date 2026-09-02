// Downloads wago.tools DB2 exports (the live game client's own database),
// caches them in data/cache/, and builds the season loot database:
// every source (raid boss / M+ dungeon / world boss / outdoor event) and
// every equippable item it drops.
//
// wago.tools updates per game build — downloads happen only on demand
// ("Refresh data" in the UI) or when the cache is empty.

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.js';
import { loadDropLevels } from './dropLevels.js';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache');
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const LOOT_DB = join(CACHE_DIR, 'lootdb.json');

const CURRENT_SEASON_TIER = 505; // JournalTier "Current Season" — stable across seasons
const CRAFT_EXPANSION = 11; // ItemSparse.ExpansionID for Midnight — bump each expansion
const CURRENT_MAP_EXPANSION = 11; // Map.ExpansionID for Midnight — bump with CRAFT_EXPANSION
const LOOT_DB_VERSION = 8; // bump to force a rebuild when the db shape changes
// ItemLimitCategory ids marking inherently-embellished crafted designs
const EMBELLISHED_LIMIT_CATEGORIES = new Set([512, 697]);

// table -> columns we keep (null = all)
const TABLES = {
  JournalTierXInstance: ['JournalTierID', 'JournalInstanceID', 'OrderIndex', 'AvailabilityCondition'],
  JournalInstance: ['ID', 'Name_lang', 'MapID', 'Flags'],
  JournalEncounter: ['ID', 'Name_lang', 'JournalInstanceID', 'OrderIndex', 'DifficultyMask', 'DungeonEncounterID'],
  JournalEncounterItem: ['ID', 'JournalEncounterID', 'ItemID', 'DifficultyMask', 'Flags', 'WorldStateExpressionID'],
  MythicPlusSeasonTrackedMap: ['MapChallengeModeID', 'DisplaySeasonID'],
  MapChallengeMode: ['ID', 'Name_lang', 'MapID'],
  Map: ['ID', 'InstanceType', 'ExpansionID'],
  ItemSet: null, // small table; need all ItemID_N columns
  Item: ['ID', 'ClassID', 'SubclassID', 'InventoryType', 'IconFileDataID'],
  ItemSparse: [
    'ID', 'Display_lang', 'ItemLevel', 'AllowableClass', 'InventoryType', 'OverallQualityID', 'ExpansionID',
    'LimitCategory', 'Flags_0',
    'StatModifier_bonusStat_0', 'StatModifier_bonusStat_1', 'StatModifier_bonusStat_2',
    'StatModifier_bonusStat_3', 'StatModifier_bonusStat_4', 'StatModifier_bonusStat_5',
    // stat allocation budget + weapon fields, for item tooltips
    'StatPercentEditor_0', 'StatPercentEditor_1', 'StatPercentEditor_2',
    'StatPercentEditor_3', 'StatPercentEditor_4', 'StatPercentEditor_5',
    'ItemDelay', 'DmgVariance', 'QualityModifier',
    'SocketType_0', 'SocketType_1', 'SocketType_2',
  ],
  CraftingData: ['ID', 'CraftedItemID'],
  // Item icons: modern items leave Item.IconFileDataID at 0 and carry their icon
  // on the appearance instead, so both are needed to cover everything.
  ItemAppearance: ['ID', 'DefaultIconFileDataID'],
  ItemModifiedAppearance: ['ItemID', 'ItemAppearanceID', 'OrderIndex'],
  // Stat budget per item level — the basis of tooltip stat values.
  RandPropPoints: null,
  // Weapon damage and armour, for the rest of the tooltip.
  ItemDamageOneHand: ['ItemLevel', 'Quality_4'],
  ItemDamageTwoHand: ['ItemLevel', 'Quality_4'],
  ItemArmorTotal: ['ItemLevel', 'Cloth', 'Leather', 'Mail', 'Plate'],
  ArmorLocation: ['ID', 'Clothmodifier', 'Leathermodifier', 'Chainmodifier', 'Platemodifier', 'Modifier'],
  // set bonuses: which spell each piece-count threshold grants
  ItemSetSpell: ['ID', 'ChrSpecID', 'SpellID', 'Threshold', 'ItemSetID'],
  // Per-item drop item levels (see dropLevels.js): how far into an instance a
  // boss sits, and which upgrade-track step its loot therefore lands on.
  DungeonEncounter: ['ID', 'ItemSequenceLevel'],
  ItemXBonusTree: ['ItemBonusTreeID', 'ItemID'],
  ItemBonusTreeNode: ['ItemContext', 'ChildItemBonusTreeID', 'ChildItemBonusListGroupID',
    'MinMythicPlusLevel', 'MaxMythicPlusLevel', 'ParentItemBonusTreeID'],
  ItemBonusListGroupEntry: ['ItemBonusListGroupID', 'ItemBonusListID', 'SequenceValue'],
  // An enchant_id's real name ("Enchant Chest - Mark of the Worldsoul") --
  // simc's own tuning data has no such name, hence the raw id shown until
  // this table exists in the cache.
  SpellItemEnchantment: ['ID', 'Name_lang'],
};

// Tables added after the first release: an older cache without them still
// counts as present (the features they power just stay off until a refresh).
const OPTIONAL_TABLES = new Set([
  'CraftingData', 'ItemAppearance', 'ItemModifiedAppearance',
  'RandPropPoints', 'ItemDamageOneHand', 'ItemDamageTwoHand', 'ItemArmorTotal', 'ArmorLocation',
  'ItemSetSpell',
  'DungeonEncounter', 'ItemXBonusTree', 'ItemBonusTreeNode', 'ItemBonusListGroupEntry',
  'SpellItemEnchantment',
]);

// wago.tools' locale codes for the game-data text (item/set/instance names)
// baked into the cached CSVs -- 'en' (the default, no param) needs no entry.
export const WAGO_LOCALES = { es: 'esMX' };

// Per-patch file locations. The live patch in English keeps the original flat
// layout (no migration for existing installs); a PTR patch and/or a non-English
// locale each get their own subdirectory, so switching the language never
// touches or invalidates the English cache.
export function patchPaths(patchId = 'live', delveFile = null, locale = 'en') {
  const localeSeg = locale && locale !== 'en' ? [locale] : [];
  const cacheDir = patchId === 'live' && !localeSeg.length
    ? CACHE_DIR : join(CACHE_DIR, ...(patchId === 'live' ? [] : [patchId]), ...localeSeg);
  return {
    cacheDir,
    lootDbPath: patchId === 'live' && !localeSeg.length ? LOOT_DB : join(cacheDir, 'lootdb.json'),
    delvePath: join(DATA_DIR, delveFile ?? (patchId === 'live' ? 'delve-loot.json' : `delve-loot-${patchId}.json`)),
    probeCachePath: join(cacheDir, 'simc-known-items.json'),
  };
}

// opts.build pins the exact game build wago serves (never trust wago's
// default — it sometimes points at a test build); opts.cacheDir selects the
// patch; opts.bonusesChannel picks Raidbots' live vs ptr bonus map; opts.locale
// ('en' by default) picks which language the item/set/instance names come back
// in -- everything else about a table (ids, stats, item levels) is
// locale-independent, so only the *_lang columns actually change.
export async function downloadTables(onProgress = () => {}, opts = {}) {
  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  const buildParam = opts.build ? `build=${encodeURIComponent(opts.build)}` : '';
  const wagoLocale = WAGO_LOCALES[opts.locale];
  const localeParam = wagoLocale ? `locale=${wagoLocale}` : '';
  const query = [buildParam, localeParam].filter(Boolean).join('&');
  mkdirSync(cacheDir, { recursive: true });
  const names = Object.keys(TABLES);
  for (const [i, table] of names.entries()) {
    onProgress({ table, index: i + 1, total: names.length });
    const resp = await fetch(`https://wago.tools/db2/${table}/csv${query ? `?${query}` : ''}`, {
      headers: { 'User-Agent': 'localbots (github.com/balovich-matje/localbots)' },
    });
    if (!resp.ok) throw new Error(`wago.tools ${table}: HTTP ${resp.status}`);
    writeFileSync(join(cacheDir, `${table}.csv`), await resp.text());
  }
  // Raidbots' public bonus-id map: the community-standard decode of upgrade
  // tracks ("Hero 6/6"), sockets etc. Static file, cached like the CSVs.
  onProgress({ table: 'bonuses.json (raidbots)', index: names.length, total: names.length });
  const channel = opts.bonusesChannel === 'ptr' ? 'ptr' : 'live';
  const resp = await fetch(`https://www.raidbots.com/static/data/${channel}/bonuses.json`, {
    headers: { 'User-Agent': 'localbots (github.com/balovich-matje/localbots)' },
  });
  if (resp.ok) writeFileSync(join(cacheDir, 'bonuses.json'), await resp.text());
  // Record which game build these tables came from — cacheStatus compares it
  // against the build the local simc expects, so a cache downloaded from the
  // wrong build (e.g. wago's default while it pointed at a test build) is
  // flagged for a re-download instead of silently served.
  writeFileSync(join(cacheDir, 'meta.json'),
    JSON.stringify({ build: opts.build ?? null, downloadedAt: Date.now() }));
}

// bonus ids that grant a prismatic socket — an equipped line carrying one
// without a gem_id means an EMPTY socket (free DPS via the gem comparison)
export function loadSocketBonusIds(cacheDir = CACHE_DIR) {
  const path = join(cacheDir, 'bonuses.json');
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return new Set(Object.values(raw).filter((e) => e?.socket).map((e) => Number(e.id)));
  } catch {
    return new Set();
  }
}

// bonus id -> { track, level, max, ilvl } for upgrade-track bonuses
export function loadBonusUpgradeMap(cacheDir = CACHE_DIR) {
  const path = join(cacheDir, 'bonuses.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const map = new Map();
    for (const entry of Object.values(raw)) {
      const u = entry?.upgrade;
      if (u?.name && u.level && u.max) {
        map.set(Number(entry.id), {
          track: u.name, level: u.level, max: u.max, ilvl: u.itemLevel ?? null,
          seasonId: u.seasonId ?? null, // used to reject last season's tracks
        });
      }
    }
    return map;
  } catch {
    return null;
  }
}

export function cacheStatus(cacheDir = CACHE_DIR, expectedBuild = null) {
  const missing = Object.keys(TABLES)
    .filter((t) => !OPTIONAL_TABLES.has(t))
    .filter((t) => !existsSync(join(cacheDir, `${t}.csv`)));
  if (missing.length === Object.keys(TABLES).length - OPTIONAL_TABLES.size) return { present: false };
  const missingOptional = [...OPTIONAL_TABLES]
    .filter((t) => !existsSync(join(cacheDir, `${t}.csv`)));
  let cachedBuild = null;
  try {
    cachedBuild = JSON.parse(readFileSync(join(cacheDir, 'meta.json'), 'utf8')).build ?? null;
  } catch { /* pre-marker cache — treated as unknown build */ }
  // A cache from the wrong (or unknown) game build must be re-downloaded:
  // wago's default build sometimes points at a test build, and serving those
  // tables as "live" quietly corrupts the loot database.
  const buildMismatch = expectedBuild !== null && cachedBuild !== expectedBuild;
  let oldest = null;
  for (const t of Object.keys(TABLES)) {
    const p = join(cacheDir, `${t}.csv`);
    if (existsSync(p)) {
      const m = statSync(p).mtimeMs;
      if (oldest === null || m < oldest) oldest = m;
    }
  }
  return {
    present: missing.length === 0,
    // complete = every table incl. optional ones AND the right game build; a
    // silent startup rebuild is only safe then — otherwise the UI prompts
    complete: missing.length === 0 && missingOptional.length === 0 && !buildMismatch,
    missing,
    missingOptional,
    cachedBuild,
    buildMismatch,
    downloadedAt: oldest,
  };
}

function loadTable(name, cacheDir = CACHE_DIR) {
  return parseCsv(readFileSync(join(cacheDir, `${name}.csv`), 'utf8'), TABLES[name]);
}

// WoW's inline markup in a *_lang string -- |A:atlas:w:h|a (an icon),
// |cAARRGGBB...|r (a color run), |T...|t (a texture) -- none of which mean
// anything outside the game client, so strip it down to the plain text.
function stripWowMarkup(s) {
  return String(s ?? '')
    .replace(/\|[Aa]:[^|]*\|a/g, '')
    .replace(/\|[Tt][^|]*\|t/g, '')
    .replace(/\|c[0-9a-fA-F]{8}/g, '')
    .replace(/\|r/g, '')
    .trim();
}

// enchant_id -> its real name ("Enchant Chest - Mark of the Worldsoul"),
// straight from the game client's own SpellItemEnchantment table -- simc's
// tuning data has no such name, so without this the UI can only show the raw
// id. There is no per-enchant icon to go with it: SpellItemEnchantment's own
// IconFileDataID is 0 on every row (verified against the current cache), and
// Raidbots' Top Gear report -- the reference for this UI -- draws from the
// same emptiness, which is why every enchant there shares one fixed generic
// scroll icon rather than a distinct one each; callers do the same (see
// ENCHANT_ICON_URL in report.js and app.js). Optional table: missing (not
// yet refreshed) just means an empty map, and callers fall back to the id.
export function loadEnchantNames(cacheDir = CACHE_DIR) {
  const path = join(cacheDir, 'SpellItemEnchantment.csv');
  if (!existsSync(path)) return new Map();
  const rows = parseCsv(readFileSync(path, 'utf8'), TABLES.SpellItemEnchantment);
  return new Map(rows.map((r) => [Number(r.ID), stripWowMarkup(r.Name_lang)]).filter(([, name]) => name));
}

// Build (and persist) the joined loot database from the cached CSVs.
// Raids / world bosses / outdoor events come from the "Current Season"
// journal tier. The live M+ dungeon pool rotates out of the DB2 tables,
// so it is named explicitly in data/season.json (mythicPlusDungeons).
export function buildLootDb(mplusDungeonNames = [], paths = {}) {
  const cacheDir = paths.cacheDir ?? CACHE_DIR;
  const lootDbPath = paths.lootDbPath ?? LOOT_DB;
  const delvePath = paths.delvePath ?? join(DATA_DIR, 'delve-loot.json');
  const allTierRows = loadTable('JournalTierXInstance', cacheDir)
    .filter((r) => Number(r.JournalTierID) === CURRENT_SEASON_TIER);
  const instances = loadTable('JournalInstance', cacheDir);
  const encounters = loadTable('JournalEncounter', cacheDir);
  const jei = loadTable('JournalEncounterItem', cacheDir);
  const mapRows = loadTable('Map', cacheDir);
  // Map.InstanceType is the game's own raid/dungeon marker (2 = raid, 1 = dungeon)
  const instanceTypeByMap = new Map(mapRows.map((r) => [r.ID, Number(r.InstanceType)]));
  const expansionByMap = new Map(mapRows.map((r) => [r.ID, Number(r.ExpansionID)]));

  const instById = new Map(instances.map((r) => [r.ID, r]));

  // The "Current Season" tier keeps PAST seasons' rows too — last expansion's
  // content and, after a content patch, the previous season of this one. They
  // are separated only by AvailabilityCondition, a gate the client evaluates
  // and we can't read. The season's M+ pool is the anchor: whichever condition
  // group holds this season's keystone dungeons is the live group. A patch
  // that adds raids in a newer group than the dungeons is covered by also
  // taking the highest-numbered group that has current-expansion content.
  const mplusNames = new Set(mplusDungeonNames);
  const condOfInstance = (t) => t.AvailabilityCondition ?? '0';
  const currentGroups = new Set(['0']); // ungated rows are evergreen
  let newestCurrent = null;
  for (const t of allTierRows) {
    const inst = instById.get(t.JournalInstanceID);
    if (!inst) continue;
    const cond = condOfInstance(t);
    if (mplusNames.has(inst.Name_lang)) currentGroups.add(cond);
    if (expansionByMap.get(inst.MapID) === CURRENT_MAP_EXPANSION
        && (newestCurrent === null || Number(cond) > Number(newestCurrent))) {
      newestCurrent = cond;
    }
  }
  if (newestCurrent !== null) currentGroups.add(newestCurrent);
  const txi = allTierRows.filter((t) => currentGroups.has(condOfInstance(t)));
  const encByInstance = new Map();
  for (const e of encounters) {
    if (!encByInstance.has(e.JournalInstanceID)) encByInstance.set(e.JournalInstanceID, []);
    encByInstance.get(e.JournalInstanceID).push(e);
  }
  const itemsByEncounter = new Map();
  for (const r of jei) {
    if (!itemsByEncounter.has(r.JournalEncounterID)) itemsByEncounter.set(r.JournalEncounterID, []);
    itemsByEncounter.get(r.JournalEncounterID).push(r);
  }

  // M+ pool: resolve configured names to journal instances (newest wins on
  // name collisions — remakes like Magisters' Terrace reuse the name).
  const dungeonInstances = [];
  for (const name of mplusDungeonNames) {
    const matches = instances.filter((r) => r.Name_lang === name);
    if (!matches.length) continue;
    matches.sort((a, b) => Number(b.ID) - Number(a.ID));
    dungeonInstances.push(matches[0]);
  }

  // Legacy dungeons keep their historical loot rows in the journal. Two
  // filters recover the CURRENT drop table (matches the in-game journal):
  //  1. the difficulty mask must include a DUNGEON difficulty. Returning
  //     dungeons keep their original loot rows (which drop again, scaled to
  //     the current season — we override ilevel anyway), and those rows are
  //     tagged Normal/Heroic rather than Mythic, so requiring the Mythic bits
  //     would throw away most of a returning dungeon's table.
  //  2. when rows are gated by WorldStateExpression (Blizzard's "which era
  //     of this dungeon is active" switch), keep only the current group —
  //     identified as the one containing current-expansion item ids. This is
  //     the filter that actually removes a revamped dungeon's dead loot.
  const DUNGEON_BITS = (1 << 0) | (1 << 1) | (1 << 7) | (1 << 22); // Normal, Heroic, M+, Mythic
  const CURRENT_ITEM_ID = 240000;
  const filterDungeonRows = (instId) => {
    const encIds = (encByInstance.get(instId) ?? []).map((e) => e.ID);
    const rows = encIds.flatMap((id) => itemsByEncounter.get(id) ?? []);
    const wseGroups = new Set(rows.map((r) => r.WorldStateExpressionID).filter((w) => w !== '0'));
    let currentWse = null;
    if (wseGroups.size > 1) {
      // the group holding newly-minted items is the live one; tie-break newest
      const candidates = [...wseGroups].filter((w) =>
        rows.some((r) => r.WorldStateExpressionID === w && Number(r.ItemID) >= CURRENT_ITEM_ID));
      currentWse = (candidates.length ? candidates : [...wseGroups])
        .sort((a, b) => Number(b) - Number(a))[0];
    }
    const keep = new Set();
    for (const r of rows) {
      const mask = Number(r.DifficultyMask);
      if (mask !== -1 && mask !== 0 && !(mask & DUNGEON_BITS)) continue;
      if (currentWse !== null && r.WorldStateExpressionID !== '0' && r.WorldStateExpressionID !== currentWse) continue;
      keep.add(r.ID);
    }
    return keep;
  };

  const picked = []; // { inst, bosses, kind, keepRows }
  const addInstance = (inst, kind) => {
    const bosses = (encByInstance.get(inst.ID) ?? [])
      .sort((a, b) => Number(a.OrderIndex) - Number(b.OrderIndex));
    if (!bosses.some((b) => (itemsByEncounter.get(b.ID) ?? []).length > 0)) return;
    const keepRows = kind === 'dungeon' ? filterDungeonRows(inst.ID) : null;
    picked.push({ inst, bosses, kind, keepRows });
  };

  for (const t of txi) {
    const inst = instById.get(t.JournalInstanceID);
    if (!inst) continue;
    const kind = Number(inst.Flags) & 2 ? 'worldboss'
      : instanceTypeByMap.get(inst.MapID) === 2 ? 'raid'
      : null; // tier dungeons not in the configured M+ pool are future content — skip
    if (kind) addInstance(inst, kind);
  }
  for (const inst of dungeonInstances) addInstance(inst, 'dungeon');

  // curated delve pool (server-side loot; see data/delve-loot.json —
  // per-patch file, optional: a patch without one just has no delve source)
  let delveEntries = [];
  try {
    delveEntries = JSON.parse(readFileSync(delvePath, 'utf8')).items ?? [];
  } catch { /* optional */ }
  const delveIds = new Set(delveEntries.filter((e) => e.id).map((e) => String(e.id)));
  const delveNames = new Set(delveEntries.filter((e) => e.name).map((e) => e.name));

  const wantedItemIds = new Set(delveIds);
  for (const { bosses, keepRows } of picked) {
    for (const b of bosses) {
      for (const r of itemsByEncounter.get(b.ID) ?? []) {
        if (keepRows && !keepRows.has(r.ID)) continue;
        wantedItemIds.add(r.ItemID);
      }
    }
  }

  // Profession-crafted gear with selectable secondary stats: the two
  // placeholder codes 24 & 25 in the stat slots mark the player-choice
  // slots, and CraftingData.CraftedItemID confirms it's an actual craft.
  const craftedRecipeIds = new Set();
  const craftingPath = join(cacheDir, 'CraftingData.csv');
  if (existsSync(craftingPath)) {
    for (const r of parseCsv(readFileSync(craftingPath, 'utf8'), TABLES.CraftingData)) {
      craftedRecipeIds.add(r.CraftedItemID);
    }
  }
  const hasSelectableStats = (r) => {
    let has24 = false, has25 = false;
    for (let i = 0; i < 6; i++) {
      const v = Number(r[`StatModifier_bonusStat_${i}`]);
      if (v === 24) has24 = true;
      if (v === 25) has25 = true;
    }
    return has24 && has25;
  };

  // Resolve delve names to the best item version (some names have old or
  // low-quality doppelgangers): highest quality wins, then newest id.
  const nameCandidates = new Map();
  const sparse = new Map();
  const craftedIds = [];
  for (const r of loadTable('ItemSparse', cacheDir)) {
    if (wantedItemIds.has(r.ID)) sparse.set(r.ID, r);
    if (craftedRecipeIds.has(r.ID) && Number(r.ExpansionID) === CRAFT_EXPANSION && hasSelectableStats(r)) {
      craftedIds.push(r.ID);
      sparse.set(r.ID, r);
    }
    if (delveNames.has(r.Display_lang)) {
      const prev = nameCandidates.get(r.Display_lang);
      const better = !prev
        || Number(r.OverallQualityID) > Number(prev.OverallQualityID)
        || (Number(r.OverallQualityID) === Number(prev.OverallQualityID) && Number(r.ID) > Number(prev.ID));
      if (better) nameCandidates.set(r.Display_lang, r);
    }
  }
  for (const r of nameCandidates.values()) {
    wantedItemIds.add(r.ID);
    sparse.set(r.ID, r);
    delveIds.add(r.ID);
  }
  for (const id of craftedIds) wantedItemIds.add(id);
  const itemMeta = new Map();
  for (const r of loadTable('Item', cacheDir)) if (wantedItemIds.has(r.ID)) itemMeta.set(r.ID, r);

  // Raid drops climb through the instance, so each boss's items carry their
  // own per-difficulty item level (see dropLevels.js). Absent tables just mean
  // the droptimizer keeps using season.json's one-level-per-difficulty table.
  const dropLevels = loadDropLevels(cacheDir);
  const sequenceByEncounter = new Map();
  if (dropLevels && existsSync(join(cacheDir, 'DungeonEncounter.csv'))) {
    for (const r of loadTable('DungeonEncounter', cacheDir)) {
      sequenceByEncounter.set(r.ID, Number(r.ItemSequenceLevel));
    }
  }

  const sources = [];
  for (const { inst, bosses, kind, keepRows } of picked) {
    const bossEntries = bosses.map((b, order) => {
      const seen = new Set();
      const sequence = kind === 'raid' ? sequenceByEncounter.get(b.DungeonEncounterID) : undefined;
      const withDrops = (item) => {
        if (!item || sequence === undefined) return item;
        const drops = dropLevels.dropsFor(item.id, sequence);
        return drops ? { ...item, drops } : item;
      };
      return {
        id: b.ID,
        name: b.Name_lang,
        order,
        ...(sequence === undefined ? {} : { sequence }),
        items: (itemsByEncounter.get(b.ID) ?? [])
          .filter((r) => !keepRows || keepRows.has(r.ID))
          .filter((r) => (seen.has(r.ItemID) ? false : (seen.add(r.ItemID), true)))
          .map((r) => withDrops(shapeItem(r.ItemID, sparse, itemMeta)))
          .filter(Boolean),
      };
    }).filter((b) => b.items.length > 0);

    if (bossEntries.length) {
      sources.push({
        instanceId: inst.ID,
        name: inst.Name_lang,
        kind,
        bosses: bossEntries,
      });
    }
  }

  // Curated pool entries are trusted even when the base item record is
  // low quality (epic quality often comes from server-side bonuses).
  const delveItems = [...delveIds]
    .map((id) => shapeItem(id, sparse, itemMeta))
    .filter(Boolean)
    .map((it) => ({ ...it, curated: true }));
  if (delveItems.length) {
    sources.push({
      instanceId: 'delves',
      name: 'Delves',
      kind: 'delves',
      bosses: [{ id: 'delve-pool', name: 'Bountiful loot pool', order: 0, items: delveItems }],
    });
  }

  // Craftable gear pool (one source; the stat pair is chosen at sim time)
  const craftedItems = craftedIds
    .map((id) => shapeItem(id, sparse, itemMeta))
    .filter(Boolean);
  if (craftedItems.length) {
    sources.push({
      instanceId: 'crafted',
      name: 'Crafted gear',
      kind: 'crafted',
      bosses: [{ id: 'crafted-pool', name: 'Profession crafts', order: 0, items: craftedItems }],
    });
  }

  const db = { builtAt: Date.now(), version: LOOT_DB_VERSION, sources };
  writeFileSync(lootDbPath, JSON.stringify(db));
  return db;
}

// Only keep equippable gear (armor/weapons), drop quest items, tokens, recipes.
function shapeItem(itemId, sparse, itemMeta) {
  const s = sparse.get(itemId);
  const m = itemMeta.get(itemId);
  if (!s || !m) return null;
  const invType = Number(s.InventoryType);
  if (!invType || invType === 18 || invType === 24 || invType === 27 || invType === 28) return null; // bags, ammo, quivers
  const classId = Number(m.ClassID);
  if (classId !== 2 && classId !== 4) return null; // weapons + armor only
  const stats = [];
  for (let i = 0; i < 6; i++) {
    const v = Number(s[`StatModifier_bonusStat_${i}`]);
    if (v > 0) stats.push(v);
  }
  // sockets the item is born with — most modern gear has none and gets them
  // from a socket bonus instead (see the droptimizer's gem carry-over)
  let sockets = 0;
  for (let i = 0; i < 3; i++) if (Number(s[`SocketType_${i}`]) > 0) sockets++;
  return {
    id: Number(itemId),
    name: s.Display_lang,
    invType,
    quality: Number(s.OverallQualityID),
    allowableClass: Number(s.AllowableClass),
    classId,
    subclassId: Number(m.SubclassID),
    stats,
    icon: Number(m.IconFileDataID) || null,
    ...(sockets ? { sockets } : {}),
    // inherently-embellished crafted designs (effect baked into the item)
    ...(EMBELLISHED_LIMIT_CATEGORIES.has(Number(s.LimitCategory)) ? { embellished: true } : {}),
    // ITEM_FLAG_UNIQUE_EQUIPPED (0x80000): the character may wear only one.
    // Without this a droptimizer happily suggests a second copy for the other
    // trinket/ring slot, which cannot be equipped.
    ...(Number(s.Flags_0) & 0x80000 ? { uniqueEquipped: true } : {}),
  };
}

// Item-set membership from the game's ItemSet table:
// { byItem: Map(itemId -> setId), sets: Map(setId -> { name, items: [ids] }) }
export function loadItemSetMap(cacheDir = CACHE_DIR) {
  const path = join(cacheDir, 'ItemSet.csv');
  if (!existsSync(path)) return null;
  const byItem = new Map();
  const sets = new Map();
  for (const r of parseCsv(readFileSync(path, 'utf8'))) {
    const items = [];
    for (let i = 0; i <= 16; i++) {
      const id = Number(r[`ItemID_${i}`]);
      if (id > 0) items.push(id);
    }
    if (items.length < 2) continue;
    const setId = Number(r.ID);
    sets.set(setId, { name: r.Name_lang, items, bonuses: [] });
    for (const id of items) byItem.set(id, setId);
  }
  // attach each set's piece-count bonuses, lowest threshold first
  const spellPath = join(cacheDir, 'ItemSetSpell.csv');
  if (existsSync(spellPath)) {
    for (const r of parseCsv(readFileSync(spellPath, 'utf8'), ['SpellID', 'Threshold', 'ItemSetID'])) {
      const set = sets.get(Number(r.ItemSetID));
      if (!set) continue;
      set.bonuses.push({ threshold: Number(r.Threshold), spellId: Number(r.SpellID) });
    }
    for (const set of sets.values()) set.bonuses.sort((a, b) => a.threshold - b.threshold);
  }
  return { byItem, sets };
}

export function loadLootDb(lootDbPath = LOOT_DB) {
  if (!existsSync(lootDbPath)) return null;
  try {
    const db = JSON.parse(readFileSync(lootDbPath, 'utf8'));
    // an older db shape forces a rebuild from the cached CSVs at startup
    if (db.version !== LOOT_DB_VERSION) return null;
    return db;
  } catch {
    return null;
  }
}
