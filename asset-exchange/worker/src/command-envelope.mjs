import { invariant } from "../../core/src/errors.mjs";

const NEW_COMMITMENT_COMMANDS = new Set([
  "CREATE_OFFER",
  "ACCEPT_OFFER",
  "BROADCAST_A_LOCK",
  "BROADCAST_B_LOCK"
]);

const RECOVERY_COMMANDS = new Set([
  "OBSERVE_CHAIN",
  "REDEEM",
  "REFUND",
  "RECOVERY_EXPORT"
]);

export function createCommandEnvelope(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "CMD_TYPE", "command envelope required");
  const allowed = new Set(["commandId","tradeId","type","policyEpoch","idempotencyKey","requestHash","createdAtUnixMs"]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "CMD_UNKNOWN_FIELD", `unknown command field: ${key}`);

  invariant(typeof input.commandId === "string" && input.commandId.length >= 8 && input.commandId.length <= 128, "CMD_ID", "invalid commandId");
  invariant(input.tradeId === null || (typeof input.tradeId === "string" && input.tradeId.length >= 8), "CMD_TRADE_ID", "invalid tradeId");
  invariant(NEW_COMMITMENT_COMMANDS.has(input.type) || RECOVERY_COMMANDS.has(input.type), "CMD_KIND", "unsupported command type");
  invariant(Number.isSafeInteger(input.policyEpoch) && input.policyEpoch >= 0, "CMD_EPOCH", "invalid policy epoch");
  invariant(typeof input.idempotencyKey === "string" && input.idempotencyKey.length >= 16 && input.idempotencyKey.length <= 128, "CMD_IDEMPOTENCY", "invalid idempotency key");
  invariant(typeof input.requestHash === "string" && /^[0-9a-f]{64}$/.test(input.requestHash), "CMD_HASH", "invalid request hash");
  invariant(Number.isSafeInteger(input.createdAtUnixMs) && input.createdAtUnixMs > 0, "CMD_TIME", "invalid command timestamp");

  return Object.freeze({ ...input });
}

export function assertCommandEpoch(command, currentPolicyEpoch) {
  const cmd = createCommandEnvelope(command);
  invariant(Number.isSafeInteger(currentPolicyEpoch) && currentPolicyEpoch >= 0, "CURRENT_EPOCH", "invalid current policy epoch");

  if (NEW_COMMITMENT_COMMANDS.has(cmd.type)) {
    invariant(cmd.policyEpoch === currentPolicyEpoch, "STALE_EPOCH", "stale epoch cannot create a new commitment");
    return true;
  }

  invariant(cmd.policyEpoch <= currentPolicyEpoch, "FUTURE_EPOCH", "recovery command cannot claim a future epoch");
  return true;
}

export function commandClass(type) {
  if (NEW_COMMITMENT_COMMANDS.has(type)) return "NEW_COMMITMENT";
  if (RECOVERY_COMMANDS.has(type)) return "RECOVERY";
  return "UNKNOWN";
}
