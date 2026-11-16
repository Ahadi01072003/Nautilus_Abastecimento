-- NAUTILUS · Avaliações, fase B: termo de consentimento (LGPD) com versões, anonimização a pedido do titular
-- e por retenção, e modelo do comprovante em PDF (logotipo, título, texto e rodapé) por questionário.
SET LOCAL lock_timeout='15s';

ALTER TABLE quizzes
  ADD COLUMN IF NOT EXISTS consent_text text NOT NULL DEFAULT 'Ao continuar, autorizo o registro do meu nome, empresa, CPF e respostas desta avaliação, usados só para controlar o acesso e a segurança da base. Os dados ficam guardados enquanto forem necessários para essa finalidade e posso pedir a exclusão a qualquer momento na recepção.' CHECK (length(trim(consent_text)) BETWEEN 20 AND 4000),
  ADD COLUMN IF NOT EXISTS consent_version integer NOT NULL DEFAULT 1 CHECK (consent_version >= 1),
  ADD COLUMN IF NOT EXISTS retention_months integer CHECK (retention_months IS NULL OR retention_months BETWEEN 6 AND 120),
  ADD COLUMN IF NOT EXISTS pdf_title text NOT NULL DEFAULT 'Comprovante de avaliação' CHECK (length(trim(pdf_title)) BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS pdf_body text NOT NULL DEFAULT 'Certificamos que {nome}, da empresa {empresa}, realizou a avaliação "{questionario}" em {data}, com {nota} de acertos (mínimo {minimo}). Resultado: {resultado}.' CHECK (length(pdf_body) <= 2000),
  ADD COLUMN IF NOT EXISTS pdf_footer text NOT NULL DEFAULT '' CHECK (length(pdf_footer) <= 300),
  ADD COLUMN IF NOT EXISTS pdf_logo bytea CHECK (pdf_logo IS NULL OR octet_length(pdf_logo) <= 524288),
  ADD COLUMN IF NOT EXISTS pdf_logo_type text CHECK (pdf_logo_type IS NULL OR pdf_logo_type IN ('image/png','image/jpeg'));

-- Cada texto do termo fica guardado; a tentativa aponta a versão aceita.
CREATE TABLE IF NOT EXISTS quiz_consents (
  quiz_id text NOT NULL REFERENCES quizzes(id),
  version integer NOT NULL CHECK (version >= 1),
  text text NOT NULL,
  created_at text NOT NULL,
  created_by text REFERENCES members(id),
  PRIMARY KEY (quiz_id, version)
);
INSERT INTO quiz_consents(quiz_id,version,text,created_at,created_by)
  SELECT id,consent_version,consent_text,updated_at,created_by FROM quizzes ON CONFLICT DO NOTHING;
CREATE OR REPLACE TRIGGER quiz_consents_immutable BEFORE UPDATE OR DELETE ON quiz_consents FOR EACH ROW EXECUTE FUNCTION nautilus_quiz_immutable();

ALTER TABLE quiz_tickets ADD COLUMN IF NOT EXISTS consent_version integer;

ALTER TABLE quiz_attempts
  ADD COLUMN IF NOT EXISTS consent_version integer,
  ADD COLUMN IF NOT EXISTS consent_at text,
  ADD COLUMN IF NOT EXISTS anonymized_at text,
  ADD COLUMN IF NOT EXISTS anonymized_reason text CHECK (anonymized_reason IS NULL OR length(anonymized_reason) <= 300),
  ADD COLUMN IF NOT EXISTS anonymized_by text REFERENCES members(id);
ALTER TABLE quiz_attempts DROP CONSTRAINT IF EXISTS quiz_attempts_cpf_check;
ALTER TABLE quiz_attempts ADD CONSTRAINT quiz_attempts_cpf_check CHECK (cpf ~ '^[0-9]{11}$' OR (anonymized_at IS NOT NULL AND cpf = ''));
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_retention ON quiz_attempts (quiz_id, created_at) WHERE anonymized_at IS NULL;

-- Tentativa: não se apaga; a única alteração aceita é a anonimização (uma vez), que troca nome, empresa,
-- CPF e textos livres e mantém nota, resultado e datas para as estatísticas.
CREATE OR REPLACE FUNCTION nautilus_quiz_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Registros de avaliação não podem ser alterados nem apagados'; END IF;
  IF OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL
     AND NEW.name = 'Anonimizado' AND NEW.company = 'Anonimizado' AND NEW.cpf = '' AND NEW.ip_hash = '' AND NEW.user_agent = ''
     AND (NEW.id, NEW.quiz_id, NEW.version, NEW.code, NEW.submit_key, NEW.correct_count, NEW.graded_count, NEW.score, NEW.min_score,
          NEW.passed, NEW.valid_until, NEW.started_at, NEW.created_at, NEW.consent_version, NEW.consent_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.quiz_id, OLD.version, OLD.code, OLD.submit_key, OLD.correct_count, OLD.graded_count, OLD.score, OLD.min_score,
          OLD.passed, OLD.valid_until, OLD.started_at, OLD.created_at, OLD.consent_version, OLD.consent_at)
     AND jsonb_array_length(NEW.answers) = jsonb_array_length(OLD.answers) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Registros de avaliação não podem ser alterados nem apagados';
END $$;
DROP TRIGGER IF EXISTS quiz_attempts_immutable ON quiz_attempts;
CREATE OR REPLACE TRIGGER quiz_attempts_guard BEFORE UPDATE OR DELETE ON quiz_attempts FOR EACH ROW EXECUTE FUNCTION nautilus_quiz_attempt_guard();

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['quiz_consents'] LOOP
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
