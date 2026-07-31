-- Defense in depth: audit records must never retain secret-store references.
-- The API already avoids returning these values, and this trigger protects
-- future write paths that might accidentally include ownerPoolSecretRef.
CREATE OR REPLACE FUNCTION "redactMiningAuditSecretRefs"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."previousValue" IS NOT NULL THEN
    NEW."previousValue" := NEW."previousValue" - 'ownerPoolSecretRef';
  END IF;

  IF NEW."nextValue" IS NOT NULL THEN
    NEW."nextValue" := NEW."nextValue" - 'ownerPoolSecretRef';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "MiningAuditLog_redact_secret_refs"
BEFORE INSERT OR UPDATE OF "previousValue", "nextValue"
ON "MiningAuditLog"
FOR EACH ROW
EXECUTE FUNCTION "redactMiningAuditSecretRefs"();
