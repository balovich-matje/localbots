// Decodes Blizzard talent-loadout strings into the actual talents they pick,
// and exposes the tree layout so the UI can draw a build at a glance.
//
// The data comes from the local SimulationCraft build's own generated trait
// tables (engine/dbc/generated/trait_data*.inc) rather than wago: it is the
// exact table the sim itself uses, so what we draw and what gets simmed can
// never disagree, and it follows the simc binary across updates and PTR.
//
// The bit layout mirrors simc's parse_traits_hash() (engine/player/player.cpp),
// which in turn mirrors Blizzard's Blizzard_ClassTalentImportExport.lua.
// Verified against simc's own debug output on 13 specs: identical talent sets.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SERIALIZATION_VERSION = 2;
const NODE_TIERED = 1, NODE_SELECTION = 3;
export const TREE_CLASS = 1, TREE_SPEC = 2, TREE_HERO = 3, TREE_SELECTION = 4;

const ROW_RE = /^\s*\{\s*([-\d\s,]+?),\s*"((?:[^"\\]|\\.)*)"\s*,\s*\{([^}]*)\}\s*,\s*\{([^}]*)\}\s*,\s*(\d+)\s*,\s*(\d+)\s*\}\s*,?\s*$/;
const SUBTREE_RE = /^\s*\{\s*(\d+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*\}\s*,?\s*$/;

const cache = new Map(); // "live" | "ptr" -> { traits, subTrees }

// simc's source tree sits next to the binary: <src>/build/simc
function traitFileFor(simcPath, ptr) {
  try {
    const srcDir = dirname(dirname(realpathSync(simcPath)));
    const file = join(srcDir, 'engine', 'dbc', 'generated', ptr ? 'trait_data_ptr.inc' : 'trait_data.inc');
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

export function loadTraitData(simcPath, ptr = false) {
  const key = ptr ? 'ptr' : 'live';
  if (cache.has(key)) return cache.get(key);
  const file = traitFileFor(simcPath, ptr);
  if (!file) return null; // binary-only simc install (e.g. Windows nightly)

  const traits = [];
  const subTrees = new Map();
  let inSubTrees = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.includes('trait_sub_tree_data')) { inSubTrees = true; continue; }
    if (inSubTrees) {
      const s = line.match(SUBTREE_RE);
      if (s) subTrees.set(Number(s[1]), s[2]);
      continue;
    }
    const m = line.match(ROW_RE);
    if (!m) continue;
    const n = m[1].split(',').map((v) => Number(v.trim()));
    if (n.length < 13) continue;
    traits.push({
      tree: n[0], classId: n[1], entry: n[2], node: n[3], maxRanks: n[4],
      spell: n[7], row: n[10], col: n[11],
      name: m[2],
      spec: m[3].split(',').map((v) => Number(v.trim())).filter(Boolean),
      subTree: Number(m[5]), nodeType: Number(m[6]),
    });
  }
  const data = traits.length ? { traits, subTrees } : null;
  cache.set(key, data);
  return data;
}

export function clearTraitCache() {
  cache.clear();
}

// Every trait of one class, grouped by node, node ids ascending — the exact
// order the export string's bits are written in.
function nodesForClass(traits, classId) {
  const byNode = new Map();
  for (const t of traits) {
    if (t.classId !== classId) continue;
    if (!byNode.has(t.node)) byNode.set(t.node, []);
    byNode.get(t.node).push(t);
  }
  return [...byNode.entries()].sort((a, b) => a[0] - b[0]);
}

export function decodeTalents(str, data) {
  const { traits, subTrees } = data;
  let head = 0;
  const total = str.length * 6;
  const bit = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (head >= total) throw new Error('the talent string ends unexpectedly');
      const c = B64.indexOf(str[Math.floor(head / 6)]);
      if (c < 0) throw new Error('the talent string has invalid characters');
      v |= ((c >> (head % 6)) & 1) << i;
      head++;
    }
    return v;
  };

  const version = bit(8);
  if (version !== SERIALIZATION_VERSION) {
    throw new Error(`this talent string uses format version ${version}, which this build does not read`);
  }
  const specId = bit(16);
  for (let i = 0; i < 16; i++) bit(8); // tree hash — simc ignores it, so do we

  const classId = traits.find((t) => t.spec.includes(specId))?.classId;
  if (!classId) throw new Error('the talent string is for a specialization this simc build does not know');

  const picked = [];
  const heroTrees = new Set();
  for (const [id, node] of nodesForClass(traits, classId)) {
    if (!bit(1)) continue; // node not selected
    let trait = node[0];
    const maxRank = trait.nodeType === NODE_TIERED
      ? node.reduce((sum, n) => sum + n.maxRanks, 0)
      : trait.maxRanks;
    let rank = maxRank;
    const foreign = trait.tree !== TREE_HERO && trait.spec.length && !trait.spec.includes(specId);

    if (!bit(1)) {
      rank = 1; // granted rather than purchased
    } else {
      if (bit(1)) rank = bit(6); // partially ranked
      if (bit(1)) {              // choice node
        const idx = bit(2);
        if (idx >= node.length) throw new Error(`choice index ${idx} is out of range on node ${id}`);
        trait = node[idx];
      }
    }
    // a hero-tree selection for another spec is stale data simc skips
    if (foreign && trait.tree === TREE_SELECTION) continue;
    if (foreign) throw new Error('this talent string is not for the character\'s specialization');

    if (trait.nodeType === NODE_TIERED) {
      let left = rank;
      for (const n of node) {
        const alloc = Math.min(left, n.maxRanks);
        picked.push({ node: id, entry: n.entry, name: n.name, tree: n.tree, rank: alloc });
        left -= alloc;
        if (left <= 0) break;
      }
    } else {
      picked.push({ node: id, entry: trait.entry, name: trait.name, tree: trait.tree, rank });
      if (trait.tree === TREE_SELECTION || trait.nodeType === NODE_SELECTION) heroTrees.add(trait.subTree);
    }
  }

  const heroName = [...heroTrees].map((id) => subTrees.get(id)).filter(Boolean)[0] ?? null;
  return {
    specId,
    classId,
    heroName,
    picked,
    counts: {
      class: picked.filter((p) => p.tree === TREE_CLASS).length,
      spec: picked.filter((p) => p.tree === TREE_SPEC).length,
      hero: picked.filter((p) => p.tree === TREE_HERO).length,
    },
    selectedNodes: [...new Set(picked.map((p) => p.node))],
  };
}

// The class and spec grids this spec can actually see — one dot per node,
// so the UI can draw the tree with the picked nodes lit up.
export function talentLayout(data, specId, classId) {
  const seen = new Map();
  for (const t of data.traits) {
    if (t.classId !== classId) continue;
    if (t.tree !== TREE_CLASS && t.tree !== TREE_SPEC) continue;
    if (t.spec.length && !t.spec.includes(specId)) continue;
    if (t.row <= 0 || t.col <= 0) continue; // off-screen/internal nodes
    if (seen.has(t.node)) continue;
    seen.set(t.node, { node: t.node, tree: t.tree, row: t.row, col: t.col, name: t.name });
  }
  return [...seen.values()];
}
