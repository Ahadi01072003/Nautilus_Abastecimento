-- NAUTILUS · Planejamento: barras OCP e Equinor. HH disponível do dia = funcionários × horas trabalhadas.
-- Cada barra tem o padrão (funcionários em dia útil e fim de semana, jornada em horas) que o planejador corrige
-- por dia (falta, férias, reforço, jornada menor). A barra da OS vem do solicitante.
SET LOCAL lock_timeout='15s';

CREATE TABLE IF NOT EXISTS plan_bars (
  id text PRIMARY KEY CHECK (id IN ('ocp','equinor')),
  name text NOT NULL,
  color text NOT NULL CHECK (color ~ '^#[0-9A-F]{6}$'),
  staff_weekday integer NOT NULL DEFAULT 0 CHECK (staff_weekday BETWEEN 0 AND 500),
  staff_weekend integer NOT NULL DEFAULT 0 CHECK (staff_weekend BETWEEN 0 AND 500),
  hours numeric(4,2) NOT NULL DEFAULT 12 CHECK (hours > 0 AND hours <= 24),
  updated_at text,
  updated_by_name text
);
INSERT INTO plan_bars(id,name,color,hours) VALUES ('ocp','OCP','#14254A',9),('equinor','Equinor','#B3261E',12)
ON CONFLICT (id) DO NOTHING;

-- Efetivo do dia: corrige o padrão da barra naquele dia (sem linha = vale o padrão).
CREATE TABLE IF NOT EXISTS plan_day_staff (
  bar text NOT NULL REFERENCES plan_bars(id),
  day date NOT NULL,
  people integer NOT NULL CHECK (people BETWEEN 0 AND 500),
  hours numeric(4,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
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
