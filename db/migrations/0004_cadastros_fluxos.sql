-- NAUTILUS · Cadastros gerais, cadastro de fluxos e modelos de checklist (fase 1 do prompt v2.1).
-- Reaproveita equipamentos, operadores e usuários existentes; nenhum dado é removido.

-- Acessos adicionais por usuário (o gestor tem todos). Um usuário pode acumular acessos.
ALTER TABLE members ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT '{}';
ALTER TABLE members DROP CONSTRAINT IF EXISTS member_capabilities;
ALTER TABLE members ADD CONSTRAINT member_capabilities CHECK (capabilities <@ ARRAY['cadastros','planejamento']::text[]);

-- Organizações solicitantes (operação interna ou clientes) e pessoas solicitantes.
CREATE TABLE IF NOT EXISTS requester_orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  acronym text NOT NULL CHECK (acronym ~ '^[A-Z0-9][A-Z0-9 ._-]{0,11}$'),
  category text NOT NULL CHECK (category IN ('interna','cliente')),
  color text NOT NULL CHECK (color ~ '^#[0-9A-F]{6}$'),
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS requester_orgs_name_key ON requester_orgs (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS requester_orgs_acronym_key ON requester_orgs (acronym);

CREATE TABLE IF NOT EXISTS requester_people (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES requester_orgs(id),
  name text NOT NULL,
  role text NOT NULL DEFAULT '',
  email text,
  phone text NOT NULL DEFAULT '',
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requester_people_org ON requester_people(org_id);

-- Locais: unidade › área › local. O nível não muda depois de criado, e o pai sempre
-- tem nível superior: isso impede ciclos sem precisar percorrer a árvore.
CREATE TABLE IF NOT EXISTS locations (
  id text PRIMARY KEY,
  parent_id text REFERENCES locations(id),
  kind text NOT NULL CHECK (kind IN ('unidade','area','local')),
  code text NOT NULL DEFAULT '',
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT location_root CHECK ((kind = 'unidade') = (parent_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS locations_name_key ON locations (coalesce(parent_id,''), lower(name));

CREATE OR REPLACE FUNCTION nautilus_location_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'Nível do local não pode ser alterado';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT kind INTO parent_kind FROM locations WHERE id = NEW.parent_id;
    IF parent_kind IS NULL OR NOT ((NEW.kind = 'area' AND parent_kind = 'unidade') OR (NEW.kind = 'local' AND parent_kind IN ('unidade','area'))) THEN
      RAISE EXCEPTION 'Hierarquia de local inválida';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER location_guard BEFORE INSERT OR UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION nautilus_location_guard();

-- Tipos de equipamento, criados a partir dos tipos já digitados nos equipamentos.
CREATE TABLE IF NOT EXISTS equipment_types (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS equipment_types_name_key ON equipment_types (lower(name));

ALTER TABLE equipment ADD COLUMN IF NOT EXISTS type_id text REFERENCES equipment_types(id);
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS location_id text REFERENCES locations(id);
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS capacity text NOT NULL DEFAULT '';

INSERT INTO equipment_types(id,name,description,active,created_at,updated_at)
SELECT gen_random_uuid()::text, t.name, '', 1, to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM (SELECT DISTINCT ON (lower(trim(type))) trim(type) AS name FROM equipment WHERE trim(type) <> '' ORDER BY lower(trim(type)), trim(type)) t
ON CONFLICT DO NOTHING;
UPDATE equipment e SET type_id = t.id FROM equipment_types t WHERE e.type_id IS NULL AND lower(t.name) = lower(trim(e.type));

-- Funções dos colaboradores; um colaborador pode ter várias funções e, opcionalmente, um usuário.
CREATE TABLE IF NOT EXISTS job_functions (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS job_functions_name_key ON job_functions (lower(name));

ALTER TABLE operators ADD COLUMN IF NOT EXISTS member_id text REFERENCES members(id);
CREATE UNIQUE INDEX IF NOT EXISTS operators_member_key ON operators(member_id) WHERE member_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS operator_functions (
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  function_id text NOT NULL REFERENCES job_functions(id),
  PRIMARY KEY (operator_id, function_id)
);

-- Categorias de ocorrências, impactos e bloqueios.
CREATE TABLE IF NOT EXISTS occurrence_categories (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('ocorrencia','impacto','bloqueio')),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS occurrence_categories_name_key ON occurrence_categories (kind, lower(name));

-- Tipos de atividade e versões imutáveis do fluxo (etapas, dependências e necessidades).
CREATE TABLE IF NOT EXISTS activity_types (
  id text PRIMARY KEY,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9._-]{1,19}$'),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  current_version integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS activity_types_code_key ON activity_types (code);
CREATE UNIQUE INDEX IF NOT EXISTS activity_types_name_key ON activity_types (lower(name));

CREATE TABLE IF NOT EXISTS flow_versions (
  id text PRIMARY KEY,
  activity_type_id text NOT NULL REFERENCES activity_types(id),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL,
  UNIQUE (activity_type_id, version)
);

CREATE TABLE IF NOT EXISTS flow_steps (
  id text PRIMARY KEY,
  flow_version_id text NOT NULL REFERENCES flow_versions(id),
  step_key text NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  default_minutes integer CHECK (default_minutes IS NULL OR default_minutes BETWEEN 1 AND 525600),
  required integer NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  UNIQUE (flow_version_id, id),
  UNIQUE (flow_version_id, step_key),
  UNIQUE (flow_version_id, position)
);

CREATE TABLE IF NOT EXISTS flow_dependencies (
  flow_version_id text NOT NULL,
  step_id text NOT NULL,
  depends_on_id text NOT NULL,
  PRIMARY KEY (step_id, depends_on_id),
  FOREIGN KEY (flow_version_id, step_id) REFERENCES flow_steps(flow_version_id, id),
  FOREIGN KEY (flow_version_id, depends_on_id) REFERENCES flow_steps(flow_version_id, id),
  CONSTRAINT dependency_self CHECK (step_id <> depends_on_id)
);

CREATE TABLE IF NOT EXISTS flow_step_needs (
  id text PRIMARY KEY,
  flow_version_id text NOT NULL,
  step_id text NOT NULL,
  equipment_type_id text REFERENCES equipment_types(id),
  function_id text REFERENCES job_functions(id),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  FOREIGN KEY (flow_version_id, step_id) REFERENCES flow_steps(flow_version_id, id),
  CONSTRAINT need_target CHECK (num_nonnulls(equipment_type_id, function_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS flow_step_needs_unique ON flow_step_needs (step_id, coalesce(equipment_type_id,''), coalesce(function_id,''));

-- Ciclos de dependência são recusados no próprio banco (verificação ao fim da transação).
CREATE OR REPLACE FUNCTION nautilus_flow_cycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE upstream(id) AS (
      SELECT NEW.depends_on_id
      UNION
      SELECT d.depends_on_id FROM flow_dependencies d JOIN upstream u ON d.step_id = u.id
    ) SELECT 1 FROM upstream WHERE id = NEW.step_id
  ) THEN
    RAISE EXCEPTION 'Dependência circular entre etapas';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS flow_cycle_guard ON flow_dependencies;
CREATE CONSTRAINT TRIGGER flow_cycle_guard AFTER INSERT ON flow_dependencies DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nautilus_flow_cycle_guard();

-- Modelos de checklist com versões imutáveis: perguntas e vínculos ficam na versão.
CREATE TABLE IF NOT EXISTS checklist_templates (
  id text PRIMARY KEY,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9._-]{1,19}$'),
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  current_version integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS checklist_templates_code_key ON checklist_templates (code);

CREATE TABLE IF NOT EXISTS checklist_versions (
  id text PRIMARY KEY,
  template_id text NOT NULL REFERENCES checklist_templates(id),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  moment text NOT NULL CHECK (moment IN ('pre_atividade','pre_uso','durante','pos_atividade')),
  mandatory integer NOT NULL DEFAULT 0 CHECK (mandatory IN (0,1)),
  general_use integer NOT NULL DEFAULT 0 CHECK (general_use IN (0,1)),
  notes text NOT NULL DEFAULT '',
  created_at text NOT NULL,
  created_by text NOT NULL REFERENCES members(id),
  created_by_name text NOT NULL,
  UNIQUE (template_id, version)
);

CREATE TABLE IF NOT EXISTS checklist_questions (
  id text PRIMARY KEY,
  version_id text NOT NULL REFERENCES checklist_versions(id),
  position integer NOT NULL CHECK (position > 0),
  text text NOT NULL,
  required integer NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  critical integer NOT NULL DEFAULT 0 CHECK (critical IN (0,1)),
  target text NOT NULL CHECK (target IN ('atividade','equipamento')),
  allow_na integer NOT NULL DEFAULT 1 CHECK (allow_na IN (0,1)),
  note_on text[] NOT NULL DEFAULT '{}' CHECK (note_on <@ ARRAY['C','NC','NA']::text[]),
  evidence_on text[] NOT NULL DEFAULT '{}' CHECK (evidence_on <@ ARRAY['C','NC','NA']::text[]),
  UNIQUE (version_id, position),
  CONSTRAINT na_rules CHECK (allow_na = 1 OR NOT ('NA' = ANY(note_on) OR 'NA' = ANY(evidence_on)))
);

CREATE TABLE IF NOT EXISTS checklist_links (
  id text PRIMARY KEY,
  version_id text NOT NULL REFERENCES checklist_versions(id),
  activity_type_id text REFERENCES activity_types(id),
  equipment_id text REFERENCES equipment(id),
  equipment_type_id text REFERENCES equipment_types(id),
  CONSTRAINT link_target CHECK (num_nonnulls(activity_type_id, equipment_id, equipment_type_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS checklist_links_unique ON checklist_links (version_id, coalesce(activity_type_id,''), coalesce(equipment_id,''), coalesce(equipment_type_id,''));

-- Versões publicadas nunca mudam: OS e preenchimentos futuros dependem delas.
CREATE OR REPLACE FUNCTION nautilus_immutable_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Versão publicada é imutável';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['flow_versions','flow_steps','flow_dependencies','flow_step_needs','checklist_versions','checklist_questions','checklist_links'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_immutable', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION nautilus_immutable_version()', t || '_immutable', t);
  END LOOP;
END $$;

-- Auditoria: além das regras anteriores, quem tem o acesso "Cadastros gerais" ou
-- "Planejamento" registra somente as ações desses módulos. Como toda alteração grava
-- auditoria na mesma transação, a permissão também vale na camada de dados.
CREATE OR REPLACE FUNCTION nautilus_audit_actor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.author_id AND active = 1 AND (
      profile = 'manager'
      OR (NEW.action = 'Senha definida pelo usuário' AND NEW.entity_id = NEW.author_id)
      OR (profile = 'planner' AND NEW.action IN ('Abastecimento agendado','Abastecimento reagendado','Solicitação de abastecimento cancelada'))
      OR (profile = 'fueler' AND NEW.action = 'Abastecimento registrado')
      OR (profile = 'requester' AND NEW.action IN ('Abastecimento solicitado','Solicitação de abastecimento cancelada')
          AND EXISTS (SELECT 1 FROM appointments WHERE id = NEW.entity_id AND requester_id = NEW.author_id))
      OR ('cadastros' = ANY(capabilities) AND NEW.action LIKE 'Cadastros gerais:%')
      OR ('planejamento' = ANY(capabilities) AND NEW.action LIKE 'Fluxo:%')
    )) THEN
    RAISE EXCEPTION 'Auditoria sem autorização';
  END IF;
  RETURN NEW;
END $$;

-- Mantém o search_path fixo também nas funções novas.
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.proname LIKE 'nautilus\_%' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I', f, current_schema());
  END LOOP;
END $$;
