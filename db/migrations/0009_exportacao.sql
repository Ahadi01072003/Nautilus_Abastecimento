-- NAUTILUS · Exportação em planilha (Excel) e relatório da OS: toda exportação entra na auditoria.
-- Quem consulta OS (Operação, Planejamento ou Acompanhamento) pode registrar a própria exportação.
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
      -- Exportações (planilha e relatório da OS): o acesso é conferido pelo servidor; aqui só se registra quem exportou.
      OR (NEW.action LIKE 'Exportação:%' AND NEW.entity_id IS NOT NULL)
    )) THEN
    RAISE EXCEPTION 'Auditoria sem autorização';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN EXECUTE format('ALTER FUNCTION nautilus_audit_actor_guard() SET search_path TO %I', current_schema()); END $$;
