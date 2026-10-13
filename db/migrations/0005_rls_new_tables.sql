-- Defesa em profundidade: toda tabela do schema fica com RLS ativo e sem políticas
-- (o dono, usado pela aplicação, continua com acesso) e sem privilégios para os
-- papéis públicos da API do Supabase, quando existirem.
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
