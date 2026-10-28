-- NAUTILUS · Horas de uso do equipamento respeitadas também com a OS em andamento.
-- Equipamento com horas de uso definidas (OS sem fluxo) fica reservado só nesse período, mesmo com a
-- etapa em execução: depois disso, fica livre para outras OS. Equipamento da etapa inteira ("OS
-- inteira", o padrão) segue ocupado até a etapa ser finalizada, se ela passar do previsto.
-- Corrige a 0017, que estendia qualquer reserva de etapa em andamento até o fim previsto da etapa.
-- Revisão relançada sem alterações fica marcada no histórico.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS revision_unchanged smallint NOT NULL DEFAULT 0;

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
   JOIN plan_steps rs ON rs.id = r.plan_step_id
   LEFT JOIN os_steps o ON o.plan_step_id = r.plan_step_id AND o.status IN ('em_execucao','bloqueada','pausada')
   WHERE r.equipment_id = NEW.equipment_id AND r.id <> NEW.id AND r.status <> 'liberada'
     AND (wo IS NULL OR rp.id = NEW.plan_id OR rp.work_order_id IS DISTINCT FROM wo)
     AND r.start_at::timestamptz < e
     -- Etapa em andamento: só a reserva da etapa inteira (vai até o fim previsto da etapa) segue
     -- ocupada enquanto a etapa não termina; horas de uso definidas valem exatamente como planejadas.
     AND (CASE WHEN o.id IS NOT NULL AND r.end_at::timestamptz >= rs.planned_end::timestamptz THEN greatest(r.end_at::timestamptz, now()) ELSE r.end_at::timestamptz END) > s LIMIT 1;
  IF other IS NOT NULL THEN RAISE EXCEPTION 'Equipamento reservado no período' USING DETAIL = other; END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN EXECUTE format('ALTER FUNCTION nautilus_reservation_guard() SET search_path TO %I', current_schema()); END $$;
