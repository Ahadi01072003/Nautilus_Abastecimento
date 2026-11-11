-- NAUTILUS · Ferramentaria (ajustes de 11/11/2026): o responsável do solicitante é escolhido na hora da
-- assinatura (nem sempre é quem pediu), a devolução prevista é opcional e a devolução registra quem devolveu.
SET LOCAL lock_timeout='15s';

ALTER TABLE tool_loans ALTER COLUMN contractor_person DROP NOT NULL;
ALTER TABLE tool_loans ALTER COLUMN expected_return DROP NOT NULL;
ALTER TABLE tool_loans DROP CONSTRAINT IF EXISTS tool_loan_signed_person;
ALTER TABLE tool_loans ADD CONSTRAINT tool_loan_signed_person CHECK (signed_at IS NULL OR contractor_person IS NOT NULL);
ALTER TABLE tool_loan_returns ADD COLUMN IF NOT EXISTS returned_by text CHECK (returned_by IS NULL OR length(trim(returned_by)) BETWEEN 1 AND 120);
ALTER TABLE tool_loan_returns DROP CONSTRAINT IF EXISTS tool_return_signed_person;
ALTER TABLE tool_loan_returns ADD CONSTRAINT tool_return_signed_person CHECK (signed_at IS NULL OR returned_by IS NOT NULL);

-- Empréstimo: os nomes dos responsáveis podem ser definidos até a assinatura; depois dela, nada muda.
CREATE OR REPLACE FUNCTION nautilus_tool_loan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.number <> OLD.number OR NEW.contractor_id <> OLD.contractor_id
     OR NEW.issued_at <> OLD.issued_at OR NEW.issued_by <> OLD.issued_by OR NEW.create_key <> OLD.create_key
     OR NEW.purpose <> OLD.purpose OR NEW.expected_return IS DISTINCT FROM OLD.expected_return THEN
    RAISE EXCEPTION 'Empréstimo emitido não pode ser alterado';
  END IF;
  IF (NEW.contractor_person IS DISTINCT FROM OLD.contractor_person OR NEW.ocp_name <> OLD.ocp_name) AND OLD.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Empréstimo emitido não pode ser alterado';
  END IF;
  IF OLD.ocp_signature IS NOT NULL AND (NEW.ocp_signature IS DISTINCT FROM OLD.ocp_signature OR NEW.contractor_signature IS DISTINCT FROM OLD.contractor_signature) THEN
    RAISE EXCEPTION 'Assinatura do empréstimo já registrada';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
      (OLD.status = 'emitido' AND NEW.status IN ('parcial','encerrado','cancelado'))
      OR (OLD.status = 'parcial' AND NEW.status = 'encerrado')) THEN
    RAISE EXCEPTION 'Situação do empréstimo não pode passar de % para %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- Devolução: quem devolveu e a assinatura podem ser gravados depois, uma vez.
CREATE OR REPLACE FUNCTION nautilus_tool_return_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.loan_id <> OLD.loan_id OR NEW.number <> OLD.number OR NEW.closes_loan <> OLD.closes_loan
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by OR NEW.create_key <> OLD.create_key
     OR (OLD.signed_at IS NOT NULL AND (NEW.ocp_signature IS DISTINCT FROM OLD.ocp_signature OR NEW.contractor_signature IS DISTINCT FROM OLD.contractor_signature OR NEW.returned_by IS DISTINCT FROM OLD.returned_by)) THEN
    RAISE EXCEPTION 'Devolução registrada não pode ser alterada';
  END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.proname LIKE 'nautilus\_%' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I', f, current_schema());
  END LOOP;
END $$;
