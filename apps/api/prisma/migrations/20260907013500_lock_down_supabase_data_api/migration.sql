-- GPUbnb uses Supabase Auth in the browser, but all application data access goes
-- through the trusted Fastify/Prisma API. The browser does not query public
-- application tables through PostgREST/GraphQL. Keep the public Prisma schema
-- inaccessible to Supabase client roles even on older projects whose historical
-- default privileges exposed new public objects automatically.
--
-- The role checks keep this migration portable in local/CI PostgreSQL, where the
-- Supabase-specific roles may not exist.
DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', client_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', client_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', client_role);
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', client_role);
    END IF;
  END LOOP;
END
$$;

-- Supabase historically configured default grants for objects created by the
-- postgres role. Revoke those defaults for browser-facing roles so future Prisma
-- migrations cannot silently re-expose a new application table or routine.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated';
  END IF;
END
$$;
