-- NAUTILUS · Avaliações por QR code, fase A: questionários com versões, link público sem login,
-- correção no servidor, uma avaliação válida por CPF por período e limite de tentativas por dia.
-- Acesso novo "avaliacoes" (a Gestão tem sempre). O visitante não tem cadastro: a tentativa é o registro.
SET LOCAL lock_timeout='15s';

ALTER TABLE members DROP CONSTRAINT IF EXISTS member_capabilities;
ALTER TABLE members ADD CONSTRAINT member_capabilities CHECK (capabilities <@ ARRAY['abastecimento','planejamento','operacao','manutencao','cadastros','acompanhamento','financeiro','ferramentaria','avaliacoes']::text[]);

-- Questionário: o rascunho (título, abertura e perguntas) é editável; publicar cria uma versão imutável.
-- As regras (validade, nota mínima, limite diário, detalhe do resultado) valem para as próximas tentativas.
CREATE TABLE IF NOT EXISTS quizzes (
  id text PRIMARY KEY,
  token text NOT NULL UNIQUE CHECK (length(token) BETWEEN 20 AND 64),
  status text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','publicado','pausado','encerrado')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  intro text NOT NULL DEFAULT '' CHECK (length(intro) <= 2000),
  questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(questions) = 'array'),
  published_version integer NOT NULL DEFAULT 0 CHECK (published_version >= 0),
  validity_amount integer NOT NULL DEFAULT 12 CHECK (validity_amount BETWEEN 1 AND 3650),
  validity_unit text NOT NULL DEFAULT 'meses' CHECK (validity_unit IN ('dias','meses')),
  min_score integer NOT NULL DEFAULT 70 CHECK (min_score BETWEEN 1 AND 100),
  daily_limit integer NOT NULL DEFAULT 3 CHECK (daily_limit BETWEEN 1 AND 20),
  result_detail text NOT NULL DEFAULT 'erradas' CHECK (result_detail IN ('resultado','nota','erradas')),
  shuffle smallint NOT NULL DEFAULT 0 CHECK (shuffle IN (0,1)),
  closed_message text NOT NULL DEFAULT '' CHECK (length(closed_message) <= 300),
  rev integer NOT NULL DEFAULT 1,
  create_key text UNIQUE,
  created_by text NOT NULL REFERENCES members(id),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quizzes_status ON quizzes (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS quiz_versions (
  quiz_id text NOT NULL REFERENCES quizzes(id),
  version integer NOT NULL CHECK (version >= 1),
  title text NOT NULL,
  intro text NOT NULL,
  questions jsonb NOT NULL CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) BETWEEN 1 AND 100),
  published_at text NOT NULL,
  published_by text NOT NULL REFERENCES members(id),
  PRIMARY KEY (quiz_id, version)
);

-- Etapa do CPF: o servidor confere validade e limite antes das perguntas e entrega um bilhete de uso único.
CREATE TABLE IF NOT EXISTS quiz_tickets (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 20 AND 64),
  quiz_id text NOT NULL REFERENCES quizzes(id),
  cpf text NOT NULL CHECK (cpf ~ '^[0-9]{11}$'),
  issued_at text NOT NULL,
  used_at text
);
CREATE INDEX IF NOT EXISTS idx_quiz_tickets_issued ON quiz_tickets (issued_at);

-- Tentativa enviada: cópia das perguntas e respostas daquele momento (o histórico não muda com novas versões).
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id text PRIMARY KEY,
  quiz_id text NOT NULL REFERENCES quizzes(id),
  version integer NOT NULL,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{8}$'),
  submit_key text NOT NULL CHECK (length(submit_key) BETWEEN 8 AND 64),
  cpf text NOT NULL CHECK (cpf ~ '^[0-9]{11}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 3 AND 120),
  company text NOT NULL CHECK (length(trim(company)) BETWEEN 1 AND 120),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'array'),
  correct_count integer NOT NULL CHECK (correct_count >= 0),
  graded_count integer NOT NULL CHECK (graded_count >= 1 AND correct_count <= graded_count),
  score numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  min_score integer NOT NULL,
  passed smallint NOT NULL CHECK (passed IN (0,1)),
  valid_until text CHECK ((passed = 1) = (valid_until IS NOT NULL)),
  ip_hash text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '' CHECK (length(user_agent) <= 200),
  started_at text NOT NULL,
  created_at text NOT NULL,
  FOREIGN KEY (quiz_id, version) REFERENCES quiz_versions(quiz_id, version),
  UNIQUE (quiz_id, submit_key)
);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_cpf ON quiz_attempts (quiz_id, cpf, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_date ON quiz_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_company ON quiz_attempts (lower(company));

-- Versões e tentativas não se alteram nem se apagam; questionário não se apaga (encerra).
CREATE OR REPLACE FUNCTION nautilus_quiz_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Registros de avaliação não podem ser alterados nem apagados'; END $$;
CREATE OR REPLACE TRIGGER quiz_versions_immutable BEFORE UPDATE OR DELETE ON quiz_versions FOR EACH ROW EXECUTE FUNCTION nautilus_quiz_immutable();
CREATE OR REPLACE TRIGGER quiz_attempts_immutable BEFORE UPDATE OR DELETE ON quiz_attempts FOR EACH ROW EXECUTE FUNCTION nautilus_quiz_immutable();
CREATE OR REPLACE TRIGGER quizzes_no_delete BEFORE DELETE ON quizzes FOR EACH ROW EXECUTE FUNCTION nautilus_quiz_immutable();

-- Encerrado não volta; rascunho só sai publicando.
CREATE OR REPLACE FUNCTION nautilus_quiz_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'encerrado' AND NEW.status <> 'encerrado' THEN RAISE EXCEPTION 'Questionário encerrado não volta'; END IF;
  IF NEW.status IN ('publicado','pausado') AND NEW.published_version = 0 THEN RAISE EXCEPTION 'Publique o questionário antes'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER quiz_status_guard BEFORE UPDATE ON quizzes FOR EACH ROW EXECUTE FUNCTION nautilus_quiz_status_guard();

-- Auditoria: ações "Avaliações:" de quem tem o acesso (demais regras como antes).
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
      OR ('ferramentaria' = ANY(capabilities) AND NEW.action LIKE 'Ferramentaria:%')
      OR ('avaliacoes' = ANY(capabilities) AND NEW.action LIKE 'Avaliações:%')
      OR (NEW.action LIKE 'Exportação:%' AND NEW.entity_id IS NOT NULL
          AND ('planejamento' = ANY(capabilities) OR 'acompanhamento' = ANY(capabilities) OR 'operacao' = ANY(capabilities) OR 'financeiro' = ANY(capabilities) OR 'ferramentaria' = ANY(capabilities)))
    )) THEN
    RAISE EXCEPTION 'Auditoria sem autorização';
  END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['quizzes','quiz_versions','quiz_tickets','quiz_attempts'] LOOP
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
