// PvP-only progression. Never reads or writes main-world levels, profiles, assets or money.
export const PROGRESSION_SCHEMA = 'chikiseum.pvp-progression/v1';
export const MAX_LEVEL = 30;
const DAY = 86400;
const clone = value => structuredClone(value);
const dictionary = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const keyOK = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
  && !Object.hasOwn(Object.prototype, value) && value !== 'prototype';

export function levelFromXP(xp) {
  if (!integer(xp, 0, 100000000)) throw new Error('Invalid durable battle XP');
  let level = 1, within = xp;
  while (level < MAX_LEVEL && within >= 100 * level) { within -= 100 * level; level++; }
  return { level, xp, level_xp: level === MAX_LEVEL ? 0 : within,
    next_level_xp: level === MAX_LEVEL ? 0 : level * 100,
    level_source: 'server_earned_pvp' };
}

export class ChikiseumProgressBook {
  constructor(saved = null) {
    this.value = saved == null ? { schema: PROGRESSION_SCHEMA, assets: {}, receipts: {}, days: {} } : clone(saved);
    const v = this.value;
    if (v.schema !== PROGRESSION_SCHEMA || !dictionary(v.assets) || !dictionary(v.receipts) || !dictionary(v.days)
      || Object.keys(v.assets).length > 400000 || Object.keys(v.receipts).length > 20000)
      throw new Error('Battle progression unavailable: invalid durable state');
    for (const [id, row] of Object.entries(v.assets)) {
      if (!keyOK(id) || !dictionary(row) || !integer(row.xp, 0, 100000000)) throw new Error('Invalid durable battle fighter');
    }
    for (const [id, r] of Object.entries(v.receipts)) {
      if (!keyOK(id) || !dictionary(r) || r.match_id !== id || !Number.isFinite(r.at) || r.at < 0
        || !dictionary(r.awards) || Object.keys(r.awards).length !== 2
        || !['completed_battle', 'participation_required', 'daily_limit'].includes(r.reason)) throw new Error('Invalid battle receipt');
      for (const [asset, award] of Object.entries(r.awards)) {
        if (!keyOK(asset) || !dictionary(award) || ![0, 18, 22, 30].includes(award.gained_xp)) throw new Error('Invalid durable XP award');
        const expected = levelFromXP(award.xp);
        if (Object.entries(expected).some(([k, value]) => award[k] !== value)
          || (r.reason !== 'completed_battle' && award.gained_xp !== 0)) throw new Error('Corrupt durable XP award');
      }
    }
    for (const [day, row] of Object.entries(v.days)) {
      if (!/^\d{1,10}$/.test(day) || !dictionary(row) || !dictionary(row.wallets) || !dictionary(row.pairs)
        || Object.keys(row.wallets).some(k => !keyOK(k)) || Object.keys(row.pairs).some(k => k.split(':').length !== 2 || k.split(':').some(v => !keyOK(v)))) throw new Error('Invalid battle day counters');
      if (Object.values(row.wallets).some(x => !integer(x, 0, 20)) || Object.values(row.pairs).some(x => !integer(x, 0, 3)))
        throw new Error('Invalid battle progression limits');
    }
  }

  fighter(assetId) {
    if (!keyOK(assetId)) throw new Error('Invalid owned asset id');
    return levelFromXP(this.value.assets[assetId]?.xp ?? 0);
  }

  // Called only with server engine completions; never exported as an HTTP mutation.
  // Construct a separate candidate book; caller installs it only AFTER its durable write succeeds.
  withCompletion(summary, now) {
    if (!dictionary(summary) || !keyOK(summary.match_id) || !Number.isFinite(now)) throw new Error('Invalid completed match');
    const book = new ChikiseumProgressBook(this.value);
    if (Object.hasOwn(book.value.receipts, summary.match_id))
      return { book, receipt: clone(book.value.receipts[summary.match_id]), repeated: true };
    const p = summary.players;
    if (!Array.isArray(p) || p.length !== 2 || p.some(x => !dictionary(x) || !keyOK(x.asset_id)
      || !keyOK(x.wallet) || !['A', 'B'].includes(x.side)) || p[0].wallet === p[1].wallet
      || p[0].asset_id === p[1].asset_id || p[0].side === p[1].side) throw new Error('Invalid completed fighters');
    const at = summary.completed_at;
    if (!Number.isFinite(at) || at > now + 1 || !Number.isFinite(summary.started_at)
      || at < summary.started_at || now - at > 7 * DAY) throw new Error('Invalid completed match time');
    if (!['finished', 'draw'].includes(summary.status)) throw new Error('Cancelled games cannot award XP');
    if (summary.winner != null && !['A', 'B'].includes(summary.winner)) throw new Error('Invalid winner');
    const day = String(Math.floor(at / DAY));
    for (const d of Object.keys(book.value.days)) if (Number(d) < Number(day) - 8) delete book.value.days[d];
    for (const [id, r] of Object.entries(book.value.receipts)) if (r.at < now - 8 * DAY) delete book.value.receipts[id];
    if (Object.keys(book.value.receipts).length >= 20000) throw new Error('Battle receipt capacity reached');
    const counters = book.value.days[day] ||= { wallets: {}, pairs: {} };
    const pair = p.map(x => x.wallet).sort().join(':');
    const active = at - summary.started_at >= 30 && p.every(x => integer(x.cast_count, 3, 10000)
      && Number.isFinite(x.damage_dealt) && x.damage_dealt > 0);
    const underCap = (counters.pairs[pair] || 0) < 3 && p.every(x => (counters.wallets[x.wallet] || 0) < 20);
    const receipt = { match_id: summary.match_id, at, awards: {},
      reason: !active ? 'participation_required' : !underCap ? 'daily_limit' : 'completed_battle' };
    for (const player of p) {
      const gain = active && underCap ? (summary.winner == null ? 22 : summary.winner === player.side ? 30 : 18) : 0;
      const old = book.fighter(player.asset_id);
      const xp = Math.min(100000000, old.xp + gain);
      if (gain) {
        if (!Object.hasOwn(book.value.assets, player.asset_id) && Object.keys(book.value.assets).length >= 400000)
          throw new Error('Battle fighter capacity reached');
        book.value.assets[player.asset_id] = { xp };
        counters.wallets[player.wallet] = (counters.wallets[player.wallet] || 0) + 1;
      }
      receipt.awards[player.asset_id] = { gained_xp: gain, ...levelFromXP(xp) };
    }
    if (active && underCap) counters.pairs[pair] = (counters.pairs[pair] || 0) + 1;
    book.value.receipts[summary.match_id] = receipt;
    return { book, receipt: clone(receipt), repeated: false };
  }

  snapshot() { return clone(this.value); }
}
