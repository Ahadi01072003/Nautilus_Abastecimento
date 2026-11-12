-- NAUTILUS · Planejamento por dia (P0, decisões do usuário em 11 e 12/11/2026).
-- 1. Planejamento (OS planejada) passa a ter só dia de início e dia de fim. As colunas continuam
--    com data e hora, sempre em dia inteiro de Brasília: início = 00h do primeiro dia; fim = 00h do dia
--    seguinte ao último (exclusivo). A hora antiga fica guardada como histórico (*_old).
--    Atividade realizada (registro do que já foi feito) mantém data e hora reais.
-- 2. Equipamento reservado em HORAS POR DIA: a soma das reservas de um equipamento num dia não passa
--    de 12 h. Reserva antiga vira as horas reais que ela ocupava no dia (máximo 12).
--    Continua: rascunho não segura (só OS lançada disputa; dentro do mesmo planejamento todas contam),
--    impedimento técnico bloqueia, atividade realizada fica fora, revisão mantém o da versão vigente.
SET LOCAL lock_timeout='15s';

CREATE OR REPLACE FUNCTION nautilus_day_start(d date) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT to_char((d::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
CREATE OR REPLACE FUNCTION nautilus_first_day(v text) RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (v::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
$$;
-- Último dia ocupado por um fim exclusivo (00h do dia seguinte conta como o dia anterior).
CREATE OR REPLACE FUNCTION nautilus_last_day(v text) RETURNS date LANGUAGE sql STABLE AS $$
  SELECT ((v::timestamptz - interval '1 millisecond') AT TIME ZONE 'America/Sao_Paulo')::date
$$;

ALTER TABLE plans ADD COLUMN IF NOT EXISTS planned_start_old text, ADD COLUMN IF NOT EXISTS planned_end_old text;
ALTER TABLE plan_steps ADD COLUMN IF NOT EXISTS planned_start_old text, ADD COLUMN IF NOT EXISTS planned_end_old text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS planned_start_old text, ADD COLUMN IF NOT EXISTS planned_end_old text;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS start_at_old text, ADD COLUMN IF NOT EXISTS end_at_old text;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS hours_per_day numeric(4,2) NOT NULL DEFAULT 12;
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_hours_per_day;
ALTER TABLE reservations ADD CONSTRAINT reservations_hours_per_day CHECK (hours_per_day > 0 AND hours_per_day <= 12);

-- Conversão das OS já existentes (fora as atividades realizadas). Guardas desligadas só durante a conversão.
ALTER TABLE plans DISABLE TRIGGER USER;
ALTER TABLE plan_steps DISABLE TRIGGER USER;
ALTER TABLE reservations DISABLE TRIGGER USER;
ALTER TABLE work_orders DISABLE TRIGGER USER;

-- Horas reais que a reserva ocupava no dia mais carregado, arredondadas para cima ao quarto de hora
-- (máximo 12), antes de virar dia inteiro. Dias que já passavam de 12 h ficam como estão (a trava vale
-- para reservas novas ou alteradas).
UPDATE reservations r SET start_at_old = r.start_at, end_at_old = r.end_at,
  hours_per_day = coalesce(nullif(least(12, ceil((
    SELECT max(extract(epoch FROM least(r.end_at::timestamptz, (d + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
                       - greatest(r.start_at::timestamptz, d::timestamp AT TIME ZONE 'America/Sao_Paulo')) / 3600)
    FROM generate_series(nautilus_first_day(r.start_at), nautilus_last_day(r.end_at), interval '1 day') g(d0), LATERAL (SELECT g.d0::date d) x
  )::numeric * 4) / 4), 0), 12)
 FROM plans p WHERE p.id = r.plan_id AND p.mode <> 'realizada' AND r.end_at::timestamptz > r.start_at::timestamptz;
UPDATE reservations r SET start_at = nautilus_day_start(nautilus_first_day(r.start_at)),
  end_at = nautilus_day_start(greatest(nautilus_last_day(r.end_at), nautilus_first_day(r.start_at)) + 1)
 FROM plans p WHERE p.id = r.plan_id AND p.mode <> 'realizada';

UPDATE plan_steps s SET planned_start_old = s.planned_start, planned_end_old = s.planned_end,
  planned_start = nautilus_day_start(nautilus_first_day(s.planned_start)),
  planned_end = nautilus_day_start(greatest(nautilus_last_day(s.planned_end), nautilus_first_day(s.planned_start)) + 1)
 FROM plans p WHERE p.id = s.plan_id AND p.mode <> 'realizada' AND s.planned_start IS NOT NULL AND s.planned_end IS NOT NULL;

UPDATE plans p SET planned_start_old = p.planned_start, planned_end_old = p.planned_end,
  planned_start = nautilus_day_start(nautilus_first_day(p.planned_start)),
  planned_end = nautilus_day_start(greatest(nautilus_last_day(p.planned_end), nautilus_first_day(p.planned_start)) + 1)
 WHERE p.mode <> 'realizada' AND p.planned_start IS NOT NULL AND p.planned_end IS NOT NULL;

UPDATE work_orders w SET planned_start_old = w.planned_start, planned_end_old = w.planned_end,
  planned_start = nautilus_day_start(nautilus_first_day(w.planned_start)),
  planned_end = nautilus_day_start(greatest(nautilus_last_day(w.planned_end), nautilus_first_day(w.planned_start)) + 1)
 FROM plans p WHERE p.id = w.original_plan_id AND p.mode <> 'realizada' AND w.planned_start IS NOT NULL AND w.planned_end IS NOT NULL;

ALTER TABLE plans ENABLE TRIGGER USER;
ALTER TABLE plan_steps ENABLE TRIGGER USER;
ALTER TABLE reservations ENABLE TRIGGER USER;
ALTER TABLE work_orders ENABLE TRIGGER USER;

-- Intertravamento por horas no dia. Para cada dia da reserva: horas já reservadas por quem disputa
-- (OS lançada; no mesmo planejamento, todas) + as desta reserva ≤ 12.
CREATE OR REPLACE FUNCTION nautilus_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s timestamptz; e timestamptz; wo text; carried boolean := false; d date; used numeric; other text;
BEGIN
  IF NEW.status = 'liberada' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'liberada' THEN RAISE EXCEPTION 'Reserva liberada não pode ser reativada'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'liberada' THEN RAISE EXCEPTION 'Reserva liberada não pode ser reativada'; END IF;
  s := NEW.start_at::timestamptz; e := NEW.end_at::timestamptz;
  IF e <= s THEN RAISE EXCEPTION 'Reserva com período inválido'; END IF;
  IF NEW.hours_per_day IS NULL OR NEW.hours_per_day <= 0 OR NEW.hours_per_day > 12 THEN RAISE EXCEPTION 'Horas de uso por dia (hours_per_day) devem ser de mais de 0 até 12'; END IF;
  -- Atividade realizada (registro do que já foi feito): não sofre nem causa intertravamento.
  IF EXISTS (SELECT 1 FROM plans WHERE id = NEW.plan_id AND mode = 'realizada') THEN RETURN NEW; END IF;
  SELECT work_order_id INTO wo FROM plans WHERE id = NEW.plan_id;
  -- Revisão: o mesmo equipamento, na mesma etapa, dentro do período e das horas da versão vigente, é a mesma reserva.
  IF wo IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM reservations r0 JOIN plans p0 ON p0.id = r0.plan_id
      JOIN plan_steps s0 ON s0.id = r0.plan_step_id JOIN plan_steps s1 ON s1.id = NEW.plan_step_id
      WHERE p0.work_order_id = wo AND p0.id <> NEW.plan_id AND p0.status = 'launched' AND r0.status = 'confirmada'
        AND r0.equipment_id = NEW.equipment_id AND s0.step_key = s1.step_key AND r0.hours_per_day >= NEW.hours_per_day
        AND r0.start_at::timestamptz <= s AND r0.end_at::timestamptz >= e) INTO carried;
  END IF;
  PERFORM 1 FROM equipment WHERE id = NEW.equipment_id AND (active = 1 OR carried) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Equipamento indisponível para reserva'; END IF;
  IF carried THEN RETURN NEW; END IF;
  -- Promover a confirmada ou encurtar uma reserva já confirmada não reavalia a condição técnica.
  IF NOT (TG_OP = 'UPDATE' AND OLD.status = 'confirmada' AND NEW.status = 'confirmada' AND NEW.start_at = OLD.start_at AND NEW.end_at::timestamptz <= OLD.end_at::timestamptz)
     AND EXISTS (SELECT 1 FROM equipment_impediments WHERE equipment_id = NEW.equipment_id AND released_at IS NULL AND opened_at::timestamptz < e) THEN
    RAISE EXCEPTION 'Equipamento bloqueado por impedimento técnico';
  END IF;
  FOR d IN SELECT g::date FROM generate_series(nautilus_first_day(NEW.start_at), nautilus_last_day(NEW.end_at), interval '1 day') g LOOP
    SELECT coalesce(sum(r.hours_per_day), 0), min(r.id) INTO used, other FROM reservations r JOIN plans rp ON rp.id = r.plan_id
     WHERE r.equipment_id = NEW.equipment_id AND r.id <> NEW.id AND r.status <> 'liberada'
       AND rp.mode <> 'realizada'
       AND (r.status = 'confirmada' OR r.plan_id = NEW.plan_id)
       AND (wo IS NULL OR rp.id = NEW.plan_id OR rp.work_order_id IS DISTINCT FROM wo)
       AND nautilus_first_day(r.start_at) <= d AND nautilus_last_day(r.end_at) >= d;
    IF used + NEW.hours_per_day > 12 THEN
      RAISE EXCEPTION 'Equipamento reservado no período' USING DETAIL = coalesce(other, ''), HINT = format('%s: %s h já reservadas', to_char(d, 'DD/MM/YYYY'), used);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER reservation_guard BEFORE INSERT OR UPDATE OF start_at, end_at, status, equipment_id, hours_per_day ON reservations
  FOR EACH ROW EXECUTE FUNCTION nautilus_reservation_guard();

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.proname LIKE 'nautilus\_%' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I', f, current_schema());
  END LOOP;
END $$;
