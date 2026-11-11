/* GPUbnb profitability engine — browser-native, no external dependencies. */
(function (root) {
  'use strict';
  const MAX_FEED_AGE_MS = 24 * 60 * 60 * 1000;
  const RECENT_FEED_MS = 2 * 60 * 60 * 1000;
  const MAX_GROSS_EUR_24H = 100000;
  const bounded = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

  function profit({ grossEur24h, watts, quantity, hours, electricityEurKwh, poolFeePercent }) {
    if (!bounded(grossEur24h, 0, MAX_GROSS_EUR_24H) ||
      !bounded(watts, 1, 1500) || !Number.isInteger(quantity) || !bounded(quantity, 1, 100) ||
      !bounded(hours, 0, 24) || !bounded(electricityEurKwh, 0, 5) ||
      !bounded(poolFeePercent, 0, 100)) return null;
    const gross = grossEur24h * hours / 24 * quantity;
    const kwh = watts / 1000 * hours * quantity;
    const electricity = kwh * electricityEurKwh;
    const fees = gross * poolFeePercent / 100;
    return { gross, electricity, fees, net: gross - electricity - fees, kwh };
  }

  function validateFeed(doc, knownIds, now = Date.now()) {
    if (!doc || doc.currency !== 'EUR' || typeof doc.source !== 'string' ||
      !doc.source.trim() || !Array.isArray(doc.devices) || doc.devices.length > 2000 ||
      !knownIds || typeof knownIds.has !== 'function') return null;
    const ts = Date.parse(doc.updatedAt || '');
    if (!Number.isFinite(ts) || ts > now + 5 * 60 * 1000 || now - ts > MAX_FEED_AGE_MS) return null;
    const map = new Map();
    for (const device of doc.devices) {
      if (!device || !knownIds.has(device.id) || !Array.isArray(device.coins) ||
        device.coins.length > 100 || map.has(device.id)) continue;
      const entries = [];
      for (const coin of device.coins) {
        if (!coin || typeof coin.coin !== 'string' || !/^[A-Za-z0-9._ -]{1,32}$/.test(coin.coin) ||
          typeof coin.algorithm !== 'string' || coin.algorithm.length > 80 ||
          !bounded(coin.grossEur24h, 0, MAX_GROSS_EUR_24H)) continue;
        entries.push({ id: String(entries.length), coin: coin.coin.trim(),
          algorithm: coin.algorithm.trim(), gross: coin.grossEur24h, mode: 'live' });
      }
      if (entries.length) map.set(device.id, entries);
    }
    // Empty snapshots never masquerade as connected live data.
    if (map.size === 0) return null;
    return { map, source: doc.source.trim().slice(0, 100), ts };
  }
  root.GPUBNBProfitCore = Object.freeze({ profit, validateFeed, MAX_FEED_AGE_MS, RECENT_FEED_MS });
})(globalThis);
