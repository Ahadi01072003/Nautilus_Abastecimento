-- NAUTILUS · Planejamento P1: barras (OCP e Equinor), equipes e escala 2x2, ausências, planejadores por
-- barra e solicitante por barra. A capacidade (HH por dia e por função) é calculada a partir daqui.
SET LOCAL lock_timeout='15s';

-- Barras de HH: cada uma com a sua equipe e os seus planejadores. Jornada ADM por dia da semana
-- (domingo a sábado), turno 2x2 (12 h; Turno A trabalha nos dias 0 e 1 do ciclo de 4 a partir da âncora,
-- Turno B nos dias 2 e 3) e zonas (meta, 100% e teto de ultrapassagem).
CREATE TABLE IF NOT EXISTS plan_bars (
  id text PRIMARY KEY CHECK (id IN ('ocp','equinor')),
  name text NOT NULL,
  color text NOT NULL CHECK (color ~ '^#[0-9A-F]{6}$'),
  adm_hours numeric(4,2)[] NOT NULL CHECK (array_length(adm_hours,1) = 7 AND 0 <= ALL(adm_hours) AND 24 >= ALL(adm_hours)),
  shift_hours numeric(4,2) NOT NULL DEFAULT 12 CHECK (shift_hours > 0 AND shift_hours <= 24),
  shift_anchor date NOT NULL,
  zone_target smallint NOT NULL DEFAULT 85,
  zone_full smallint NOT NULL DEFAULT 100,
  zone_ceiling smallint NOT NULL DEFAULT 115,
  updated_at text,
  updated_by_name text,
  CONSTRAINT plan_bars_zones CHECK (zone_target > 0 AND zone_target <= zone_full AND zone_full <= zone_ceiling AND zone_ceiling <= 200)
);
INSERT INTO plan_bars(id,name,color,adm_hours,shift_hours,shift_anchor) VALUES
 ('ocp','OCP','#14254A','{0,9,9,9,9,9,0}',12,'2026-11-11'),
 ('equinor','Equinor','#B3261E','{0,9,9,9,9,9,4}',12,'2026-11-11')
ON CONFLICT (id) DO NOTHING;

-- Colaborador: barra, equipe (ADM, Turno A, Turno B), função atuante e se entra no HH (Supervisor e TST não).
ALTER TABLE operators ADD COLUMN IF NOT EXISTS bar text REFERENCES plan_bars(id);
ALTER TABLE operators ADD COLUMN IF NOT EXISTS team text CHECK (team IN ('adm','turno_a','turno_b'));
ALTER TABLE operators ADD COLUMN IF NOT EXISTS acting_function_id text REFERENCES job_functions(id);
ALTER TABLE operators ADD COLUMN IF NOT EXISTS counts_hh smallint NOT NULL DEFAULT 1 CHECK (counts_hh IN (0,1));

-- Solicitante: a barra da OS vem da organização (OCP OCEANPACT → OCP; os demais → Equinor).
ALTER TABLE requester_orgs ADD COLUMN IF NOT EXISTS bar text NOT NULL DEFAULT 'equinor' REFERENCES plan_bars(id);
UPDATE requester_orgs SET bar = 'ocp' WHERE upper(acronym) = 'OCP' OR upper(name) LIKE 'OCP%';

-- Planejador: barras que planeja (vazio = sem restrição, como antes).
ALTER TABLE members ADD COLUMN IF NOT EXISTS planning_bars text[] NOT NULL DEFAULT '{}';
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_planning_bars;
ALTER TABLE members ADD CONSTRAINT members_planning_bars CHECK (planning_bars <@ ARRAY['ocp','equinor']::text[]);

-- Ausências: férias e afastamentos (Gestão) e falta do dia (líder na chamada). Reduzem a capacidade.
CREATE TABLE IF NOT EXISTS operator_absences (
  id text PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id),
  kind text NOT NULL CHECK (kind IN ('ferias','afastamento','folga','falta')),
  start_day date NOT NULL,
  end_day date NOT NULL,
  note text,
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL,
  cancelled_at text,
  cancelled_by_name text,
  CONSTRAINT operator_absences_period CHECK (end_day >= start_day AND end_day - start_day <= 366)
);
CREATE INDEX IF NOT EXISTS idx_operator_absences_operator ON operator_absences(operator_id, start_day) WHERE cancelled_at IS NULL;

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['plan_bars','operator_absences'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r); END IF;
    END LOOP;
  END LOOP;
END $$;
