-- NAUTILUS · Avaliações: conteúdo programático do questionário (o que a avaliação contempla).
-- Faz parte da versão, como as perguntas: muda ao publicar, e cada resposta mostra o conteúdo da versão feita.
SET LOCAL lock_timeout='15s';
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS syllabus text NOT NULL DEFAULT '' CHECK (length(syllabus) <= 4000);
ALTER TABLE quiz_versions ADD COLUMN IF NOT EXISTS syllabus text NOT NULL DEFAULT '';
