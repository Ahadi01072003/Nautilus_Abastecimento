-- NAUTILUS · Remove o módulo Portaria (decisão do usuário em 11/11/2026: não será usado).
-- Desfaz a 0024 sem reescrevê-la: apaga as tabelas portaria_*, as funções e volta as regras de perfil/acesso e
-- de auditoria ao que valia antes. Os registros de auditoria já gravados são imutáveis e continuam no banco.
-- Backup dos dados de produção feito antes (eram 1 relatório vazio e nenhum visitante).
SET LOCAL lock_timeout='15s';

-- Falha clara se alguém ainda usa o perfil Porteiro (a troca de perfil é decisão da gestão, não da migração).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM members WHERE profile = 'porteiro') THEN
    RAISE EXCEPTION 'Há usuário com perfil Porteiro: troque o perfil antes de remover a Portaria.';
  END IF;
END $$;
UPDATE members SET capabilities = array_remove(capabilities, 'portaria') WHERE 'portaria' = ANY(capabilities);

DROP TABLE IF EXISTS portaria_events;
DROP TABLE IF EXISTS portaria_report_versions;
DROP TABLE IF EXISTS portaria_visits;
DROP TABLE IF EXISTS portaria_idempotency;
DROP TABLE IF EXISTS portaria_pending_review;
DROP TABLE IF EXISTS portaria_people;
DROP TABLE IF EXISTS portaria_companies;
DROP TABLE IF EXISTS portaria_reports;
DROP TABLE IF EXISTS portaria_bases;
DROP FUNCTION IF EXISTS nautilus_portaria_no_delete();
DROP FUNCTION IF EXISTS nautilus_portaria_immutable();
DROP FUNCTION IF EXISTS nautilus_portaria_report_guard();
DROP FUNCTION IF EXISTS nautilus_portaria_visit_guard();

-- Perfil e acessos como antes da 0024.
ALTER TABLE members DROP CONSTRAINT IF EXISTS member_capabilities;
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_profile_check;
ALTER TABLE members ADD CONSTRAINT members_profile_check CHECK (profile IN ('fueler','planner','operator','maintainer','manager'));
ALTER TABLE members ADD CONSTRAINT member_capabilities CHECK (capabilities <@ ARRAY['abastecimento','planejamento','operacao','manutencao','cadastros','acompanhamento','financeiro']::text[]);

-- Auditoria: as regras da 0019 (sem as ações da Portaria).
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
      -- Exportações (planilha e relatórios): o acesso é conferido pelo servidor; aqui só se registra quem exportou.
      OR (NEW.action LIKE 'Exportação:%' AND NEW.entity_id IS NOT NULL
          AND ('planejamento' = ANY(capabilities) OR 'acompanhamento' = ANY(capabilities) OR 'operacao' = ANY(capabilities) OR 'financeiro' = ANY(capabilities)))
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
