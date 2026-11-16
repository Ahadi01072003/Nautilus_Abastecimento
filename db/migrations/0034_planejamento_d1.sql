-- NAUTILUS · Planejamento P2: tela do D+1. HH por função (pessoas × horas por dia), prioridade da OS na
-- pilha do dia, opção de não trabalhar aos domingos e registro de quem validou a zona esticada (100–115%).
SET LOCAL lock_timeout='15s';

-- Horas por dia de cada função necessária (vazio = jornada padrão da barra: Equinor 12 h, OCP 9 h).
ALTER TABLE plan_step_needs ADD COLUMN IF NOT EXISTS hours_per_day numeric(4,2)
  CHECK (hours_per_day IS NULL OR (hours_per_day >= 0.25 AND hours_per_day <= 24));
ALTER TABLE plan_bars ADD COLUMN IF NOT EXISTS default_need_hours numeric(4,2) NOT NULL DEFAULT 12
  CHECK (default_need_hours > 0 AND default_need_hours <= 24);
UPDATE plan_bars SET default_need_hours = 9 WHERE id = 'ocp';

-- Prioridade da OS na pilha (menor primeiro; vazio vai para o fim) e domingo de folga da atividade.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS priority integer CHECK (priority IS NULL OR priority BETWEEN 0 AND 1000000000);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS skip_sunday smallint NOT NULL DEFAULT 0 CHECK (skip_sunday IN (0,1));
CREATE INDEX IF NOT EXISTS idx_plans_priority ON plans (priority) WHERE status IN ('draft','launched');

-- OS lançada continua congelada; a única mudança aceita (além de ser substituída) é a prioridade na pilha.
CREATE OR REPLACE FUNCTION nautilus_plan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Planejamento não pode ser apagado'; END IF;
  IF OLD.status <> 'draft' AND NOT (OLD.status = 'launched' AND NEW.status = 'superseded')
     AND (to_jsonb(NEW) - 'priority') IS DISTINCT FROM (to_jsonb(OLD) - 'priority') THEN
    RAISE EXCEPTION 'Planejamento lançado não pode ser alterado';
  END IF;
  RETURN NEW;
END $$;

-- Zona esticada: quem validou passar de 100% (até o teto) naquela barra, dia e função.
CREATE TABLE IF NOT EXISTS plan_stretches (
  id text PRIMARY KEY,
  bar text NOT NULL REFERENCES plan_bars(id),
  day date NOT NULL,
  function_id text REFERENCES job_functions(id),
  function_name text NOT NULL,
  load_pct numeric(6,2) NOT NULL,
  validated_by text NOT NULL CHECK (length(trim(validated_by)) BETWEEN 2 AND 120),
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_stretches_day ON plan_stretches (bar, day);

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['plan_stretches'] LOOP
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
