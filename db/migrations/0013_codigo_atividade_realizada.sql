-- NAUTILUS · Código da atividade (vinculado ao setor) e registro de atividade realizada sem
-- planejamento prévio (urgência). O registro usa o mesmo formulário da OS sem fluxo, mas nasce já
-- executado, com início e fim reais.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'planejada';
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_mode_check;
ALTER TABLE plans ADD CONSTRAINT plans_mode_check CHECK (mode IN ('planejada','realizada'));
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_code_check;
ALTER TABLE plans ADD CONSTRAINT plans_code_check CHECK (code IS NULL OR code ~ '^[A-Z0-9][A-Z0-9./_-]{0,29}$');
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'planejada';
ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_origin_check;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_origin_check CHECK (origin IN ('planejada','realizada'));
ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_code_check;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_code_check CHECK (code IS NULL OR code ~ '^[A-Z0-9][A-Z0-9./_-]{0,29}$');
CREATE INDEX IF NOT EXISTS idx_work_orders_code ON work_orders(code) WHERE code IS NOT NULL;

-- Reservas: um impedimento técnico aberto depois do fim do período não afeta o período (atividade
-- já realizada antes do bloqueio). Demais regras iguais às da migração 0010.
CREATE OR REPLACE FUNCTION nautilus_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s timestamptz; e timestamptz; other text; wo text; carried boolean := false;
BEGIN
  IF NEW.status = 'liberada' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'liberada' THEN RAISE EXCEPTION 'Reserva liberada não pode ser reativada'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'liberada' THEN RAISE EXCEPTION 'Reserva liberada não pode ser reativada'; END IF;
  s := NEW.start_at::timestamptz; e := NEW.end_at::timestamptz;
  IF e <= s THEN RAISE EXCEPTION 'Reserva com período inválido'; END IF;
  SELECT work_order_id INTO wo FROM plans WHERE id = NEW.plan_id;
  IF wo IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM reservations r0 JOIN plans p0 ON p0.id = r0.plan_id
      JOIN plan_steps s0 ON s0.id = r0.plan_step_id JOIN plan_steps s1 ON s1.id = NEW.plan_step_id
      WHERE p0.work_order_id = wo AND p0.id <> NEW.plan_id AND p0.status = 'launched' AND r0.status = 'confirmada'
        AND r0.equipment_id = NEW.equipment_id AND s0.step_key = s1.step_key
        AND r0.start_at::timestamptz <= s AND r0.end_at::timestamptz >= e) INTO carried;
  END IF;
  PERFORM 1 FROM equipment WHERE id = NEW.equipment_id AND (active = 1 OR carried) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Equipamento indisponível para reserva'; END IF;
  IF carried THEN RETURN NEW; END IF;
  -- Promover a confirmada ou ajustar o fim de uma reserva já confirmada (término real) não reavalia a condição técnica.
  IF NOT (TG_OP = 'UPDATE' AND OLD.status = 'confirmada' AND NEW.status = 'confirmada' AND NEW.start_at = OLD.start_at AND NEW.end_at::timestamptz <= OLD.end_at::timestamptz)
     AND EXISTS (SELECT 1 FROM equipment_impediments WHERE equipment_id = NEW.equipment_id AND released_at IS NULL AND opened_at::timestamptz < e) THEN
    RAISE EXCEPTION 'Equipamento bloqueado por impedimento técnico';
  END IF;
  SELECT r.id INTO other FROM reservations r
   JOIN plans rp ON rp.id = r.plan_id
   LEFT JOIN os_steps o ON o.plan_step_id = r.plan_step_id AND o.status IN ('em_execucao','bloqueada','pausada')
   WHERE r.equipment_id = NEW.equipment_id AND r.id <> NEW.id AND r.status <> 'liberada'
     AND (wo IS NULL OR rp.id = NEW.plan_id OR rp.work_order_id IS DISTINCT FROM wo)
     AND r.start_at::timestamptz < e AND (CASE WHEN o.id IS NOT NULL THEN 'infinity'::timestamptz ELSE r.end_at::timestamptz END) > s LIMIT 1;
  IF other IS NOT NULL THEN RAISE EXCEPTION 'Equipamento reservado no período' USING DETAIL = other; END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN EXECUTE format('ALTER FUNCTION nautilus_reservation_guard() SET search_path TO %I', current_schema()); END $$;

-- Auditoria: quem tem Operação também registra a atividade realizada e cadastra recursos nela.
-- (Ações "Operação:%" já são aceitas para o acesso Operação.)
