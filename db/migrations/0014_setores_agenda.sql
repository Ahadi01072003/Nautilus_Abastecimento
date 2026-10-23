-- Código do setor: cadastro próprio (Cadastros gerais › Setores). O código da OS passa a ser
-- escolhido desse cadastro (com ou sem fluxo, planejada ou realizada); o número da OS não muda.
CREATE TABLE IF NOT EXISTS sectors (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9./_-]{0,29}$'),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
-- O código identifica o setor nas OS já lançadas: depois de criado, não muda (só nome, descrição e situação).
CREATE OR REPLACE FUNCTION nautilus_sector_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Setor não pode ser apagado; inative-o'; END IF;
  IF NEW.code <> OLD.code THEN RAISE EXCEPTION 'O código do setor não pode ser alterado'; END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN EXECUTE format('ALTER FUNCTION nautilus_sector_guard() SET search_path TO %I', current_schema()); END $$;
CREATE OR REPLACE TRIGGER sector_guard BEFORE UPDATE OR DELETE ON sectors FOR EACH ROW EXECUTE FUNCTION nautilus_sector_guard();

-- Códigos já usados entram no cadastro (nome provisório = código; o gestor ajusta o nome depois).
INSERT INTO sectors(id,code,name,created_at,updated_at)
SELECT gen_random_uuid()::text, code, code, to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM (SELECT code FROM work_orders WHERE coalesce(code,'') <> '' UNION SELECT code FROM plans WHERE coalesce(code,'') <> '' AND status <> 'discarded') x
WHERE code ~ '^[A-Z0-9][A-Z0-9./_-]{0,29}$'
ON CONFLICT (code) DO NOTHING;

-- Cancelamento de OS em andamento (planejador ou gestor, com justificativa): as etapas abertas
-- terminam como canceladas e o histórico de execução fica preservado.
ALTER TABLE os_steps DROP CONSTRAINT IF EXISTS os_steps_status_check;
ALTER TABLE os_steps ADD CONSTRAINT os_steps_status_check CHECK (status IN ('nao_iniciada','em_execucao','bloqueada','pausada','concluida','dispensada','cancelada'));
ALTER TABLE execution_events DROP CONSTRAINT IF EXISTS execution_events_kind_check;
ALTER TABLE execution_events ADD CONSTRAINT execution_events_kind_check CHECK (kind IN ('inicio','bloqueio','pausa','retomada','termino','dispensa','encerramento','encerramento_pendente','nc_critica','interrupcao_tecnica','cancelamento'));

-- Atividade realizada: apontamentos (ocorrência, impacto, bloqueio) informados no próprio registro.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS realized_notes jsonb NOT NULL DEFAULT '[]';
