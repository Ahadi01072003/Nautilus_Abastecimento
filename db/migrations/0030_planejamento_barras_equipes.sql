-- NAUTILUS · Programação do dia: barras OCP e Equinor. HH disponível do dia = soma das janelas do dia, cada uma com
-- quem está presente: colaboradores com barra e escala (ADM, Turno A, Turno B; sem escala = fora do HH, como
-- Supervisor e TST) e as jornadas da barra (início, fim e almoço por escala e tipo de dia). Turno 2x2 a partir da
-- âncora (primeiro dia do Turno A). O planejador pode ajustar o HH de um dia. A barra da OS vem do solicitante.
SET LOCAL lock_timeout='15s';

CREATE TABLE IF NOT EXISTS plan_bars (
  id text PRIMARY KEY CHECK (id IN ('ocp','equinor')),
  name text NOT NULL,
  color text NOT NULL CHECK (color ~ '^#[0-9A-F]{6}$'),
  schedule jsonb NOT NULL CHECK (jsonb_typeof(schedule) = 'object'),
  updated_at text,
  updated_by_name text
);
-- Jornadas (17/11/2026): Equinor ADM seg–sex 08–17 (almoço), sáb 08–12; Turno 2x2 08–20 (almoço) todo dia, Turno A
-- em 19/11/2026. OCP só ADM seg–sex 08–17 (almoço).
INSERT INTO plan_bars(id,name,color,schedule) VALUES
 ('ocp','OCP','#14254A','{"anchor":"2026-11-19","adm":{"weekday":{"start":"08:00","end":"17:00","lunch":true},"saturday":null,"sunday":null},"turno":null}'),
 ('equinor','Equinor','#B3261E','{"anchor":"2026-11-19","adm":{"weekday":{"start":"08:00","end":"17:00","lunch":true},"saturday":{"start":"08:00","end":"12:00","lunch":false},"sunday":null},"turno":{"weekday":{"start":"08:00","end":"20:00","lunch":true},"saturday":{"start":"08:00","end":"20:00","lunch":true},"sunday":{"start":"08:00","end":"20:00","lunch":true}}}')
ON CONFLICT (id) DO NOTHING;

-- Colaborador: barra e escala (vazio = fora do HH).
ALTER TABLE operators ADD COLUMN IF NOT EXISTS bar text REFERENCES plan_bars(id);
ALTER TABLE operators ADD COLUMN IF NOT EXISTS schedule text CHECK (schedule IN ('adm','turno_a','turno_b'));

-- Ajuste do HH de um dia (sem linha = vale o calculado).
CREATE TABLE IF NOT EXISTS plan_day_staff (
  bar text NOT NULL REFERENCES plan_bars(id),
  day date NOT NULL,
  hh numeric(7,2) NOT NULL CHECK (hh >= 0 AND hh <= 5000),
  note text CHECK (note IS NULL OR length(note) <= 300),
  updated_at text NOT NULL,
  updated_by text NOT NULL REFERENCES members(id),
  updated_by_name text NOT NULL,
  PRIMARY KEY (bar, day)
);

-- Solicitante: a barra da OS vem da organização (OceanPact → OCP; os demais → Equinor). O cadastro atual
-- da OceanPact usa sigla OCPT e nome OCEANPACT; as variações OCP… também contam. Ajustável no cadastro.
ALTER TABLE requester_orgs ADD COLUMN IF NOT EXISTS bar text NOT NULL DEFAULT 'equinor' REFERENCES plan_bars(id);
UPDATE requester_orgs SET bar = 'ocp'
 WHERE upper(acronym) IN ('OCP','OCPT') OR upper(name) LIKE 'OCP%' OR upper(replace(name,' ','')) LIKE 'OCEANPACT%';

-- Planejador: barras que planeja (vazio = sem restrição, como antes).
ALTER TABLE members ADD COLUMN IF NOT EXISTS planning_bars text[] NOT NULL DEFAULT '{}';
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_planning_bars;
ALTER TABLE members ADD CONSTRAINT members_planning_bars CHECK (planning_bars <@ ARRAY['ocp','equinor']::text[]);

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['plan_bars','plan_day_staff'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r); END IF;
    END LOOP;
  END LOOP;
END $$;
