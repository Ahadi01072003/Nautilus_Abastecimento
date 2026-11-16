-- NAUTILUS · Planejamento P3: reunião das 16:00 e publicação do D+1 por barra. Na reunião cada OS do dia
-- fica Confirmada ou Ajustar (Adiar usa a ação do D+1). Publicar grava uma versão imutável (o que a TV, o
-- celular do líder e a lista de separação mostram), com as lideranças presentes; depois disso, mudar o dia
-- é permitido, mas pede nova versão com justificativa.
SET LOCAL lock_timeout='15s';

CREATE TABLE IF NOT EXISTS plan_d1_marks (
  bar text NOT NULL REFERENCES plan_bars(id),
  day date NOT NULL,
  plan_id text NOT NULL REFERENCES plans(id),
  mark text NOT NULL CHECK (mark IN ('confirmado','ajustar')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  updated_at text NOT NULL,
  updated_by text NOT NULL REFERENCES members(id),
  updated_by_name text NOT NULL,
  PRIMARY KEY (bar, day, plan_id)
);

CREATE TABLE IF NOT EXISTS plan_d1_publications (
  id text PRIMARY KEY,
  bar text NOT NULL REFERENCES plan_bars(id),
  day date NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  fingerprint text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  leaders text[] NOT NULL CHECK (cardinality(leaders) BETWEEN 1 AND 30),
  justification text CHECK (justification IS NULL OR length(justification) <= 1200),
  published_at text NOT NULL,
  published_by text NOT NULL REFERENCES members(id),
  published_by_name text NOT NULL,
  UNIQUE (bar, day, version),
  CONSTRAINT plan_d1_publications_reason CHECK (version = 1 OR (justification IS NOT NULL AND length(trim(justification)) >= 3))
);
CREATE INDEX IF NOT EXISTS idx_plan_d1_publications_day ON plan_d1_publications (day, bar, version DESC);

CREATE OR REPLACE FUNCTION nautilus_d1_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Publicação do D+1 não pode ser alterada nem apagada'; END $$;
CREATE OR REPLACE TRIGGER plan_d1_publications_immutable BEFORE UPDATE OR DELETE ON plan_d1_publications FOR EACH ROW EXECUTE FUNCTION nautilus_d1_publication_immutable();

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['plan_d1_marks','plan_d1_publications'] LOOP
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
