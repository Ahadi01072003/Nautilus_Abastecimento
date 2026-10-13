-- Decisão do usuário: o NAUTILUS não guarda documentos/anexos. Remove a tabela e a
-- configuração do serviço de armazenamento (nenhum arquivo havia sido enviado em produção).
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS app_settings;
