# Revisão do prompt v2.1 (Planejamento, Operação e Cadastros Gerais)

Revisão feita sobre o código real do NAUTILUS (Next.js + Postgres/Supabase + Vercel), em 13/10/2026.

## 1. Entendimento

O NAUTILUS deixa de ser só um controle de abastecimento e passa a ser uma ferramenta de gestão operacional com quatro áreas:

- **Abastecimento**: tudo o que já existia, agrupado num módulo.
- **Planejamento**:
  1. Cadastro de fluxo (tipo de atividade → etapas → dependências).
  2. Planejamento da OS em rascunho, com reserva de equipamentos.
  3. Lançamento pelo próprio planejador.
- **Operação**:
  1. Execução das OS por etapa, com cronômetro em HH:MM.
  2. Ocorrências, impactos e bloqueios.
  3. Checklists dentro da OS.
  4. Encerramento automático.
- **Cadastros gerais**: a base comum de todo o sistema.

Duas regras atravessam tudo:

- **Intertravamento de agenda.** O mesmo equipamento nunca fica em dois intervalos sobrepostos, inclusive entre rascunhos.
- **Bloqueio técnico global.** Uma NC em pergunta crítica de equipamento bloqueia o equipamento até a liberação pela Manutenção, módulo que ainda será especificado.

## 2. Viabilidade

Tudo é viável na estrutura atual, sem trocar de tecnologia. Pontos que pedem cuidado ou decisão:

| Item do prompt | Situação | Como fazer na estrutura atual |
|---|---|---|
| Intertravamento de reservas (§22, §27.2) | Viável e forte | Restrição de exclusão do Postgres (`EXCLUDE USING gist` com `tstzrange`). Duas reservas sobrepostas do mesmo equipamento são recusadas pelo próprio banco, mesmo em requisições simultâneas. |
| NC crítica × reserva/início (§27.6) | Viável | Toda reserva, lançamento, início e retomada trava a linha do equipamento (`FOR UPDATE`) e confere impedimentos na mesma transação. O registro da NC usa a mesma trava, então nenhum dos dois passa "por fora". |
| Versões imutáveis (§6, §7.3) | **Feito** | Gatilhos no banco impedem alterar ou apagar versões publicadas. |
| Gantt com zoom pela roda (§12) | Viável | Reaproveita a lógica do gráfico "Ritmo de abastecimento" (ano › mês › dia, âncora no cursor). Consulta por intervalo, sem carregar todo o histórico. |
| Anexos JPG/PNG/PDF até 20 MiB (§19) | **Exige decisão** | Funções da Vercel aceitam no máximo ~4,5 MB por requisição. Arquivos maiores precisam de envio direto a um armazenamento privado (recomendado: Supabase Storage, bucket privado, URL assinada de curta duração). Exige uma nova chave secreta no servidor. O plano gratuito tem 1 GB no total. |
| Atualização sem recarregar (§27.4) | Viável | Consulta periódica, que já existe (45 s; 5 s quando há pendência). O Supabase Realtime exigiria abrir o banco a chaves públicas, o que hoje está fechado de propósito. |
| Offline (§3.10) | Fora da v1 | Como o próprio prompt recomenda. |

## 3. Lacunas e inconsistências no prompt

As decisões abaixo foram tomadas nesta fase, ou ficam pendentes.

1. **Perfil "Gestor de cadastros" não existia.** Foram criados **acessos adicionais acumuláveis**: "Cadastros gerais" e "Planejamento", que se somam ao perfil de abastecimento. Um planejador de abastecimento pode, por exemplo, também ter acesso ao Planejamento. O gestor tem tudo.
2. **"Operador" do prompt ≠ operador cadastrado hoje.** Os operadores atuais não têm login. Quem apontar execução na Operação precisa de usuário. Por isso, o colaborador agora pode ser **vinculado a um usuário de acesso**, e somente o gestor faz esse vínculo.
3. **Escopo por cliente/área (§20).** O sistema não tem escopo hoje: quem tem acesso a um módulo vê todos os registros dele. Se clientes ou áreas precisarem ver só o que é deles, isso precisa ser definido antes da Operação.
4. **NC crítica sem módulo de Manutenção (§27.5).** Seguindo o prompt, não haverá botão de liberação. **Risco:**
   - Uma NC marcada por engano deixa o equipamento parado sem saída pelo sistema.
   - Recomendação: antes de ativar os checklists na Operação, criar ao menos o comando técnico mínimo previsto em §27.5.
     - Ele seria uma "liberação técnica" ou "correção de NC registrada por engano".
     - Teria permissão específica, justificativa obrigatória, evidência e auditoria.
5. **Reservas provisórias sem expiração (§3.3).** Um rascunho esquecido segura o equipamento indefinidamente. Proposta: listar ao gestor os "rascunhos com reservas", com liberação auditada.
6. **Dependência de etapa opcional não incluída.** O prompt não diz o que acontece quando a etapa B depende da etapa A, e A é opcional e não foi incluída na OS. Regra proposta: a dependência é ignorada e o planejador é avisado na revisão.
7. **"OS finalizadas visíveis na Operação".** Adotada a interpretação do próprio prompt (§2): OS lançadas, ou seja, programadas, em andamento e concluídas.

## 4. Brechas de segurança e tratamento

| Risco | Onde aparece | Tratamento |
|---|---|---|
| Escalada de privilégio | Cadastros gerais | **Feito.** O acesso "Cadastros gerais" não inclui usuários e senhas. Vincular colaborador a usuário é exclusivo do gestor. O gatilho de auditoria no banco recusa ações fora do acesso de quem registra; como toda alteração grava auditoria na mesma transação, a regra vale também na camada de dados. |
| Revogação tardia | Todos | **Feito.** Os acessos são relidos do cadastro a cada ação, então retirar um acesso vale na hora, mesmo com a sessão aberta. |
| Acesso direto por ID ou URL | Telas e API | **Feito.** Esconder o menu não basta, por isso a API recusa (403) e a tela redireciona. Para rascunhos e anexos da OS, a mesma regra será aplicada no servidor (rascunho visível só ao autor e ao gestor). |
| Sobrescrita concorrente | Cadastros | **Feito.** Controle de versão: quem salva sobre um cadastro alterado por outra pessoa recebe aviso e precisa atualizar a tela. |
| Corrida de reservas e de NC × início | Planejamento e Operação | Restrição de exclusão no banco, mais trava da linha do equipamento (seção 2). |
| Cliques repetidos e reenvio | Lançamento, início e término | Chave de operação única, padrão que já protege os abastecimentos contra duplicidade. |
| Upload malicioso | Anexos | Os riscos são três: PDF com script, arquivo disfarçado (extensão ou MIME falsos) e esgotamento de cota. O tratamento previsto: <ul><li>conferir a assinatura real do arquivo (*magic bytes*);</li><li>não aceitar SVG ou HTML;</li><li>limitar tamanho e quantidade por usuário e por minuto;</li><li>usar bucket privado com URL assinada de curta duração e `Content-Disposition`;</li><li>exibir prévia isolada.</li></ul> Não há antivírus no plano gratuito, e o sistema não vai afirmar que existe verificação. |
| Bloqueio global usado como sabotagem | Checklists | Por regra, qualquer operador pode bloquear um equipamento com NC crítica. Mitigação: só quem tem acesso à Operação preenche, tudo é auditado, o gestor recebe alerta, e existe o comando técnico do item 3.4. |
| Repúdio | Auditoria | Recomendado: tornar `audits` e os eventos de execução imutáveis no banco, como já é feito com as versões, antes de a Operação entrar em uso. |
| Plataforma | Hospedagem | Dois pontos a verificar: <ol><li>**Vercel Hobby não permite uso comercial** nos termos. Para uso da empresa, o correto é o plano Pro.</li><li>**O Supabase gratuito não tem backup automático.** Para uma ferramenta de gestão, recomenda-se o plano Pro (backup diário) ou uma exportação agendada.</li></ol> |

## 5. O que foi entregue nesta fase

Correspondem às etapas 1 e 2 da sequência recomendada (§25): inspeção do sistema, cadastros, fluxos versionados e checklists com aplicabilidade.

### Navegação

- A configuração central de módulos fica em `app/navigation.tsx`.
- Os módulos se expandem e recolhem, e a expansão é lembrada durante a sessão.
- Funcionam teclado, links diretos (`?modulo=`) e o voltar do navegador.
- No celular o menu se sobrepõe à tela e fecha após a navegação.
- **Abastecimento** contém Visão geral, Solicitações, Abastecimentos, Controle de estoque e Alertas e reposições.
  - "Combustíveis e parâmetros" passou a ser uma aba de Controle de estoque.
- **Exportação** fica fora dos módulos.

### Cadastros gerais

- **Solicitantes e clientes**: organização (sigla, categoria interna/cliente, cor com contraste automático) e pessoas solicitantes.
- **Locais**: unidade › área › local, com hierarquia garantida no banco.
- **Tipos e equipamentos**:
  - Os tipos já usados ("Empilhadeira", "PTA") foram convertidos automaticamente em cadastro de tipos.
  - O equipamento ganhou capacidade e local de base.
- **Colaboradores e funções**:
  - Várias funções por colaborador.
  - Vínculo opcional com usuário.
  - Usuários, senhas e acessos adicionais.
  - Histórico de alterações.
- **Checklists**:
  - Perguntas C/NC/N/A, obrigatória, crítica, alvo (atividade/equipamento) e N/A permitido.
  - Exigência de observação por resposta.
  - Vínculos com tipos de atividade, tipos de equipamento e equipamentos específicos, ou uso geral.
  - Cada gravação publica uma versão imutável.
  - O efeito "NC crítica de equipamento bloqueia globalmente" não pode ser desligado.
- **Ocorrências, impactos e bloqueios**: categorias por tipo.

### Planejamento › Cadastro de fluxo

- Tipos de atividade com etapas, duração padrão em HH:MM (pode passar de 24 h) e etapa obrigatória ou opcional.
- Dependências término → início, com ciclo recusado na tela, no servidor e no banco.
- Necessidades padrão por tipo de equipamento ou função.
- Prévia por fases, que mostra o que corre em paralelo.
- Versões imutáveis, duplicação e inativação.

### Verificação

- 32 testes automatizados (9 novos para cadastros, fluxos, acessos e camada de dados).
- Roteiro no navegador em desktop e celular, sem erros de console.
- Migração ensaiada numa cópia local com a estrutura de produção.

## 6. Fase 3 entregue (13/10/2026)

Decisões confirmadas pelo usuário:
1. **Anexos**: inicialmente feitos em armazenamento privado; **removidos por decisão do usuário** (13/10/2026). O NAUTILUS não guarda documentos nem evidências em arquivo; checklists usam observação por pergunta.
2. **Liberação técnica**:
   - Novo acesso adicional "Liberação técnica".
   - Impedimento técnico manual (e, na Operação, por NC crítica) bloqueia reservas e lançamentos no banco.
   - A liberação exige justificativa e evidência. Nada é apagado.
   - Com dois impedimentos ativos, são necessárias duas liberações.
3. **Escopo do cliente**:
   - Novo perfil "Sem acesso ao abastecimento" e acesso "Acompanhamento de OS".
   - Cada usuário tem "Organizações visíveis", editável pelo gestor; vazio = todas.
   - A restrição vale na lista, no detalhe e no acesso direto.
4. **Rascunho esquecido**: o gestor libera as reservas, com motivo e auditoria.
5. **Dependência de etapa opcional não incluída**: é ignorada e gera aviso na revisão.

Entregue:
- **Planejamento de atividade**:
  - Rascunho com salvamento automático. O status mostra "Salvando", "Salvo às" ou "Não salvo"; "Salvo" só aparece após confirmação do servidor.
  - Horários por etapa, com sugestão pelas durações padrão, aplicada só após confirmação.
  - Equipamentos com agenda do intervalo: livre, reservado (com o motivo) ou bloqueado.
  - Colaboradores por função.
  - Troca de tipo com confirmação.
- **Reservas provisórias exclusivas**:
  - O banco recusa sobreposição `[início, fim)` e equipamento bloqueado, travando a linha do equipamento. Isso vale inclusive para gravações simultâneas.
- **Revisar e lançar**:
  - Pendências e avisos aparecem antes do lançamento.
  - O lançamento é idempotente: duplo clique ou reenvio devolve a mesma OS.
  - Ele cria o número da OS, congela o planejamento, confirma as reservas e cria as etapas da OS.
- **Rascunhos**: lista com as reservas que cada um segura; o gestor pode liberá-las.
- **Lista de OS** (Planejamento) e **Operação › Ordens de serviço**:
  - Mesma fonte de dados.
  - Filtro por sobreposição de período, organização, tipo, local, situação e número.
  - Ordem padrão da especificação; canceladas só aparecem por filtro.
  - Contagem por organização; cartões no celular.
  - Detalhe da OS.
  - Cancelamento libera as reservas.
- **Condição técnica**: aba em Cadastros gerais › Tipos e equipamentos, com os compromissos afetados.

## 7. Próximas fases

| Fase | Conteúdo | Decisões necessárias |
|---|---|---|
| 4 | Lista e Gantt compartilhados (ano/mês/dia), filtros por sobreposição, contagens por organização | — |
| 5 | Operação: execução por etapa, cronômetros, ocorrências/impactos/bloqueios, checklists na OS, NC crítica com bloqueio global e repercussão nas OS | — |
| 6 | Encerramento automático, revisões de OS, auditoria imutável, cenários de risco | — |
