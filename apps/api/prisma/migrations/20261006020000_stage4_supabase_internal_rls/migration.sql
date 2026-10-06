-- Stage 4 defense-in-depth for Supabase's exposed public schema.
--
-- GPUbnb browser clients authenticate with Supabase Auth but all application
-- data access remains server-authoritative through Fastify/Prisma. The earlier
-- Data API lockdown revoked browser-role grants. This migration adds a second
-- boundary for the two security-sensitive operational tables that contain
-- diagnostic/quarantine state, and closes every remaining future table
-- privilege (including TRUNCATE/REFERENCES/TRIGGER/MAINTAIN where supported)
-- from Supabase browser roles for objects created by the postgres owner.
--
-- No policies are intentionally created: anon/authenticated have no legitimate
-- direct access to these tables. Prisma's database owner/service connection
-- remains the authority.

ALTER TABLE public."DiagnosticRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MachineQuarantineEvent" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role)
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
        client_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
        client_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL PRIVILEGES ON FUNCTIONS FROM %I',
        client_role
      );
    END IF;
  END LOOP;
END
$$;
