-- NAUTILUS · Planejamento: publicação do D+1 por barra e dia. Publicar grava um retrato imutável (o que a TV,
-- o celular do líder e a lista de separação mostram). Publicar de novo cria a versão seguinte; as anteriores
-- ficam como histórico.
SET LOCAL lock_timeout='15s';

CREATE TABLE IF NOT EXISTS plan_d1_publications (
  id text PRIMARY KEY,
  bar text NOT NULL REFERENCES plan_bars(id),
  day date NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  fingerprint text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  published_at text NOT NULL,
  published_by text NOT NULL REFERENCES members(id),
  published_by_name text NOT NULL,
  UNIQUE (bar, day, version)
);
CREATE INDEX IF NOT EXISTS idx_plan_d1_publications_day ON plan_d1_publications (day, bar, version DESC);

CREATE OR REPLACE FUNCTION nautilus_d1_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Publicação do D+1 não pode ser alterada nem apagada'; END $$;
CREATE OR REPLACE TRIGGER plan_d1_publications_immutable BEFORE UPDATE OR DELETE ON plan_d1_publications FOR EACH ROW EXECUTE FUNCTION nautilus_d1_publication_immutable();

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['plan_d1_publications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r); END IF;
    END LOOP;
  END LOOP;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.proname LIKE 'nautilus\_%' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I', f, current_schema());
  END LOOP;
END $$;
