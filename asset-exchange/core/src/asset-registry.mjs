import { createAssetIdentity, assetKey } from "./asset.mjs";
import { invariant } from "./errors.mjs";

export const ASSET_SUPPORT_STATUSES = Object.freeze([
  "SECURE",
  "LIMITED",
  "MARKETPLACE_ONLY",
  "QUARANTINED"
]);

export const ASSET_RISK_LEVELS = Object.freeze([
  "NORMAL",
  "WATCH",
  "RESTRICTED",
  "QUARANTINE"
]);

function freezeRecord(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "ASSET_REGISTRY_TYPE", "asset registry record required");
  invariant(typeof input.registryId === "string" && /^[a-z0-9][a-z0-9._:-]{2,127}$/.test(input.registryId), "ASSET_REGISTRY_ID", "invalid registry id");
  invariant(typeof input.canonicalName === "string" && input.canonicalName.length >= 2 && input.canonicalName.length <= 128, "ASSET_REGISTRY_NAME", "invalid canonical name");
  invariant(typeof input.symbol === "string" && input.symbol.length >= 2 && input.symbol.length <= 32, "ASSET_REGISTRY_SYMBOL", "invalid symbol");
  invariant(typeof input.category === "string" && input.category.length >= 3 && input.category.length <= 64, "ASSET_REGISTRY_CATEGORY", "invalid category");
  invariant(ASSET_SUPPORT_STATUSES.includes(input.supportStatus), "ASSET_REGISTRY_STATUS", "invalid support status");
  invariant(ASSET_RISK_LEVELS.includes(input.riskLevel), "ASSET_REGISTRY_RISK", "invalid risk level");
  invariant(typeof input.identityReady === "boolean", "ASSET_REGISTRY_IDENTITY_READY", "identityReady must be boolean");

  const identity = input.identityReady ? createAssetIdentity(input.identity) : null;
  invariant(input.identityReady || input.identity == null, "ASSET_REGISTRY_PENDING_IDENTITY", "pending identity must not contain unverified identity");
  const canonicalAssetKey = identity === null ? null : assetKey(identity);

  const capabilities = Object.freeze({
    marketplaceEnabled: input.capabilities.marketplaceEnabled === true,
    newOffersEnabled: input.capabilities.newOffersEnabled === true,
    newTradesEnabled: input.capabilities.newTradesEnabled === true,
    ownershipProofSupported: input.capabilities.ownershipProofSupported === true,
    lockSupported: input.capabilities.lockSupported === true,
    redeemSupported: input.capabilities.redeemSupported === true,
    refundSupported: input.capabilities.refundSupported === true,
    recoverySupported: input.capabilities.recoverySupported === true,
    automaticSettlementSupported: input.capabilities.automaticSettlementSupported === true
  });

  if (capabilities.automaticSettlementSupported) {
    invariant(identity !== null, "ASSET_REGISTRY_AUTO_IDENTITY", "automatic settlement requires verified canonical identity");
    invariant(input.supportStatus === "SECURE" || input.supportStatus === "LIMITED", "ASSET_REGISTRY_AUTO_STATUS", "automatic settlement requires SECURE or LIMITED");
    invariant(
      capabilities.lockSupported &&
      capabilities.redeemSupported &&
      capabilities.refundSupported &&
      capabilities.recoverySupported,
      "ASSET_REGISTRY_AUTO_RECOVERY",
      "automatic settlement requires lock/redeem/refund/recovery"
    );
    invariant(typeof input.routing.settlement === "string" && input.routing.settlement.length > 0, "ASSET_REGISTRY_AUTO_ROUTE", "automatic settlement requires settlement route");
  } else {
    invariant(input.routing.settlement === null, "ASSET_REGISTRY_FALSE_ROUTE", "non-automatic asset must not expose settlement route");
  }

  if (input.supportStatus === "MARKETPLACE_ONLY") {
    invariant(!capabilities.newTradesEnabled, "ASSET_REGISTRY_MARKETPLACE_TRADES", "marketplace-only asset cannot start settled trades");
    invariant(!capabilities.automaticSettlementSupported, "ASSET_REGISTRY_MARKETPLACE_AUTO", "marketplace-only asset cannot auto settle");
  }

  if (input.supportStatus === "QUARANTINED") {
    invariant(!capabilities.newOffersEnabled && !capabilities.newTradesEnabled && !capabilities.automaticSettlementSupported, "ASSET_REGISTRY_QUARANTINE", "quarantined asset must block new exposure");
  }

  return Object.freeze({
    registryId: input.registryId,
    canonicalName: input.canonicalName,
    symbol: input.symbol,
    category: input.category,
    supportStatus: input.supportStatus,
    riskLevel: input.riskLevel,
    identityReady: input.identityReady,
    identity,
    assetKey: canonicalAssetKey,
    issuerControlled: input.issuerControlled === true,
    privacySensitive: input.privacySensitive === true,
    capabilities,
    routing: Object.freeze({
      discovery: "CENTRAL_ORDER_DISCOVERY_V1",
      settlement: input.routing.settlement,
      researchFamily: input.routing.researchFamily
    }),
    notes: Object.freeze([...(input.notes ?? [])])
  });
}

const marketplace = ({
  registryId, canonicalName, symbol, category, identity = null,
  riskLevel = "WATCH", issuerControlled = false, privacySensitive = false,
  researchFamily, notes = []
}) => freezeRecord({
  registryId, canonicalName, symbol, category,
  supportStatus: "MARKETPLACE_ONLY",
  riskLevel,
  identityReady: identity !== null,
  identity,
  issuerControlled,
  privacySensitive,
  capabilities: {
    marketplaceEnabled: true,
    newOffersEnabled: true,
    newTradesEnabled: false,
    ownershipProofSupported: false,
    lockSupported: false,
    redeemSupported: false,
    refundSupported: false,
    recoverySupported: false,
    automaticSettlementSupported: false
  },
  routing: { settlement: null, researchFamily },
  notes
});

const quarantined = ({ registryId, canonicalName, symbol, category, researchFamily, notes = [] }) => freezeRecord({
  registryId, canonicalName, symbol, category,
  supportStatus: "QUARANTINED",
  riskLevel: "QUARANTINE",
  identityReady: false,
  identity: null,
  issuerControlled: false,
  privacySensitive: false,
  capabilities: {
    marketplaceEnabled: false,
    newOffersEnabled: false,
    newTradesEnabled: false,
    ownershipProofSupported: false,
    lockSupported: false,
    redeemSupported: false,
    refundSupported: false,
    recoverySupported: false,
    automaticSettlementSupported: false
  },
  routing: { settlement: null, researchFamily },
  notes
});

const RECORDS = Object.freeze([
  freezeRecord({
    registryId: "btc-regtest-native",
    canonicalName: "Bitcoin Regtest",
    symbol: "BTC",
    category: "NATIVE_UTXO",
    supportStatus: "LIMITED",
    riskLevel: "WATCH",
    identityReady: true,
    identity: { chainId: "bitcoin", networkId: "regtest", assetType: "NATIVE", assetId: "BTC_NATIVE", decimals: 8 },
    issuerControlled: false,
    privacySensitive: false,
    capabilities: {
      marketplaceEnabled: true,
      newOffersEnabled: true,
      newTradesEnabled: true,
      ownershipProofSupported: true,
      lockSupported: true,
      redeemSupported: true,
      refundSupported: true,
      recoverySupported: true,
      automaticSettlementSupported: true
    },
    routing: { settlement: "BITCOIN_P2WSH_HTLC_V1_REGTEST", researchFamily: "UTXO_BITCOIN" },
    notes: ["REGTEST_ONLY", "NO_REAL_FUNDS", "NOT_MAINNET_AUTHORIZED"]
  }),
  marketplace({
    registryId: "btc-mainnet-native", canonicalName: "Bitcoin", symbol: "BTC", category: "NATIVE_UTXO",
    identity: { chainId: "bitcoin", networkId: "mainnet", assetType: "NATIVE", assetId: "BTC_NATIVE", decimals: 8 },
    researchFamily: "UTXO_BITCOIN", notes: ["MAINNET_SETTLEMENT_NOT_AUTHORIZED"]
  }),
  marketplace({
    registryId: "doge-mainnet-native", canonicalName: "Dogecoin", symbol: "DOGE", category: "NATIVE_UTXO",
    identity: { chainId: "dogecoin", networkId: "mainnet", assetType: "NATIVE", assetId: "DOGE_NATIVE", decimals: 8 },
    researchFamily: "UTXO_DOGE"
  }),
  marketplace({
    registryId: "ltc-mainnet-native", canonicalName: "Litecoin", symbol: "LTC", category: "NATIVE_UTXO",
    identity: { chainId: "litecoin", networkId: "mainnet", assetType: "NATIVE", assetId: "LTC_NATIVE", decimals: 8 },
    researchFamily: "UTXO_LTC"
  }),
  marketplace({
    registryId: "bch-mainnet-native", canonicalName: "Bitcoin Cash", symbol: "BCH", category: "NATIVE_UTXO",
    identity: { chainId: "bitcoin-cash", networkId: "mainnet", assetType: "NATIVE", assetId: "BCH_NATIVE", decimals: 8 },
    researchFamily: "UTXO_BCH"
  }),
  marketplace({
    registryId: "xmr-mainnet-native", canonicalName: "Monero", symbol: "XMR", category: "PRIVACY_NATIVE",
    identity: { chainId: "monero", networkId: "mainnet", assetType: "NATIVE", assetId: "XMR_NATIVE", decimals: 12 },
    researchFamily: "XMR_RESEARCH", privacySensitive: true, riskLevel: "RESTRICTED",
    notes: ["NO_INVENTED_CRYPTO", "INDEPENDENT_CRYPTO_REVIEW_REQUIRED"]
  }),
  marketplace({
    registryId: "zec-mainnet-transparent", canonicalName: "Zcash Transparent", symbol: "ZEC", category: "SHIELDED_FAMILY",
    identity: { chainId: "zcash", networkId: "mainnet", assetType: "NATIVE", assetId: "ZEC_TRANSPARENT", decimals: 8 },
    researchFamily: "ZEC_TRANSPARENT_RESEARCH", privacySensitive: true, riskLevel: "RESTRICTED",
    notes: ["TRANSPARENT_POOL_ONLY_IDENTITY", "SHIELDED_POOLS_REQUIRE_SEPARATE_PROFILE"]
  }),
  marketplace({
    registryId: "zec-mainnet-sapling", canonicalName: "Zcash Sapling", symbol: "ZEC", category: "SHIELDED_FAMILY",
    researchFamily: "ZEC_SAPLING_RESEARCH", privacySensitive: true, riskLevel: "RESTRICTED",
    notes: ["IDENTITY_PENDING_POOL_SPECIFIC_IMPLEMENTATION"]
  }),
  marketplace({
    registryId: "zec-mainnet-orchard", canonicalName: "Zcash Orchard", symbol: "ZEC", category: "SHIELDED_FAMILY",
    researchFamily: "ZEC_ORCHARD_RESEARCH", privacySensitive: true, riskLevel: "RESTRICTED",
    notes: ["IDENTITY_PENDING_POOL_SPECIFIC_IMPLEMENTATION"]
  }),
  marketplace({
    registryId: "eth-mainnet-native", canonicalName: "Ether", symbol: "ETH", category: "NATIVE_ACCOUNT",
    identity: { chainId: "ethereum", networkId: "mainnet", assetType: "NATIVE", assetId: "ETH_NATIVE", decimals: 18 },
    researchFamily: "EVM_NATIVE"
  }),
  marketplace({
    registryId: "sol-mainnet-native", canonicalName: "Solana", symbol: "SOL", category: "NATIVE_ACCOUNT",
    identity: { chainId: "solana", networkId: "mainnet-beta", assetType: "NATIVE", assetId: "SOL_NATIVE", decimals: 9 },
    researchFamily: "SOLANA_NATIVE"
  }),
  marketplace({
    registryId: "xrp-mainnet-native", canonicalName: "XRP", symbol: "XRP", category: "NATIVE_ESCROW_LEDGER",
    identity: { chainId: "xrpl", networkId: "mainnet", assetType: "NATIVE", assetId: "XRP_NATIVE", decimals: 6 },
    researchFamily: "XRPL_NATIVE_ESCROW"
  }),
  marketplace({
    registryId: "ada-mainnet-native", canonicalName: "Cardano ADA", symbol: "ADA", category: "NATIVE_UTXO",
    identity: { chainId: "cardano", networkId: "mainnet", assetType: "NATIVE", assetId: "ADA_NATIVE", decimals: 6 },
    researchFamily: "CARDANO_RESEARCH"
  }),
  marketplace({
    registryId: "bnb-mainnet-native", canonicalName: "BNB Smart Chain BNB", symbol: "BNB", category: "NATIVE_ACCOUNT",
    identity: { chainId: "bnb-smart-chain", networkId: "mainnet", assetType: "NATIVE", assetId: "BNB_NATIVE", decimals: 18 },
    researchFamily: "EVM_NATIVE"
  }),
  marketplace({
    registryId: "avax-c-mainnet-native", canonicalName: "Avalanche C-Chain AVAX", symbol: "AVAX", category: "NATIVE_ACCOUNT",
    identity: { chainId: "avalanche-c", networkId: "mainnet", assetType: "NATIVE", assetId: "AVAX_NATIVE", decimals: 18 },
    researchFamily: "EVM_NATIVE"
  }),
  marketplace({
    registryId: "kas-mainnet-native", canonicalName: "Kaspa", symbol: "KAS", category: "NATIVE_DAG",
    identity: { chainId: "kaspa", networkId: "mainnet", assetType: "NATIVE", assetId: "KAS_NATIVE", decimals: 8 },
    researchFamily: "KASPA_RESEARCH"
  }),
  marketplace({
    registryId: "usdt-ethereum-mainnet", canonicalName: "Tether USD Ethereum", symbol: "USDT", category: "STABLECOIN",
    identity: { chainId: "ethereum", networkId: "mainnet", assetType: "TOKEN", assetId: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
    researchFamily: "EVM_ERC20", issuerControlled: true, riskLevel: "RESTRICTED",
    notes: ["ISSUER_FREEZE_BLACKLIST_RISK", "CONTRACT_SPECIFIC_REVALIDATION_REQUIRED"]
  }),
  marketplace({
    registryId: "usdt-solana-mainnet", canonicalName: "Tether USD Solana", symbol: "USDT", category: "STABLECOIN",
    identity: { chainId: "solana", networkId: "mainnet-beta", assetType: "TOKEN", assetId: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
    researchFamily: "SOLANA_SPL", issuerControlled: true, riskLevel: "RESTRICTED",
    notes: ["MINT_ADDRESS_PINNED", "ISSUER_CONTROL_RISK"]
  }),
  marketplace({
    registryId: "usdt-tron-mainnet", canonicalName: "Tether USD Tron", symbol: "USDT", category: "STABLECOIN",
    identity: { chainId: "tron", networkId: "mainnet", assetType: "TOKEN", assetId: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
    researchFamily: "TRON_TRC20", issuerControlled: true, riskLevel: "RESTRICTED",
    notes: ["CONTRACT_ADDRESS_PINNED", "ISSUER_CONTROL_RISK"]
  }),
  marketplace({
    registryId: "usdc-ethereum-mainnet", canonicalName: "USD Coin Ethereum", symbol: "USDC", category: "STABLECOIN",
    identity: { chainId: "ethereum", networkId: "mainnet", assetType: "TOKEN", assetId: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
    researchFamily: "EVM_ERC20", issuerControlled: true, riskLevel: "RESTRICTED",
    notes: ["NATIVE_CIRCLE_USDC_ONLY", "BRIDGED_FORMS_DISTINCT"]
  }),
  marketplace({
    registryId: "usdc-solana-mainnet", canonicalName: "USD Coin Solana", symbol: "USDC", category: "STABLECOIN",
    identity: { chainId: "solana", networkId: "mainnet-beta", assetType: "TOKEN", assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
    researchFamily: "SOLANA_SPL", issuerControlled: true, riskLevel: "RESTRICTED",
    notes: ["NATIVE_CIRCLE_USDC_ONLY", "MINT_ADDRESS_PINNED"]
  }),
  quarantined({
    registryId: "firo-mainnet-native", canonicalName: "Firo", symbol: "FIRO", category: "PRIVACY_NATIVE",
    researchFamily: "FIRO_R_AND_D", notes: ["QUARANTINED_PENDING_SECURITY_REVIEW"]
  }),
  marketplace({
    registryId: "qubic-mainnet-native", canonicalName: "Qubic", symbol: "QUBIC", category: "EXPERIMENTAL_NATIVE",
    researchFamily: "QUBIC_QPI_RESEARCH", riskLevel: "RESTRICTED",
    notes: ["IDENTITY_PENDING_VERIFICATION", "NOT_EVM"]
  }),
  marketplace({
    registryId: "pearl-mainnet-native", canonicalName: "Pearl", symbol: "PEARL", category: "EXPERIMENTAL_NATIVE",
    researchFamily: "PEARL_R_AND_D", riskLevel: "RESTRICTED",
    notes: ["IDENTITY_PENDING_VERIFICATION", "MARKETPLACE_ONLY"]
  }),
  marketplace({
    registryId: "aleo-mainnet-native", canonicalName: "Aleo Credits", symbol: "ALEO", category: "PRIVACY_PROGRAMMABLE",
    researchFamily: "ALEO_R_AND_D", riskLevel: "RESTRICTED",
    notes: ["IDENTITY_PENDING_VERIFICATION"]
  }),
  marketplace({
    registryId: "tari-mainnet-native", canonicalName: "Tari", symbol: "TARI", category: "PRIVACY_NATIVE",
    researchFamily: "TARI_R_AND_D", privacySensitive: true, riskLevel: "RESTRICTED",
    notes: ["IDENTITY_PENDING_VERIFICATION"]
  })
]);

const BY_ID = new Map();
const BY_ASSET_KEY = new Map();
for (const record of RECORDS) {
  invariant(!BY_ID.has(record.registryId), "ASSET_REGISTRY_DUPLICATE_ID", "duplicate asset registry id");
  BY_ID.set(record.registryId, record);
  if (record.assetKey !== null) {
    invariant(!BY_ASSET_KEY.has(record.assetKey), "ASSET_REGISTRY_DUPLICATE_KEY", "duplicate canonical asset key");
    BY_ASSET_KEY.set(record.assetKey, record);
  }
}

export function listAssetCatalog() {
  return RECORDS;
}

export function getAssetCatalogRecord(registryId) {
  return BY_ID.get(registryId) ?? null;
}

export function resolveAssetCatalogByIdentity(identity) {
  const normalized = createAssetIdentity(identity);
  return BY_ASSET_KEY.get(assetKey(normalized)) ?? null;
}

export function assertAutomaticSettlementEligible(identity) {
  const record = resolveAssetCatalogByIdentity(identity);
  invariant(record !== null, "ASSET_REGISTRY_UNKNOWN", "asset identity is not in registry");
  invariant(record.capabilities.automaticSettlementSupported, "ASSET_SETTLEMENT_DISABLED", "automatic settlement is not enabled for this exact asset/network");
  invariant(record.routing.settlement !== null, "ASSET_SETTLEMENT_ROUTE", "automatic settlement route missing");
  return record;
}
