-- Perfil do Usuário: o perfil define o módulo principal (Abastecedor → Abastecimento,
-- Planejador → Planejamento, Operador → Operação, Mantenedor → Manutenção; Gestão → todos) e os
-- acessos adicionais liberam os outros módulos, inclusive o novo acesso "abastecimento".
-- Os perfis "Solicitante" e "Sem acesso ao abastecimento" deixam de existir.
-- O módulo principal também fica gravado em capabilities: as regras do banco que conferem
-- acessos continuam valendo sem exceção por perfil.
ALTER TABLE members DROP CONSTRAINT IF EXISTS member_capabilities;
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_profile_check;

-- Planejadores já agendavam abastecimentos e solicitantes já solicitavam: mantêm o Abastecimento.
UPDATE members SET capabilities=array_append(capabilities,'abastecimento')
 WHERE profile IN ('planner','requester') AND NOT ('abastecimento'=ANY(capabilities));

-- Solicitante e "sem acesso": vão para o perfil do módulo que já usavam (pelos acessos atuais);
-- sem nenhum, Abastecedor.
UPDATE members SET profile=CASE
  WHEN 'planejamento'=ANY(capabilities) THEN 'planner'
  WHEN 'operacao'=ANY(capabilities) THEN 'operator'
  WHEN 'manutencao'=ANY(capabilities) THEN 'maintainer'
  ELSE 'fueler' END
 WHERE profile IN ('requester','none');

-- Módulo principal do perfil gravado junto com os adicionais (o gestor tem todos e não grava nada).
UPDATE members SET capabilities=array_append(capabilities,m.cap)
  FROM (VALUES ('fueler','abastecimento'),('planner','planejamento'),('operator','operacao'),('maintainer','manutencao')) AS m(profile,cap)
 WHERE members.profile=m.profile AND NOT (m.cap=ANY(members.capabilities));
UPDATE members SET capabilities='{}' WHERE profile='manager';

ALTER TABLE members ALTER COLUMN profile SET DEFAULT 'fueler';
ALTER TABLE members ADD CONSTRAINT members_profile_check CHECK (profile IN ('fueler','planner','operator','maintainer','manager'));
ALTER TABLE members ADD CONSTRAINT member_capabilities CHECK (capabilities <@ ARRAY['abastecimento','planejamento','operacao','manutencao','cadastros','acompanhamento']::text[]);

-- Abastecimento no banco: solicitar exige o módulo; agendar é do planejador com o módulo (ou gestor);
-- cancelar é de quem agenda ou do próprio solicitante enquanto a solicitação não foi agendada.
CREATE OR REPLACE FUNCTION nautilus_appointment_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'requested' THEN RAISE EXCEPTION 'Uma solicitação deve começar como solicitada'; END IF;
  IF NOT EXISTS (SELECT 1 FROM equipment e JOIN fuels f ON f.id = NEW.fuel_id WHERE e.id = NEW.equipment_id AND e.active = 1 AND f.active = 1 AND f.id = ANY(e.fuel_ids)) THEN
    RAISE EXCEPTION 'Equipamento incompatível ou inativo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.requester_id AND active = 1 AND (profile = 'manager' OR 'abastecimento' = ANY(capabilities))) THEN
    RAISE EXCEPTION 'Solicitante sem acesso ativo';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION nautilus_appointment_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_member_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.assigned_member_id AND active = 1 AND profile IN ('fueler','manager')) THEN
    RAISE EXCEPTION 'Responsável sem autorização para abastecer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.scheduled_by_id AND active = 1 AND (profile = 'manager' OR (profile = 'planner' AND 'abastecimento' = ANY(capabilities)))) THEN
    RAISE EXCEPTION 'Agendamento sem autorização';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM equipment e JOIN fuels f ON f.id = NEW.fuel_id WHERE e.id = NEW.equipment_id AND e.active = 1 AND f.active = 1 AND f.id = ANY(e.fuel_ids)) THEN
    RAISE EXCEPTION 'Equipamento incompatível ou inativo';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION nautilus_appointment_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.cancelled_by_id AND active = 1 AND (
      profile = 'manager' OR (profile = 'planner' AND 'abastecimento' = ANY(capabilities))
      OR ('abastecimento' = ANY(capabilities) AND id = OLD.requester_id AND OLD.status = 'requested'))) THEN
    RAISE EXCEPTION 'Cancelamento sem autorização';
  END IF;
  RETURN NEW;
END $$;

-- Auditoria: mesmas regras de antes, com o Abastecimento pelo acesso (não mais pelo perfil Solicitante).
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
