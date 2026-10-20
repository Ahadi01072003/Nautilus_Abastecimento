-- NAUTILUS · Revisão de OS lançada: nova versão do planejamento com o mesmo número da OS.
-- A revisão é um rascunho ligado à OS; ao ser lançada, substitui o planejamento vigente e as
-- reservas numa única transação. Etapas concluídas ou dispensadas não mudam.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS revision_reason text NOT NULL DEFAULT '';
-- Planejamento a partir do qual a revisão foi aberta (o vigente naquele momento).
ALTER TABLE plans ADD COLUMN IF NOT EXISTS base_plan_id text REFERENCES plans(id);
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

-- Uma revisão em rascunho por OS; número de revisão único entre as versões lançadas.
CREATE UNIQUE INDEX IF NOT EXISTS plans_one_revision_draft ON plans(work_order_id) WHERE status = 'draft' AND work_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS plans_revision_number ON plans(work_order_id, revision) WHERE status IN ('launched','superseded');

-- Checklist previsto que deixou de se aplicar (equipamento retirado na revisão): fica registrado, não é apagado.
ALTER TABLE checklist_requirements ADD COLUMN IF NOT EXISTS waived_at text;
ALTER TABLE checklist_requirements ADD COLUMN IF NOT EXISTS waived_reason text;

-- Reservas: o rascunho de revisão não disputa com o planejamento vigente da própria OS, e a
-- reserva transportada da versão vigente (mesmo equipamento, mesma etapa, dentro do mesmo
-- intervalo) não é um compromisso novo: não reavalia agenda nem condição técnica.
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
     AND EXISTS (SELECT 1 FROM equipment_impediments WHERE equipment_id = NEW.equipment_id AND released_at IS NULL) THEN
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

-- Etapa da OS aponta sempre para uma etapa do planejamento vigente da própria OS.
CREATE OR REPLACE FUNCTION nautilus_os_step_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plan_steps ps JOIN plans p ON p.id = ps.plan_id
      WHERE ps.id = NEW.plan_step_id AND ps.step_key = NEW.step_key AND p.work_order_id = NEW.work_order_id) THEN
    RAISE EXCEPTION 'Etapa da OS fora do planejamento da OS';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN EXECUTE format('ALTER FUNCTION nautilus_os_step_plan() SET search_path TO %I', current_schema()); END $$;
CREATE OR REPLACE TRIGGER os_step_plan BEFORE INSERT OR UPDATE OF plan_step_id, step_key, work_order_id ON os_steps
  FOR EACH ROW EXECUTE FUNCTION nautilus_os_step_plan();
