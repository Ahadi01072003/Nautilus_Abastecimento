-- NAUTILUS · Portaria: controle de entradas e saídas de pessoas na base.
-- Módulo isolado: não se liga a OS, Planejamento, Operação nem Financeiro. Compartilha só os usuários
-- (perfil Porteiro e acesso "portaria"), a leitura das empresas de Solicitantes e clientes e a
-- auditoria. Datas e horas em timestamptz/date; a data operacional é derivada no fuso da base.
-- Aditiva.

-- A troca das constraints de members pede trava exclusiva: se não conseguir em 15 s, a migração falha limpa (sem
-- travar o login de ninguém) e pode ser repetida.
SET LOCAL lock_timeout='15s';

-- Perfil Porteiro e acesso "portaria".
ALTER TABLE members DROP CONSTRAINT IF EXISTS member_capabilities;
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_profile_check;
ALTER TABLE members ADD CONSTRAINT members_profile_check CHECK (profile IN ('fueler','planner','operator','maintainer','porteiro','manager'));
ALTER TABLE members ADD CONSTRAINT member_capabilities CHECK (capabilities <@ ARRAY['abastecimento','planejamento','operacao','manutencao','cadastros','acompanhamento','financeiro','portaria']::text[]);

CREATE TABLE IF NOT EXISTS portaria_bases (
  id text PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo'
);
INSERT INTO portaria_bases(id,name) VALUES ('base-acu','Base Açu') ON CONFLICT (id) DO NOTHING;

-- Empresas da Portaria: as de Solicitantes e clientes entram como espelho (origin 'cadastro', só leitura)
-- na primeira vez em que são escolhidas; as criadas na hora ficam só aqui (origin 'portaria').
CREATE TABLE IF NOT EXISTS portaria_companies (
  id text PRIMARY KEY,
  org_id text UNIQUE REFERENCES requester_orgs(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  origin text NOT NULL CHECK (origin IN ('cadastro','portaria')),
  active smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL REFERENCES members(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portaria_company_origin CHECK ((origin = 'cadastro') = (org_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS portaria_companies_name ON portaria_companies (lower(trim(name))) WHERE origin = 'portaria';

-- Visitantes (pessoas que entram e saem). Não precisam de conta. Nunca são apagados.
CREATE TABLE IF NOT EXISTS portaria_people (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 180),
  document_type text NOT NULL CHECK (document_type IN ('CPF','RG','CNH','PASSAPORTE','OUTRO')),
  document_number text NOT NULL CHECK (length(trim(document_number)) BETWEEN 3 AND 40),
  document_norm text NOT NULL CHECK (document_norm ~ '^[A-Z0-9]{3,40}$'),
  company_id text NOT NULL REFERENCES portaria_companies(id),
  active smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL REFERENCES members(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portaria_people_document ON portaria_people (document_type, document_norm);
CREATE INDEX IF NOT EXISTS idx_portaria_people_name ON portaria_people (lower(name));
CREATE INDEX IF NOT EXISTS idx_portaria_people_company ON portaria_people (company_id);

-- Cadastros feitos na hora, aguardando a revisão da gestão.
CREATE TABLE IF NOT EXISTS portaria_pending_review (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('pessoa','empresa')),
  entity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL REFERENCES members(id),
  reviewed_at timestamptz,
  reviewed_by text REFERENCES members(id),
  UNIQUE (kind, entity_id)
);

-- Relatório diário: um por base e data operacional. "version" conta cada mudança de conteúdo e é o que
-- o fechamento confere. Nunca é apagado.
CREATE TABLE IF NOT EXISTS portaria_reports (
  id text PRIMARY KEY,
  base_id text NOT NULL REFERENCES portaria_bases(id),
  op_date date NOT NULL,
  status text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','fechado')),
  version integer NOT NULL DEFAULT 0,
  closed_at timestamptz,
  closed_by text REFERENCES members(id),
  closed_by_name text,
  reopen_kind text CHECK (reopen_kind IN ('movimento_posterior','correcao')),
  reopen_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (base_id, op_date),
  CONSTRAINT portaria_report_closed CHECK ((status = 'fechado') = (closed_at IS NOT NULL))
);

-- Visita: da entrada à saída. Guarda cópia histórica da pessoa e da empresa.
CREATE TABLE IF NOT EXISTS portaria_visits (
  id text PRIMARY KEY,
  base_id text NOT NULL REFERENCES portaria_bases(id),
  person_id text NOT NULL REFERENCES portaria_people(id),
  person_name text NOT NULL,
  document_type text NOT NULL,
  document_number text NOT NULL,
  company_id text NOT NULL REFERENCES portaria_companies(id),
  company_name text NOT NULL,
  purpose text NOT NULL CHECK (length(trim(purpose)) BETWEEN 1 AND 200),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  access_mode text NOT NULL CHECK (access_mode IN ('a_pe','veiculo','outro')),
  plate_in text CHECK (plate_in ~ '^[A-Z0-9]{3,10}$'),
  plate_out text CHECK (plate_out ~ '^[A-Z0-9]{3,10}$'),
  entry_at timestamptz NOT NULL,
  exit_at timestamptz,
  status text NOT NULL CHECK (status IN ('em_andamento','finalizada','anulada')),
  entry_report_id text NOT NULL REFERENCES portaria_reports(id),
  exit_report_id text REFERENCES portaria_reports(id),
  entry_by text NOT NULL REFERENCES members(id),
  entry_by_name text NOT NULL,
  exit_by text REFERENCES members(id),
  exit_by_name text,
  entry_registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  exit_registered_at timestamptz,
  retroactive smallint NOT NULL DEFAULT 0 CHECK (retroactive IN (0,1)),
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portaria_visit_exit_after_entry CHECK (exit_at IS NULL OR exit_at >= entry_at),
  CONSTRAINT portaria_visit_state CHECK ((status = 'em_andamento' AND exit_at IS NULL) OR (status = 'finalizada' AND exit_at IS NOT NULL) OR status = 'anulada'),
  CONSTRAINT portaria_visit_vehicle CHECK ((access_mode = 'veiculo') = (plate_in IS NOT NULL))
);
-- Uma visita em andamento por pessoa e base (vale mesmo com duas entradas simultâneas).
CREATE UNIQUE INDEX IF NOT EXISTS portaria_visits_open ON portaria_visits (base_id, person_id) WHERE status = 'em_andamento';
CREATE INDEX IF NOT EXISTS idx_portaria_visits_entry ON portaria_visits (base_id, entry_at);
CREATE INDEX IF NOT EXISTS idx_portaria_visits_exit ON portaria_visits (base_id, exit_at) WHERE exit_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portaria_visits_person ON portaria_visits (person_id, entry_at);
CREATE INDEX IF NOT EXISTS idx_portaria_visits_company ON portaria_visits (company_id, entry_at);
CREATE INDEX IF NOT EXISTS idx_portaria_visits_entry_report ON portaria_visits (entry_report_id);
CREATE INDEX IF NOT EXISTS idx_portaria_visits_exit_report ON portaria_visits (exit_report_id) WHERE exit_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portaria_visits_plate ON portaria_visits (plate_in) WHERE plate_in IS NOT NULL;

-- Eventos: entrada, saída, correção, anulação, desfazer saída e restauração. Imutáveis.
CREATE TABLE IF NOT EXISTS portaria_events (
  id text PRIMARY KEY,
  visit_id text NOT NULL REFERENCES portaria_visits(id),
  report_id text NOT NULL REFERENCES portaria_reports(id),
  exit_report_id text REFERENCES portaria_reports(id),
  kind text NOT NULL CHECK (kind IN ('entrada','saida','correcao','anulacao','desfazer_saida','restauracao')),
  occurred_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id text NOT NULL REFERENCES members(id),
  actor_name text NOT NULL,
  justification text CHECK (justification IS NULL OR length(justification) <= 1000),
  before jsonb,
  after jsonb
);
CREATE INDEX IF NOT EXISTS idx_portaria_events_visit ON portaria_events (visit_id, registered_at);
CREATE INDEX IF NOT EXISTS idx_portaria_events_report ON portaria_events (report_id, registered_at);
CREATE INDEX IF NOT EXISTS idx_portaria_events_exit_report ON portaria_events (exit_report_id, registered_at) WHERE exit_report_id IS NOT NULL;

-- Versões (revisões) do relatório: fotografia imutável a cada fechamento.
CREATE TABLE IF NOT EXISTS portaria_report_versions (
  id text PRIMARY KEY,
  report_id text NOT NULL REFERENCES portaria_reports(id),
  number integer NOT NULL CHECK (number >= 1),
  kind text NOT NULL CHECK (kind IN ('original','atualizada','retificada')),
  reason text,
  report_version integer NOT NULL,
  snapshot jsonb NOT NULL,
  closed_with_present integer NOT NULL DEFAULT 0,
  close_justification text,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  issued_by text NOT NULL REFERENCES members(id),
  issued_by_name text NOT NULL,
  UNIQUE (report_id, number)
);

-- Idempotência: a mesma chave com o mesmo conteúdo devolve a resposta guardada.
CREATE TABLE IF NOT EXISTS portaria_idempotency (
  member_id text NOT NULL REFERENCES members(id),
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  operation text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, key)
);

-- Travas: nada é apagado; eventos e versões não mudam; a pessoa não tem visitas sobrepostas.
CREATE OR REPLACE FUNCTION nautilus_portaria_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Registro da portaria não pode ser apagado';
END $$;
CREATE OR REPLACE TRIGGER portaria_people_no_delete BEFORE DELETE ON portaria_people FOR EACH ROW EXECUTE FUNCTION nautilus_portaria_no_delete();
CREATE OR REPLACE TRIGGER portaria_companies_no_delete BEFORE DELETE ON portaria_companies FOR EACH ROW EXECUTE FUNCTION nautilus_portaria_no_delete();
CREATE OR REPLACE TRIGGER portaria_reports_no_delete BEFORE DELETE ON portaria_reports FOR EACH ROW EXECUTE FUNCTION nautilus_portaria_no_delete();
CREATE OR REPLACE TRIGGER portaria_visits_no_delete BEFORE DELETE ON portaria_visits FOR EACH ROW EXECUTE FUNCTION nautilus_portaria_no_delete();

CREATE OR REPLACE FUNCTION nautilus_portaria_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Evento ou versão da portaria não pode ser alterado nem apagado';
END $$;
CREATE OR REPLACE TRIGGER portaria_events_immutable BEFORE UPDATE OR DELETE ON portaria_events FOR EACH ROW EXECUTE FUNCTION nautilus_portaria_immutable();
CREATE OR REPLACE TRIGGER portaria_versions_immutable BEFORE UPDATE OR DELETE ON portaria_report_versions FOR EACH ROW EXECUTE FUNCTION nautilus_portaria_immutable();

CREATE OR REPLACE FUNCTION nautilus_portaria_report_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.base_id <> OLD.base_id OR NEW.op_date <> OLD.op_date THEN
    RAISE EXCEPTION 'Identificação do relatório da portaria não pode ser alterada';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER portaria_report_guard BEFORE UPDATE ON portaria_reports FOR EACH ROW EXECUTE FUNCTION nautilus_portaria_report_guard();

CREATE OR REPLACE FUNCTION nautilus_portaria_visit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.base_id <> OLD.base_id OR NEW.entry_by <> OLD.entry_by
      OR NEW.entry_registered_at <> OLD.entry_registered_at OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'Identificação da visita não pode ser alterada';
  END IF;
  -- Saída antes da entrada é recusada pela restrição da tabela, não pela conferência de sobreposição.
  IF NEW.status <> 'anulada' AND (NEW.exit_at IS NULL OR NEW.exit_at >= NEW.entry_at) AND EXISTS (SELECT 1 FROM portaria_visits v
      WHERE v.person_id = NEW.person_id AND v.id <> NEW.id AND v.status <> 'anulada'
        AND tstzrange(v.entry_at, coalesce(v.exit_at, 'infinity'), '[)') && tstzrange(NEW.entry_at, coalesce(NEW.exit_at, 'infinity'), '[)')) THEN
    RAISE EXCEPTION 'Pessoa já tem visita neste intervalo';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER portaria_visit_guard BEFORE INSERT OR UPDATE ON portaria_visits FOR EACH ROW EXECUTE FUNCTION nautilus_portaria_visit_guard();

-- Auditoria: mesmas regras da 0019, com as ações da Portaria para quem tem o acesso.
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
      OR ('portaria' = ANY(capabilities) AND NEW.action LIKE 'Portaria:%')
      -- Exportações (planilha e relatórios): o acesso é conferido pelo servidor; aqui só se registra quem exportou.
      OR (NEW.action LIKE 'Exportação:%' AND NEW.entity_id IS NOT NULL
          AND ('planejamento' = ANY(capabilities) OR 'acompanhamento' = ANY(capabilities) OR 'operacao' = ANY(capabilities) OR 'financeiro' = ANY(capabilities) OR 'portaria' = ANY(capabilities)))
    )) THEN
    RAISE EXCEPTION 'Auditoria sem autorização';
  END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['portaria_bases','portaria_companies','portaria_people','portaria_pending_review','portaria_reports','portaria_visits','portaria_events','portaria_report_versions','portaria_idempotency'] LOOP
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
