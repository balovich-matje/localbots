import express from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInput, buildStatWeightsInput, buildTopGearInput, buildConsumableVariants, detectSpec } from './profileBuilder.js';
import { buildEnchantVariants, buildGemVariants, buildDiamondVariants, buildFolioVariants, buildTrackUpgradeVariants, trackFor } from './enhancements.js';
import { resolveEquipped, clearResolveCache } from './equippedResolver.js';
import { SimQueue, findSimc, simcVersion } from './simRunner.js';
import { parseGear, GEAR_SLOTS } from './gearParser.js';
import { loadLootDb, buildLootDb, downloadTables, cacheStatus, loadItemSetMap, loadBonusUpgradeMap, loadSocketBonusIds, loadEnchantNames, patchPaths } from './wagoData.js';
import { buildSourceTree, buildDroptimizerInput, tierSetSummary, weaponSetup, seasonConfig as fullSeasonConfig } from './droptimizer.js';
import { probeKnownItems, loadProbeCache } from './simcProbe.js';
import { CLASS_IDS, INV_SLOTS } from './lootFilter.js';
import { saveHistoryEntry, listHistory, getHistoryEntry, deleteHistoryEntry } from './history.js';
import { buildReportHtml, reportFilename } from './report.js';
import { updateStatus } from './status.js';
import { parseLoadouts, buildLoadoutVariants } from './talents.js';
import { loadTraitData, decodeTalents, talentLayout, clearTraitCache } from './talentData.js';
import { loadSetBonusNames, loadCatalystSets } from './setBonus.js';
import { detectSimcSource, startSimcUpdate } from './simcUpdater.js';
import { invalidateStatus } from './status.js';
import { fetchCharacter, buildProfile as buildArmoryProfile } from './armory.js';
import { buildIconMap, loadIconMap } from './itemIcons.js';
import { loadScaling, loadItemTables, itemStats, effectContext, clearScalingCache } from './itemStats.js';
import { loadEffectData, itemEffects, renderSpell, clearEffectCache } from './itemEffects.js';
import { crestPlan, achievementProgress } from './crests.js';

// Optional local secrets (Blizzard API credentials for the Armory tab). The
// file is gitignored; nothing here is required for Localbots to run.
try { process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '..', '.env')); } catch { /* no .env, or a Node without loadEnvFile */ }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4747;

const simcPath = findSimc();
if (!simcPath) {
  console.error(
    '\n  Could not find the simc executable.\n' +
    '  Install SimulationCraft (see README) and either put simc on your PATH\n' +
    '  or set the SIMC_PATH environment variable to the full path of the binary.\n'
  );
  process.exit(1);
}
let version = simcVersion(simcPath);
const queue = new SimQueue(simcPath);
// from-source installs (macOS/Linux README recipe) can update simc in place
const simcSource = detectSimcSource(simcPath);
const simcUpdateState = { running: false, step: null, progress: null, error: null, log: [] };

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(ROOT, 'public')));

// On a shared server (the Docker image sets this to 0) the in-page shutdown
// button is disabled — otherwise any visitor could stop everyone's sims.
const ALLOW_SHUTDOWN = process.env.LOCALBOTS_ALLOW_SHUTDOWN !== '0';

app.get('/api/health', (req, res) => {
  res.json({ ok: true, simcPath, simcVersion: version, allowShutdown: ALLOW_SHUTDOWN });
});

// Header status bar: is the repo behind GitHub / is simc behind the live game?
app.get('/api/status', async (req, res) => {
  const s = await updateStatus(version);
  res.json({ ...s, simc: { ...s.simc, updatable: !!simcSource }, allowShutdown: ALLOW_SHUTDOWN });
});

// One-click simc update (only for from-source installs). Runs in the
// background; the UI polls /api/simc/update/status for progress.
app.post('/api/simc/update', (req, res) => {
  if (!simcSource) {
    return res.status(400).json({
      error: 'This simc was not built from source on this machine — update it the way it was installed (see the README).',
    });
  }
  if (simcUpdateState.running) return res.json({ started: false, reason: 'already running' });
  if (queue.running) {
    return res.status(409).json({ error: 'A sim is running — try again when it finishes.' });
  }
  startSimcUpdate(simcSource, simcUpdateState, (err) => {
    if (err) {
      console.error('simc update failed:', err.message);
      return;
    }
    // the binary changed under us: refresh the version banners, re-derive
    // each patch's availability (a PTR patch may just have gained/lost its
    // data), reload loot dbs for newly-available patches, drop stale probes
    // (their caches are keyed on the simc build), and re-check the light
    version = simcVersion(simcPath);
    ptrVersion = simcVersion(simcPath, true);
    if (ptrVersion && !/PTR/i.test(ptrVersion)) ptrVersion = null;
    clearResolveCache();
    clearTraitCache(); // talent tables ship with the binary we just replaced
    clearScalingCache(); // ...and so do the item scaling curves
    clearEffectCache(); // ...and the item effect tables
    for (const p of patches.values()) {
      p.available = !!p.config && (!p.def.ptr || !!ptrVersion);
      p.reason = !p.config ? `missing data/${p.def.seasonFile}`
        : p.def.ptr && !ptrVersion ? 'this simc build has no PTR data' : null;
      if (p.available && !p.lootDb) {
        const cs = cacheStatus(p.paths.cacheDir, expectedBuildFor(p));
        p.lootDb = cs.buildMismatch ? null : loadLootDb(p.paths.lootDbPath);
        if (!p.lootDb && cs.complete) {
          try { p.lootDb = buildLootDb(p.config.droptimizer.mythicPlusDungeons, p.paths); } catch { /* refresh rebuilds */ }
        }
        p.itemSetMap ??= loadItemSetMap(p.paths.cacheDir);
        p.bonusUpgradeMap ??= loadBonusUpgradeMap(p.paths.cacheDir);
        p.iconMap ??= loadIconMap(p.paths.cacheDir);
      }
      p.knownItems = p.lootDb
        ? loadProbeCache(patchVersion(p), p.lootDb.builtAt, p.paths.probeCachePath) : null;
    }
    invalidateStatus();
    console.log(`simc updated: ${version}`);
    // A new simc almost always means a new game build, which makes the cached
    // tables the wrong build. Those get rejected, so the Droptimizer would sit
    // empty behind a "hit Refresh data" banner until somebody read it. Start
    // that download here instead — the tab shows the same progress either way.
    for (const p of patches.values()) {
      if (!p.available) continue;
      if (!cacheStatus(p.paths.cacheDir, expectedBuildFor(p)).buildMismatch) continue;
      const r = startDataRefresh(p);
      if (r.started) console.log(`refreshing game data for ${p.def.label} after the simc update`);
      else if (r.error) console.error(`auto-refresh skipped for ${p.def.label}: ${r.error}`);
    }
  });
  res.json({ started: true });
});

app.get('/api/simc/update/status', (req, res) => {
  res.json({ ...simcUpdateState, updatable: !!simcSource });
});

// ---------- sim history ----------
// Finished sims are written to data/history/ so the History page can
// show them again after the run (and across server restarts).
function persistWhenDone(job, mode, options, p = null) {
  const onUpdate = (j) => {
    if (j.status === 'done') {
      try {
        saveHistoryEntry(j, mode, options,
          p && p.def.id !== DEFAULT_PATCH_ID ? { id: p.def.id, label: p.def.label, ptr: !!p.def.ptr } : null);
      } catch (e) { console.error('could not save sim history:', e.message); }
    }
    if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') {
      queue.off(`update:${job.id}`, onUpdate);
    }
  };
  queue.on(`update:${job.id}`, onUpdate);
}

app.get('/api/history', (req, res) => res.json({ entries: listHistory() }));

app.get('/api/history/:id', (req, res) => {
  const entry = getHistoryEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'unknown history entry' });
  res.json(entry);
});

app.delete('/api/history/:id', (req, res) => {
  res.json({ deleted: deleteHistoryEntry(req.params.id) });
});

// One self-contained HTML file for a finished sim, to hand to someone else.
// Served as a download so the browser saves it instead of opening it.
app.get('/api/history/:id/report', async (req, res) => {
  const entry = getHistoryEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'unknown history entry' });
  // icons come from the patch the sim was run against, so a PTR report still
  // draws the right art
  const p = patches.get(entry.patch?.id ?? DEFAULT_PATCH_ID) ?? patches.get(DEFAULT_PATCH_ID);
  const iconMap = p.iconMap ?? patches.get(DEFAULT_PATCH_ID).iconMap;
  const icons = {};
  if (iconMap) {
    for (const id of reportItemIds(entry)) {
      const file = iconMap.get(Number(id));
      if (file) icons[id] = file;
    }
  }
  const consumableLabels = {};
  for (const list of Object.values(p.config?.consumableOptions ?? {})) {
    if (Array.isArray(list)) for (const o of list) consumableLabels[o.value] = o.label;
  }
  // item quality, for the "Your Top Gear" paperdoll's rarity-coloured names --
  // locale-independent, so always read from the base (English) patch's cache
  p.itemTables ??= loadItemTables(p.paths.cacheDir);
  const qualities = {};
  if (p.itemTables) {
    for (const id of reportItemIds(entry)) {
      const q = p.itemTables.items.get(Number(id))?.quality;
      if (q != null) qualities[id] = q;
    }
  }
  // gems/diamonds carry a real item id, so if this language's data has been
  // refreshed at least once, localizeSeasonConfig swaps in that name; enchant
  // ids have no such lookup and always stay in the season config's language
  const lang = String(req.query.lang ?? '');
  let localePatch = p;
  if (lang && lang !== 'en') {
    const key = `${p.def.id}:${lang}`;
    if (!localizedPatches.has(key)) localizedPatches.set(key, loadPatchData(p.def, lang));
    localePatch = localizedPatches.get(key);
  }
  const { gemLabels, enchantLabels } = enchGemLabelsFrom(
    localizeSeasonConfig(localePatch.config, localePatch), localePatch.enchantNames);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="${reportFilename(entry).replace(/"/g, '')}"`);
  res.send(buildReportHtml(entry, { icons, consumableLabels, gemLabels, enchantLabels, qualities }));
});

// every item the report draws a tile for
function reportItemIds(entry) {
  const r = entry.result ?? {};
  const ids = new Set();
  for (const t of r.topgear ?? []) if (t.itemId) ids.add(Number(t.itemId));
  for (const it of Object.values(r.equipped ?? {})) {
    if (it?.id) ids.add(Number(it.id));
    for (const g of it?.gemIds ?? []) if (g) ids.add(Number(g)); // gems are real items too
  }
  return ids;
}

// ---------- patch registry ----------
// Each patch (live, PTR) carries its own season config, consumable defaults,
// wago cache, loot db, item probe and refresh state. data/patches.json is the
// registry; the UI switches between them and every API call names its patch.
const PATCH_DEFS = JSON.parse(readFileSync(join(ROOT, 'data', 'patches.json'), 'utf8')).patches;
// first registry entry = the default patch (so promoting 12.1 to live later
// is just reordering data/patches.json)
const DEFAULT_PATCH_ID = PATCH_DEFS[0]?.id;
if (!DEFAULT_PATCH_ID) throw new Error('data/patches.json must register at least one patch (first entry = default)');
let ptrVersion = simcVersion(simcPath, true);
if (ptrVersion && !/PTR/i.test(ptrVersion)) ptrVersion = null; // simc built without PTR data

function patchVersion(p) {
  return p.def.ptr ? ptrVersion : version;
}

const buildFromBanner = (banner) => banner?.match(/World of Warcraft (\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null;

// expected wago build for a patch's cache — used to spot wrong-build caches
function expectedBuildFor(p) {
  return buildFromBanner(patchVersion(p));
}

const patches = new Map();
// Builds one patch's full state (config, wago cache, loot db, probe cache) at
// a given language. `locale` only ever changes which subdirectory of
// data/cache/ this reads from (see patchPaths) and which language a refresh
// downloads next -- the simc math is identical in every language, only item/
// set/instance *names* differ. English is the original, always-present
// cache; a non-English `p` starts out exactly like a patch nobody has
// refreshed yet (lootDb: null), so the existing "needsData" -> Refresh data
// flow doubles as the first-time download for that language, no separate UI
// needed.
function loadPatchData(def, locale = 'en') {
  const paths = patchPaths(def.id, def.delveFile, locale);
  let config = null;
  try { config = JSON.parse(readFileSync(join(ROOT, 'data', def.seasonFile), 'utf8')); } catch { /* missing = unavailable */ }
  let consumableDefaults = null;
  try { consumableDefaults = JSON.parse(readFileSync(join(ROOT, 'data', def.consumablesFile), 'utf8')); } catch { /* live defaults apply */ }
  const p = {
    def, locale, paths, config, consumableDefaults,
    available: !!config && (!def.ptr || !!ptrVersion),
    reason: !config ? `missing data/${def.seasonFile}`
      : def.ptr && !ptrVersion ? 'this simc build has no PTR data' : null,
    lootDb: null, knownItems: null,
    probeRunning: false, probeProgress: null, probeError: null,
    refreshState: { running: false, step: null, error: null },
    itemSetMap: loadItemSetMap(paths.cacheDir),
    bonusUpgradeMap: loadBonusUpgradeMap(paths.cacheDir),
    iconMap: loadIconMap(paths.cacheDir),
    socketBonusIds: loadSocketBonusIds(paths.cacheDir),
    enchantNames: loadEnchantNames(paths.cacheDir),
  };
  if (p.available) {
    const cs = cacheStatus(paths.cacheDir, expectedBuildFor(p));
    // A wrong-build cache must not be served: drop the loot db so the UI's
    // needsData path prompts a (pinned) re-download.
    p.lootDb = cs.buildMismatch ? null : loadLootDb(paths.lootDbPath);
    // Silent startup rebuild only when the cache has every table (incl.
    // optional ones added by updates) AND the right game build — otherwise
    // the UI prompts a refresh.
    if (!p.lootDb && cs.complete) {
      try { p.lootDb = buildLootDb(p.config.droptimizer.mythicPlusDungeons, paths); } catch { /* refresh rebuilds */ }
    }
    p.knownItems = p.lootDb ? loadProbeCache(patchVersion(p), p.lootDb.builtAt, paths.probeCachePath) : null;
  }
  return p;
}

for (const def of PATCH_DEFS) patches.set(def.id, loadPatchData(def, 'en'));

// Non-English patch data is built lazily, the first time it's asked for
// (which is the first request made while the language switch is set to
// something other than English) — no point paying the disk reads at boot
// for a language nobody has selected yet.
const localizedPatches = new Map(); // "<patchId>:<locale>" -> p, locale != 'en'

const getPatch = (req) => {
  const id = req.body?.patch ?? req.query?.patch;
  const base = patches.get(typeof id === 'string' ? id : DEFAULT_PATCH_ID) ?? patches.get(DEFAULT_PATCH_ID);
  const lang = req.body?.lang ?? req.query?.lang;
  if (typeof lang !== 'string' || lang === 'en') return base;
  const key = `${base.def.id}:${lang}`;
  if (!localizedPatches.has(key)) localizedPatches.set(key, loadPatchData(base.def, lang));
  return localizedPatches.get(key);
};

app.get('/api/patches', (req, res) => {
  res.json({
    patches: PATCH_DEFS.map((def) => {
      const p = patches.get(def.id);
      return { id: def.id, label: def.label, ptr: !!def.ptr, available: p.available, reason: p.reason };
    }),
  });
});

// Gems and Eversong Diamonds carry a real item id, so once a non-English
// patch's data has been refreshed at least once, ItemSparse.csv (already
// downloaded for the droptimizer/stat-tooltip machinery) has their name in
// that language -- this swaps season.json's hand-written English label for
// it wherever a real id is known. Enchant options have no such id (an
// enchant_id is a SpellItemEnchantment row, not an item) and consumable
// options only carry a simc value string, so both stay in English.
function localizeSeasonConfig(config, p) {
  if (!config || p.locale === 'en') return config;
  p.itemTables ??= loadItemTables(p.paths.cacheDir);
  const items = p.itemTables?.items;
  if (!items) return config; // not refreshed in this language yet
  const relabel = (id) => items.get(Number(id))?.name ?? null;
  const out = { ...config };
  if (Array.isArray(out.gemOptions)) {
    out.gemOptions = out.gemOptions.map((g) => ({ ...g, label: relabel(g.id) ?? g.label }));
  }
  if (out.diamondOptions?.options) {
    out.diamondOptions = {
      ...out.diamondOptions,
      options: out.diamondOptions.options.map((d) => ({ ...d, label: relabel(d.id) ?? d.label })),
    };
  }
  return out;
}

app.get('/api/season', (req, res) => {
  const p = getPatch(req);
  res.json(localizeSeasonConfig(p.config, p) ?? patches.get(DEFAULT_PATCH_ID).config);
});

function uniqueLootItems(lootDb) {
  const uniq = new Map();
  for (const s of lootDb.sources) for (const b of s.bosses) for (const it of b.items) {
    // classId/subclassId let the probe pick a stand-in who can wear the item
    uniq.set(it.id, { id: it.id, invType: it.invType, classId: it.classId, subclassId: it.subclassId });
  }
  return [...uniq.values()];
}

// item id -> inventory type, for working out whether the character's main hand
// is a two-hander. Uses the tooltip tables, which the droptimizer page loads
// anyway; null when they are not available and the caller falls back.
function invTypeLookup(p) {
  p.itemTables ??= loadItemTables(p.paths.cacheDir);
  const items = p.itemTables?.items;
  return items ? (id) => items.get(Number(id))?.invType ?? null : null;
}

// { bySlot } mapping each catalyst-eligible slot (head/shoulder/chest/hands/
// legs) to the character's class's real current tier piece for it — { id,
// name } — so the gear list's "Catalyzed" section (app.js) can offer the
// real item each ticked looted piece becomes. null when the class's tier set
// (see setBonus.js) or item names aren't available (simc built from a
// release archive, not from source).
function buildCatalystCtx(profileText, p) {
  const classId = CLASS_IDS[detectSpec(profileText).class];
  const classSet = classId ? loadCatalystSets(simcPath, p.def.ptr)?.get(classId) : null;
  if (!classSet) return null;
  const invTypeOf = invTypeLookup(p);
  if (!invTypeOf) return null;
  const bySlot = {};
  for (const id of classSet.itemIds) {
    const slot = INV_SLOTS[invTypeOf(id)]?.[0];
    if (slot) bySlot[slot] = { id, name: p.itemTables?.items?.get(id)?.name ?? null };
  }
  return Object.keys(bySlot).length ? { bySlot } : null;
}

function ensureProbe(p, profileText) {
  if (!p.lootDb || p.knownItems || p.probeRunning) return;
  p.probeRunning = true;
  p.probeError = null;
  // if a data refresh replaces the loot db — or a simc update replaces the
  // binary — while we probe, the result is stale: drop it and let the next
  // request probe fresh
  const builtAt = p.lootDb.builtAt;
  const build = patchVersion(p);
  probeKnownItems(simcPath, build, builtAt, profileText, uniqueLootItems(p.lootDb),
    (prog) => { p.probeProgress = prog; },
    { ptr: p.def.ptr, cachePath: p.paths.probeCachePath })
    .then((set) => {
      if (p.lootDb && p.lootDb.builtAt === builtAt && patchVersion(p) === build) p.knownItems = set;
    })
    .catch((err) => { p.probeError = err.message; })
    .finally(() => { p.probeRunning = false; p.probeProgress = null; });
}

function dataStatus(p) {
  return {
    cache: cacheStatus(p.paths.cacheDir, expectedBuildFor(p)),
    lootDb: p.lootDb ? { builtAt: p.lootDb.builtAt, sources: p.lootDb.sources.length } : null,
    probe: { ready: !!p.knownItems, running: p.probeRunning, progress: p.probeProgress, error: p.probeError },
    refresh: p.refreshState,
  };
}

app.get('/api/data/status', (req, res) => res.json(dataStatus(getPatch(req))));

// Download a patch's game tables and rebuild its loot database. Shared by the
// Refresh data button and by the automatic refresh that follows a simc update.
// Returns rather than sending a response so both callers can report their own way.
function startDataRefresh(p) {
  if (!p.available) return { error: `That patch is not available: ${p.reason}` };
  // Pin wago to the exact build simc's dataset was made for — never trust
  // wago's default (it sometimes points at a test build). No pin, no download.
  const build = expectedBuildFor(p);
  if (!build) {
    return {
      error: 'Could not read the game build from your simc install, and the data refresh needs it ' +
        'to download matching tables. Update or reinstall simc (check the Simc light), then try again.',
    };
  }
  const rs = p.refreshState;
  if (rs.running) return { started: false, reason: 'already running' };
  rs.running = true;
  rs.error = null;
  rs.step = 'downloading';
  (async () => {
    await downloadTables((prog) => { rs.step = `downloading ${prog.table} (${prog.index}/${prog.total})`; },
      { cacheDir: p.paths.cacheDir, build, bonusesChannel: p.def.ptr ? 'ptr' : 'live', locale: p.locale });
    rs.step = 'building loot database';
    p.lootDb = buildLootDb(p.config.droptimizer.mythicPlusDungeons, p.paths);
    rs.step = 'indexing item icons';
    p.iconMap = buildIconMap(p.paths.cacheDir);
    p.itemTables = null; // rebuilt lazily from the new csvs
    p.itemSetMap = loadItemSetMap(p.paths.cacheDir);
    p.bonusUpgradeMap = loadBonusUpgradeMap(p.paths.cacheDir);
    p.iconMap = loadIconMap(p.paths.cacheDir);
    p.socketBonusIds = loadSocketBonusIds(p.paths.cacheDir);
    p.enchantNames = loadEnchantNames(p.paths.cacheDir);
    p.knownItems = null; // probe cache is keyed on builtAt; it re-runs on next use
  })()
    .catch((err) => { rs.error = err.message; })
    .finally(() => { rs.running = false; rs.step = null; invalidateStatus(); });
  return { started: true };
}

app.post('/api/data/refresh', (req, res) => {
  const r = startDataRefresh(getPatch(req));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ started: !!r.started, ...(r.reason ? { reason: r.reason } : {}) });
});

// Source tree for the droptimizer tab. Kicks off the one-time simc item
// probe in the background on first call (needs a valid character profile).
app.post('/api/droptimizer/sources', (req, res) => {
  const { profile } = req.body ?? {};
  const p = getPatch(req);
  if (!p.available) return res.status(400).json({ error: `That patch is not available: ${p.reason}` });
  if (!p.lootDb) {
    return res.json({ needsData: true, status: dataStatus(p) });
  }
  const spec = detectSpec(profile ?? '');
  if (!spec.class || !spec.key) {
    return res.status(400).json({ error: 'Paste your /simc export first — the droptimizer filters loot for your class and spec.' });
  }
  ensureProbe(p, profile);
  const tree = buildSourceTree(p.lootDb, CLASS_IDS[spec.class], spec.key, p.knownItems,
    weaponSetup(parseGear(profile ?? '').equipped, invTypeLookup(p)));
  res.json({
    spec,
    tree,
    tierSet: tierSetSummary(profile ?? '', p.itemSetMap ?? patches.get(DEFAULT_PATCH_ID).itemSetMap),
    season: p.config.droptimizer,
    crafted: {
      ...(p.config.crafted ?? {}),
      voidcoreIlvl: p.config.voidcore?.craftedIlvl ?? null,
      embellishments: (p.config.embellishmentOptions?.options ?? [])
        .map((o) => ({ key: o.key, label: o.label })),
    },
    status: dataStatus(p),
  });
});

// Enrich simc-resolved equipped items with their exact upgrade track/step:
// upgrade-track bonus ids on the item line decode to "Hero 6/6" etc. via the
// bonus map.
//
// Only THIS season's tracks count (upgradeSeasonId). Gear kept from a previous
// season keeps its item level but no longer sits on a track, and last season's
// levels overlap this season's lower tracks -- a 289 Myth 6/6 piece from season 1
// looks exactly like a season-2 Veteran 4/6. Inferring the track from item level
// would offer upgrades the game will not sell, so once the bonus map is loaded an
// item without a current-season track bonus is reported as untracked. The ilvl
// guess survives only as a fallback for installs with no bonus data cached yet.
// An item's upgrade track, read from the track bonus id on its own gear line.
// This is the ONLY reliable source: item levels overlap between tracks (321 is
// both Hero 6/6 and Myth 2/6, 308 is both Champion 6/6 and Hero 2/6), so a
// level cannot say which track a piece is on, and guessing the higher one
// offers upgrades that do not exist. trackSource:
//   'exact'   — decoded from the bonus id
//   'none'    — no current-season track: crafted gear, or last season's, which
//               genuinely cannot be upgraded
//   'guessed' — only when the bonus map is unavailable at all
export function decodeTrack(line, p) {
  const bonusMap = p.bonusUpgradeMap ?? patches.get(DEFAULT_PATCH_ID).bonusUpgradeMap;
  const seasonId = p.config?.upgradeSeasonId ?? null;
  const ids = (String(line ?? '').match(/bonus_id=([\d/]+)/)?.[1] ?? '').split('/').map(Number);
  const up = bonusMap
    ? ids.map((id) => bonusMap.get(id)).find((u) => u && (seasonId === null || u.seasonId === seasonId))
    : null;
  if (up) return { track: up.track, stepIdx: up.level - 1, trackSource: 'exact' };
  if (bonusMap) return { track: null, stepIdx: null, trackSource: 'none' };
  return { track: null, stepIdx: null, trackSource: 'guessed' };
}

function enrichEquipped(profile, resolved, p) {
  const { equipped } = parseGear(profile);
  const itemIds = equippedIdsFrom(equipped); // so the page can draw item icons
  return resolved.map((it0) => {
    const it = { ...it0, id: itemIds[it0.slot] ?? null };
    // a Catalyst-converted piece keeps the secondaries of what it was made
    // from, and the export names that source
    const src = equipped[it0.slot]?.match(/redirected_base_stats=(\d+)/)?.[1];
    if (src) it.statSource = Number(src);
    const decoded = decodeTrack(equipped[it.slot], p);
    if (decoded.trackSource !== 'guessed') return { ...it, ...decoded };
    const guess = trackFor(it.ilvl, p.config?.tracks ?? {});
    return {
      ...it,
      track: guess?.track ?? null,
      stepIdx: guess?.stepIdx ?? null,
      trackSource: 'guessed',
    };
  });
}

function equippedIdsFrom(equipped) {
  const ids = {};
  for (const [slot, line] of Object.entries(equipped)) {
    const id = Number(line.match(/(?:^|,)id=(\d+)/)?.[1]);
    if (id) ids[slot] = id;
  }
  return ids;
}

// Decode every talent build the character has (active, saved in game, and
// any hand-added ones) plus the tree layout, so the UI can draw each build
// and the user can see what they're picking between.
function talentPayload(profile, p, customLoadouts = []) {
  const data = loadTraitData(simcPath, p.def.ptr);
  const { active, loadouts } = parseLoadouts(profile);
  const custom = (Array.isArray(customLoadouts) ? customLoadouts : [])
    .filter((c) => c && typeof c.name === 'string' && typeof c.talents === 'string')
    .map((c) => ({ name: c.name, talents: c.talents, isActive: false, custom: true }));
  const all = [
    ...(active ? [{ name: 'Active build', talents: active, isActive: true }] : []),
    ...loadouts.filter((l) => !l.isActive),
    ...custom,
  ];
  if (!data) {
    // simc installed as a plain binary — no trait tables to read
    return { available: false, reason: 'This simc install has no talent data files (built-from-source installs do).',
      layout: [], loadouts: all.map((l) => ({ name: l.name, isActive: !!l.isActive, custom: !!l.custom, valid: true })) };
  }
  let layout = [];
  let charSpec = null; // the active build defines who this character is
  const out = [];
  for (const lo of all) {
    try {
      const d = decodeTalents(lo.talents, data);
      if (lo.isActive) charSpec = d.specId;
      // a build for another spec would abort the sim ("Wrong specialization")
      if (charSpec !== null && d.specId !== charSpec) {
        throw new Error('this build is for a different specialization, so it cannot be simmed on this character');
      }
      if (!layout.length) layout = talentLayout(data, d.specId, d.classId);
      out.push({
        name: lo.name, isActive: !!lo.isActive, custom: !!lo.custom, valid: true,
        heroName: d.heroName, counts: d.counts, selectedNodes: d.selectedNodes,
        talents: d.picked.filter((t) => t.name).map((t) => ({ name: t.name, rank: t.rank, tree: t.tree })),
      });
    } catch (e) {
      out.push({ name: lo.name, isActive: !!lo.isActive, custom: !!lo.custom, valid: false, error: e.message });
    }
  }
  return { available: true, layout, loadouts: out };
}

// slot -> { id, name, ilvl } for the equipped gear: names error messages
// ("cannot initialize this item") and feeds the results view's
// "equipped ilvl -> suggested ilvl" comparison.
function gearBySlotFrom(profile) {
  const { equipped, equippedNames, equippedIlvls } = parseGear(profile);
  const out = {};
  for (const [slot, line] of Object.entries(equipped)) {
    out[slot] = {
      id: Number(line.match(/(?:^|,)id=(\d+)/)?.[1]) || null,
      name: equippedNames?.[slot] ?? null,
      ilvl: equippedIlvls?.[slot] ?? null,
      enchantId: Number(line.match(/,enchant_id=(\d+)/)?.[1]) || null,
      gemIds: (line.match(/,gem_id=([\d/]+)/)?.[1] ?? '').split('/').filter((g) => g && g !== '0'),
    };
  }
  return out;
}

// gem #id / enchant #id -> the season's display name for it, for the report's
// "Gear simmed" table -- built fresh from the current patch config so a
// report always shows the season's current wording, not what was true when
// the sim ran.
function enchGemLabelsFrom(season, enchantNames = null) {
  const gemLabels = {};
  for (const g of season?.gemOptions ?? []) gemLabels[g.id] = g.label;
  for (const d of season?.diamondOptions?.options ?? []) gemLabels[d.id] = d.label;
  // the season config's own curated list covers only the handful of
  // enchants worth simming against each other; the game client's real name
  // (see wagoData.js's loadEnchantNames) covers every enchant_id anyone's
  // gear could carry, so it wins whenever both exist
  const enchantLabels = {};
  for (const arr of Object.values(season?.enchantOptions ?? {})) {
    if (Array.isArray(arr)) for (const e of arr) enchantLabels[e.id] = e.label;
  }
  if (enchantNames) for (const [id, name] of enchantNames) enchantLabels[id] = name;
  return { gemLabels, enchantLabels };
}

// Item sets present in the character's equipped + bagged gear.
function detectItemSets(equipped, bagItems, itemSetMap) {
  if (!itemSetMap) return [];
  const equippedIds = Object.values(equippedIdsFrom(equipped));
  const bagIds = bagItems
    .map((it) => Number(String(it.line).match(/(?:^|,)id=(\d+)/)?.[1]))
    .filter(Boolean);
  const counts = new Map(); // setId -> { equipped, owned }
  for (const id of equippedIds) {
    const sid = itemSetMap.byItem.get(id);
    if (sid == null) continue;
    const c = counts.get(sid) ?? { equipped: 0, owned: 0 };
    c.equipped++; c.owned++;
    counts.set(sid, c);
  }
  for (const id of bagIds) {
    const sid = itemSetMap.byItem.get(id);
    if (sid == null) continue;
    const c = counts.get(sid) ?? { equipped: 0, owned: 0 };
    c.owned++;
    counts.set(sid, c);
  }
  const out = [];
  for (const [setId, c] of counts) {
    if (c.owned < 2) continue;
    const info = itemSetMap.sets.get(setId);
    out.push({ setId, name: info.name, size: info.items.length, equipped: c.equipped, owned: c.owned });
  }
  return out.sort((a, b) => b.equipped - a.equipped);
}

// Parse bagged/vault gear out of an export so the UI can offer checkboxes.
// resolveIlvls=true additionally runs a 1-iteration simc pass to decode each
// equipped item's actual item level and upgrade track (cached per profile).
// Import a character by name + realm instead of pasting a /simc export.
// Returns a profile in the same shape the addon writes, plus the bits the page
// needs to draw the character card. See server/armory.js for why this does not
// use Blizzard's armory API.
// Icon file ids for a batch of item ids. The page asks for whatever it is about
// to draw and caches the answer, so this stays one small request per screen.
// Tooltip data for a batch of "itemId:itemLevel" pairs, or
// "itemId:itemLevel:statSourceId" for a Catalyst-converted piece, which wears
// the secondaries of whatever it was made from. Stats are computed the way the
// game computes them (see server/itemStats.js) and cached per patch.
app.get('/api/items', (req, res) => {
  const p = getPatch(req);
  const icons = p.iconMap ?? patches.get(DEFAULT_PATCH_ID).iconMap;
  p.itemTables ??= loadItemTables(p.paths.cacheDir);
  const scaling = loadScaling(simcPath, p.def.ptr);
  const out = {};
  for (const pair of String(req.query.q ?? '').split(',').slice(0, 60)) {
    const [rawId, rawIlvl, rawSrc] = pair.split(':');
    const id = Number(rawId);
    const ilvl = Number(rawIlvl);
    if (!id) continue;
    const entry = { icon: icons?.get(id) ?? null };
    const st = itemStats(id, ilvl, p.itemTables, scaling, Number(rawSrc) || null);
    if (st) Object.assign(entry, st);
    const fx = loadEffectData(simcPath, p.def.ptr);
    const ctx = effectContext(id, ilvl, p.itemTables, scaling);
    if (fx && ctx) entry.effects = itemEffects(id, ilvl, fx, ctx);
    // tier pieces carry their set's bonuses; the raid drops tokens rather than
    // the pieces themselves, so this is often the only place to read them
    const setMap = p.itemSetMap ?? patches.get(DEFAULT_PATCH_ID).itemSetMap;
    const setId = setMap?.byItem?.get(id);
    const set = setId != null ? setMap.sets.get(setId) : null;
    if (set && fx && ctx) {
      const bonuses = [];
      for (const b of set.bonuses) {
        const text = renderSpell(b.spellId, fx, ctx);
        if (text) bonuses.push({ threshold: b.threshold, text });
      }
      if (bonuses.length) {
        entry.set = {
          name: set.name, pieces: set.items.length, bonuses,
          items: set.items.map((sid) => ({ id: sid, name: p.itemTables.items.get(sid)?.name ?? null })),
        };
      }
    }
    out[pair] = entry;
  }
  res.json({ items: out });
});

app.get('/api/icons', (req, res) => {
  const p = getPatch(req);
  const map = p.iconMap ?? patches.get(DEFAULT_PATCH_ID).iconMap;
  if (!map) return res.json({ icons: {}, ready: false });
  const out = {};
  for (const raw of String(req.query.ids ?? '').split(',')) {
    const id = Number(raw);
    if (!id) continue;
    const f = map.get(id);
    if (f) out[id] = f;
  }
  res.json({ icons: out, ready: true });
});

// enchant_id -> its real name, for item hovercards. Falls back to nothing
// (the caller shows the raw id) until this language's data has SpellItemEnchantment
// cached -- same "Refresh data" flow as everything else wago-sourced.
app.get('/api/enchant-names', (req, res) => {
  const p = getPatch(req);
  const map = p.enchantNames;
  const out = {};
  for (const raw of String(req.query.ids ?? '').split(',')) {
    const id = Number(raw);
    if (!id) continue;
    const name = map?.get(id);
    if (name) out[id] = name;
  }
  res.json({ names: out, ready: !!map?.size });
});

app.post('/api/armory', async (req, res) => {
  const { region, realm, name } = req.body ?? {};
  try {
    const character = await fetchCharacter({ region, realm, name });
    res.json({ profile: buildArmoryProfile(character), character });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/gear', async (req, res) => {
  const { profile, resolveIlvls, customLoadouts } = req.body ?? {};
  if (!profile || typeof profile !== 'string') {
    return res.status(400).json({ error: 'No profile text supplied.' });
  }
  const p = getPatch(req);
  const { equipped, items, equippedItems: equippedGear } = parseGear(profile);
  // bag and equipped items alike carry their own bonus ids, so both get the
  // exact track rather than one guessed from item level
  const withTrack = (list) => list.map((it) => ({ ...it, ...decodeTrack(it.line, p) }));
  const out = {
    equippedSlots: Object.keys(equipped),
    items: withTrack(items),
    equippedGear: withTrack(equippedGear),
    itemSets: detectItemSets(equipped, items, p.itemSetMap ?? patches.get(DEFAULT_PATCH_ID).itemSetMap),
    loadouts: parseLoadouts(profile).loadouts.map((l) => ({ name: l.name, isActive: l.isActive })),
    talents: talentPayload(profile, p, customLoadouts),
    // slot -> this class's real current tier piece, for the gear list's
    // "Catalyzed" section (see buildCatalystCtx) — null slots mean the class's
    // tier set (or this simc build's own generated data) isn't known.
    catalystSlots: buildCatalystCtx(profile, p)?.bySlot ?? null,
  };
  if (resolveIlvls) {
    if (!p.available) {
      out.equippedItemsError = `That patch is not available: ${p.reason}`;
    } else {
      try {
        const resolved = await resolveEquipped(simcPath, profile, p.def.ptr);
        out.equippedItems = enrichEquipped(profile, resolved, p);
      } catch (e) {
        out.equippedItemsError = e.message;
      }
    }
  }
  res.json(out);
});

// Per-slot crest upgrade prices for the pasted character.
//
// The gear list's "highest affordable upgrade" needs three things the
// upgrade_currencies= line alone does not give:
//   * an item's real track, read from its bonus id -- matching on item level is
//     ambiguous (295 is both Veteran 6/6 and Champion 2/6, 305 both Champion
//     5/6 and Hero 1/6)
//   * FREE ranks, from the export's slot_high_watermarks
//   * the halved cost on tiers whose account-wide achievement is held
app.post('/api/crests', (req, res) => {
  const { profile } = req.body ?? {};
  if (!profile || typeof profile !== 'string') return res.status(400).json({ error: 'No profile text supplied.' });
  const p = getPatch(req);
  const bonusMap = p.bonusUpgradeMap ?? patches.get(DEFAULT_PATCH_ID).bonusUpgradeMap;
  if (!bonusMap) return res.status(409).json({ error: 'Game data not downloaded yet — use "Refresh data" first.' });
  const season = p.config;
  if (!season?.upgradeCrests) return res.status(409).json({ error: 'This patch has no crest data curated yet.' });
  try {
    const plan = crestPlan(profile, bonusMap, season, (line) => decodeTrack(line, p));
    res.json({
      hasWatermarks: plan.watermarks.size > 0,
      tiers: plan.tiers,
      achievements: achievementProgress(plan, season),
      items: plan.items.map((i) => ({
        slot: i.slot, name: i.name, track: i.track, rank: i.rank, max: i.max, ilvl: i.ilvl,
        free: i.freeRanks.map((r) => ({ rank: r.rank, ilvl: r.ilvl })),
        paid: i.paidRanks.map((r) => ({ rank: r.rank, ilvl: r.ilvl, cost: r.cost })),
      })),
    });
  } catch (e) {
    res.status(400).json({ error: `Could not read crest data: ${e.message}` });
  }
});

app.post('/api/sim', async (req, res) => {
  const { profile, options, mode, items } = req.body ?? {};
  if (simcUpdateState.running) {
    return res.status(409).json({ error: 'SimulationCraft is updating right now — try again in a minute.' });
  }
  if (!profile || typeof profile !== 'string' || !profile.trim()) {
    return res.status(400).json({ error: 'No profile text supplied. Paste your /simc addon export.' });
  }
  const spec = detectSpec(profile);
  if (!spec.class) {
    return res.status(400).json({
      error: 'That does not look like a /simc export (no class line found). ' +
             'In game, type /simc, press Ctrl+C (Cmd+C on Mac) to copy, and paste the whole thing here.',
    });
  }
  const p = getPatch(req);
  if (!p.available) {
    return res.status(400).json({ error: `That patch is not available: ${p.reason}` });
  }
  // every sim on this patch carries its ptr flag + consumable defaults
  const simOpts = {
    ...(options ?? {}),
    ptr: p.def.ptr,
    ...(p.consumableDefaults ? { consumableDefaults: p.consumableDefaults } : {}),
  };
  // gem/diamond option labels come back in this request's language when that
  // language's data has been refreshed (see localizeSeasonConfig) -- this is
  // what makes a "Stat gems -> ..." comparison row's name show up translated
  const season = localizeSeasonConfig(p.config, p);

  if (mode === 'topgear') {
    const clean = validateItems(items);
    const compare = req.body.compare ?? {};
    const trackUpgrades = req.body.trackUpgrades ?? null;
    if (!clean.length && !compare.consumables && !compare.enchants && !compare.gems && !compare.folio
        && !compare.talents && !(trackUpgrades?.slots?.length)) {
      return res.status(400).json({ error: 'Nothing to compare — tick some items or enable a comparison group.' });
    }
    let setCtx = null;
    const minimums = req.body.setMinimums ?? {};
    const setMap = p.itemSetMap ?? patches.get(DEFAULT_PATCH_ID).itemSetMap;
    if (setMap && Object.keys(minimums).length) {
      const byItem = {};
      for (const [id, sid] of setMap.byItem) byItem[id] = sid;
      setCtx = {
        byItem,
        equippedIds: equippedIdsFrom(parseGear(profile).equipped),
        minimums,
      };
    }
    // both hands are one decision: see buildTopGearInput
    const invTypeOf = invTypeLookup(p);
    const handCtx = {
      ...weaponSetup(parseGear(profile).equipped, invTypeOf),
      specKey: detectSpec(profile).key,
      invTypeOf,
    };
    let { input, sets, skippedBySets, skippedByHands } =
      buildTopGearInput(profile, simOpts, clean, setCtx, handCtx);
    // compare groups: `true` (or missing selection) means "all options";
    // an object with per-category arrays narrows what gets simmed
    const sel = (group) => (typeof compare[group] === 'object' && compare[group] !== null
      ? compare[group].selection ?? null : null);
    const append = (variants) => {
      input += variants.lines.join('\n') + '\n';
      Object.assign(sets, variants.sets);
    };
    if (compare.consumables) {
      append(buildConsumableVariants(profile, simOpts, season.consumableOptions, sel('consumables')));
    }
    // labels + socket data so gem/enchant rows can explain themselves
    // ("Item (slot): current -> suggested" in the expandable details)
    const enhCtx = { socketBonusIds: p.socketBonusIds, gemLabels: {}, enchantLabels: {} };
    for (const g of season.gemOptions ?? []) enhCtx.gemLabels[g.id] = g.label;
    for (const d of season.diamondOptions?.options ?? []) enhCtx.gemLabels[d.id] = d.label;
    for (const arr of Object.values(season.enchantOptions ?? {})) {
      if (Array.isArray(arr)) for (const e of arr) enhCtx.enchantLabels[e.id] = e.label;
    }
    if (compare.enchants) {
      append(buildEnchantVariants(profile, season.enchantOptions, sel('enchants'), enhCtx));
    }
    if (compare.gems) {
      append(buildGemVariants(profile, season.gemOptions, sel('gems')?.gems ?? null, enhCtx));
      append(buildDiamondVariants(profile, season.diamondOptions, sel('gems')?.diamonds ?? null, enhCtx));
    }
    if (compare.folio) {
      append(buildFolioVariants(profile, season.omniumFolio));
    }
    if (compare.talents) {
      append(buildLoadoutVariants(profile, sel('talents')?.loadouts ?? null,
        req.body.customLoadouts ?? []));
    }
    if (trackUpgrades?.slots?.length) {
      try {
        const resolved = await resolveEquipped(simcPath, profile, p.def.ptr);
        append(buildTrackUpgradeVariants(profile, enrichEquipped(profile, resolved, p), season, trackUpgrades));
      } catch (e) {
        return res.status(500).json({ error: `Could not resolve equipped item levels: ${e.message}` });
      }
    }
    const job = queue.submit(input, { mode: 'topgear', spec, sets, gearBySlot: gearBySlotFrom(profile) });
    persistWhenDone(job, 'topgear', options ?? {}, p);
    return res.json({
      jobId: job.id,
      skippedBySets: skippedBySets ?? 0,
      skippedByHands: skippedByHands ?? 0,
    });
  }

  if (mode === 'droptimizer') {
    if (!p.lootDb) return res.status(409).json({ error: 'Game data not downloaded yet — use "Refresh data" first.' });
    if (!p.knownItems) {
      ensureProbe(p, profile);
      return res.status(409).json({ error: 'Still checking which items your simc build supports — try again in a moment.' });
    }
    const { input, sets, profilesetCount, skippedUnknown } =
      buildDroptimizerInput(profile, simOpts, req.body.selection ?? {}, p.lootDb, spec, p.knownItems, season, {
        socketBonusIds: p.socketBonusIds,
        itemSetMap: p.itemSetMap ?? patches.get(DEFAULT_PATCH_ID).itemSetMap,
        setBonusNames: loadSetBonusNames(simcPath, p.def.ptr),
        invTypeOf: invTypeLookup(p),
      });
    if (!profilesetCount) {
      return res.status(400).json({ error: 'Nothing to sim — enable at least one source with usable items.' });
    }
    const job = queue.submit(input, { mode: 'droptimizer', spec, sets, gearBySlot: gearBySlotFrom(profile) });
    persistWhenDone(job, 'droptimizer', options ?? {}, p);
    return res.json({ jobId: job.id, profilesetCount, skippedUnknown });
  }

  if (mode === 'statweights') {
    const input = buildStatWeightsInput(profile, simOpts);
    const job = queue.submit(input, { mode: 'statweights', spec, gearBySlot: gearBySlotFrom(profile) });
    persistWhenDone(job, 'statweights', options ?? {}, p);
    return res.json({ jobId: job.id });
  }

  const input = buildInput(profile, simOpts);
  const job = queue.submit(input, { mode: 'quick', spec, gearBySlot: gearBySlotFrom(profile) });
  persistWhenDone(job, 'quick', options ?? {}, p);
  res.json({ jobId: job.id });
});

// Item lines get written into the simc input file — accept only clean
// single-line "slot=,id=..." strings for known slots.
function validateItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items.slice(0, 300)) {
    const line = String(it?.line ?? '').trim();
    const m = line.match(/^([a-z_0-9]+)=(\S*)$/);
    if (!m || !GEAR_SLOTS.includes(m[1]) || !m[2].includes('id=')) continue;
    const targetIlvl = Number(it?.targetIlvl);
    out.push({
      name: String(it?.name ?? '').slice(0, 120) || null,
      ilvl: Number.isFinite(Number(it?.ilvl)) ? Number(it.ilvl) : null,
      targetIlvl: Number.isInteger(targetIlvl) && targetIlvl >= 100 && targetIlvl <= 500 ? targetIlvl : null,
      section: String(it?.section ?? 'Bags').slice(0, 60),
      slot: m[1],
      line,
      // the looted item's name, for a "Catalyzed" row's tooltip (see the
      // gear list's catalystEntriesFor) — display text only, never parsed
      ...(it?.catalystFrom ? { catalystFrom: String(it.catalystFrom).slice(0, 120) } : {}),
    });
  }
  return out;
}

// Server-Sent Events: progress stream for one job.
app.get('/api/sim/:id/events', (req, res) => {
  const job = queue.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job id' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const send = (j) => {
    const payload = {
      status: j.status,
      progress: j.progress,
      queuePosition: j.status === 'queued' ? queue.queuePosition(j.id) + 1 : 0,
      queue: j.status === 'queued' ? queue.queueInfo(j.id) : null,
      error: j.error,
      result: j.status === 'done' ? j.result : null,
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') {
      queue.off(`update:${j.id}`, send);
      res.end();
    }
  };

  queue.on(`update:${job.id}`, send);
  req.on('close', () => queue.off(`update:${job.id}`, send));
  send(job); // initial state right away
});

app.post('/api/sim/:id/cancel', (req, res) => {
  const ok = queue.cancel(req.params.id);
  res.json({ cancelled: ok });
});

// Shut the server down from the UI (localhost app — the button is the
// only way to stop it without a terminal). Kills any running sim first.
app.post('/api/shutdown', (req, res) => {
  if (!ALLOW_SHUTDOWN) {
    return res.status(403).json({
      error: 'This Localbots is running as a shared server, so it cannot be shut down from the page. ' +
        'Stop it on the host instead (for Docker: docker compose stop).',
    });
  }
  const running = queue.running;
  if (running) queue.cancel(running.id);
  res.json({ ok: true });
  console.log('\n  Shut down from the web UI. Bye!\n');
  setTimeout(() => process.exit(0), 300);
});

app.listen(PORT, () => {
  console.log(`\n  Localbots running:  http://localhost:${PORT}\n`);
  console.log(`  simc: ${simcPath}`);
  console.log(`  ${version ?? 'version unknown'}\n`);
});
