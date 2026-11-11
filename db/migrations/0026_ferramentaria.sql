-- NAUTILUS · Ferramentaria e Inventário, fase A: cadastros, saldo e livro de movimentos.
-- Itens são Ferramenta (volta no empréstimo) ou Material (consumível), controlados por quantidade. O saldo
-- nunca é editado: é aplicado por gatilho a cada movimento, e o livro de movimentos não se altera nem se apaga.
-- Quantidades em milésimos (como o estoque de combustível); unidade "inteira" só aceita números inteiros.
SET LOCAL lock_timeout='15s';

-- Perfil Almoxarife e acesso "ferramentaria".
ALTER TABLE members DROP CONSTRAINT IF EXISTS member_capabilities;
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_profile_check;
ALTER TABLE members ADD CONSTRAINT members_profile_check CHECK (profile IN ('fueler','planner','operator','maintainer','almoxarife','manager'));
ALTER TABLE members ADD CONSTRAINT member_capabilities CHECK (capabilities <@ ARRAY['abastecimento','planejamento','operacao','manutencao','cadastros','acompanhamento','financeiro','ferramentaria']::text[]);

CREATE TABLE IF NOT EXISTS tool_units (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  abbr text NOT NULL CHECK (length(trim(abbr)) BETWEEN 1 AND 8),
  integral smallint NOT NULL DEFAULT 1 CHECK (integral IN (0,1)),
  active smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tool_units_name_key ON tool_units (lower(trim(name)));

CREATE TABLE IF NOT EXISTS tool_categories (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  active smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tool_categories_name_key ON tool_categories (lower(trim(name)));

CREATE TABLE IF NOT EXISTS tool_locations (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  active smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tool_locations_name_key ON tool_locations (lower(trim(name)));

CREATE TABLE IF NOT EXISTS tool_items (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('ferramenta','material')),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  code text CHECK (code IS NULL OR length(trim(code)) BETWEEN 1 AND 40),
  category_id text REFERENCES tool_categories(id),
  location_id text REFERENCES tool_locations(id),
  unit_id text NOT NULL REFERENCES tool_units(id),
  min_milli bigint NOT NULL DEFAULT 0 CHECK (min_milli >= 0 AND min_milli <= 1000000000000),
  balance_milli bigint NOT NULL DEFAULT 0 CHECK (balance_milli >= 0 AND balance_milli <= 1000000000000),
  active smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  version integer NOT NULL DEFAULT 0,
  create_key text UNIQUE,
  created_by text NOT NULL REFERENCES members(id),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tool_items_code_key ON tool_items (lower(trim(code))) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_items_name ON tool_items (lower(name));
CREATE INDEX IF NOT EXISTS idx_tool_items_category ON tool_items (category_id);
CREATE INDEX IF NOT EXISTS idx_tool_items_location ON tool_items (location_id);

-- Livro de movimentos. "operation_key" torna o envio idempotente (reenvio devolve o mesmo resultado).
CREATE TABLE IF NOT EXISTS tool_movements (
  id text PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  item_id text NOT NULL REFERENCES tool_items(id),
  kind text NOT NULL CHECK (kind IN ('entrada','saida','ajuste','perda','emprestimo','devolucao','contagem')),
  delta_milli bigint NOT NULL CHECK (delta_milli <> 0),
  balance_after_milli bigint NOT NULL DEFAULT 0,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 200),
  ref_type text,
  ref_id text,
  occurred_at text NOT NULL,
  author_id text NOT NULL REFERENCES members(id),
  author_name text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_movements_item ON tool_movements (item_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_movements_date ON tool_movements (occurred_at DESC);

-- Aplica o movimento ao saldo: trava o item, confere o sinal e o saldo, respeita unidade inteira.
CREATE OR REPLACE FUNCTION nautilus_tool_movement_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i tool_items%ROWTYPE; u tool_units%ROWTYPE;
BEGIN
  SELECT * INTO i FROM tool_items WHERE id = NEW.item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item não encontrado'; END IF;
  IF i.active = 0 AND NEW.kind IN ('entrada','saida','emprestimo') THEN RAISE EXCEPTION 'Item inativo'; END IF;
  IF NEW.kind IN ('entrada','devolucao') AND NEW.delta_milli < 0 THEN RAISE EXCEPTION 'Esta movimentação deve aumentar o saldo'; END IF;
  IF NEW.kind IN ('saida','perda','emprestimo') AND NEW.delta_milli > 0 THEN RAISE EXCEPTION 'Esta movimentação deve reduzir o saldo'; END IF;
  SELECT * INTO u FROM tool_units WHERE id = i.unit_id;
  IF u.integral = 1 AND NEW.delta_milli % 1000 <> 0 THEN RAISE EXCEPTION 'Esta unidade só aceita quantidade inteira'; END IF;
  IF i.balance_milli + NEW.delta_milli < 0 THEN RAISE EXCEPTION 'Saldo insuficiente'; END IF;
  NEW.balance_after_milli := i.balance_milli + NEW.delta_milli;
  UPDATE tool_items SET balance_milli = NEW.balance_after_milli, version = version + 1, updated_at = NEW.occurred_at WHERE id = NEW.item_id;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER tool_movement_apply BEFORE INSERT ON tool_movements FOR EACH ROW EXECUTE FUNCTION nautilus_tool_movement_apply();

CREATE OR REPLACE FUNCTION nautilus_tool_movement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Movimentações da ferramentaria não podem ser alteradas nem apagadas'; END $$;
CREATE OR REPLACE TRIGGER tool_movement_immutable BEFORE UPDATE OR DELETE ON tool_movements FOR EACH ROW EXECUTE FUNCTION nautilus_tool_movement_immutable();

-- O saldo só muda por movimento; o tipo e a unidade do item não mudam depois que há movimento.
CREATE OR REPLACE FUNCTION nautilus_tool_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.balance_milli <> OLD.balance_milli AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'O saldo só muda por movimentação';
    END IF;
    IF EXISTS (SELECT 1 FROM tool_movements WHERE item_id = OLD.id) AND (NEW.kind <> OLD.kind OR NEW.unit_id <> OLD.unit_id) THEN
      RAISE EXCEPTION 'Tipo e unidade não mudam depois da primeira movimentação';
    END IF;
  ELSIF NEW.balance_milli <> 0 THEN
    RAISE EXCEPTION 'O saldo inicial entra por movimentação';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER tool_item_guard BEFORE INSERT OR UPDATE ON tool_items FOR EACH ROW EXECUTE FUNCTION nautilus_tool_item_guard();

CREATE OR REPLACE FUNCTION nautilus_tool_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Cadastro da ferramentaria não pode ser apagado: inative-o'; END $$;
CREATE OR REPLACE TRIGGER tool_items_no_delete BEFORE DELETE ON tool_items FOR EACH ROW EXECUTE FUNCTION nautilus_tool_no_delete();
CREATE OR REPLACE TRIGGER tool_units_no_delete BEFORE DELETE ON tool_units FOR EACH ROW EXECUTE FUNCTION nautilus_tool_no_delete();
CREATE OR REPLACE TRIGGER tool_categories_no_delete BEFORE DELETE ON tool_categories FOR EACH ROW EXECUTE FUNCTION nautilus_tool_no_delete();
CREATE OR REPLACE TRIGGER tool_locations_no_delete BEFORE DELETE ON tool_locations FOR EACH ROW EXECUTE FUNCTION nautilus_tool_no_delete();

-- Unidades iniciais (a gestão ajusta no cadastro).
INSERT INTO tool_units(id,name,abbr,integral,created_at,updated_at) VALUES
  ('un','Unidade','un',1,'2026-11-11T00:00:00.000Z','2026-11-11T00:00:00.000Z'),
  ('pc','Peça','pç',1,'2026-11-11T00:00:00.000Z','2026-11-11T00:00:00.000Z'),
  ('cx','Caixa','cx',1,'2026-11-11T00:00:00.000Z','2026-11-11T00:00:00.000Z'),
  ('par','Par','par',1,'2026-11-11T00:00:00.000Z','2026-11-11T00:00:00.000Z'),
  ('kg','Quilo','kg',0,'2026-11-11T00:00:00.000Z','2026-11-11T00:00:00.000Z'),
  ('m','Metro','m',0,'2026-11-11T00:00:00.000Z','2026-11-11T00:00:00.000Z'),
  ('l','Litro','L',0,'2026-11-11T00:00:00.000Z','2026-11-11T00:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

-- Auditoria: ações "Ferramentaria:" de quem tem o acesso (demais regras como antes).
CREATE OR REPLACE FUNCTION nautilus_audit_actor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.author_id AND active = 1 AND (
      profile = 'manager'
      OR (NEW.action = 'Senha definida pelo usuário' AND NEW.entity_id = NEW.author_id)
      OR (profile = 'planner' AND 'abastecimento' = ANY(capabilities) AND NEW.action IN ('Abastecimento agendado','Abastecimento reagendado','Solicitação de abastecimento cancelada'))
      OR (profile = 'fueler' AND NEW.action = 'Abastecimento registrado')
      OR ('abastecimento' = ANY(capabilities) AND NEW.action IN ('Abastecimento solicitado','Solicitação de abastecimento cancelada')
          AND EXISTS (SELECT 1 FROM appointments WHERE id = NEW.entity_id AND requester_id = NEW.author_id))
      OR ('cadastros' = ANY(capabilities) AND NEW.action LIKE 'Cadastros gerais:%')
      OR ('planejamento' = ANY(capabilities) AND (NEW.action LIKE 'Fluxo:%' OR NEW.action LIKE 'Planejamento:%'))
      OR (('cadastros' = ANY(capabilities) OR 'manutencao' = ANY(capabilities)) AND NEW.action = 'Condição técnica: impedimento registrado')
      OR ('manutencao' = ANY(capabilities) AND (NEW.action = 'Condição técnica: liberação técnica' OR NEW.action LIKE 'Manutenção:%'))
      OR ('operacao' = ANY(capabilities) AND (NEW.action LIKE 'Operação:%' OR NEW.action = 'Condição técnica: NC crítica' OR NEW.action = 'Manutenção: leitura registrada'))
      OR ('financeiro' = ANY(capabilities) AND NEW.action LIKE 'Financeiro:%')
      OR ('ferramentaria' = ANY(capabilities) AND NEW.action LIKE 'Ferramentaria:%')
      OR (NEW.action LIKE 'Exportação:%' AND NEW.entity_id IS NOT NULL
          AND ('planejamento' = ANY(capabilities) OR 'acompanhamento' = ANY(capabilities) OR 'operacao' = ANY(capabilities) OR 'financeiro' = ANY(capabilities) OR 'ferramentaria' = ANY(capabilities)))
    )) THEN
    RAISE EXCEPTION 'Auditoria sem autorização';
  END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['tool_units','tool_categories','tool_locations','tool_items','tool_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r); END IF;
    END LOOP;
  END LOOP;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.proname LIKE 'nautilus\_%' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I', f, current_schema());
  END LOOP;
END $$;
