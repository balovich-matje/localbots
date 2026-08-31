// Parses gear out of a /simc addon export:
//  - equipped items (normal lines like "head=,id=123,bonus_id=...")
//  - bagged items and weekly-vault choices, which the addon writes as comments:
//      ### Gear from Bags
//      #
//      # Item Name (289)
//      # head=,id=250060,bonus_id=12806/13335
//
// Returns { equipped: {slot: line}, equippedNames: {slot: name},
//           items: [{name, ilvl, slot, line, section}],
//           equippedItems: the same shape, one per currently-worn item, for
//           comparing "what would upgrading what I already have get me". }.

export const GEAR_SLOTS = [
  'head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist',
  'legs', 'feet', 'finger1', 'finger2', 'trinket1', 'trinket2',
  'main_hand', 'off_hand',
];

const SLOT_LINE = new RegExp(`^(${GEAR_SLOTS.join('|')})=(.*)$`);
const NAME_LINE = /^(.*?)\s*\((\d+)\)\s*$/;
const ID_FIELD = /(?:^|,)id=(\d+)/;

export function parseGear(profileText) {
  const equipped = {};
  const equippedNames = {};
  const equippedIlvls = {}; // from the "# Item Name (289)" comment above each line
  const items = [];
  const equippedItems = [];
  let section = null;
  let pendingName = null;

  for (const raw of profileText.split('\n')) {
    const line = raw.trim();

    if (line.startsWith('###')) {
      const title = line.replace(/^#+\s*/, '').trim();
      if (/^end of/i.test(title)) section = null;
      else if (/gear from bags/i.test(title)) section = 'Bags';
      else if (/weekly reward/i.test(title)) section = 'Vault';
      else section = title || null;
      pendingName = null;
      continue;
    }

    if (line.startsWith('#')) {
      const content = line.replace(/^#+\s*/, '');
      if (!content) { pendingName = null; continue; }
      const slotMatch = content.match(SLOT_LINE);
      if (slotMatch && content.includes('id=')) {
        items.push({
          name: pendingName?.name ?? prettyNameFromLine(slotMatch[2]) ?? slotMatch[1],
          ilvl: pendingName?.ilvl ?? null,
          slot: slotMatch[1],
          id: Number(slotMatch[2].match(ID_FIELD)?.[1]) || null,
          line: content,
          section: section ?? 'Bags',
          // crafted gear always carries crafted_stats= in the export;
          // dropped gear never does — this gates crafted-only upgrade options
          crafted: /[,=]crafted_stats=/.test(`,${content}`),
        });
        pendingName = null;
      } else {
        const nameMatch = content.match(NAME_LINE);
        if (nameMatch) pendingName = { name: nameMatch[1], ilvl: Number(nameMatch[2]) };
        else pendingName = { name: content, ilvl: null };
      }
      continue;
    }

    const eq = line.match(SLOT_LINE);
    if (eq) {
      equipped[eq[1]] = line;
      // the item's display name + ilvl come from the comment line just above
      if (pendingName?.name) equippedNames[eq[1]] = pendingName.name;
      if (pendingName?.ilvl) equippedIlvls[eq[1]] = pendingName.ilvl;
      if (eq[2].includes('id=')) {
        equippedItems.push({
          name: pendingName?.name ?? prettyNameFromLine(eq[2]) ?? eq[1],
          ilvl: pendingName?.ilvl ?? null,
          slot: eq[1],
          id: Number(eq[2].match(ID_FIELD)?.[1]) || null,
          line,
          section: 'Equipped',
          crafted: /[,=]crafted_stats=/.test(`,${line}`),
        });
      }
      pendingName = null;
    }
  }

  return { equipped, equippedNames, equippedIlvls, items, equippedItems };
}

function prettyNameFromLine(rest) {
  // "voidbreakers_veil,id=250060,..." -> "Voidbreakers Veil"
  const slug = rest.split(',')[0];
  if (!slug) return null;
  return slug.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Which equipped slots a bag item can replace.
export function placementsFor(slot) {
  if (slot === 'finger1' || slot === 'finger2') return ['finger1', 'finger2'];
  if (slot === 'trinket1' || slot === 'trinket2') return ['trinket1', 'trinket2'];
  return [slot];
}
