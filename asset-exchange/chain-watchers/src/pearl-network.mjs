// Source-derived identity guard only: no address, consensus or financial qualification.
import { invariant } from "../../core/src/errors.mjs";
export const PEARL_SOURCE_COMMIT = "0dbdb2ffd8b81193a5079bb67a59aecc10ad501c";
const profiles = {
  "mainnet": {
    "networkId": "mainnet",
    "genesisHash": "a18d3093b7ff618f0cdd073fa3d10374e2e0105fe7ef53ff48b55f41c58dadd7",
    "wireMagicHex": "50524c4d",
    "addressHrp": "prl"
  },
  "regtest": {
    "networkId": "regtest",
    "genesisHash": "78d0ab27df6a51a8e9dbbdefffca1ebbbeb3818cb083ce2c2f43b047247e5832",
    "wireMagicHex": "50524c52",
    "addressHrp": "rprl"
  },
  "testnet": {
    "networkId": "testnet",
    "genesisHash": "10f0be7be9950f74021d0f7c62989d1e2541c4d46f3c95b74e61679864b43d18",
    "wireMagicHex": "50524c31",
    "addressHrp": "tprl"
  },
  "testnet2": {
    "networkId": "testnet2",
    "genesisHash": "b0c86d0cd8825f4d72260d2de46f470429eece413811d5d82b5f2e2ea0336f96",
    "wireMagicHex": "50524c32",
    "addressHrp": "tprl"
  },
  "simnet": {
    "networkId": "simnet",
    "genesisHash": "78d0ab27df6a51a8e9dbbdefffca1ebbbeb3818cb083ce2c2f43b047247e5832",
    "wireMagicHex": "50524c53",
    "addressHrp": "rprl"
  },
  "signet": {
    "networkId": "signet",
    "genesisHash": "2fef231e6125467452c9fb569e2f78c9dd534d04111fcf2cd28d9d0e93b00f34",
    "wireMagicHex": "40cf030a",
    "addressHrp": "tprl"
  }
};
for (const profile of Object.values(profiles)) Object.freeze(profile);
Object.freeze(profiles);

export function pearlNetworkProfile(networkId) {
  invariant(typeof networkId === "string" && Object.hasOwn(profiles, networkId), "PEARL_NETWORK", "explicit supported Pearl network required");
  return profiles[networkId];
}

// Both genesis and address prefixes collide across some Pearl networks. Callers
// must independently establish the network and wire magic; never infer either
// from an address or getblockhash(0). Custom signet is deliberately unsupported.
export function validatePearlNetworkIdentity(expectedNetworkId, observation) {
  const expected = pearlNetworkProfile(expectedNetworkId);
  invariant(observation && Object.getPrototypeOf(observation) === Object.prototype, "PEARL_IDENTITY", "plain Pearl identity required");
  const fields = ["chainId", "networkId", "genesisHash", "wireMagicHex", "addressHrp"];
  const keys = Reflect.ownKeys(observation);
  invariant(keys.length === fields.length && keys.every(key => fields.includes(key)), "PEARL_IDENTITY_FIELDS", "exact Pearl identity fields required");
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(observation, key);
    invariant(descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string", "PEARL_IDENTITY_FIELDS", "own text data fields required");
    invariant(descriptor.value === (key === "chainId" ? "pearl" : expected[key]), "PEARL_IDENTITY_MISMATCH", "Pearl network identity mismatch");
  }
  return Object.freeze({ ...expected, chainId: "pearl", qualificationStatus: "BLOCKED", automaticSettlement: false });
}
