-- NAUTILUS · Planejamento: barras OCP e Equinor. HH disponível do dia = ADM (funcionários × horas do dia:
-- segunda a sexta, sábado; domingo não) + Turno do dia (funcionários × horas, todos os dias, escala 2x2).
-- A Gestão define o padrão; o planejador corrige ADM e turno de um dia (falta, férias, reforço). A barra da OS
-- vem do solicitante.
SET LOCAL lock_timeout='15s';

CREATE TABLE IF NOT EXISTS plan_bars (
  id text PRIMARY KEY CHECK (id IN ('ocp','equinor')),
  name text NOT NULL,
  color text NOT NULL CHECK (color ~ '^#[0-9A-F]{6}$'),
  adm_people integer NOT NULL DEFAULT 0 CHECK (adm_people BETWEEN 0 AND 500),
  adm_hours numeric(4,2) NOT NULL DEFAULT 8 CHECK (adm_hours >= 0 AND adm_hours <= 24),
  adm_saturday_hours numeric(4,2) NOT NULL DEFAULT 0 CHECK (adm_saturday_hours >= 0 AND adm_saturday_hours <= 24),
  shift_people integer NOT NULL DEFAULT 0 CHECK (shift_people BETWEEN 0 AND 500),
  shift_hours numeric(4,2) NOT NULL DEFAULT 12 CHECK (shift_hours > 0 AND shift_hours <= 24),
  updated_at text,
  updated_by_name text
);
-- Equinor conforme a planilha de HH (17/11/2026): ADM 7 (8 h seg–sex, 4 h sáb) e turno 7 por dia (12 h).
INSERT INTO plan_bars(id,name,color,adm_people,adm_hours,adm_saturday_hours,shift_people,shift_hours) VALUES
 ('ocp','OCP','#14254A',0,9,0,0,12),
 ('equinor','Equinor','#B3261E',7,8,4,7,12)
ON CONFLICT (id) DO NOTHING;

-- Efetivo do dia: corrige o padrão da barra naquele dia (sem linha = vale o padrão).
CREATE TABLE IF NOT EXISTS plan_day_staff (
  bar text NOT NULL REFERENCES plan_bars(id),
  day date NOT NULL,
  adm_people integer NOT NULL CHECK (adm_people BETWEEN 0 AND 500),
  adm_hours numeric(4,2) NOT NULL CHECK (adm_hours >= 0 AND adm_hours <= 24),
  shift_people integer NOT NULL CHECK (shift_people BETWEEN 0 AND 500),
  shift_hours numeric(4,2) NOT NULL CHECK (shift_hours >= 0 AND shift_hours <= 24),
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
