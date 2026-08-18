// "Equip:" / "Use:" lines for the item tooltip.
//
// Everything comes from the local simc build's generated data, the same place
// the talent trees and stat curves come from:
//
//   item_effect.inc     item id -> the spells it grants, and how they trigger
//   sc_spell_data.inc   each spell's effects (coefficient + scaling class),
//                       plus duration and cooldown
//   spelltext_data.inc  the description template
//
// An effect's number is coefficient x a budget chosen by its scaling class:
//
//   -1  Primary Attribute  primary budget
//   -7  Secondary Rating   primary budget x the combat-rating curve
//   -9  Replace Secondary  the secondary damage budget
//
// then floored. All three are verified against in-game tooltips (see the tests
// at the bottom of this file's history: two trinkets, four item levels).
//
// Descriptions are a small template language. Anything we cannot resolve makes
// us drop that line rather than print a half-substituted string — a tooltip
// with a missing line is fine, one showing "$1297760s1 Strength" is not.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SCALE_PRIMARY = -1, SCALE_SECONDARY_RATING = -7, SCALE_REPLACE_SECONDARY = -9;

// item_effect.inc trigger_type
const TRIGGER = { 0: 'Use', 1: 'Equip', 2: 'Chance on hit' };

const cache = new Map(); // "live"|"ptr" -> parsed data

function genDir(simcPath) {
  try {
    return join(dirname(dirname(realpathSync(simcPath))), 'engine', 'dbc', 'generated');
  } catch {
    return null;
  }
}

function readIf(dir, name) {
  const f = join(dir, name);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

// { effect_id, spell_id, item_id, index, trigger_type, cooldown_group, ... }
function parseItemEffects(text) {
  const byItem = new Map();
  const re = /^\s*\{\s*(\d+),\s*(\d+),\s*(\d+),\s*(-?\d+),\s*(-?\d+),/gm;
  for (const m of text.matchAll(re)) {
    const itemId = Number(m[3]);
    if (!itemId) continue;
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId).push({
      spellId: Number(m[2]),
      index: Number(m[4]),
      trigger: TRIGGER[Number(m[5])] ?? null,
    });
  }
  return byItem;
}

// { effect_id, spell_id, index, type, subtype, scaling_class, attributes, coefficient, ... }
function parseSpellEffects(text) {
  const start = text.indexOf('__spelleffect_data[');
  if (start < 0) return new Map();
  const body = text.slice(start);
  const bySpell = new Map();
  // ... scaling class, attributes, coefficient, then seven fields before the
  // flat base value that non-scaling effects use instead
  const re = /^\s*\{\s*(\d+),\s*(\d+),\s*(\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*0x[0-9a-fA-F]+,\s*(-?[\d.]+)(?:,\s*-?[\d.]+){7},\s*(-?[\d.]+)/gm;
  for (const m of body.matchAll(re)) {
    const spellId = Number(m[2]);
    if (!bySpell.has(spellId)) bySpell.set(spellId, []);
    bySpell.get(spellId).push({
      index: Number(m[3]),
      scaling: Number(m[6]),
      coefficient: Number(m[7]),
      base: Number(m[8]),
    });
  }
  return bySpell;
}

// { "name", id, school, ...  cooldown(ms) ... duration(ms) ... }
// Only the id, cooldown and duration are needed, and they sit at stable
// offsets among the plain numeric fields that follow the name.
function parseSpells(text) {
  const end = text.indexOf('__spelleffect_data[');
  const body = end > 0 ? text.slice(0, end) : text;
  const out = new Map();
  // rows carry nested { ... } groups further along; only the flat numeric
  // fields before the first of those are needed
  const re = /^\s*\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*,([^{]*)/gm;
  for (const m of body.matchAll(re)) {
    const id = Number(m[2]);
    const nums = m[3].split(',').map((s) => s.trim());
    // fields after id: [0]=school [1..3]=projectile [4]=race [5]=class ... the
    // cooldown sits at 14 and the duration at 26, counting from school
    const num = (i) => {
      const v = nums[i];
      if (v === undefined) return 0;
      if (/^0x/i.test(v)) return 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    out.set(id, { name: m[1], cooldown: num(14), duration: num(26) });
  }
  return out;
}

function parseSpellText(text) {
  const out = new Map();
  const re = /^\s*\{\s*(\d+),\s*"((?:[^"\\]|\\.)*)"\s*,\s*(?:"((?:[^"\\]|\\.)*)"|0)\s*,/gm;
  for (const m of text.matchAll(re)) {
    out.set(Number(m[1]), { desc: m[2] ?? '', tooltip: m[3] ?? '' });
  }
  return out;
}

export function loadEffectData(simcPath, ptr = false) {
  const key = ptr ? 'ptr' : 'live';
  if (cache.has(key)) return cache.get(key);
  const dir = genDir(simcPath);
  if (!dir) { cache.set(key, null); return null; }
  const sfx = ptr ? '_ptr' : '';
  try {
    const ie = readIf(dir, `item_effect${sfx}.inc`);
    const sd = readIf(dir, `sc_spell_data${sfx}.inc`);
    const st = readIf(dir, `spelltext_data${sfx}.inc`);
    if (!ie || !sd || !st) { cache.set(key, null); return null; }
    const data = {
      itemEffects: parseItemEffects(ie),
      spellEffects: parseSpellEffects(sd),
      spells: parseSpells(sd),
      spellText: parseSpellText(st),
    };
    cache.set(key, data);
    return data;
  } catch {
    cache.set(key, null);
    return null;
  }
}

export function clearEffectCache() { cache.clear(); }

// ---------- value + text rendering ----------

function effectValue(eff, ctx) {
  switch (eff.scaling) {
    case SCALE_PRIMARY: return Math.floor(eff.coefficient * ctx.primaryBudget);
    case SCALE_SECONDARY_RATING: return Math.floor(eff.coefficient * ctx.primaryBudget * ctx.crMult);
    case SCALE_REPLACE_SECONDARY: return Math.floor(eff.coefficient * ctx.secondaryBudget);
    case 0: return eff.base ? Math.floor(eff.base) : null; // flat, not item-scaled
    default: return null; // an unknown class must not be guessed at
  }
}

function fmtDuration(ms) {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} sec` : `${m} min`;
}

// $?(cond)[a]?(cond)[b][fallback] -> fallback. The conditions pick wording by
// spec; Localbots does not claim to know the reader's spec, so it uses the
// game's own generic wording, which is the last bracket.
function stripConditionals(text) {
  // a conditional is a chain: $?(c1)[a]?(c2)[b][fallback], where a condition is
  // either a parenthesised expression or a bare token like s319949 / a382293
  const COND = String.raw`(?:\([^()]*\)|[a-z]\d+)`;
  const re = new RegExp(
    String.raw`\$\?${COND}\[[^\][]*\](?:\?${COND}\[[^\][]*\])*(?:\[[^\][]*\])?`, 'g');
  let out = text;
  for (let pass = 0; pass < 8; pass++) {
    const next = out.replace(re, (m) => {
      const groups = [...m.matchAll(/\[([^\][]*)\]/g)].map((g) => g[1]);
      return groups.length ? groups[groups.length - 1] : '';
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

function renderText(raw, selfSpellId, resolve) {
  let text = stripConditionals(raw);
  // $<spellid>s1 / $s1 / $w1 / $o1  -> an effect's value
  text = text.replace(/\$(\d*)([swo])(\d+)/g, (m, sid, _kind, idx) => {
    const v = resolve.value(sid ? Number(sid) : selfSpellId, Number(idx));
    return v == null ? m : v.toLocaleString('en-US');
  });
  // $<spellid>d / $d -> duration
  text = text.replace(/\$(\d*)d\b/g, (m, sid) => {
    const v = resolve.duration(sid ? Number(sid) : selfSpellId);
    return v == null ? m : v;
  });
  // simple ${a*b} style expressions, once their variables are numbers
  text = text.replace(/\$\{([^}]*)\}/g, (m, expr) => {
    if (!/^[\d\s.+\-*/()]+$/.test(expr)) return m;
    try {
      // eslint-disable-next-line no-new-func
      const v = Function(`"use strict";return (${expr})`)();
      return Number.isFinite(v) ? String(Math.floor(v)) : m;
    } catch { return m; }
  });
  text = text.replace(/\\r\\n|\r\n/g, '\n').replace(/\|[Tt][^|]*\|[Tt]?/g, '').trim();
  // Keep the paragraphs that came out clean. Dropping only the unresolved ones
  // means an item whose secondary flavour text we cannot compute still shows
  // its main effect, and never shows a raw "$1297760s1".
  const kept = text.split(/\n\s*\n/).map((p) => p.trim())
    .filter((p) => p && !/\$/.test(p));
  return kept.length ? kept.join('\n\n') : null;
}

export function itemEffects(itemId, ilvl, data, ctx) {
  if (!data || !ilvl || !ctx) return [];
  const list = data.itemEffects.get(Number(itemId));
  if (!list?.length) return [];

  const resolve = {
    value(spellId, idx) {
      const eff = data.spellEffects.get(spellId)?.find((e) => e.index === idx - 1);
      return eff ? effectValue(eff, ctx) : null;
    },
    duration(spellId) {
      return fmtDuration(data.spells.get(spellId)?.duration ?? 0);
    },
  };

  const out = [];
  const seen = new Set();
  for (const { spellId, trigger } of list) {
    const raw = data.spellText.get(spellId)?.desc;
    if (!raw || seen.has(spellId)) continue;
    seen.add(spellId);
    const text = renderText(raw, spellId, resolve);
    if (!text) continue;
    const cd = fmtDuration(data.spells.get(spellId)?.cooldown ?? 0);
    out.push({ trigger, text, cooldown: cd });
  }
  return out;
}
