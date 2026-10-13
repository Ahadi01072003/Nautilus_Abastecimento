-- NAUTILUS · Operação: execução por etapa, intervalos, apontamentos, checklists na OS,
-- NC crítica com bloqueio global, encerramento automático e auditoria imutável.

-- Acesso "Operação" (executa etapas, aponta e preenche checklists).
ALTER TABLE members DROP CONSTRAINT IF EXISTS member_capabilities;
ALTER TABLE members ADD CONSTRAINT member_capabilities CHECK (capabilities <@ ARRAY['cadastros','planejamento','acompanhamento','manutencao','operacao']::text[]);

ALTER TABLE os_steps ADD COLUMN IF NOT EXISTS dispensed_reason text;
ALTER TABLE os_steps DROP CONSTRAINT IF EXISTS os_steps_order_id_key;
ALTER TABLE os_steps ADD CONSTRAINT os_steps_order_id_key UNIQUE (work_order_id, id);

-- Eventos de execução: o registro autoritativo do que aconteceu. Nunca são reescritos.
CREATE TABLE IF NOT EXISTS execution_events (
  id text PRIMARY KEY,
  work_order_id text NOT NULL REFERENCES work_orders(id),
  os_step_id text,
  kind text NOT NULL CHECK (kind IN ('inicio','bloqueio','pausa','retomada','termino','dispensa','encerramento','encerramento_pendente','nc_critica','interrupcao_tecnica')),
  occurred_at text NOT NULL,
  registered_at text NOT NULL,
  author_id text NOT NULL REFERENCES members(id),
  author_name text NOT NULL,
  operation_key text NOT NULL UNIQUE,
  detail jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (work_order_id, os_step_id) REFERENCES os_steps(work_order_id, id)
);
CREATE INDEX IF NOT EXISTS idx_events_order ON execution_events(work_order_id);

-- Intervalos da etapa: ativo (execução efetiva) e interrompido (bloqueio/pausa).
CREATE TABLE IF NOT EXISTS step_intervals (
  id text PRIMARY KEY,
  os_step_id text NOT NULL REFERENCES os_steps(id),
  kind text NOT NULL CHECK (kind IN ('ativo','interrompido')),
  start_at text NOT NULL,
  end_at text,
  start_event_id text NOT NULL REFERENCES execution_events(id),
  end_event_id text REFERENCES execution_events(id)
);
-- No máximo um intervalo aberto por etapa (ativo ou interrompido).
CREATE UNIQUE INDEX IF NOT EXISTS step_intervals_one_open ON step_intervals(os_step_id) WHERE end_at IS NULL;

-- Apontamentos: ocorrência, impacto (com ou sem bloqueio) e bloqueio. Sempre ligados a uma etapa da mesma OS.
CREATE TABLE IF NOT EXISTS occurrences (
  id text PRIMARY KEY,
  work_order_id text NOT NULL,
  os_step_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ocorrencia','impacto','bloqueio')),
  blocking integer NOT NULL DEFAULT 0 CHECK (blocking IN (0,1)),
  category_id text REFERENCES occurrence_categories(id),
  description text NOT NULL,
  severity text CHECK (severity IN ('baixa','media','alta')),
  equipment_id text REFERENCES equipment(id),
  impediment_id text REFERENCES equipment_impediments(id),
  impact_start text,
  impact_end text,
  occurred_at text NOT NULL,
  registered_at text NOT NULL,
  late integer NOT NULL DEFAULT 0 CHECK (late IN (0,1)),
  author_id text NOT NULL REFERENCES members(id),
  author_name text NOT NULL,
  status text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','resolvido')),
  resolved_at text,
  resolved_by text REFERENCES members(id),
  resolved_by_name text,
  resolution text,
  operation_key text NOT NULL UNIQUE,
  FOREIGN KEY (work_order_id, os_step_id) REFERENCES os_steps(work_order_id, id),
  CONSTRAINT blocking_kind CHECK (blocking = 0 OR kind IN ('impacto','bloqueio')),
  CONSTRAINT bloqueio_blocks CHECK (kind <> 'bloqueio' OR blocking = 1),
  CONSTRAINT occurrence_resolved CHECK ((status = 'resolvido') = (resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_occurrences_order ON occurrences(work_order_id);

-- Apontamento não é apagado nem reescrito: só pode ser resolvido (uma vez).
CREATE OR REPLACE FUNCTION nautilus_occurrence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Apontamento não pode ser apagado'; END IF;
  IF OLD.status = 'resolvido' OR NEW.status <> 'resolvido' OR NEW.description <> OLD.description OR NEW.kind <> OLD.kind
     OR NEW.os_step_id <> OLD.os_step_id OR NEW.occurred_at <> OLD.occurred_at OR NEW.blocking <> OLD.blocking THEN
    RAISE EXCEPTION 'Apontamento não pode ser alterado';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER occurrence_guard BEFORE UPDATE OR DELETE ON occurrences FOR EACH ROW EXECUTE FUNCTION nautilus_occurrence_guard();

-- Checklists previstos na OS (versão fixada no lançamento) e preenchimentos.
ALTER TABLE checklist_versions DROP CONSTRAINT IF EXISTS checklist_versions_id_version_key;
ALTER TABLE checklist_versions ADD CONSTRAINT checklist_versions_id_version_key UNIQUE (id, template_id);
ALTER TABLE checklist_questions DROP CONSTRAINT IF EXISTS checklist_questions_version_id_key;
ALTER TABLE checklist_questions ADD CONSTRAINT checklist_questions_version_id_key UNIQUE (version_id, id);

CREATE TABLE IF NOT EXISTS checklist_requirements (
  id text PRIMARY KEY,
  work_order_id text NOT NULL REFERENCES work_orders(id),
  version_id text NOT NULL REFERENCES checklist_versions(id),
  equipment_id text REFERENCES equipment(id),
  mandatory integer NOT NULL CHECK (mandatory IN (0,1)),
  moment text NOT NULL CHECK (moment IN ('pre_atividade','pre_uso','durante','pos_atividade')),
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS checklist_requirements_unique ON checklist_requirements(work_order_id, version_id, coalesce(equipment_id,''));

CREATE TABLE IF NOT EXISTS checklist_instances (
  id text PRIMARY KEY,
  work_order_id text NOT NULL REFERENCES work_orders(id),
  requirement_id text REFERENCES checklist_requirements(id),
  version_id text NOT NULL REFERENCES checklist_versions(id),
  equipment_id text REFERENCES equipment(id),
  os_step_id text,
  status text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','concluido')),
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL,
  completed_at text,
  completed_by text REFERENCES members(id),
  completed_by_name text,
  operation_key text NOT NULL UNIQUE,
  UNIQUE (id, version_id),
  FOREIGN KEY (work_order_id, os_step_id) REFERENCES os_steps(work_order_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS checklist_instances_requirement ON checklist_instances(requirement_id) WHERE requirement_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS checklist_answers (
  instance_id text NOT NULL,
  version_id text NOT NULL,
  question_id text NOT NULL,
  answer text NOT NULL CHECK (answer IN ('C','NC','NA')),
  note text NOT NULL DEFAULT '',
  answered_at text NOT NULL,
  answered_by text NOT NULL REFERENCES members(id),
  answered_by_name text NOT NULL,
  PRIMARY KEY (instance_id, question_id),
  FOREIGN KEY (instance_id, version_id) REFERENCES checklist_instances(id, version_id),
  FOREIGN KEY (version_id, question_id) REFERENCES checklist_questions(version_id, id)
);

-- Preenchimento concluído não muda mais (correção = novo preenchimento).
CREATE OR REPLACE FUNCTION nautilus_answer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM checklist_instances WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.instance_id ELSE NEW.instance_id END;
  IF st = 'concluido' THEN RAISE EXCEPTION 'Checklist concluído não pode ser alterado'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Resposta não pode ser apagada'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER answer_guard BEFORE INSERT OR UPDATE OR DELETE ON checklist_answers FOR EACH ROW EXECUTE FUNCTION nautilus_answer_guard();

CREATE OR REPLACE FUNCTION nautilus_instance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Checklist não pode ser apagado'; END IF;
  IF OLD.status = 'concluido' THEN RAISE EXCEPTION 'Checklist concluído não pode ser alterado'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER instance_guard BEFORE UPDATE OR DELETE ON checklist_instances FOR EACH ROW EXECUTE FUNCTION nautilus_instance_guard();

-- Eventos e intervalos fechados são imutáveis; intervalo aberto só pode ser fechado.
CREATE OR REPLACE FUNCTION nautilus_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Evento de execução não pode ser alterado'; END $$;
CREATE OR REPLACE TRIGGER event_guard BEFORE UPDATE OR DELETE ON execution_events FOR EACH ROW EXECUTE FUNCTION nautilus_event_guard();
CREATE OR REPLACE FUNCTION nautilus_interval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.end_at IS NOT NULL OR NEW.end_at IS NULL OR NEW.start_at <> OLD.start_at OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'Intervalo de execução não pode ser alterado';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER interval_guard BEFORE UPDATE OR DELETE ON step_intervals FOR EACH ROW EXECUTE FUNCTION nautilus_interval_guard();

-- Auditoria imutável.
CREATE OR REPLACE FUNCTION nautilus_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Auditoria não pode ser alterada'; END $$;
DROP TRIGGER IF EXISTS audit_immutable ON audits;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audits FOR EACH ROW EXECUTE FUNCTION nautilus_audit_immutable();

-- Equipamento em uso real (etapa iniciada e não concluída) continua ocupado mesmo
-- depois do fim previsto: a reserva dele conta como aberta até o término.
CREATE OR REPLACE FUNCTION nautilus_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s timestamptz; e timestamptz; other text;
BEGIN
  IF NEW.status = 'liberada' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'liberada' THEN RAISE EXCEPTION 'Reserva liberada não pode ser reativada'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'liberada' THEN RAISE EXCEPTION 'Reserva liberada não pode ser reativada'; END IF;
  s := NEW.start_at::timestamptz; e := NEW.end_at::timestamptz;
  IF e <= s THEN RAISE EXCEPTION 'Reserva com período inválido'; END IF;
  PERFORM 1 FROM equipment WHERE id = NEW.equipment_id AND active = 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Equipamento indisponível para reserva'; END IF;
  -- Promover a confirmada ou ajustar o fim de uma reserva já confirmada (término real) não reavalia a condição técnica.
  IF NOT (TG_OP = 'UPDATE' AND OLD.status = 'confirmada' AND NEW.status = 'confirmada' AND NEW.start_at = OLD.start_at AND NEW.end_at::timestamptz <= OLD.end_at::timestamptz)
     AND EXISTS (SELECT 1 FROM equipment_impediments WHERE equipment_id = NEW.equipment_id AND released_at IS NULL) THEN
    RAISE EXCEPTION 'Equipamento bloqueado por impedimento técnico';
  END IF;
  SELECT r.id INTO other FROM reservations r
   LEFT JOIN os_steps o ON o.plan_step_id = r.plan_step_id AND o.status IN ('em_execucao','bloqueada','pausada')
   WHERE r.equipment_id = NEW.equipment_id AND r.id <> NEW.id AND r.status <> 'liberada'
     AND r.start_at::timestamptz < e AND (CASE WHEN o.id IS NOT NULL THEN 'infinity'::timestamptz ELSE r.end_at::timestamptz END) > s LIMIT 1;
  IF other IS NOT NULL THEN RAISE EXCEPTION 'Equipamento reservado no período' USING DETAIL = other; END IF;
  RETURN NEW;
END $$;

-- Auditoria: ações da Operação.
CREATE OR REPLACE FUNCTION nautilus_audit_actor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.author_id AND active = 1 AND (
      profile = 'manager'
      OR (NEW.action = 'Senha definida pelo usuário' AND NEW.entity_id = NEW.author_id)
      OR (profile = 'planner' AND NEW.action IN ('Abastecimento agendado','Abastecimento reagendado','Solicitação de abastecimento cancelada'))
      OR (profile = 'fueler' AND NEW.action = 'Abastecimento registrado')
      OR (profile = 'requester' AND NEW.action IN ('Abastecimento solicitado','Solicitação de abastecimento cancelada')
          AND EXISTS (SELECT 1 FROM appointments WHERE id = NEW.entity_id AND requester_id = NEW.author_id))
      OR ('cadastros' = ANY(capabilities) AND NEW.action LIKE 'Cadastros gerais:%')
      OR ('planejamento' = ANY(capabilities) AND (NEW.action LIKE 'Fluxo:%' OR NEW.action LIKE 'Planejamento:%'))
      OR (('cadastros' = ANY(capabilities) OR 'manutencao' = ANY(capabilities)) AND NEW.action = 'Condição técnica: impedimento registrado')
      OR ('manutencao' = ANY(capabilities) AND NEW.action = 'Condição técnica: liberação técnica')
      OR ('operacao' = ANY(capabilities) AND (NEW.action LIKE 'Operação:%' OR NEW.action = 'Condição técnica: NC crítica'))
    )) THEN
    RAISE EXCEPTION 'Auditoria sem autorização';
  END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.proname LIKE 'nautilus\_%' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I', f, current_schema());
  END LOOP;
END $$;

DO $$ DECLARE t text; r text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
