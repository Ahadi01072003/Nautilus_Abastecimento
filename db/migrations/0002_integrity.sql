-- NAUTILUS · regras de integridade executadas no banco (portadas dos triggers SQLite da v7).
-- A aplicação valida antes; o banco é a última barreira contra estoque negativo,
-- autoria indevida e execução duplicada. Mensagens são mapeadas pela API.

-- Estoque -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nautilus_movement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f fuels%ROWTYPE;
BEGIN
  -- Bloqueia a linha do combustível: movimentações concorrentes são serializadas.
  SELECT * INTO f FROM fuels WHERE id = NEW.fuel_id FOR UPDATE;
  IF NOT FOUND OR f.active <> 1 THEN RAISE EXCEPTION 'Combustível indisponível'; END IF;
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.author_id AND active = 1 AND (profile = 'manager' OR (NEW.kind = 'debit' AND profile = 'fueler'))) THEN
    RAISE EXCEPTION 'Estoque sem autorização';
  END IF;
  IF NEW.expected_version IS NOT NULL AND NEW.expected_version <> f.version THEN RAISE EXCEPTION 'Estoque alterado durante conferência'; END IF;
  IF f.integral = 1 AND NEW.delta_milli % 1000 <> 0 THEN RAISE EXCEPTION 'Quantidade deve ser inteira'; END IF;
  IF f.stock_milli + NEW.delta_milli < 0 THEN RAISE EXCEPTION 'Estoque insuficiente'; END IF;
  IF f.stock_milli + NEW.delta_milli > f.capacity_milli THEN RAISE EXCEPTION 'Quantidade excede a capacidade máxima'; END IF;
  IF NEW.kind = 'receipt' AND NEW.request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM requests WHERE id = NEW.request_id AND fuel_id = NEW.fuel_id AND status IN ('open','purchasing','partial')
      AND received_milli + NEW.delta_milli <= requested_milli AND NEW.delta_milli > 0) THEN
    RAISE EXCEPTION 'Recebimento excede a solicitação ou ela está encerrada';
  END IF;
  NEW.balance_after_milli := f.stock_milli + NEW.delta_milli;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER movement_guard BEFORE INSERT ON movements FOR EACH ROW EXECUTE FUNCTION nautilus_movement_guard();

CREATE OR REPLACE FUNCTION nautilus_movement_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE fuels SET stock_milli = stock_milli + NEW.delta_milli, version = version + 1 WHERE id = NEW.fuel_id;
  IF NEW.kind = 'receipt' AND NEW.request_id IS NOT NULL THEN
    UPDATE requests SET received_milli = received_milli + NEW.delta_milli,
      status = CASE WHEN received_milli + NEW.delta_milli = requested_milli THEN 'received' ELSE 'partial' END
    WHERE id = NEW.request_id;
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER movement_apply AFTER INSERT ON movements FOR EACH ROW EXECUTE FUNCTION nautilus_movement_apply();

-- Movimentações formam um livro-razão: não são editadas nem removidas.
CREATE OR REPLACE FUNCTION nautilus_movement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Movimentações não podem ser alteradas'; END $$;
CREATE OR REPLACE TRIGGER movement_immutable BEFORE UPDATE OR DELETE ON movements FOR EACH ROW EXECUTE FUNCTION nautilus_movement_immutable();

-- Abastecimentos ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nautilus_supply_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a appointments%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM equipment e WHERE e.id = NEW.equipment_id AND e.active = 1 AND NEW.fuel_id = ANY(e.fuel_ids)) THEN
    RAISE EXCEPTION 'Equipamento incompatível ou inativo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM operators WHERE id = NEW.operator_id AND active = 1) THEN RAISE EXCEPTION 'Operador inativo'; END IF;
  IF NEW.quantity_milli <= 0 THEN RAISE EXCEPTION 'Quantidade inválida'; END IF;
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.author_id AND active = 1 AND profile IN ('fueler','manager')) THEN
    RAISE EXCEPTION 'Acesso sem autorização para abastecer';
  END IF;
  IF NEW.appointment_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.author_id AND active = 1 AND profile = 'manager') OR length(trim(NEW.notes)) = 0 THEN
      RAISE EXCEPTION 'Registro sem agendamento exige gestor e justificativa';
    END IF;
  ELSE
    SELECT * INTO a FROM appointments WHERE id = NEW.appointment_id FOR UPDATE;
    IF NOT FOUND OR a.status <> 'scheduled' OR a.equipment_id <> NEW.equipment_id OR a.fuel_id <> NEW.fuel_id
       OR NEW.hourmeter_milli IS NULL OR NEW.hourmeter_milli < a.hourmeter_milli OR NEW.occurred_at < a.created_at THEN
      RAISE EXCEPTION 'Agendamento indisponível ou abastecimento incompatível';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER supply_guard BEFORE INSERT ON supplies FOR EACH ROW EXECUTE FUNCTION nautilus_supply_guard();

CREATE OR REPLACE FUNCTION nautilus_supply_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO movements(id, operation_key, fuel_id, delta_milli, kind, supply_id, occurred_at, author_id, author_name, reason)
  VALUES (NEW.id, 'supply:' || NEW.operation_key, NEW.fuel_id, -NEW.quantity_milli, 'debit', NEW.id, NEW.created_at, NEW.author_id, NEW.author_name, 'Abastecimento ' || NEW.equipment_tag);
  IF NEW.appointment_id IS NOT NULL THEN
    UPDATE appointments SET status = 'completed', completed_at = NEW.created_at, updated_at = NEW.created_at, version = version + 1 WHERE id = NEW.appointment_id;
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER supply_after_insert AFTER INSERT ON supplies FOR EACH ROW EXECUTE FUNCTION nautilus_supply_after_insert();

-- Cancelar um consumo confirmado reabre a solicitação para novo planejamento.
CREATE OR REPLACE FUNCTION nautilus_supply_reopen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE appointments SET status = 'requested', scheduled_at = NULL, assigned_member_id = NULL, assigned_name = NULL,
    scheduled_by_id = NULL, scheduled_by_name = NULL, completed_at = NULL,
    updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), version = version + 1
  WHERE id = NEW.appointment_id AND status = 'completed';
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER supply_appointment_reopen AFTER UPDATE OF status ON supplies FOR EACH ROW
  WHEN (OLD.status = 'confirmed' AND NEW.status = 'cancelled' AND NEW.appointment_id IS NOT NULL)
  EXECUTE FUNCTION nautilus_supply_reopen();

-- Solicitações e agenda -----------------------------------------------------
CREATE OR REPLACE FUNCTION nautilus_appointment_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'requested' THEN RAISE EXCEPTION 'Uma solicitação deve começar como solicitada'; END IF;
  IF NOT EXISTS (SELECT 1 FROM equipment e JOIN fuels f ON f.id = NEW.fuel_id WHERE e.id = NEW.equipment_id AND e.active = 1 AND f.active = 1 AND f.id = ANY(e.fuel_ids)) THEN
    RAISE EXCEPTION 'Equipamento incompatível ou inativo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.requester_id AND active = 1 AND profile IN ('requester','manager')) THEN
    RAISE EXCEPTION 'Solicitante sem acesso ativo';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER appointment_insert_guard BEFORE INSERT ON appointments FOR EACH ROW EXECUTE FUNCTION nautilus_appointment_insert_guard();

CREATE OR REPLACE FUNCTION nautilus_appointment_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_member_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.assigned_member_id AND active = 1 AND profile IN ('fueler','manager')) THEN
    RAISE EXCEPTION 'Responsável sem autorização para abastecer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.scheduled_by_id AND active = 1 AND profile IN ('planner','manager')) THEN
    RAISE EXCEPTION 'Agendamento sem autorização';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM equipment e JOIN fuels f ON f.id = NEW.fuel_id WHERE e.id = NEW.equipment_id AND e.active = 1 AND f.active = 1 AND f.id = ANY(e.fuel_ids)) THEN
    RAISE EXCEPTION 'Equipamento incompatível ou inativo';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER appointment_schedule_guard BEFORE UPDATE ON appointments FOR EACH ROW
  WHEN (NEW.status = 'scheduled' AND OLD.status IN ('requested','scheduled'))
  EXECUTE FUNCTION nautilus_appointment_schedule_guard();

CREATE OR REPLACE FUNCTION nautilus_appointment_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.cancelled_by_id AND active = 1 AND (
      profile IN ('planner','manager') OR (profile = 'requester' AND id = OLD.requester_id AND OLD.status = 'requested'))) THEN
    RAISE EXCEPTION 'Cancelamento sem autorização';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER appointment_cancel_guard BEFORE UPDATE OF status ON appointments FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IN ('requested','scheduled'))
  EXECUTE FUNCTION nautilus_appointment_cancel_guard();

-- Acessos -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nautilus_last_manager_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serializa alterações simultâneas de gestores antes da contagem.
  PERFORM 1 FROM members WHERE profile = 'manager' AND active = 1 FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM members WHERE id <> OLD.id AND active = 1 AND profile = 'manager') THEN
    RAISE EXCEPTION 'Mantenha ao menos um gestor ativo';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER member_last_manager_update BEFORE UPDATE OF active, profile ON members FOR EACH ROW
  WHEN (OLD.profile = 'manager' AND OLD.active = 1 AND (NEW.profile <> 'manager' OR NEW.active <> 1))
  EXECUTE FUNCTION nautilus_last_manager_guard();
CREATE OR REPLACE TRIGGER member_last_manager_delete BEFORE DELETE ON members FOR EACH ROW
  WHEN (OLD.profile = 'manager' AND OLD.active = 1)
  EXECUTE FUNCTION nautilus_last_manager_guard();

-- Auditoria: cada perfil só registra as ações que pode executar.
CREATE OR REPLACE FUNCTION nautilus_audit_actor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.author_id AND active = 1 AND (
      profile = 'manager'
      OR (NEW.action = 'Senha definida pelo usuário' AND NEW.entity_id = NEW.author_id)
      OR (profile = 'planner' AND NEW.action IN ('Abastecimento agendado','Abastecimento reagendado','Solicitação de abastecimento cancelada'))
      OR (profile = 'fueler' AND NEW.action = 'Abastecimento registrado')
      OR (profile = 'requester' AND NEW.action IN ('Abastecimento solicitado','Solicitação de abastecimento cancelada')
          AND EXISTS (SELECT 1 FROM appointments WHERE id = NEW.entity_id AND requester_id = NEW.author_id))
    )) THEN
    RAISE EXCEPTION 'Auditoria sem autorização';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER audit_actor_guard BEFORE INSERT ON audits FOR EACH ROW EXECUTE FUNCTION nautilus_audit_actor_guard();
