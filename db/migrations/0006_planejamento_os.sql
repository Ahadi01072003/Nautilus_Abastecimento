-- NAUTILUS · Fase 3: planejamento de atividade, OS, reservas com intertravamento,
-- impedimentos técnicos (liberação técnica), anexos e escopo por organização.

-- Perfil "sem abastecimento" (ex.: clientes que só acompanham OS) e novos acessos adicionais.
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_profile_check;
ALTER TABLE members ADD CONSTRAINT members_profile_check CHECK (profile IN ('requester','planner','fueler','manager','none'));
ALTER TABLE members DROP CONSTRAINT IF EXISTS member_capabilities;
ALTER TABLE members ADD CONSTRAINT member_capabilities CHECK (capabilities <@ ARRAY['cadastros','planejamento','acompanhamento','manutencao']::text[]);
-- Escopo de organizações solicitantes: vazio = todas; preenchido = somente as OS dessas organizações.
ALTER TABLE members ADD COLUMN IF NOT EXISTS org_scope text[] NOT NULL DEFAULT '{}';

-- Configurações internas do servidor (ex.: credencial do serviço de anexos). Nunca vão para a tela.
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at text NOT NULL
);

-- Impedimentos técnicos do equipamento: independentes de reservas e de uso.
CREATE TABLE IF NOT EXISTS equipment_impediments (
  id text PRIMARY KEY,
  equipment_id text NOT NULL REFERENCES equipment(id),
  kind text NOT NULL CHECK (kind IN ('nc_critica','manual')),
  reason text NOT NULL,
  source_ref text,
  opened_at text NOT NULL,
  opened_by text NOT NULL REFERENCES members(id),
  opened_by_name text NOT NULL,
  released_at text,
  released_by text REFERENCES members(id),
  released_by_name text,
  release_reason text,
  release_evidence text,
  CONSTRAINT impediment_release CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_impediments_open ON equipment_impediments(equipment_id) WHERE released_at IS NULL;

-- Impedimento nunca é apagado nem reescrito; só recebe a liberação técnica, uma vez,
-- por gestor ou por quem tem o acesso "Liberação técnica".
CREATE OR REPLACE FUNCTION nautilus_impediment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Impedimento técnico não pode ser apagado'; END IF;
  IF OLD.released_at IS NOT NULL OR NEW.equipment_id <> OLD.equipment_id OR NEW.kind <> OLD.kind OR NEW.reason <> OLD.reason
     OR NEW.opened_at <> OLD.opened_at OR NEW.opened_by <> OLD.opened_by OR NEW.source_ref IS DISTINCT FROM OLD.source_ref THEN
    RAISE EXCEPTION 'Impedimento técnico não pode ser alterado';
  END IF;
  IF NEW.released_at IS NULL THEN RAISE EXCEPTION 'Impedimento técnico não pode ser alterado'; END IF;
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.released_by AND active = 1 AND (profile = 'manager' OR 'manutencao' = ANY(capabilities))) THEN
    RAISE EXCEPTION 'Liberação técnica sem autorização';
  END IF;
  IF length(trim(coalesce(NEW.release_reason,''))) = 0 THEN RAISE EXCEPTION 'Liberação técnica exige justificativa'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER impediment_guard BEFORE UPDATE OR DELETE ON equipment_impediments FOR EACH ROW EXECUTE FUNCTION nautilus_impediment_guard();

-- Ordens de serviço: número legível separado do ID interno.
CREATE SEQUENCE IF NOT EXISTS work_order_number_seq;
CREATE TABLE IF NOT EXISTS work_orders (
  id text PRIMARY KEY,
  number integer NOT NULL UNIQUE DEFAULT nextval('work_order_number_seq'),
  status text NOT NULL DEFAULT 'programada' CHECK (status IN ('programada','em_andamento','encerramento_pendente','concluida','cancelada')),
  current_plan_id text NOT NULL,
  original_plan_id text NOT NULL,
  activity_type_id text NOT NULL REFERENCES activity_types(id),
  org_id text NOT NULL REFERENCES requester_orgs(id),
  location_id text REFERENCES locations(id),
  planned_start text NOT NULL,
  planned_end text NOT NULL,
  actual_start text,
  actual_end text,
  closed_at text,
  launched_at text NOT NULL,
  launched_by text NOT NULL REFERENCES members(id),
  launched_by_name text NOT NULL,
  cancelled_at text,
  cancelled_by text REFERENCES members(id),
  cancel_reason text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_work_orders_org ON work_orders(org_id);

-- Planejamento: rascunho (editável) ou versão lançada (congelada) de uma OS.
CREATE TABLE IF NOT EXISTS plans (
  id text PRIMARY KEY,
  work_order_id text REFERENCES work_orders(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','launched','discarded','superseded')),
  activity_type_id text NOT NULL REFERENCES activity_types(id),
  flow_version_id text NOT NULL REFERENCES flow_versions(id),
  description text NOT NULL DEFAULT '',
  org_id text REFERENCES requester_orgs(id),
  requester_person_id text REFERENCES requester_people(id),
  location_id text REFERENCES locations(id),
  planned_start text,
  planned_end text,
  author_id text NOT NULL REFERENCES members(id),
  author_name text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  version integer NOT NULL DEFAULT 0,
  launch_key text UNIQUE,
  launched_at text,
  launched_by text REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_plans_author ON plans(author_id) WHERE status = 'draft';
ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_current_plan_fk;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_current_plan_fk FOREIGN KEY (current_plan_id) REFERENCES plans(id);
ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_original_plan_fk;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_original_plan_fk FOREIGN KEY (original_plan_id) REFERENCES plans(id);

CREATE TABLE IF NOT EXISTS plan_steps (
  id text PRIMARY KEY,
  plan_id text NOT NULL REFERENCES plans(id),
  step_key text NOT NULL,
  position integer NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  required integer NOT NULL CHECK (required IN (0,1)),
  included integer NOT NULL DEFAULT 1 CHECK (included IN (0,1)),
  default_minutes integer,
  depends_on text[] NOT NULL DEFAULT '{}',
  planned_start text,
  planned_end text,
  location_id text REFERENCES locations(id),
  UNIQUE (plan_id, step_key),
  UNIQUE (plan_id, id),
  CONSTRAINT required_included CHECK (required = 0 OR included = 1)
);

CREATE TABLE IF NOT EXISTS plan_step_needs (
  id text PRIMARY KEY,
  plan_id text NOT NULL,
  plan_step_id text NOT NULL,
  equipment_type_id text REFERENCES equipment_types(id),
  function_id text REFERENCES job_functions(id),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  FOREIGN KEY (plan_id, plan_step_id) REFERENCES plan_steps(plan_id, id),
  CONSTRAINT plan_need_target CHECK (num_nonnulls(equipment_type_id, function_id) = 1)
);

CREATE TABLE IF NOT EXISTS plan_step_people (
  plan_id text NOT NULL,
  plan_step_id text NOT NULL,
  operator_id text NOT NULL REFERENCES operators(id),
  PRIMARY KEY (plan_step_id, operator_id),
  FOREIGN KEY (plan_id, plan_step_id) REFERENCES plan_steps(plan_id, id)
);

-- Reserva de equipamento identificado. Provisória (rascunho) e confirmada (OS) têm a
-- mesma exclusividade; liberada não reserva mais nada.
CREATE TABLE IF NOT EXISTS reservations (
  id text PRIMARY KEY,
  plan_id text NOT NULL,
  plan_step_id text NOT NULL,
  equipment_id text NOT NULL REFERENCES equipment(id),
  start_at text NOT NULL,
  end_at text NOT NULL,
  status text NOT NULL CHECK (status IN ('provisoria','confirmada','liberada')),
  created_at text NOT NULL,
  released_at text,
  release_reason text,
  FOREIGN KEY (plan_id, plan_step_id) REFERENCES plan_steps(plan_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS reservations_step_equipment ON reservations(plan_step_id, equipment_id) WHERE status <> 'liberada';
CREATE INDEX IF NOT EXISTS idx_reservations_equipment ON reservations(equipment_id) WHERE status <> 'liberada';

-- Intertravamento garantido no banco: trava a linha do equipamento (serializa reservas e
-- impedimentos concorrentes) e recusa sobreposição [início, fim) ou equipamento bloqueado.
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
  IF EXISTS (SELECT 1 FROM equipment_impediments WHERE equipment_id = NEW.equipment_id AND released_at IS NULL) THEN
    RAISE EXCEPTION 'Equipamento bloqueado por impedimento técnico';
  END IF;
  SELECT r.id INTO other FROM reservations r
   WHERE r.equipment_id = NEW.equipment_id AND r.id <> NEW.id AND r.status <> 'liberada'
     AND r.start_at::timestamptz < e AND r.end_at::timestamptz > s LIMIT 1;
  IF other IS NOT NULL THEN RAISE EXCEPTION 'Equipamento reservado no período' USING DETAIL = other; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER reservation_guard BEFORE INSERT OR UPDATE OF start_at, end_at, status, equipment_id ON reservations
  FOR EACH ROW EXECUTE FUNCTION nautilus_reservation_guard();

-- Impedimento novo trava a mesma linha do equipamento: reserva e bloqueio nunca passam "por fora" um do outro.
CREATE OR REPLACE FUNCTION nautilus_impediment_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM equipment WHERE id = NEW.equipment_id FOR UPDATE;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER impediment_lock BEFORE INSERT ON equipment_impediments FOR EACH ROW EXECUTE FUNCTION nautilus_impediment_lock();

-- Planejamento lançado fica congelado: etapas, necessidades e pessoas só mudam em rascunho.
CREATE OR REPLACE FUNCTION nautilus_plan_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid text; st text;
BEGIN
  pid := CASE WHEN TG_OP = 'DELETE' THEN OLD.plan_id ELSE NEW.plan_id END;
  SELECT status INTO st FROM plans WHERE id = pid;
  IF st IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Planejamento lançado não pode ser alterado'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['plan_steps','plan_step_needs','plan_step_people'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_frozen', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION nautilus_plan_frozen()', t || '_frozen', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION nautilus_plan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Planejamento não pode ser apagado'; END IF;
  IF OLD.status <> 'draft' AND NOT (OLD.status = 'launched' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'Planejamento lançado não pode ser alterado';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER plan_guard BEFORE UPDATE OR DELETE ON plans FOR EACH ROW EXECUTE FUNCTION nautilus_plan_guard();

-- Instâncias de execução das etapas, criadas no lançamento (identidade estável).
CREATE TABLE IF NOT EXISTS os_steps (
  id text PRIMARY KEY,
  work_order_id text NOT NULL REFERENCES work_orders(id),
  step_key text NOT NULL,
  plan_step_id text NOT NULL REFERENCES plan_steps(id),
  status text NOT NULL DEFAULT 'nao_iniciada' CHECK (status IN ('nao_iniciada','em_execucao','bloqueada','pausada','concluida','dispensada')),
  actual_start text,
  actual_end text,
  UNIQUE (work_order_id, step_key)
);

-- Documentos do planejamento (OS inteira ou etapa). O arquivo fica em armazenamento privado.
CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  plan_id text NOT NULL REFERENCES plans(id),
  step_key text,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  purpose text NOT NULL DEFAULT '',
  original_name text NOT NULL,
  mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','application/pdf')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  storage_path text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','pronto','recusado','removido')),
  author_id text NOT NULL REFERENCES members(id),
  author_name text NOT NULL,
  created_at text NOT NULL,
  ready_at text
);
CREATE INDEX IF NOT EXISTS idx_attachments_plan ON attachments(plan_id);

-- Auditoria: ações do planejamento e da condição técnica.
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
