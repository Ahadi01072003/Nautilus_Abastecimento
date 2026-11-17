-- NAUTILUS · Planejamento: tela do D+1. Horas por dia de cada função da OS (HH = funcionários × horas), ordem
-- da OS na pilha do dia (prioridade) e opção de a atividade não trabalhar aos domingos.
SET LOCAL lock_timeout='15s';

-- Horas por dia de cada função necessária (vazio = horas do turno do dia da barra).
ALTER TABLE plan_step_needs ADD COLUMN IF NOT EXISTS hours_per_day numeric(4,2)
  CHECK (hours_per_day IS NULL OR (hours_per_day >= 0.25 AND hours_per_day <= 24));

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

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.proname LIKE 'nautilus\_%' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I', f, current_schema());
  END LOOP;
END $$;
