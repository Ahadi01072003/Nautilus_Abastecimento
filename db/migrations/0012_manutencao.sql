-- NAUTILUS · Manutenção: critérios (planos de preventiva por equipamento), leituras de horímetro e
-- odômetro, registros de preventiva e corretiva com apontamentos, e parada do equipamento.
-- Nada é apagado: leituras e registros podem ser anulados (com motivo), nunca reescritos.

-- Critério de manutenção preventiva de um equipamento. O ciclo é calculado pelo sistema a partir
-- do marco zero (data ou leitura) e do intervalo; a abrangência é a tolerância antes do vermelho.
CREATE TABLE IF NOT EXISTS maintenance_plans (
  id text PRIMARY KEY,
  equipment_id text NOT NULL REFERENCES equipment(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  method text NOT NULL CHECK (method IN ('dias','horimetro','odometro')),
  interval_value numeric(12,1) NOT NULL CHECK (interval_value > 0 AND interval_value <= 10000000),
  tolerance_value numeric(12,1) NOT NULL DEFAULT 0 CHECK (tolerance_value >= 0 AND tolerance_value <= 10000000),
  anchor_date text CHECK (anchor_date IS NULL OR anchor_date ~ '^\d{4}-\d{2}-\d{2}$'),
  anchor_reading numeric(12,1) CHECK (anchor_reading IS NULL OR anchor_reading >= 0),
  cycle_mode text NOT NULL DEFAULT 'fixo' CHECK (cycle_mode IN ('fixo','execucao')),
  tasks jsonb NOT NULL DEFAULT '[]',
  attention jsonb NOT NULL DEFAULT '[]',
  nonconformities jsonb NOT NULL DEFAULT '[]',
  estimated_minutes integer CHECK (estimated_minutes IS NULL OR estimated_minutes BETWEEN 1 AND 100000),
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  version integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  updated_at text NOT NULL,
  CONSTRAINT plan_anchor CHECK ((method = 'dias' AND anchor_date IS NOT NULL AND anchor_reading IS NULL)
    OR (method <> 'dias' AND anchor_reading IS NOT NULL AND anchor_date IS NULL)),
  CONSTRAINT plan_lists CHECK (jsonb_typeof(tasks) = 'array' AND jsonb_typeof(attention) = 'array' AND jsonb_typeof(nonconformities) = 'array')
);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_plans_name_key ON maintenance_plans (equipment_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_equipment ON maintenance_plans (equipment_id);

-- Leituras de horímetro e odômetro digitadas (as de horímetro dos abastecimentos entram pela consulta).
CREATE TABLE IF NOT EXISTS equipment_readings (
  id text PRIMARY KEY,
  equipment_id text NOT NULL REFERENCES equipment(id),
  kind text NOT NULL CHECK (kind IN ('horimetro','odometro')),
  value numeric(12,1) NOT NULL CHECK (value >= 0 AND value <= 100000000),
  read_at text NOT NULL,
  registered_at text NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','manutencao')),
  record_id text,
  note text NOT NULL DEFAULT '',
  author_id text NOT NULL REFERENCES members(id),
  author_name text NOT NULL,
  voided_at text,
  voided_by text REFERENCES members(id),
  void_reason text,
  CONSTRAINT reading_void CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_readings_equipment ON equipment_readings (equipment_id, kind, read_at);

-- Todas as leituras válidas (digitadas e de abastecimentos), na mesma forma.
CREATE OR REPLACE VIEW equipment_meter WITH (security_invoker = true) AS
  SELECT r.equipment_id, r.kind, r.value::numeric value, r.read_at, r.source, r.id ref_id, r.author_name
    FROM equipment_readings r WHERE r.voided_at IS NULL
  UNION ALL
  SELECT s.equipment_id, 'horimetro', greatest(s.hourmeter_milli, coalesce(s.hourmeter_end_milli, 0)) / 1000.0, s.occurred_at, 'abastecimento', s.id, s.author_name
    FROM supplies s WHERE s.status = 'confirmed' AND s.hourmeter_milli IS NOT NULL;

-- Leitura nunca volta, nunca fica acima de uma leitura posterior e o horímetro não anda mais
-- que o tempo corrido. Anulação (gestor, com motivo) é a única alteração permitida.
CREATE OR REPLACE FUNCTION nautilus_reading_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev record; nxt record; t timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Leitura não pode ser apagada'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL OR NEW.value <> OLD.value OR NEW.read_at <> OLD.read_at OR NEW.kind <> OLD.kind OR NEW.equipment_id <> OLD.equipment_id THEN
      RAISE EXCEPTION 'Leitura não pode ser alterada';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.voided_by AND active = 1 AND profile = 'manager') THEN RAISE EXCEPTION 'Anulação de leitura exige gestor'; END IF;
    IF length(trim(coalesce(NEW.void_reason,''))) = 0 THEN RAISE EXCEPTION 'Anulação de leitura exige motivo'; END IF;
    RETURN NEW;
  END IF;
  t := NEW.read_at::timestamptz;
  IF t > now() + interval '5 minutes' THEN RAISE EXCEPTION 'Leitura com data no futuro'; END IF;
  PERFORM 1 FROM equipment WHERE id = NEW.equipment_id FOR UPDATE;
  SELECT value, read_at INTO prev FROM equipment_meter WHERE equipment_id = NEW.equipment_id AND kind = NEW.kind AND read_at::timestamptz <= t ORDER BY read_at::timestamptz DESC, value DESC LIMIT 1;
  SELECT value, read_at INTO nxt FROM equipment_meter WHERE equipment_id = NEW.equipment_id AND kind = NEW.kind AND read_at::timestamptz > t ORDER BY read_at::timestamptz ASC, value ASC LIMIT 1;
  IF prev.value IS NOT NULL AND NEW.value < prev.value THEN
    RAISE EXCEPTION 'Leitura menor que a anterior' USING DETAIL = prev.value::text;
  END IF;
  IF nxt.value IS NOT NULL AND NEW.value > nxt.value THEN
    RAISE EXCEPTION 'Leitura maior que uma leitura posterior' USING DETAIL = nxt.value::text;
  END IF;
  IF NEW.kind = 'horimetro' AND prev.value IS NOT NULL
     AND NEW.value - prev.value > extract(epoch FROM (t - prev.read_at::timestamptz)) / 3600 + 1 THEN
    RAISE EXCEPTION 'Horímetro avançou mais que o tempo decorrido';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER reading_guard BEFORE INSERT OR UPDATE OR DELETE ON equipment_readings FOR EACH ROW EXECUTE FUNCTION nautilus_reading_guard();

-- Impedimento aberto por corretiva com o equipamento parado.
ALTER TABLE equipment_impediments DROP CONSTRAINT IF EXISTS equipment_impediments_kind_check;
ALTER TABLE equipment_impediments ADD CONSTRAINT equipment_impediments_kind_check CHECK (kind IN ('nc_critica','manual','manutencao'));

-- Registros de manutenção. Preventiva atende um marco (ciclo) de um critério; corretiva é avulsa.
CREATE TABLE IF NOT EXISTS maintenance_records (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('preventiva','corretiva')),
  equipment_id text NOT NULL REFERENCES equipment(id),
  plan_id text REFERENCES maintenance_plans(id),
  cycle integer CHECK (cycle IS NULL OR cycle >= 1),
  due_label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'em_andamento' CHECK (status IN ('em_andamento','concluida','anulada')),
  started_at text NOT NULL,
  ended_at text,
  responsible_id text REFERENCES operators(id),
  responsible_name text NOT NULL,
  team_ids text[] NOT NULL DEFAULT '{}',
  reading numeric(12,1) CHECK (reading IS NULL OR reading >= 0),
  reading_kind text CHECK (reading_kind IS NULL OR reading_kind IN ('horimetro','odometro')),
  items jsonb NOT NULL DEFAULT '[]',
  nonconformities jsonb NOT NULL DEFAULT '[]',
  notes text NOT NULL DEFAULT '',
  failure text NOT NULL DEFAULT '',
  stopped integer NOT NULL DEFAULT 0 CHECK (stopped IN (0,1)),
  impediment_id text REFERENCES equipment_impediments(id),
  released_impediment_id text REFERENCES equipment_impediments(id),
  late integer NOT NULL DEFAULT 0 CHECK (late IN (0,1)),
  operation_key text NOT NULL UNIQUE,
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL,
  closed_at text,
  closed_by text REFERENCES members(id),
  closed_by_name text,
  voided_at text,
  voided_by text REFERENCES members(id),
  voided_by_name text,
  void_reason text,
  CONSTRAINT record_kind CHECK ((kind = 'preventiva') = (plan_id IS NOT NULL AND cycle IS NOT NULL)),
  CONSTRAINT record_closed CHECK ((status = 'concluida') <= (ended_at IS NOT NULL AND closed_at IS NOT NULL)),
  CONSTRAINT record_void CHECK ((status = 'anulada') = (voided_at IS NOT NULL)),
  CONSTRAINT record_reading CHECK ((reading IS NULL) = (reading_kind IS NULL)),
  CONSTRAINT record_lists CHECK (jsonb_typeof(items) = 'array' AND jsonb_typeof(nonconformities) = 'array')
);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_records_cycle ON maintenance_records (plan_id, cycle) WHERE status <> 'anulada';
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_records_open_plan ON maintenance_records (plan_id) WHERE status = 'em_andamento';
CREATE INDEX IF NOT EXISTS idx_maintenance_records_equipment ON maintenance_records (equipment_id, started_at);

-- Registro em andamento pode ser completado; concluído só pode ser anulado pelo gestor, com motivo.
CREATE OR REPLACE FUNCTION nautilus_maintenance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Registro de manutenção não pode ser apagado'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.started_at::timestamptz > now() + interval '5 minutes' THEN RAISE EXCEPTION 'Manutenção com início no futuro'; END IF;
  ELSE
    IF NEW.kind <> OLD.kind OR NEW.equipment_id <> OLD.equipment_id OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.cycle IS DISTINCT FROM OLD.cycle
       OR NEW.started_at <> OLD.started_at OR NEW.created_by <> OLD.created_by OR NEW.operation_key <> OLD.operation_key THEN
      RAISE EXCEPTION 'Registro de manutenção não pode ser alterado';
    END IF;
    IF OLD.status = 'anulada' THEN RAISE EXCEPTION 'Registro de manutenção não pode ser alterado'; END IF;
    IF OLD.status = 'concluida' AND NOT (NEW.status = 'anulada' AND NEW.ended_at IS NOT DISTINCT FROM OLD.ended_at
       AND NEW.items = OLD.items AND NEW.nonconformities = OLD.nonconformities AND NEW.notes = OLD.notes AND NEW.reading IS NOT DISTINCT FROM OLD.reading) THEN
      RAISE EXCEPTION 'Registro de manutenção concluído não pode ser alterado';
    END IF;
    IF NEW.status = 'anulada' THEN
      IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.voided_by AND active = 1 AND profile = 'manager') THEN RAISE EXCEPTION 'Anulação de manutenção exige gestor'; END IF;
      IF length(trim(coalesce(NEW.void_reason,''))) = 0 THEN RAISE EXCEPTION 'Anulação de manutenção exige motivo'; END IF;
    END IF;
  END IF;
  IF NEW.ended_at IS NOT NULL THEN
    IF NEW.ended_at::timestamptz <= NEW.started_at::timestamptz THEN RAISE EXCEPTION 'Fim da manutenção deve ser depois do início'; END IF;
    IF NEW.ended_at::timestamptz > now() + interval '5 minutes' THEN RAISE EXCEPTION 'Manutenção com fim no futuro'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER maintenance_guard BEFORE INSERT OR UPDATE OR DELETE ON maintenance_records FOR EACH ROW EXECUTE FUNCTION nautilus_maintenance_guard();

-- Apontamentos durante a manutenção: só são acrescentados.
CREATE TABLE IF NOT EXISTS maintenance_notes (
  id text PRIMARY KEY,
  record_id text NOT NULL REFERENCES maintenance_records(id),
  text text NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 2000),
  noted_at text NOT NULL,
  author_id text NOT NULL REFERENCES members(id),
  author_name text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintenance_notes_record ON maintenance_notes (record_id);
CREATE OR REPLACE FUNCTION nautilus_note_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Apontamento de manutenção não pode ser alterado'; END $$;
CREATE OR REPLACE TRIGGER maintenance_note_immutable BEFORE UPDATE OR DELETE ON maintenance_notes FOR EACH ROW EXECUTE FUNCTION nautilus_note_immutable();

-- Auditoria: ações da Manutenção (acesso "Manutenção"); leituras também por quem tem Operação.
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
      OR ('manutencao' = ANY(capabilities) AND (NEW.action = 'Condição técnica: liberação técnica' OR NEW.action LIKE 'Manutenção:%'))
      OR ('operacao' = ANY(capabilities) AND (NEW.action LIKE 'Operação:%' OR NEW.action = 'Condição técnica: NC crítica' OR NEW.action = 'Manutenção: leitura registrada'))
      -- Exportações (planilha e relatório da OS): o acesso é conferido pelo servidor; aqui só se registra quem exportou.
      OR (NEW.action LIKE 'Exportação:%' AND NEW.entity_id IS NOT NULL
          AND ('planejamento' = ANY(capabilities) OR 'acompanhamento' = ANY(capabilities) OR 'operacao' = ANY(capabilities)))
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
  -- A visão de leituras também não fica exposta à API pública.
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('REVOKE ALL ON equipment_meter FROM %I', r); END IF;
  END LOOP;
END $$;
