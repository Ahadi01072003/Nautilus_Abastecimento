# Financeiro · Solicitação de recobráveis por atividade (Frente B): plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** registrar solicitações de atividades recobráveis, cotar com fornecedores aos poucos, calcular margem/impostos/valor a faturar (regra A), gerar o relatório para assinatura, autorizar com o relatório assinado e ligar a solicitação à OS do Planejamento.

**Architecture:** cálculo puro em `lib/recovery-quote.ts` (nada calculado é gravado, exceto o valor da cotação escolhida ao autorizar); banco `0021` com as tabelas e as travas (caminhos de situação, cotação travada fora de "Em cotação", anexo nunca apagado, autorização exige escolha e relatório assinado); serviço `lib/finance-requests.ts`; anexos em `bytea` no próprio banco; ganchos no lançamento, encerramento e cancelamento da OS; telas no menu Financeiro.

**Tech Stack:** Next.js 16 (App Router; ler `node_modules/next/dist/docs/` antes de rota ou página nova, conforme AGENTS.md), React 19, TypeScript, Postgres (postgres.js), `node:test` com Postgres local.

**Spec:** `docs/superpowers/specs/2026-10-30-financeiro-solicitacoes-recobraveis-design.md` (aprovada em 30/10/2026). Depende da Frente A (já em produção: acesso Financeiro, menu, `lib/finance.ts`).

## Decisões do usuário (30/10/2026)

1. Cliente novo: sugestão de margem e impostos = vigência cadastrada mais recente (de qualquer cliente).
2. OS com fluxo: os recursos da solicitação vão para a descrição do rascunho; OS sem fluxo: viram recursos da etapa.
3. Cancelar solicitação com OS em execução: recusado; cancela-se a OS antes (a solicitação volta a Autorizada).

## Global Constraints

- Repositório público: código, docs e testes só com valores fictícios ("Cliente Teste", "Fornecedor Alfa/Beta/Gama", margem 10% e impostos 10% ou 12,5%). Percentuais reais só no banco, cadastrados na tela.
- Dinheiro em centavos inteiros; percentuais em centésimos de % (`1500` = 15%), de 0 a 9999 (impostos < 100%).
- Regra A: margem = arredondar(P × m); valor a faturar = arredondar(P × (1 + m) ÷ (1 − i)); subtotal = P + margem; impostos = valor a faturar − subtotal. Arredondamento em centavos, metade para cima, em aritmética inteira.
- Datas e "dia" em horário de Brasília, como no resto do sistema.
- Anexos: PDF, JPG ou PNG, até 4 MB (`4_194_304` bytes), tipo conferido pelo conteúdo (assinatura do arquivo), guardados em `bytea`, nunca apagados (substituir marca o anterior como substituído).
- Acesso: criar, cotar, enviar, autorizar, anexar, configurar e baixar anexo = Financeiro ou Gestão; "Planejar OS" = Planejamento, na solicitação autorizada. Escopo de organizações sempre aplicado (fora do escopo = 404).
- Auditoria: ações `Financeiro: …` (acesso Financeiro), `Planejamento: …` (lançar, cancelar, revisar) e `Operação: …`/`Planejamento: …` no encerramento, conforme o acesso de quem age (mesma regra de `closeOpenUses`).
- Situações: `em_cotacao`, `enviada`, `autorizada`, `em_execucao`, `concluida`, `cancelada`.
- Número `REC-000001` por sequência do banco.
- Migração `0021` aplicada em produção antes do merge, só com OK do usuário.
- Textos de tela em português; commits sem identificador de modelo, com o rodapé de coautoria da sessão.

## Review Focus

1. Cotação editada ao mesmo tempo em que outra pessoa envia a solicitação: a edição tem de falhar com mensagem clara (a trava do banco decide, não a checagem anterior na aplicação). Teste na Tarefa 2 (`cotação não muda fora de "Em cotação"` direto no banco).
2. Arquivo com extensão ou `Content-Type` trocados (um `.exe` chamado `.pdf`, um PNG enviado como `application/pdf`): vale o conteúdo; o tipo gravado é o detectado. Teste na Tarefa 4.
3. Usuário do Financeiro com escopo de organizações abrindo solicitação, relatório ou anexo de outro cliente pelo id: 404. Teste na Tarefa 4 (download) e Tarefa 3 (detalhe).
4. OS cancelada ligada a solicitação já concluída, ou revisão que conclui a OS: só `em_execucao` reage; `concluida` e `cancelada` não mudam. Teste na Tarefa 5.
5. Reabrir solicitação autorizada que já tem rascunho de OS (`plan_id`) mas ainda não lançado: reabrir descarta o vínculo com o rascunho (o rascunho continua no Planejamento) e a cotação escolhida/assinatura são limpas. Teste na Tarefa 5.

---

### Task 1: Cálculo da cotação (regra A) e caminhos de situação

**Files:**
- Create: `lib/recovery-quote.ts`
- Test: `tests/recovery-quote.test.ts`
- Modify: `docs/superpowers/specs/2026-10-30-financeiro-solicitacoes-recobraveis-design.md` (linha 3: "Situação: aprovada em 30/10/2026"; linha 5: "Os valores em reais deste documento são fictícios.")

**Interfaces:**
- Produces:
  - `type QuoteTotals={quotedCents:number,marginCents:number,subtotalCents:number,taxCents:number,totalCents:number}`
  - `quoteTotals(quotedCents:number,marginBp:number,taxBp:number):QuoteTotals` — lança `AppError` se P não for inteiro ≥ 0 ou se `marginBp`/`taxBp` saírem de 0..9999.
  - `type RequestStatus='em_cotacao'|'enviada'|'autorizada'|'em_execucao'|'concluida'|'cancelada'`
  - `const NEXT:Record<RequestStatus,RequestStatus[]>` = `em_cotacao→[enviada,cancelada]`, `enviada→[em_cotacao,autorizada,cancelada]`, `autorizada→[em_cotacao,em_execucao,cancelada]`, `em_execucao→[autorizada,concluida]`, `concluida→[]`, `cancelada→[]`.
  - `canMove(from:RequestStatus,to:RequestStatus):boolean`
  - `recNumber(n:number):string` → `REC-000001`.

- [ ] **Step 1: Write the failing tests** (`tests/recovery-quote.test.ts`)
  - `regra A: as três cotações do exemplo fecham centavo a centavo (10% e 10%)`: `quoteTotals(1000000,1000,1000)` → `{1000000,100000,1100000,122222,1222222}`; `quoteTotals(2500050,1000,1000)` → `{2500050,250005,2750055,305562,3055617}`; `quoteTotals(833333,1000,1000)` → `{833333,83333,916666,101852,1018518}`.
  - `regra A: subtotal + impostos = valor a faturar para qualquer valor`: para P em `[1,99,12345,99999999,1234567890]` e pares `(1000,1250),(0,0),(1500,0),(0,1250)` → `subtotal+tax===total` e `tax>=0`.
  - `regra A: percentuais diferentes por cliente`: `quoteTotals(1000000,1000,1250).totalCents===1257143` e margem `100000`.
  - `entradas inválidas recusadas`: P negativo, P fracionário, `taxBp=10000`, `marginBp=-1` → `AppError`.
  - `caminhos de situação`: `canMove('em_cotacao','enviada')`, `canMove('enviada','em_cotacao')`, `canMove('autorizada','em_execucao')`, `canMove('em_execucao','autorizada')` verdadeiros; `canMove('em_cotacao','autorizada')`, `canMove('concluida','cancelada')` e `canMove('em_execucao','cancelada')` falsos (decisão do usuário em 30/10: com OS em execução, cancele a OS antes).
  - `recNumber(1)==='REC-000001'`.
- [ ] **Step 2: Run** `node --import tsx --test tests/recovery-quote.test.ts` — Expected: FAIL (módulo inexistente).
- [ ] **Step 3: Implement `lib/recovery-quote.ts`** em aritmética inteira: `margin=floor((2·P·m+10000)/20000)`, `total=floor((2·P·(10000+m)+(10000−i))/(2·(10000−i)))` (todos os produtos cabem em `Number.MAX_SAFE_INTEGER` para P ≤ 10¹⁰ centavos; limite P a `10_000_000_000`).
- [ ] **Step 4: Run** o mesmo comando — Expected: PASS (6 testes).
- [ ] **Step 5: Commit** `Financeiro B: cálculo da cotação (regra A) e caminhos de situação` (inclui a atualização da spec).

### Task 2: Banco 0021 e acesso

**Files:**
- Create: `db/migrations/0021_financeiro_solicitacoes.sql`
- Modify: `lib/permissions.ts` (`financeModules` passa a `['fin-painel','fin-solicitacoes','fin-tarifas','fin-config']`)
- Test: `tests/finance-requests.test.ts` (novo arquivo, banco próprio; esta tarefa cria a parte "banco")

**Interfaces:**
- Produces (tabelas; colunas de dinheiro em centavos `bigint`, percentuais `integer` 0..9999, datas `text` ISO como o resto do esquema):
  - `finance_clients(org_id PK→requester_orgs, enabled smallint, created_at, created_by, created_by_name)`
  - `finance_client_rates(id PK, org_id, margin_bp, tax_bp, valid_from 'YYYY-MM-DD', created_at, created_by, created_by_name, UNIQUE(org_id,valid_from))` — UPDATE/DELETE bloqueados.
  - `suppliers(id PK, name, cnpj, contact, active, created_at, created_by)` com índice único `lower(name)`.
  - `recovery_requests(id PK, number integer UNIQUE DEFAULT nextval('recovery_request_number'), org_id, requester_person_id, activity_type_id NULL, title, description, planned_start, planned_end, resources jsonb DEFAULT '[]', notes, margin_bp, tax_bp, status DEFAULT 'em_cotacao', justification, chosen_quote_id, chosen_total_cents bigint, signer_name, signer_role, signed_at, plan_id, work_order_id UNIQUE, version integer DEFAULT 0, created_at, created_by, created_by_name, updated_at)`; `CHECK (activity_type_id IS NOT NULL OR title <> '')`.
  - `recovery_quotes(id PK, request_id, supplier_id, value_cents bigint ≥0, proposal_number, valid_until, lead_time, received_at, notes, created_at, created_by, created_by_name, updated_at, UNIQUE(request_id,supplier_id))`.
  - `recovery_reports(id PK, request_id, version, issued_at, issued_by, issued_by_name, snapshot jsonb, UNIQUE(request_id,version))` — UPDATE/DELETE bloqueados.
  - `finance_attachments(id PK, request_id, quote_id NULL, kind CHECK IN ('proposta','relatorio_assinado','outro'), description, file_name, content_type CHECK IN ('application/pdf','image/jpeg','image/png'), size_bytes CHECK 1..4194304, content bytea, replaced_by NULL, created_at, created_by, created_by_name)`.
  - Gatilhos:
    - `nautilus_recovery_request_guard`: mudança de `status` só pelos pares de `NEXT` (Tarefa 1, repetidos em SQL); com `OLD.status<>'em_cotacao'`, campos de dados (`org_id, requester_person_id, activity_type_id, title, description, planned_start, planned_end, resources, margin_bp, tax_bp`) não mudam; entrar em `autorizada` exige `chosen_quote_id` da própria solicitação e anexo `relatorio_assinado` não substituído; DELETE bloqueado.
    - `nautilus_recovery_quote_guard`: INSERT/UPDATE/DELETE só com a solicitação em `em_cotacao` (trava a linha da solicitação `FOR UPDATE`).
    - `nautilus_finance_attachment_guard`: DELETE bloqueado; UPDATE só pode preencher `replaced_by` uma vez.
  - RLS habilitado e `REVOKE` de `anon`/`authenticated` nas tabelas novas; bloco de `search_path` das funções `nautilus_%` (mesmo padrão da 0019).

- [ ] **Step 1: Write the failing test** `banco: caminhos de situação, cotação travada, autorização exige relatório assinado, anexo não se apaga` em `tests/finance-requests.test.ts`, com SQL direto (`db.run`): pular de `em_cotacao` para `autorizada` → `/Situação/`; alterar `title` em `enviada` → `/não pode ser alterad/`; inserir cotação em `enviada` → `/Cotação só muda em "Em cotação"/`; autorizar sem anexo → `/relatório assinado/`; `DELETE FROM finance_attachments` → `/não pode ser apagado/`; `UPDATE finance_client_rates` → `/nova vigência/`; e `modules({...operator,capabilities:['financeiro']})` inclui `fin-solicitacoes` e `fin-config`.
- [ ] **Step 2: Run** `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres node --import tsx --test tests/finance-requests.test.ts` — Expected: FAIL (tabelas inexistentes).
- [ ] **Step 3: Write `0021_financeiro_solicitacoes.sql`** e altere `financeModules`.
- [ ] **Step 4: Run** o mesmo comando — Expected: PASS.
- [ ] **Step 5: Commit** `Financeiro B: tabelas de solicitações, cotações, relatórios e anexos com travas no banco`.

### Task 3: Configuração, fornecedores, solicitações e cotações (serviço)

**Files:**
- Create: `lib/finance-requests.ts`
- Modify: `app/api/[...path]/route.ts` (GET `finance/config`, `finance/requests`, `finance/request`; POST `finance/config/*`, `finance/suppliers`, `finance/requests/*`, `finance/quotes`)
- Test: `tests/finance-requests.test.ts`

**Interfaces:**
- Consumes: `quoteTotals`, `canMove`, `recNumber` (Tarefa 1); tabelas da Tarefa 2; `requireAny`, `loadAccess` (`lib/permissions`); `audit` (`lib/registry`); `isoDay`, `required`, `text` (`lib/domain`); `instant` (`lib/planning`).
- Produces:
  - `financeConfig(member)` → `{clients:{orgId,name,enabled,current:{marginBp,taxBp,validFrom}|null,history}[] ,suppliers:Row[],suggestion:{marginBp,taxBp}|null}` — `suggestion` = vigência cadastrada mais recente de qualquer cliente (o "padrão definido pelo Financeiro"; nenhum = `null`).
  - `rateFor(ex,orgId,day:string)` → `{marginBp,taxBp}|null` (vigência mais recente com `valid_from ≤ day`).
  - `requestList(member,url)` → linhas com `number, rec, orgName, activity, plannedStart, status, quotes, chosenSupplier, totalCents, workOrderNumber`; filtros `status`, `org`, `from`, `to`.
  - `requestDetail(member,id)` → solicitação + `quotes` (cada uma com `totals:QuoteTotals`) + `attachments` (sem conteúdo) + `reports` (versões) + `history` (auditoria) + `can:{edit,send,reopen,authorize,cancel,plan}`.
  - `financeRequestsMutate(path,b,member)` com caminhos: `finance/config/client` `{orgId,enabled}`; `finance/config/rate` `{orgId,margin,tax,validFrom}` (percentuais em % com vírgula aceita → bp); `finance/suppliers` `{id?,name,cnpj?,contact?,active?}`; `finance/requests/save` `{id?,version?,orgId,personId,activityTypeId?|title,description,plannedStart,plannedEnd?,resources,notes}` (ao criar, copia `rateFor` do dia de criação; sem vigência → 409 "Cadastre margem e impostos do cliente em Financeiro › Configurações."); `finance/quotes` `{id?,requestId,supplierId?|supplierName,valueCents|value,proposalNumber,validUntil,leadTime,receivedAt,notes}` (fornecedor novo por nome = "cadastrar na hora"; repetido na solicitação → 409 "Este fornecedor já tem cotação nesta solicitação.").
  - Erros de trava do banco traduzidos (padrão `dbError` de `lib/finance.ts`).

- [ ] **Step 1: Write the failing tests** (cenário fictício: "Cliente Teste" com 10%/10% desde 2026-01-01, "Outro Cliente" sem habilitar):
  - `configuração: só cliente habilitado aparece; nova vigência não altera solicitação antiga` — criar solicitação com 10%/10%, cadastrar 12,5% de impostos a partir de amanhã, a solicitação continua `tax_bp=1000`; `financeConfig(...).suggestion` = a vigência mais recente; salvar solicitação para "Outro Cliente" → 409.
  - `cotações chegam em dias diferentes e o detalhe mostra "n de 3" e os valores da regra A` — três `finance/quotes` com `receivedAt` em dias distintos (Alfa 10.000,00; Beta 25.000,50; Gama 8.333,33); `requestDetail` traz `quotes.length===3` e `totals.totalCents` `[1222222,3055617,1018518]`; `requestList` traz `quotes===3`.
  - `fornecedor: cadastrar na hora e não repetir na mesma solicitação` — `supplierName:'Fornecedor Delta'` cria o fornecedor; segunda cotação com o mesmo → 409; nome com outra caixa ("fornecedor delta") reaproveita o mesmo cadastro.
  - `escopo e acesso` — operador sem Financeiro → 403 em `finance/requests/save`; Financeiro com escopo só do "Outro Cliente" → `requestDetail` da solicitação do "Cliente Teste" → 404.
- [ ] **Step 2: Run** `TEST_DATABASE_URL=… node --import tsx --test tests/finance-requests.test.ts` — Expected: FAIL (`financeRequestsMutate` inexistente).
- [ ] **Step 3: Implement `lib/finance-requests.ts`** e as rotas.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `Financeiro B: configuração por cliente, fornecedores, solicitações e cotações`.

### Task 4: Envio, relatório, reabertura, autorização, cancelamento e anexos

**Files:**
- Modify: `lib/finance-requests.ts`
- Create: `lib/finance-files.ts` (validação e leitura de anexos)
- Create: `app/recobravel/[id]/page.tsx` (relatório imprimível; `?versao=N`, padrão = última)
- Modify: `app/api/[...path]/route.ts` (POST `finance/attachments` com corpo binário **antes** de `boundedJSON`; GET `finance/attachment?id=`)
- Test: `tests/finance-requests.test.ts`

**Interfaces:**
- Consumes: Tarefa 3.
- Produces:
  - `MAX_ATTACHMENT=4_194_304`; `sniff(bytes:Uint8Array):'application/pdf'|'image/jpeg'|'image/png'|null` (`%PDF-`, `FF D8 FF`, `89 50 4E 47 0D 0A 1A 0A`).
  - `uploadAttachment(member,params:URLSearchParams,body:Uint8Array)` — params `request`, `quote?`, `kind`, `name`, `description?`; recusa tipo (415 "Envie PDF, JPG ou PNG.") e tamanho (413 "Arquivo acima de 4 MB."); mesmo `kind` + mesma cotação substitui o anterior (`replaced_by`); só Financeiro/Gestão e dentro do escopo.
  - `downloadAttachment(member,id)` → `Response` com `Content-Type` gravado, `Content-Disposition: attachment; filename*=UTF-8''…`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.
  - `financeRequestsMutate` ganha: `finance/requests/send` `{id,version,justification?}` (menos de 3 cotações sem justificativa → 409; grava `recovery_reports` com `snapshot` = dados + cotações + totais, versão = maior + 1); `finance/requests/reopen` `{id,version,reason}` (de `enviada` ou `autorizada` sem OS; de `autorizada` limpa `chosen_quote_id`, `chosen_total_cents`, assinatura e `plan_id`); `finance/requests/authorize` `{id,version,quoteId,signerName,signerRole,signedAt}` (copia `totals.totalCents` para `chosen_total_cents`); `finance/requests/cancel` `{id,version,reason}` (em `em_cotacao`, `enviada` ou `autorizada`; em `em_execucao` → 409 "A OS desta solicitação está em execução: cancele a OS no Planejamento antes. A solicitação volta a Autorizada e pode ser cancelada.").
  - `requestReport(member,id,version?)` → `{request, snapshot, version, issuedAt}` para a página.

- [ ] **Step 1: Write the failing tests:**
  - `envio com menos de 3 sem justificativa é recusado; com justificativa gera o relatório versão 1`.
  - `reabrir com motivo volta a "Em cotação" e o novo envio gera a versão 2` — snapshot da v1 continua com os valores antigos depois de editar uma cotação.
  - `autorizar sem anexo do relatório assinado é recusado; com anexo autoriza e trava valores` — depois de autorizar, `finance/quotes` (editar valor) → 409 e `finance/requests/save` → 409; `chosen_total_cents===1222222`.
  - `anexos: tipo errado e acima de 4 MB recusados; substituição sem apagar; download sem acesso recusado` — bytes `MZ…` com nome `.pdf` → 415; 4_194_305 bytes de PDF → 413; segundo `relatorio_assinado` deixa o primeiro com `replaced_by` preenchido e ambos no banco; `downloadAttachment` por operador → 403 e por Financeiro de outro escopo → 404; PNG válido enviado como `name:'x.pdf'` grava `content_type:'image/png'`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** serviço, `lib/finance-files.ts`, rotas e a página `app/recobravel/[id]/page.tsx` (mesmo padrão de `app/relatorio/[id]/page.tsx`: logo, número REC, versão e data; dados; tabela de cotações com fornecedor, proposta, validade, prazo, valor cotado, margem, subtotal, impostos e valor a faturar; escolhida em destaque, senão coluna "Escolha do cliente" em branco; justificativa quando houver menos de 3; blocos de assinatura **Gestão Interna** e **Gestão do Cliente** com nome, cargo, data e assinatura; auditoria `Exportação: relatório de recobrável`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `Financeiro B: envio ao cliente com relatório versionado, autorização com relatório assinado e anexos`.

### Task 5: Ligação com o Planejamento

**Files:**
- Modify: `lib/finance-requests.ts` (`finance/requests/plan`, `finance/requests/link`)
- Modify: `lib/planning.ts` (exportar `createDraftFrom` e `freeType`; no `planning/launch`, ligar a solicitação; `ordersList` traz `recovery_number` e, para Financeiro/Gestão, `recovery_supplier` e `recovery_total_cents`)
- Modify: `lib/operation.ts` (`checkClosure`: ao concluir a OS, solicitação `em_execucao` → `concluida`)
- Modify: `lib/cancel.ts` (OS cancelada: solicitação `em_execucao` → `autorizada`, limpa `work_order_id` e `plan_id`)
- Test: `tests/finance-requests.test.ts`

**Interfaces:**
- Consumes: Tarefas 3–4; `createDraftFrom(tx,a,activityTypeId,header)`, `freeType(tx,a)` de `lib/planning.ts`.
- Produces:
  - `finance/requests/plan` `{id}` (acesso Planejamento; só `autorizada` sem `plan_id` ativo) → `{planId}`: rascunho com `org_id`, `requester_person_id`, `planned_start/end` e descrição; sem fluxo: `title` da solicitação e os recursos viram `plan_step_needs` da etapa única; com fluxo: etapas do fluxo e os recursos da solicitação listados na descrição ("Recursos da REC-000001: …"). Grava `plan_id` na solicitação.
  - `finance/requests/link` `{id,workOrderId}` (Financeiro/Gestão ou Planejamento): OS do mesmo cliente, não cancelada e sem solicitação → `em_execucao`; se a OS já está `concluida`, passa em seguida a `concluida`.
  - Ganchos: `planning/launch` de um plano com solicitação `autorizada` ligada → `em_execucao` + `work_order_id`; `checkClosure` concluindo → `concluida`; cancelamento → `autorizada`. Só solicitações em `em_execucao` reagem ao encerramento e ao cancelamento.
- [ ] **Step 1: Write the failing tests:**
  - `planejar OS preenche os dados da solicitação (sem fluxo: título e recursos)` — `planDetail` do rascunho: `org_id`, `requester_person_id`, `planned_start`, título e `needs` iguais aos da solicitação.
  - `lançar → Em execução; concluir → Concluída` — lança o rascunho (local e equipamento preenchidos no teste), inicia e finaliza a etapa; a solicitação passa a `em_execucao` com `work_order_id` e depois a `concluida`.
  - `cancelar a OS → volta a Autorizada, sem OS`.
  - `OS cancelada de solicitação já concluída não muda nada` e `reabrir autorizada com rascunho desliga o rascunho e limpa escolha e assinatura` (Review Focus 4 e 5).
  - `lista de OS mostra o selo da solicitação; valor só para quem tem Financeiro` — `ordersList(planner)` traz `recovery_number` e não traz `recovery_total_cents`; `ordersList(fin)` traz os dois.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** os caminhos e os ganchos (auditoria pelo acesso de quem age).
- [ ] **Step 4: Run** o arquivo e depois `npm test` completo — Expected: PASS em tudo.
- [ ] **Step 5: Commit** `Financeiro B: solicitação vira OS (planejar ou vincular) e acompanha lançamento, conclusão e cancelamento`.

### Task 6: Telas

**Files:**
- Create: `app/finance-requests.tsx` (lista, detalhe e diálogos)
- Create: `app/finance-config.tsx` (clientes, margem/impostos, fornecedores)
- Modify: `app/workspace.tsx` (rotas `fin-solicitacoes`, `fin-config`; "Planejar OS" abre `openPlan(planId)`), `app/navigation.tsx` (Financeiro: Painel de recobráveis, **Solicitação de recobráveis**, Tarifas, **Configurações**), `app/planning.tsx` (selo "Recobrável REC-000001" na Lista de OS, com fornecedor e valor quando vierem), `app/execution.tsx` (mesmo selo no cabeçalho da OS), `app/sonar.css`
- Reuse: `NeedAdder` e `needLabel` de `app/planning.tsx` (exportar `NeedAdder`) para os recursos

**Interfaces:**
- Consumes: rotas das Tarefas 3–5.
- Produces (sem novas funções de serviço):
  - lista com as colunas da spec §2 e filtros situação, solicitante e período; botão **Criar nova solicitação**;
  - detalhe com dados, recursos, cotações lado a lado (escolhida em destaque; "n de 3"), cálculo, anexos (enviar, baixar, substituídos à parte), relatórios (abrir v1, v2…), histórico e ações por situação (Enviar ao cliente, Reabrir, Autorizar, Cancelar, Planejar OS, Vincular OS);
  - Configurações com habilitar cliente, nova vigência (sugestão preenchida), fornecedores (cadastrar, editar, inativar).
- [ ] **Step 1: Verificação no navegador (demo local, `DATABASE_URL=…/demo`)** — roteiro Playwright no scratchpad: criar solicitação, registrar 2 cotações em sequência, enviar sem justificativa (erro na tela), justificar e enviar, abrir o relatório v1, anexar relatório assinado (PDF pequeno), autorizar, Planejar OS abre o rascunho preenchido; `npx tsc --noEmit` e `npx eslint .` limpos; capturas em 1440 px e 390 px sem corte de ações.
- [ ] **Step 2: Commit** `Financeiro B: telas de solicitações, cotações e configurações`.

### Task 7: Painel, exportação e documentação

**Files:**
- Modify: `lib/finance.ts` (`financePanel` ganha `activities:{emCotacao,enviadas,autorizadas,authorizedCents,concludedCents}` no período, pela data prevista de início, no escopo)
- Modify: `lib/exports.ts` (conjunto `recobraveis_atividades`), `app/export-center.tsx`, `app/finance.tsx` (bloco **Atividades** no painel)
- Create/Modify: `docs/FINANCEIRO-RECOBRAVEIS.md` (seção "Solicitação de recobráveis"), `README.md` (uma linha)
- Test: `tests/finance-requests.test.ts`

**Interfaces:**
- Produces: `requestRows(f:{start,end,org},scope)` em `lib/finance-requests.ts` para a exportação; colunas `['REC','Situação','Solicitante','Atividade','Data prevista','Fornecedor escolhido','Valor cotado (R$)','Margem (R$)','Subtotal (R$)','Impostos (R$)','Valor a faturar (R$)','OS','Autorizada em']`.
- [ ] **Step 1: Write the failing tests:** `painel: bloco Atividades conta por situação e soma autorizadas e concluídas` e `exportação: Recobráveis: atividades com colunas e valores` (linha da cotação escolhida Alfa: `10000;1000;11000;1222,22;12222,22` no CSV; sem acesso Financeiro → 403).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** painel, exportação, bloco na tela e documentação.
- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit`, `npx eslint .`, `npm run build` — Expected: tudo limpo.
- [ ] **Step 5: Commit** `Financeiro B: atividades no painel, exportação e documentação`.
