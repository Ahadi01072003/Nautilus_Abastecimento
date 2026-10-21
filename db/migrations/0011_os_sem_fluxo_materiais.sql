-- NAUTILUS · OS sem fluxo definido e materiais no planejamento de recursos.
-- A OS sem fluxo usa um tipo de atividade de sistema (criado na primeira vez que é usado, fora
-- do Cadastro de fluxo) com uma única etapa de execução presa às datas macro da OS; o título
-- da atividade fica no planejamento e na OS.

ALTER TABLE activity_types ADD COLUMN IF NOT EXISTS system integer NOT NULL DEFAULT 0;
ALTER TABLE activity_types DROP CONSTRAINT IF EXISTS activity_types_system_check;
ALTER TABLE activity_types ADD CONSTRAINT activity_types_system_check CHECK (system IN (0,1));
ALTER TABLE plans ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS title text;

-- Materiais (consumíveis, peças, insumos), com unidade de medida padrão.
CREATE TABLE IF NOT EXISTS materials (
  id text PRIMARY KEY,
  name text NOT NULL,
  unit text NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 12),
  description text NOT NULL DEFAULT '',
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS materials_name_key ON materials (lower(name));

-- Necessidades do planejamento: tipo de equipamento, função ou material. Equipamentos e funções
-- contam unidades inteiras (1 a 99); material tem quantidade decimal e unidade de medida.
ALTER TABLE plan_step_needs ADD COLUMN IF NOT EXISTS material_id text REFERENCES materials(id);
ALTER TABLE plan_step_needs ADD COLUMN IF NOT EXISTS amount numeric(14,3);
ALTER TABLE plan_step_needs ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE plan_step_needs ALTER COLUMN quantity DROP NOT NULL;
ALTER TABLE plan_step_needs DROP CONSTRAINT IF EXISTS plan_need_target;
ALTER TABLE plan_step_needs ADD CONSTRAINT plan_need_target CHECK (num_nonnulls(equipment_type_id, function_id, material_id) = 1);
ALTER TABLE plan_step_needs DROP CONSTRAINT IF EXISTS plan_need_amount;
ALTER TABLE plan_step_needs ADD CONSTRAINT plan_need_amount CHECK (
  (material_id IS NULL AND quantity IS NOT NULL AND amount IS NULL)
  OR (material_id IS NOT NULL AND amount > 0 AND amount <= 99999999 AND length(trim(coalesce(unit,''))) BETWEEN 1 AND 12));

DO $$ DECLARE t text; r text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
