/* GPUbnb independent Monero feed.
   This module only accepts mainnet observations from our own synchronized node.
   It never fetches a third-party mining or market-price API. */
import { parseMoneroHeader } from './monero-direct.mjs';

export const BLOCK_SAMPLE = 30;
export const MAX_SNAPSHOT_AGE_MS = 20 * 60 * 1000;
// Public sources are refreshed hourly; keep the LAST successful sample for at most 24 hours.
export const MAX_PUBLIC_AGE_MS = 24 * 60 * 60 * 1000;
const finitePositive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;

function positiveInteger(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'number' && !Number.isSafeInteger(value))) throw Error('Invalid atomic value');
  const text = String(value);
  if (!/^(?:0x[\da-fA-F]+|\d+)$/.test(text)) throw Error('Invalid atomic value');
  const n = BigInt(text);
  if (n <= 0n) throw Error('Invalid atomic value');
  return n;
}

export function makeMoneroSnapshot(infoRpc, lastRpc, rangeRpc, now = Date.now()) {
  const info = infoRpc?.result, range = rangeRpc?.result, last = lastRpc?.result?.block_header;
  if (!info || info.status !== 'OK' || info.untrusted !== false ||
    info.synchronized !== true || info.nettype !== 'mainnet' || info.offline === true ||
    !last || !Number.isSafeInteger(info.height) || info.height !== last.height + 1) {
    throw Error('A synchronized, trusted mainnet node is required');
  }
  const tip = parseMoneroHeader(lastRpc, now);
  if (last.orphan_status === true || tip.height < 1978433 + BLOCK_SAMPLE) {
    throw Error('Invalid RandomX chain tip');
  }
  if (!range || range.status !== 'OK' || range.untrusted !== false ||
    !Array.isArray(range.headers) || range.headers.length !== BLOCK_SAMPLE) {
    throw Error('Incomplete or untrusted block sample');
  }
  let sumDifficulty = 0, sumReward = 0;
  const first = tip.height - BLOCK_SAMPLE + 1;
  for (let i = 0; i < BLOCK_SAMPLE; i++) {
    const h = range.headers[i];
    if (!h || h.height !== first + i || h.orphan_status === true ||
      !Number.isSafeInteger(h.timestamp) ||
      h.timestamp > now / 1000 + 300 ||
      h.timestamp > (i ? range.headers[i-1].timestamp + 3600 : now / 1000 + 300)) {
      throw Error('Unusable or inconsistent sample');
    }
    const difficulty = Number(positiveInteger(h.wide_difficulty ?? h.difficulty));
    const atomicReward = Number(positiveInteger(h.reward));
    if (!finitePositive(difficulty) || !Number.isSafeInteger(atomicReward) ||
      atomicReward / 1e12 > 25) throw Error('Unsupported block fields');
    sumDifficulty += difficulty;
    sumReward += atomicReward / 1e12;
  }
  const lastSample = range.headers[BLOCK_SAMPLE - 1];
  if (lastSample.height !== tip.height ||
    (last.hash && lastSample.hash && last.hash !== lastSample.hash)) {
    throw Error('Block tip changed during sample');
  }
  return Object.freeze({
    schemaVersion: 1, coin: 'XMR', algorithm: 'RandomX', network: 'mainnet',
    source: 'own-monero-node', collectedAt: new Date(now).toISOString(),
    blockTimestamp: tip.timestamp, blockHeight: tip.height, sampleBlocks: BLOCK_SAMPLE,
    difficulty: sumDifficulty / BLOCK_SAMPLE,
    rewardXmr: sumReward / BLOCK_SAMPLE,
    quality: 'estimated-from-30-blocks'
  });
}

export function validateMoneroSnapshot(doc, now = Date.now()) {
  if (!doc || doc.schemaVersion !== 1 || doc.coin !== 'XMR' ||
    doc.algorithm !== 'RandomX' || doc.network !== 'mainnet' ||
    (!['own-monero-node','public-monero-rpc'].includes(doc.source)) ||
    (doc.source==='public-monero-rpc'&&(
      !Array.isArray(doc.operators)||doc.operators.length!==2||
      new Set(doc.operators).size!==2||
      doc.operators.some(x=>!['monero.rs','nodely.io','hostingwire.net'].includes(x))||
      !doc.operators.includes(doc.activeOperator)||
      typeof doc.usedFallback!=='boolean'||
      doc.usedFallback!==(doc.activeOperator!=='monero.rs')||
      doc.crossCheckedAt!==doc.collectedAt)) ||
    doc.sampleBlocks !== BLOCK_SAMPLE ||
    !Number.isSafeInteger(doc.blockHeight) || doc.blockHeight < 1978433 ||
    !finitePositive(doc.difficulty) || !finitePositive(doc.rewardXmr) ||
    doc.rewardXmr > 25 || doc.quality !== 'estimated-from-30-blocks') return null;
  const collected = Date.parse(doc.collectedAt || '');
  const block = Date.parse(doc.blockTimestamp || '');
  if (!Number.isFinite(collected) || !Number.isFinite(block) ||
    collected > now + 5*60000 ||
    now-collected > (doc.source==='public-monero-rpc'?MAX_PUBLIC_AGE_MS:MAX_SNAPSHOT_AGE_MS) ||
    block > collected + 5*60000 || collected - block > 30*60000 ||
    !Number.isFinite(now)) return null;
  return Object.freeze({ difficulty: doc.difficulty, rewardXmr: doc.rewardXmr,
    height: doc.blockHeight, collectedAt: doc.collectedAt,
    sampleBlocks: BLOCK_SAMPLE, source: doc.source,
    activeOperator:doc.source==='public-monero-rpc'?doc.activeOperator:null,
    usedFallback:doc.source==='public-monero-rpc'?doc.usedFallback:false });
}
