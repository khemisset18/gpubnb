import { invariant } from "./errors.mjs";

export function validateDeploymentId(value) {
  invariant(
    typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{2,127}$/.test(value),
    "DEPLOYMENT_ID",
    "deploymentId must be canonical lowercase ASCII"
  );
  return value;
}
