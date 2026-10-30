-- NAUTILUS · Financeiro: recobráveis por equipamento (Frente A).
-- Tarifas por equipamento e cliente, com vigência (nunca alteradas: cada mudança é uma nova vigência),
-- e usos reais do equipamento nas OS (início e fim). As diárias são calculadas na aplicação
-- (lib/recoverables.ts) e nunca gravadas. Novo acesso adicional "financeiro".

ALTER TABLE members DROP CONSTRAINT IF EXISTS member_capabilities;
ALTER TABLE members ADD CONSTRAINT member_capabilities CHECK (capabilities <@ ARRAY['abastecimento','planejamento','operacao','manutencao','cadastros','acompanhamento','financeiro']::text[]);

CREATE TABLE IF NOT EXISTS recovery_rates (
  id text PRIMARY KEY,
  equipment_id text NOT NULL REFERENCES equipment(id),
  org_id text NOT NULL REFERENCES requester_orgs(id),
  hourly_cents integer NOT NULL CHECK (hourly_cents >= 0 AND hourly_cents <= 100000000),
  hours_per_day integer NOT NULL CHECK (hours_per_day BETWEEN 1 AND 168),
  valid_from text NOT NULL CHECK (valid_from ~ '^\d{4}-\d{2}-\d{2}$'),
  active smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL,
  UNIQUE (equipment_id, org_id, valid_from)
);

CREATE OR REPLACE FUNCTION nautilus_recovery_rate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Tarifa não pode ser alterada: cadastre uma nova vigência';
END $$;
CREATE OR REPLACE TRIGGER recovery_rate_guard BEFORE UPDATE OR DELETE ON recovery_rates FOR EACH ROW EXECUTE FUNCTION nautilus_recovery_rate_guard();

CREATE TABLE IF NOT EXISTS equipment_uses (
  id text PRIMARY KEY,
  work_order_id text NOT NULL REFERENCES work_orders(id),
  equipment_id text NOT NULL REFERENCES equipment(id),
  org_id text NOT NULL REFERENCES requester_orgs(id),
  started_at text NOT NULL,
  ended_at text,
  end_source text CHECK (end_source IN ('registrado','etapa','cancelamento')),
  review text NOT NULL DEFAULT 'normal' CHECK (review IN ('normal','a_conferir','conferido')),
  started_by text NOT NULL REFERENCES members(id),
  started_by_name text NOT NULL,
  ended_by text REFERENCES members(id),
  ended_by_name text,
  reviewed_by text REFERENCES members(id),
  reviewed_by_name text,
  reviewed_at text,
  operation_key text NOT NULL UNIQUE,
  created_at text NOT NULL,
  CONSTRAINT use_end_source CHECK ((ended_at IS NULL) = (end_source IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_equipment_uses_equipment ON equipment_uses(equipment_id, started_at);
CREATE INDEX IF NOT EXISTS idx_equipment_uses_order ON equipment_uses(work_order_id);

-- Uso não é apagado; identidade não muda; início ou fim já registrado só muda pela correção de quem
-- tem o acesso Financeiro ou é da Gestão (registrar o fim de um uso aberto é livre); fim depois do
-- início; o mesmo equipamento não tem dois usos ao mesmo tempo (encostar é permitido; uso em aberto
-- ocupa até ser encerrado).
CREATE OR REPLACE FUNCTION nautilus_equipment_use_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE clash integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Uso de equipamento não pode ser apagado'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.work_order_id <> OLD.work_order_id OR NEW.equipment_id <> OLD.equipment_id OR NEW.org_id <> OLD.org_id
     OR NEW.operation_key <> OLD.operation_key OR NEW.started_by <> OLD.started_by) THEN
    RAISE EXCEPTION 'Uso de equipamento não pode ser alterado';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.started_at <> OLD.started_at OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at))
     AND NOT (NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at AND EXISTS (SELECT 1 FROM members WHERE id = NEW.reviewed_by AND active = 1
      AND (profile = 'manager' OR 'financeiro' = ANY(capabilities)))) THEN
    RAISE EXCEPTION 'Início ou fim do uso só muda pela correção do Financeiro';
  END IF;
  IF NEW.ended_at IS NOT NULL AND NEW.ended_at::timestamptz <= NEW.started_at::timestamptz THEN
    RAISE EXCEPTION 'Fim do uso deve ser depois do início';
  END IF;
  PERFORM 1 FROM equipment WHERE id = NEW.equipment_id FOR UPDATE;
  SELECT w.number INTO clash FROM equipment_uses u JOIN work_orders w ON w.id = u.work_order_id
   WHERE u.equipment_id = NEW.equipment_id AND u.id <> NEW.id
     AND tstzrange(u.started_at::timestamptz, coalesce(u.ended_at::timestamptz, 'infinity'), '[)')
      && tstzrange(NEW.started_at::timestamptz, coalesce(NEW.ended_at::timestamptz, 'infinity'), '[)')
   LIMIT 1;
  IF clash IS NOT NULL THEN RAISE EXCEPTION 'Equipamento já em uso no período' USING DETAIL = clash::text; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER equipment_use_guard BEFORE INSERT OR UPDATE OR DELETE ON equipment_uses FOR EACH ROW EXECUTE FUNCTION nautilus_equipment_use_guard();

-- Auditoria: mesmas regras da 0016, com as ações do Financeiro para quem tem o acesso.
CREATE OR REPLACE FUNCTION nautilus_audit_actor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.author_id AND active = 1 AND (
      profile = 'manager'
      OR (NEW.action = 'Senha definida pelo usuário' AND NEW.entity_id = NEW.author_id)
      OR (profile = 'planner' AND 'abastecimento' = ANY(capabilities) AND NEW.action IN ('Abastecimento agendado','Abastecimento reagendado','Solicitação de abastecimento cancelada'))
      OR (profile = 'fueler' AND NEW.action = 'Abastecimento registrado')
      OR ('abastecimento' = ANY(capabilities) AND NEW.action IN ('Abastecimento solicitado','Solicitação de abastecimento cancelada')
          AND EXISTS (SELECT 1 FROM appointments WHERE id = NEW.entity_id AND requester_id = NEW.author_id))
      OR ('cadastros' = ANY(capabilities) AND NEW.action LIKE 'Cadastros gerais:%')
      OR ('planejamento' = ANY(capabilities) AND (NEW.action LIKE 'Fluxo:%' OR NEW.action LIKE 'Planejamento:%'))
      OR (('cadastros' = ANY(capabilities) OR 'manutencao' = ANY(capabilities)) AND NEW.action = 'Condição técnica: impedimento registrado')
      OR ('manutencao' = ANY(capabilities) AND (NEW.action = 'Condição técnica: liberação técnica' OR NEW.action LIKE 'Manutenção:%'))
      OR ('operacao' = ANY(capabilities) AND (NEW.action LIKE 'Operação:%' OR NEW.action = 'Condição técnica: NC crítica' OR NEW.action = 'Manutenção: leitura registrada'))
      OR ('financeiro' = ANY(capabilities) AND NEW.action LIKE 'Financeiro:%')
      -- Exportações (planilha e relatório da OS): o acesso é conferido pelo servidor; aqui só se registra quem exportou.
      OR (NEW.action LIKE 'Exportação:%' AND NEW.entity_id IS NOT NULL
          AND ('planejamento' = ANY(capabilities) OR 'acompanhamento' = ANY(capabilities) OR 'operacao' = ANY(capabilities) OR 'financeiro' = ANY(capabilities)))
    )) THEN
    RAISE EXCEPTION 'Auditoria sem autorização';
  END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['recovery_rates','equipment_uses'] LOOP
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
