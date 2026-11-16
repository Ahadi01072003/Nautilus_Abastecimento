# Avaliações por QR code · especificação

Data: 16/11/2026 · Status: **aprovada pelo usuário em 16/11/2026**; implementação em duas fases (A: núcleo; B: PDF, LGPD e exportação). **Fase A entregue** (migração 0031). Ajustes da implementação na seção 12.

## 1. Objetivo
Visitantes da base respondem um questionário pelo celular, lendo um QR code, **sem login**. O Nautilus corrige na hora, mostra o resultado e guarda tudo para consulta, exportação e comprovante em PDF. O responsável pelo módulo cria e mantém os questionários.

## 2. Decisões do usuário
- **Link público sem login**, transformado em QR code e divulgado. **Sem limite de pessoas**: qualquer número de visitantes usa o mesmo link, ao mesmo tempo ou não.
- **Uma avaliação válida por CPF por período.** O responsável configura a validade por questionário; neste projeto, **1 ano**.
- **Reprovado pode refazer até passar.** A validade só começa a contar na aprovação. Há um limite de tentativas por dia por CPF, configurável (padrão 3). Todas as tentativas ficam registradas.
- **CPF que já tem avaliação válida:** a tela mostra "Este CPF já tem avaliação válida até dd/mm/aaaa." e não deixa responder de novo.
- **Responsável = novo acesso "Avaliações"**, dado pela Gestão a quem ela quiser (como Ferramentaria e Financeiro). A Gestão tem sempre. Quem não tem o acesso não vê o módulo, os CPFs nem as respostas.

## 3. Regras
1. **Link permanente.** Cada questionário tem um token aleatório (≥ 128 bits) na URL `/q/<token>`. O link e o QR **não mudam** quando o questionário ganha nova versão: o QR impresso continua valendo.
2. **Situação do questionário:** rascunho → publicado ⇄ pausado → encerrado. Rascunho, pausado e encerrado mostram no link público "Questionário indisponível no momento" (com texto opcional do responsável). Encerrado não volta.
3. **Regerar link:** invalida o token antigo na hora (para QR vazado ou impresso errado) e gera outro. Pede confirmação e fica na auditoria.
4. **Três passos no celular:** (1) dados pessoais e consentimento → (2) perguntas → (3) resultado.
   - Dados pessoais: **nome completo**, **empresa** (texto livre, com sugestões das já usadas) e **CPF** com máscara `000.000.000-00` e validação dos dígitos verificadores. CPFs com todos os dígitos iguais são recusados.
   - O CPF é verificado **antes** das perguntas: se já há avaliação válida, aparece a mensagem de validade; se estourou o limite do dia, aparece "Limite de tentativas de hoje atingido. Tente novamente amanhã."
5. **Tipos de pergunta:** múltipla escolha (uma resposta certa), sim/não e texto livre. Texto livre **não vale nota**: fica guardado para leitura. Perguntas podem ser obrigatórias ou opcionais; a ordem das perguntas e das alternativas pode ser embaralhada (opção do questionário).
6. **Gabarito só no servidor.** A página pública recebe as perguntas sem a resposta certa; a correção acontece no envio.
7. **Nota:** acertos ÷ perguntas que valem nota, de 0 a 100%. **Nota mínima** configurável (padrão 70%). Nota ≥ mínima = **aprovado**.
8. **Tela de resultado** com nível de detalhe configurável:
   - só "Aprovado / Reprovado";
   - mais a nota;
   - mais as perguntas erradas, sem mostrar a resposta certa (padrão; evita passar o gabarito adiante).
   Aprovado vê também "Válida até dd/mm/aaaa" e um código do comprovante. Reprovado vê quantas tentativas restam hoje.
9. **Versões:** publicar uma alteração cria a versão N+1; a versão anterior fica imutável. Cada tentativa guarda a versão respondida e uma cópia das perguntas e respostas daquele momento, então o histórico e o PDF continuam fiéis mesmo depois de mudanças. Mudar a validade, a nota mínima ou o limite diário vale só para novas tentativas.
10. **Validade por CPF:** aprovação em qualquer versão do mesmo questionário conta. Vence às 23h59 (horário de Brasília) do dia equivalente após o período (ex.: aprovado em 16/11/2026, válido até 16/11/2027). Depois disso o CPF pode responder de novo.
11. **Uma tentativa por envio:** cada abertura do questionário gera uma chave; enviar duas vezes (rede ruim, toque duplo) grava uma só tentativa, como nos demais módulos.
12. **Tentativa iniciada e não enviada** não conta no limite diário. Conta só o envio.

## 4. Proteções do link público
- **Limites por IP generosos**, porque visitantes costumam usar o mesmo Wi-Fi da base: por exemplo 300 envios por hora por IP e 30 verificações de CPF por minuto por IP (ajustáveis). Usa o limitador que o Nautilus já tem.
- **Campo-armadilha (honeypot)** invisível: robôs que o preenchem são descartados sem aviso.
- Tempo mínimo entre abrir e enviar (ex.: 5 s) para barrar envios automáticos.
- **Cloudflare Turnstile** (captcha invisível) **opcional**: só liga se você criar uma chave gratuita na Cloudflare. Fica desligado até lá.
- A mensagem de validade revela que aquele CPF esteve na base (decisão aceita). Para dificultar varredura de CPFs, a verificação de CPF tem limite próprio por IP e fica na auditoria.
- Mensagens de erro públicas não mostram detalhes internos.

## 5. Privacidade (LGPD) — fase B
- **Consentimento obrigatório** no passo 1, com texto configurável e **versionado**: cada tentativa guarda qual versão do texto foi aceita, com data e hora.
- **CPF mascarado** nas listas (`***.456.789-**`). O número completo aparece só no detalhe e na exportação, para quem tem o acesso Avaliações, e cada visualização ou exportação vai para a auditoria.
- **Exclusão a pedido do titular:** o responsável busca pelo CPF e **anonimiza** as tentativas (nome, empresa e CPF trocados por "Anonimizado"; nota e data ficam para estatística). Pede motivo, não se desfaz e fica na auditoria.
- **Retenção:** opção por questionário para anonimizar automaticamente tentativas com mais de N meses (desligada por padrão).

## 6. Telas internas (acesso Avaliações)
- **Questionários:** lista com situação, versão, respostas, aprovação (%) e ações (editar, publicar, pausar, encerrar, QR, regerar link).
- **Editor:** título, texto de abertura, perguntas (adicionar, reordenar, marcar a certa), nota mínima, validade (em meses ou dias), limite diário, nível de detalhe do resultado, embaralhar, texto do consentimento. Botão **Pré-visualizar** mostra a página pública sem gravar.
- **QR code:** imagem para baixar (PNG e SVG) e página pronta para imprimir (A4 com título e instruções), com o link escrito embaixo.
- **Respostas:** filtros por questionário, empresa, período, resultado e CPF. Detalhe da tentativa: dados, respostas marcadas, certas e erradas, nota, versão, IP aproximado, aparelho.
- **Por pessoa (CPF):** todas as tentativas e a validade atual.

## 7. Exportação e comprovantes — fase B
- **Excel e CSV** com os filtros da tela (questionário, empresa, período, resultado). Uma linha por tentativa; opção de incluir as respostas pergunta a pergunta. Usa o gerador de planilhas que o Nautilus já tem.
- **PDF por pessoa:** comprovante da avaliação com modelo configurável (logo, cabeçalho, texto e rodapé) contendo nome, empresa, CPF, data, nota, resultado, validade, versão e código de verificação.
- **ZIP em lote:** um PDF por tentativa filtrada, num único arquivo .zip (limite de 500 por lote para caber no tempo da Vercel; acima disso, pede para filtrar).

## 8. Modelo (proposta)
`quizzes(token, title, status, current_version, validity_days, min_score, daily_limit, result_detail, shuffle, closed_message, retention_months)` · `quiz_versions(quiz, version, questions jsonb, published_at, published_by)` (imutável) · `quiz_consent_texts(quiz, version, text)` (imutável) · `quiz_attempts(id, quiz, version, cpf, name, company, answers jsonb, score, passed, valid_until, consent_version, ip_hash, user_agent, idempotency_key, created_at, anonymized_at)` (sem apagar; só anonimiza) · `quiz_pdf_templates(quiz, logo, header, body, footer)`.
- Índice por `(quiz, cpf, created_at)` para checar validade e limite diário.
- Validade e limite checados **dentro de uma transação com trava por CPF+questionário**, para que dois envios simultâneos do mesmo CPF não passem os dois.
- Acesso novo `avaliacoes` em `permissions.ts`; a Gestão tem sempre.

## 9. Capacidade e custos
- Uma tentativa ocupa cerca de 2–4 KB no banco. **10 mil tentativas ≈ 40 MB**; o banco hoje usa ~29 MB de 500 MB do plano gratuito do Supabase.
- A página pública é leve (sem login, sem dados pesados) e aguenta muitos visitantes simultâneos dentro dos limites da Vercel. Picos de dezenas de pessoas ao mesmo tempo não são problema.
- Ponto de atenção: o plano gratuito (Hobby) da Vercel é, pelos termos dela, para uso não comercial. Isso já vale para o Nautilus todo, não só para este módulo.
- **Bibliotecas novas:** um gerador de QR code e um gerador de PDF no servidor (para o ZIP em lote), ambos em JavaScript puro, sem custo.

## 10. Fases
- **Fase A (núcleo):** acesso Avaliações, questionários com versões, editor, link e QR, página pública em 3 passos, correção, validade por CPF, limite diário, resultado, lista de respostas, proteções do link.
- **Fase B:** consentimento LGPD versionado, anonimização a pedido e por retenção, exportação Excel/CSV, PDF por pessoa com modelo, ZIP em lote.
- Primeiro no ambiente de teste? Proposta: **não precisa**; o módulo é novo e isolado (não mexe em nada existente), então pode subir direto em produção como os demais, despublicado até você criar o primeiro questionário.

## 11. Fora do escopo
- Pergunta com mais de uma resposta certa, peso por pergunta, banco de perguntas sorteadas, foto do visitante, assinatura na tela, envio do comprovante por e-mail ou WhatsApp. Podem entrar depois.

## 12. Ajustes na implementação da fase A
- **Limites por endereço de rede, por minuto** (o limitador do Nautilus trabalha em janelas de 1 minuto): abrir o questionário 240, etapa do CPF 60 e envio 60 por minuto por IP. Um grupo grande no mesmo Wi-Fi cabe com folga.
- **Etapa do CPF sem auditoria por consulta:** o visitante não tem cadastro e a auditoria do Nautilus exige um usuário. A etapa entrega um bilhete de uso único (válido por 6 h, exige 5 s até o envio) e cada envio fica registrado na tentativa. Na tela interna, a busca por CPF completo e a abertura do detalhe entram na auditoria.
- **Pergunta que vale nota é sempre obrigatória** (múltipla escolha e sim/não); "opcional" vale só para texto livre.
- **Regras (validade, nota mínima, limite diário, detalhe, embaralhar) valem ao salvar**, sem nova versão; título, abertura e perguntas mudam só ao publicar.
- O comprovante tem 8 caracteres (sem 0/O e 1/I para não confundir).

