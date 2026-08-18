// Optional Blizzard API client for the Armory lookup.
//
// Localbots works with no Blizzard credentials at all — server/armory.js falls
// back to a public character scan. When BLIZZARD_CLIENT_ID and
// BLIZZARD_CLIENT_SECRET are set, this path is used instead because it is
// strictly better: the character is read live rather than from someone else's
// crawl, every saved talent loadout comes through (not just the active one),
// and item icons resolve properly even for items added by the newest patch.
//
// Credentials are read from the environment only. Never commit them: .env is
// gitignored and .dockerignored for exactly this reason.

const QUALITY = {
  POOR: 0, COMMON: 1, UNCOMMON: 2, RARE: 3, EPIC: 4,
  LEGENDARY: 5, ARTIFACT: 6, HEIRLOOM: 7,
};

// China sits on its own gateway; everyone else shares the regional pattern.
const hosts = (region) => (region === 'cn'
  ? { oauth: 'https://oauth.battlenet.com.cn/token', api: 'https://gateway.battlenet.com.cn' }
  : { oauth: 'https://oauth.battle.net/token', api: `https://${region}.api.blizzard.com` });

export function hasCredentials() {
  return !!(process.env.BLIZZARD_CLIENT_ID && process.env.BLIZZARD_CLIENT_SECRET);
}

// one token per region, reused until shortly before it expires
const tokens = new Map();

async function accessToken(region) {
  const cached = tokens.get(region);
  if (cached && cached.expires > Date.now()) return cached.token;
  const { oauth } = hosts(region);
  const auth = Buffer.from(
    `${process.env.BLIZZARD_CLIENT_ID}:${process.env.BLIZZARD_CLIENT_SECRET}`
  ).toString('base64');
  const resp = await fetch(oauth, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new Error('Blizzard rejected the API credentials '
      + `(HTTP ${resp.status}). Check BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET.`);
  }
  const j = await resp.json();
  // renew a minute early so an in-flight request never races the expiry
  tokens.set(region, { token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token;
}

async function get(region, path, { namespace = 'profile', optional = false } = {}) {
  const { api } = hosts(region);
  const token = await accessToken(region);
  const url = `${api}${path}${path.includes('?') ? '&' : '?'}namespace=${namespace}-${region}&locale=en_GB`;
  const resp = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (resp.status === 404) {
    if (optional) return null;
    const e = new Error('not found');
    e.notFound = true;
    throw e;
  }
  if (!resp.ok) throw new Error(`Blizzard API returned HTTP ${resp.status}.`);
  return resp.json();
}

// Item icons live behind one media lookup each. They never change for a given
// item, so cache them for the life of the process.
const iconCache = new Map();

async function iconFor(region, itemId) {
  if (iconCache.has(itemId)) return iconCache.get(itemId);
  let icon = null;
  try {
    const m = await get(region, `/data/wow/media/item/${itemId}`, { namespace: 'static', optional: true });
    icon = m?.assets?.find((a) => a.key === 'icon')?.value ?? null;
  } catch { /* an icon is cosmetic — never fail an import over one */ }
  iconCache.set(itemId, icon);
  return icon;
}

const slugName = (s) => String(s).trim().toLowerCase();
// Blizzard addresses realms by slug: "Twisting Nether" -> "twisting-nether"
const slugRealm = (s) => String(s).trim().toLowerCase()
  .replace(/['’]/g, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

export async function fetchCharacter({ region, realm, name }) {
  const r = String(region).toLowerCase();
  const base = `/profile/wow/character/${encodeURIComponent(slugRealm(realm))}/${encodeURIComponent(slugName(name))}`;

  let summary, equipment, specs, media;
  try {
    [summary, equipment, specs, media] = await Promise.all([
      get(r, base),
      get(r, `${base}/equipment`),
      get(r, `${base}/specializations`, { optional: true }),
      get(r, `${base}/character-media`, { optional: true }),
    ]);
  } catch (e) {
    if (e.notFound) {
      const err = new Error('notFound');
      err.notFound = true;
      throw err;
    }
    throw e;
  }

  const items = [];
  for (const it of equipment.equipped_items ?? []) {
    const slot = String(it.slot?.type ?? '').toLowerCase()
      .replace('finger_', 'finger').replace('trinket_', 'trinket');
    items.push({
      slot,
      id: it.item.id,
      name: it.name ?? null,
      ilvl: it.level?.value ?? null,
      quality: QUALITY[it.quality?.type] ?? 4,
      icon: null, // filled in below
      iconUrl: null,
      enchant: (it.enchantments ?? [])
        .find((e) => e.enchantment_slot?.type === 'PERMANENT')?.enchantment_id ?? null,
      gems: (it.sockets ?? []).map((s) => s.item?.id).filter(Boolean),
      bonuses: it.bonus_list ?? [],
    });
  }
  // icons in parallel; a failure just leaves the tile blank
  await Promise.all(items.map(async (it) => { it.iconUrl = await iconFor(r, it.id); }));

  const activeSpecName = summary.active_spec?.name ?? null;
  const group = (specs?.specializations ?? [])
    .find((s) => s.specialization?.name === activeSpecName);
  // Blizzard exposes the loadout codes but not the names the player gave them,
  // so number them rather than repeat one meaningless label
  let n = 0;
  const loadouts = (group?.loadouts ?? [])
    .filter((l) => l.talent_loadout_code)
    .map((l) => ({
      name: l.is_active ? 'Active' : `Armory loadout ${++n}`,
      code: l.talent_loadout_code,
      active: !!l.is_active,
    }));

  return {
    source: 'blizzard',
    name: summary.name,
    realm: summary.realm?.name ?? realm,
    realmSlug: summary.realm?.slug ?? realm,
    region: r,
    level: summary.level ?? null,
    race: summary.race?.name ?? null,
    className: summary.character_class?.name ?? null,
    spec: activeSpecName,
    faction: summary.faction?.name ?? null,
    thumbnail: media?.assets?.find((a) => a.key === 'avatar')?.value ?? null,
    itemLevel: summary.equipped_item_level ?? null,
    talentLoadout: loadouts.find((l) => l.active)?.code ?? null,
    savedLoadouts: loadouts.filter((l) => !l.active),
    crawledAt: null, // live read, so there is no crawl age to warn about
    items,
  };
}
