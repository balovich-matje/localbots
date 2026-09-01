// Crest upgrade planning: what can this character upgrade, what does it cost,
// and which affordable combinations are worth simulating.
//
// Everything comes from the pasted /simc export -- no user input. The addon
// emits three comment lines we care about:
//
//   # upgrade_currencies=c:3444:88/...        crest balances by currency id
//   # slot_high_watermarks=0:295:295/...      <slot>:<character>:<account>
//   # upgrade_achievements=62410/62411/...    account-wide, halves a tier's cost
//
// COST RULES (derived from live upgrades, see docs):
//   * 20 crests per rank, locked to the item's own track
//   * FREE below the slot's CHARACTER watermark
//   * 10 crests on any tier whose "Outgrow" achievement the account holds
//   * the ACCOUNT watermark is progress toward those achievements, NOT a discount
//
// Watermark slots are Enum.ItemRedundancySlot, which is NOT inventory order:
// the two rings share one entry and the two trinkets share another, and that
// entry is the level you own TWO of -- so a paired slot only becomes free once
// the SECOND item reaches it.

const WATERMARK_SLOTS = {
  0: ['head'], 1: ['neck'], 2: ['shoulder'], 3: ['chest'], 4: ['waist'],
  5: ['legs'], 6: ['feet'], 7: ['wrist'], 8: ['hands'],
  9: ['finger1', 'finger2'],      // pair: value is the level you own two of
  10: ['trinket1', 'trinket2'],   // pair
  11: ['back'], 12: ['main_hand'], 16: ['off_hand'],
  // 13,14,15 are unidentified and carry no slot we upgrade
};

const GEAR_RE = /^(head|neck|shoulder|back|chest|waist|wrist|hands|legs|feet|finger1|finger2|trinket1|trinket2|main_hand|off_hand)=(.*)$/;

// --- parsing -------------------------------------------------------------

export function parseCrestExport(profileText) {
  const line = (key) => profileText.split('\n')
    .find((l) => l.startsWith(`# ${key}=`))?.slice(key.length + 3)?.trim();

  const balances = new Map(); // currencyId -> amount
  for (const part of (line('upgrade_currencies') ?? '').split('/')) {
    const m = part.match(/^c:(\d+):(\d+)$/);      // 'i:' entries are items, not crests
    if (m) balances.set(Number(m[1]), Number(m[2]));
  }

  const watermarks = new Map(); // slot name -> { character, account }
  for (const part of (line('slot_high_watermarks') ?? '').split('/')) {
    const m = part.match(/^(\d+):(\d+):(\d+)$/);
    if (!m) continue;
    const slots = WATERMARK_SLOTS[Number(m[1])];
    if (!slots) continue;
    for (const s of slots) watermarks.set(s, { character: Number(m[2]), account: Number(m[3]), paired: slots.length > 1 });
  }

  const achievements = new Set(
    (line('upgrade_achievements') ?? '').split('/').map(Number).filter(Boolean)
  );

  return { balances, watermarks, achievements };
}

// Equipped items with their upgrade track, current rank and reachable ranks.
// `decodeTrack` is injected rather than reimplemented: server/index.js owns the
// canonical one, and importing it here would close a cycle (index imports
// crestPlan). Falls back to reading the bonus ids directly when not supplied.
export function equippedUpgradables(profileText, bonusMap, season, decodeTrack = null) {
  const out = [];
  const lines = profileText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(GEAR_RE);
    if (!m) continue;
    const [, slot, rest] = m;
    let track;
    if (decodeTrack) {
      const d = decodeTrack(lines[i]);
      if (d?.trackSource !== 'exact') continue;  // crafted, last season's, or unknown
      track = { track: d.track, level: d.stepIdx + 1 };
    } else {
      const bonuses = (rest.match(/bonus_id=([\d/]+)/)?.[1] ?? '').split('/').map(Number);
      track = bonuses.map((b) => bonusMap?.get(b)).find((v) => v && v.seasonId === season.upgradeSeasonId);
    }
    if (!track) continue;                        // not on this season's upgrade system
    const ladder = season.tracks?.[track.track];
    if (!ladder) continue;
    track.max ??= ladder.length;
    track.ilvl ??= ladder[track.level - 1];
    const name = lines[i - 1]?.match(/^# (.+?) \(\d+\)\s*$/)?.[1] ?? slot;
    const id = Number(rest.match(/(?:^|,)id=(\d+)/)?.[1]);
    const steps = ladder.slice(track.level).map((ilvl, k) => ({ rank: track.level + k + 1, ilvl }));
    if (steps.length) out.push({ slot, name, id, track: track.track, rank: track.level, max: track.max, ilvl: track.ilvl ?? ladder[track.level - 1], steps });
  }
  return out;
}

// --- pricing -------------------------------------------------------------

// Cost of ONE rank taking an item from `fromIlvl` to `toIlvl` in `slot`.
// Free below the slot's character watermark; otherwise 20, or 10 if that
// tier's achievement is held.
export function rankCost(slot, toIlvl, track, { watermarks, achievements }, season) {
  const wm = watermarks.get(slot);
  if (wm && toIlvl <= wm.character) return 0;
  const ach = season.upgradeCrestAchievements?.[track];
  const full = season.upgradeCrestCost ?? 20;
  return ach && achievements.has(ach) ? (season.upgradeCrestCostDiscounted ?? full / 2) : full;
}

// Per-item ladder priced rank by rank, split into the free prefix (always take)
// and the paid remainder (what the budget has to cover).
export function priceLadder(item, parsed, season) {
  const priced = item.steps.map((s) => ({ ...s, cost: rankCost(item.slot, s.ilvl, item.track, parsed, season) }));
  let free = 0;
  while (free < priced.length && priced[free].cost === 0) free++;
  return { ...item, priced, freeRanks: priced.slice(0, free), paidRanks: priced.slice(free) };
}

export function crestPlan(profileText, bonusMap, season, decodeTrack = null) {
  const parsed = parseCrestExport(profileText);
  const items = equippedUpgradables(profileText, bonusMap, season, decodeTrack)
    .map((it) => priceLadder(it, parsed, season));
  const tiers = {};
  for (const [track, currencyId] of Object.entries(season.upgradeCrests ?? {})) {
    if (track.startsWith('_')) continue;                 // the schema's _comment key
    const ach = season.upgradeCrestAchievements?.[track];
    const discounted = Boolean(ach && parsed.achievements.has(ach));
    const perRank = discounted ? (season.upgradeCrestCostDiscounted ?? 10) : (season.upgradeCrestCost ?? 20);
    const balance = parsed.balances.get(currencyId) ?? 0;
    tiers[track] = { currencyId, balance, discounted, perRank, ranks: Math.floor(balance / perRank) };
  }
  return { ...parsed, items, tiers };
}

// --- achievement progress ------------------------------------------------

// The "Outgrow the use of X Mistcrests" achievements halve that tier's cost
// account-wide and permanently. Each needs every CORE slot's ACCOUNT watermark
// to reach the track's 6/6 item level -- which is what the second number in
// slot_high_watermarks is tracking. Off-hand is excluded: a live account holds
// Veteran of the Mist with its off-hand watermark well below the Veteran cap.
const CORE_SLOTS = ['head', 'neck', 'shoulder', 'chest', 'waist', 'legs', 'feet',
                    'wrist', 'hands', 'finger1', 'trinket1', 'back', 'main_hand'];

export function achievementProgress(plan, season) {
  const out = [];
  for (const [track, ladder] of Object.entries(season.tracks ?? {})) {
    const achId = season.upgradeCrestAchievements?.[track];
    if (!achId) continue;
    const cap = ladder[ladder.length - 1];
    const earned = plan.achievements.has(achId);
    const short = [];
    for (const slot of CORE_SLOTS) {
      const wm = plan.watermarks.get(slot);
      if (!wm) continue;
      if (wm.account < cap) short.push({ slot, account: wm.account, need: cap, gap: cap - wm.account });
    }
    out.push({ track, cap, earned, short, unlocksSaving: !earned && short.length > 0 });
  }
  return out;
}
