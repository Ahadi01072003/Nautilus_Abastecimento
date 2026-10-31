-- NAUTILUS · Financeiro: solicitação de recobráveis por atividade (Frente B).
-- Clientes habilitados com margem e impostos por vigência, fornecedores, solicitações, cotações,
-- relatórios enviados ao cliente (versões) e anexos (só no Financeiro, guardados no próprio banco).
-- Valores calculados das cotações não são gravados (lib/recovery-quote.ts), exceto o valor a
-- faturar da cotação escolhida, copiado para a solicitação ao autorizar. Aditiva.

CREATE TABLE IF NOT EXISTS finance_clients (
  org_id text PRIMARY KEY REFERENCES requester_orgs(id),
  enabled smallint NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL,
  updated_at text
);

CREATE TABLE IF NOT EXISTS finance_client_rates (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES requester_orgs(id),
  margin_bp integer NOT NULL CHECK (margin_bp BETWEEN 0 AND 9999),
  tax_bp integer NOT NULL CHECK (tax_bp BETWEEN 0 AND 9999),
  valid_from text NOT NULL CHECK (valid_from ~ '^\d{4}-\d{2}-\d{2}$'),
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL,
  UNIQUE (org_id, valid_from)
);
CREATE OR REPLACE FUNCTION nautilus_finance_client_rate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Margem e impostos não podem ser alterados: cadastre uma nova vigência';
END $$;
CREATE OR REPLACE TRIGGER finance_client_rate_guard BEFORE UPDATE OR DELETE ON finance_client_rates FOR EACH ROW EXECUTE FUNCTION nautilus_finance_client_rate_guard();

CREATE TABLE IF NOT EXISTS suppliers (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  cnpj text,
  contact text,
  active smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name ON suppliers (lower(trim(name)));

CREATE SEQUENCE IF NOT EXISTS recovery_request_number;
CREATE TABLE IF NOT EXISTS recovery_requests (
  id text PRIMARY KEY,
  number integer NOT NULL UNIQUE DEFAULT nextval('recovery_request_number'),
  org_id text NOT NULL REFERENCES requester_orgs(id),
  requester_person_id text NOT NULL REFERENCES requester_people(id),
  activity_type_id text REFERENCES activity_types(id),
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  planned_start text NOT NULL,
  planned_end text,
  resources jsonb NOT NULL DEFAULT '[]',
  notes text NOT NULL DEFAULT '',
  margin_bp integer NOT NULL CHECK (margin_bp BETWEEN 0 AND 9999),
  tax_bp integer NOT NULL CHECK (tax_bp BETWEEN 0 AND 9999),
  status text NOT NULL DEFAULT 'em_cotacao' CHECK (status IN ('em_cotacao','enviada','autorizada','em_execucao','concluida','cancelada')),
  justification text,
  chosen_quote_id text,
  chosen_total_cents bigint,
  signer_name text,
  signer_role text,
  signed_at text,
  cancel_reason text,
  plan_id text REFERENCES plans(id),
  work_order_id text UNIQUE REFERENCES work_orders(id),
  version integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT recovery_activity CHECK (activity_type_id IS NOT NULL OR title <> '')
);
ALTER SEQUENCE recovery_request_number OWNED BY recovery_requests.number;
CREATE INDEX IF NOT EXISTS idx_recovery_requests_org ON recovery_requests(org_id, status);

CREATE TABLE IF NOT EXISTS recovery_quotes (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES recovery_requests(id),
  supplier_id text NOT NULL REFERENCES suppliers(id),
  value_cents bigint NOT NULL CHECK (value_cents BETWEEN 0 AND 10000000000),
  proposal_number text NOT NULL DEFAULT '',
  valid_until text,
  lead_time text NOT NULL DEFAULT '',
  received_at text,
  notes text NOT NULL DEFAULT '',
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (request_id, supplier_id)
);

CREATE TABLE IF NOT EXISTS recovery_reports (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES recovery_requests(id),
  version integer NOT NULL CHECK (version >= 1),
  issued_at text NOT NULL,
  issued_by text NOT NULL REFERENCES members(id),
  issued_by_name text NOT NULL,
  snapshot jsonb NOT NULL,
  UNIQUE (request_id, version)
);

CREATE TABLE IF NOT EXISTS finance_attachments (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES recovery_requests(id),
  quote_id text REFERENCES recovery_quotes(id),
  kind text NOT NULL CHECK (kind IN ('proposta','relatorio_assinado','outro')),
  description text NOT NULL DEFAULT '',
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 4194304),
  content bytea NOT NULL,
  replaced_by text REFERENCES finance_attachments(id),
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL,
  CONSTRAINT attachment_size CHECK (octet_length(content) = size_bytes)
);
CREATE INDEX IF NOT EXISTS idx_finance_attachments_request ON finance_attachments(request_id);
-- Histórico da solicitação (auditoria por entidade).
CREATE INDEX IF NOT EXISTS idx_audits_entity ON audits(entity_id, created_at);

-- Solicitação: não é apagada; nasce "Em cotação"; situação só pelos caminhos da spec §6 (com OS em
-- execução não se cancela: cancela-se a OS antes); dados só mudam em "Em cotação"; autorizar exige a
-- cotação escolhida desta solicitação e o relatório assinado anexado (não substituído).
CREATE OR REPLACE FUNCTION nautilus_recovery_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Solicitação de recobrável não pode ser apagada'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'em_cotacao' THEN RAISE EXCEPTION 'Situação inicial da solicitação deve ser "Em cotação"'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.number <> OLD.number OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'Identificação da solicitação não pode ser alterada';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'em_cotacao' AND NEW.status IN ('enviada','cancelada'))
    OR (OLD.status = 'enviada' AND NEW.status IN ('em_cotacao','autorizada','cancelada'))
    OR (OLD.status = 'autorizada' AND NEW.status IN ('em_cotacao','em_execucao','cancelada'))
    OR (OLD.status = 'em_execucao' AND NEW.status IN ('autorizada','concluida'))) THEN
    RAISE EXCEPTION 'Situação da solicitação não pode passar de % para %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'em_cotacao' AND (NEW.org_id, NEW.requester_person_id, NEW.activity_type_id, NEW.title, NEW.description,
      NEW.planned_start, NEW.planned_end, NEW.resources, NEW.notes, NEW.margin_bp, NEW.tax_bp)
    IS DISTINCT FROM (OLD.org_id, OLD.requester_person_id, OLD.activity_type_id, OLD.title, OLD.description,
      OLD.planned_start, OLD.planned_end, OLD.resources, OLD.notes, OLD.margin_bp, OLD.tax_bp) THEN
    RAISE EXCEPTION 'Dado da solicitação não pode ser alterado fora de "Em cotação"';
  END IF;
  IF NEW.status = 'autorizada' AND OLD.status = 'enviada' THEN
    IF NEW.chosen_quote_id IS NULL OR NOT EXISTS (SELECT 1 FROM recovery_quotes WHERE id = NEW.chosen_quote_id AND request_id = NEW.id) THEN
      RAISE EXCEPTION 'Autorização exige a cotação escolhida desta solicitação';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM finance_attachments WHERE request_id = NEW.id AND kind = 'relatorio_assinado' AND replaced_by IS NULL) THEN
      RAISE EXCEPTION 'Autorização exige o anexo do relatório assinado';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER recovery_request_guard BEFORE INSERT OR UPDATE OR DELETE ON recovery_requests FOR EACH ROW EXECUTE FUNCTION nautilus_recovery_request_guard();

-- Cotação: só muda com a solicitação "Em cotação" (a linha da solicitação fica travada até o fim da
-- transação: envio e edição ao mesmo tempo não passam juntos).
CREATE OR REPLACE FUNCTION nautilus_recovery_quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid text; st text;
BEGIN
  IF TG_OP = 'DELETE' THEN rid := OLD.request_id; ELSE rid := NEW.request_id; END IF;
  IF TG_OP = 'UPDATE' AND NEW.request_id <> OLD.request_id THEN RAISE EXCEPTION 'Cotação não pode mudar de solicitação'; END IF;
  SELECT status INTO st FROM recovery_requests WHERE id = rid FOR UPDATE;
  IF st IS DISTINCT FROM 'em_cotacao' THEN RAISE EXCEPTION 'Cotação só muda em "Em cotação"'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER recovery_quote_guard BEFORE INSERT OR UPDATE OR DELETE ON recovery_quotes FOR EACH ROW EXECUTE FUNCTION nautilus_recovery_quote_guard();

CREATE OR REPLACE FUNCTION nautilus_recovery_report_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Relatório enviado ao cliente não pode ser alterado nem apagado';
END $$;
CREATE OR REPLACE TRIGGER recovery_report_guard BEFORE UPDATE OR DELETE ON recovery_reports FOR EACH ROW EXECUTE FUNCTION nautilus_recovery_report_guard();

-- Anexo: nunca é apagado; o único ajuste permitido é marcar uma vez como substituído.
CREATE OR REPLACE FUNCTION nautilus_finance_attachment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Anexo não pode ser apagado'; END IF;
  IF OLD.replaced_by IS NOT NULL OR (NEW.request_id, NEW.quote_id, NEW.kind, NEW.description, NEW.file_name, NEW.content_type, NEW.size_bytes, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.request_id, OLD.quote_id, OLD.kind, OLD.description, OLD.file_name, OLD.content_type, OLD.size_bytes, OLD.created_at, OLD.created_by)
     OR NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'Anexo não pode ser alterado (só marcado como substituído)';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER finance_attachment_guard BEFORE UPDATE OR DELETE ON finance_attachments FOR EACH ROW EXECUTE FUNCTION nautilus_finance_attachment_guard();

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_clients','finance_client_rates','suppliers','recovery_requests','recovery_quotes','recovery_reports','finance_attachments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r); END IF;
    END LOOP;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('REVOKE ALL ON SEQUENCE recovery_request_number FROM %I', r); END IF;
  END LOOP;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.proname LIKE 'nautilus\_%' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I', f, current_schema());
  END LOOP;
END $$;
