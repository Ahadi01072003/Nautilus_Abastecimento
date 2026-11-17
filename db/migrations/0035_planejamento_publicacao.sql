-- NAUTILUS · Programação do dia: consolidação da reunião das 16h, por barra (Equinor e OCP têm reuniões próprias).
-- Consolidar grava um retrato imutável do dia da barra (lista, ordem, HH, duração e recursos), com participantes e
-- observações; é o que a TV, o celular, o relatório e a lista de separação mostram e a base do indicador de
-- cumprimento. Consolidar de novo cria a versão seguinte.
SET LOCAL lock_timeout='15s';

CREATE TABLE IF NOT EXISTS plan_day_consolidations (
  id text PRIMARY KEY,
  bar text NOT NULL REFERENCES plan_bars(id),
  day date NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  fingerprint text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  participants text[] NOT NULL CHECK (cardinality(participants) BETWEEN 1 AND 30),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  consolidated_at text NOT NULL,
  consolidated_by text NOT NULL REFERENCES members(id),
  consolidated_by_name text NOT NULL,
  UNIQUE (bar, day, version)
);
CREATE INDEX IF NOT EXISTS idx_plan_day_consolidations_day ON plan_day_consolidations (bar, day, version DESC);

CREATE OR REPLACE FUNCTION nautilus_day_consolidation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Consolidação do dia não pode ser alterada nem apagada'; END $$;
CREATE OR REPLACE TRIGGER plan_day_consolidations_immutable BEFORE UPDATE OR DELETE ON plan_day_consolidations FOR EACH ROW EXECUTE FUNCTION nautilus_day_consolidation_immutable();

DO $$ DECLARE r text; BEGIN
  EXECUTE 'ALTER TABLE plan_day_consolidations ENABLE ROW LEVEL SECURITY';
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('REVOKE ALL ON TABLE plan_day_consolidations FROM %I', r); END IF;
  END LOOP;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.proname LIKE 'nautilus\_%' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I', f, current_schema());
  END LOOP;
END $$;
