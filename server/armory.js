// Character import by name + realm, without a Blizzard API key.
//
// simc's own `armory=` option talks to Blizzard's OAuth API, which needs
// credentials Localbots deliberately does not depend on — running it here fails
// with a 401. raider.io publishes the same character data through a free,
// keyless endpoint, so that is what the Armory tab reads.
//
// The trade-off is freshness: raider.io serves its most recent crawl of the
// character rather than a live read, so gear swapped in the last few minutes may
// not be there yet. We pass the crawl timestamp through so the page can say how
// old the data is, and the addon export stays the accurate route.
//
// What the crawl does NOT carry, and the addon export does: the Omnium Folio
// (omnium_talents), professions, and any saved-but-inactive talent loadouts.

const API = 'https://raider.io/api/v1/characters/profile';

// raider.io slot names -> simc slot names
const SLOTS = {
  head: 'head', neck: 'neck', shoulder: 'shoulder', back: 'back', chest: 'chest',
  waist: 'waist', wrist: 'wrist', hands: 'hands', legs: 'legs', feet: 'feet',
  finger1: 'finger1', finger2: 'finger2', trinket1: 'trinket1', trinket2: 'trinket2',
  mainhand: 'main_hand', offhand: 'off_hand',
};

export const REGIONS = ['us', 'eu', 'kr', 'tw', 'cn'];

// "Twisting Nether" -> "twisting-nether", "Kil'jaeden" -> "kiljaeden"
export function realmSlug(realm) {
  return String(realm).trim().toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

const token = (s) => String(s).trim().toLowerCase().replace(/[\s'’-]+/g, '_');

export async function fetchCharacter({ region, realm, name }, { timeoutMs = 20000 } = {}) {
  if (!REGIONS.includes(String(region).toLowerCase())) {
    throw new Error(`Unknown region "${region}". Pick one of: ${REGIONS.join(', ')}.`);
  }
  if (!String(realm ?? '').trim()) throw new Error('Enter the realm name.');
  if (!String(name ?? '').trim()) throw new Error('Enter the character name.');

  const url = `${API}?region=${encodeURIComponent(String(region).toLowerCase())}`
    + `&realm=${encodeURIComponent(realmSlug(realm))}`
    + `&name=${encodeURIComponent(String(name).trim())}`
    + '&fields=gear%2Ctalents';

  let resp;
  try {
    resp = await fetch(url, {
      headers: { accept: 'application/json', 'User-Agent': 'localbots (github.com/balovich-matje/localbots)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`Could not reach raider.io (${e.name === 'TimeoutError' ? 'timed out' : e.message}). `
      + 'Check the connection, or paste a /simc export instead.');
  }

  if (resp.status === 400 || resp.status === 404) {
    throw new Error(`No character called "${String(name).trim()}" on ${realm} (${String(region).toUpperCase()}). `
      + 'Check the spelling and the realm. A character that has never been scanned by raider.io '
      + 'will not be there either — log in, then use the /simc addon export instead.');
  }
  if (resp.status === 429) throw new Error('raider.io is rate-limiting us — wait a minute and try again.');
  if (!resp.ok) throw new Error(`raider.io returned HTTP ${resp.status}. Try again shortly.`);

  const j = await resp.json();
  if (!j?.gear?.items) {
    throw new Error('raider.io has this character but no gear on record yet. Use the /simc addon export instead.');
  }
  return normalize(j);
}

function normalize(j) {
  const items = [];
  for (const [rioSlot, simcSlot] of Object.entries(SLOTS)) {
    const it = j.gear.items[rioSlot];
    if (!it?.item_id) continue;
    items.push({
      slot: simcSlot,
      id: it.item_id,
      name: it.name ?? null,
      ilvl: it.item_level ?? null,
      quality: it.item_quality ?? null,
      icon: it.icon ?? null,
      enchant: it.enchant ?? null,
      gems: (it.gems ?? []).filter(Boolean),
      bonuses: (it.bonuses ?? []).filter(Boolean),
    });
  }
  return {
    name: j.name,
    realm: j.realm,
    region: j.region,
    race: j.race,
    className: j.class,
    spec: j.active_spec_name,
    role: j.active_spec_role,
    faction: j.faction,
    thumbnail: j.thumbnail_url ?? null,
    itemLevel: j.gear.item_level_equipped ?? null,
    talentLoadout: j.talentLoadout?.loadout_text ?? null,
    // the crawl this came from — the page shows it so nobody sims stale gear
    // believing it is live
    crawledAt: j.gear?.updated_at ?? j.last_crawled_at ?? null,
    profileUrl: j.profile_url ?? null,
    items,
  };
}

// Build a profile in the same shape the /simc addon writes, so everything
// downstream (spec detection, gear parsing, the droptimizer) treats an armory
// import exactly like a pasted export.
export function buildProfile(c) {
  const L = [];
  L.push(`# ${c.name} - ${c.spec} - imported from raider.io - ${c.region.toUpperCase()}/${c.realm}`);
  if (c.crawledAt) L.push(`# character data last updated ${c.crawledAt}`);
  L.push('');
  L.push(`${token(c.className)}="${c.name.replace(/"/g, '')}"`);
  // level is deliberately omitted: simc defaults to the max level of the build
  // it was compiled for, which stays correct across expansions
  L.push(`race=${token(c.race)}`);
  L.push(`region=${c.region}`);
  L.push(`server=${realmSlug(c.realm)}`);
  L.push(`spec=${token(c.spec)}`);
  if (c.talentLoadout) {
    L.push('');
    L.push(`talents=${c.talentLoadout}`);
  }
  L.push('');
  for (const it of c.items) {
    const parts = [`id=${it.id}`];
    if (it.enchant) parts.push(`enchant_id=${it.enchant}`);
    if (it.gems.length) parts.push(`gem_id=${it.gems.join('/')}`);
    if (it.bonuses.length) parts.push(`bonus_id=${it.bonuses.join('/')}`);
    if (it.name) L.push(`# ${it.name}${it.ilvl ? ` (${it.ilvl})` : ''}`);
    L.push(`${it.slot}=,${parts.join(',')}`);
  }
  L.push('');
  return L.join('\n');
}
