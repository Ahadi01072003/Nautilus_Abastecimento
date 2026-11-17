-- NAUTILUS · Programação do dia: duração estimada de execução da OS (horas), equipe da atividade (funções e
-- quantidade, para a OS inteira; HH da OS no dia = duração × equipe) e ordem da OS na lista do dia (prioridade).
SET LOCAL lock_timeout='15s';

-- Duração estimada de execução, em horas por dia da OS (obrigatória para lançar).
ALTER TABLE plans ADD COLUMN IF NOT EXISTS estimated_hours numeric(5,2)
  CHECK (estimated_hours IS NULL OR (estimated_hours >= 0.25 AND estimated_hours <= 24));

-- Equipe da atividade: [{functionId, quantity}] (vazio = usa as funções das etapas, OS antigas).
ALTER TABLE plans ADD COLUMN IF NOT EXISTS team jsonb CHECK (team IS NULL OR jsonb_typeof(team) = 'array');

-- Prioridade da OS na lista do dia (menor primeiro; vazio vai para o fim).
ALTER TABLE plans ADD COLUMN IF NOT EXISTS priority integer CHECK (priority IS NULL OR priority BETWEEN 0 AND 1000000000);
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
