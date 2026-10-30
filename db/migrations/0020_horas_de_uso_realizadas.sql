-- NAUTILUS · Registro de atividade realizada: horas de uso de cada equipamento (início e fim) com a
-- marca "entra no cálculo de recobráveis". Ficam guardadas no registro (plano da OS); ao registrar, as
-- recobráveis viram usos no Financeiro (equipment_uses) ligados à OS. Aditiva.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS realized_uses jsonb NOT NULL DEFAULT '[]';
