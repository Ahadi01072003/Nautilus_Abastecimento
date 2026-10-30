# Financeiro · Recobráveis por equipamento (Frente A): plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** registrar o uso real de equipamentos cobráveis nas OS, calcular as diárias pela regra de janela de horas corridas por equipamento e cliente, e entregar à Gestão: tarifas, painel (previsto × realizado, conferido × a conferir) e exportação.

**Architecture:** um motor puro em `lib/recoverables.ts` (sem banco) calcula diárias a partir de intervalos e tarifas. Ele é usado na OS, no painel e na exportação, e as diárias nunca são gravadas. O serviço `lib/finance.ts` grava tarifas e usos, aplica permissões e a revisão, e expõe as consultas. A migração 0019 cria as tabelas e as travas no banco: sem sobreposição, sem apagar e campos imutáveis. A Operação aplica o fim automático ao finalizar ou dispensar etapa e ao cancelar a OS.

**Tech Stack:** Next.js 16 (App Router, `app/api/[...path]/route.ts`), React 19, TypeScript, Postgres (schema `nautilus`, SQL com `?` via `lib/db.ts`) e testes `node --test` com banco descartável (`tests/helpers.ts`).

**Spec:** `docs/superpowers/specs/2026-10-30-financeiro-recobraveis-equipamento-design.md`

## Global Constraints

- **Repositório público:** nenhum preço real nem nome de cliente em código, teste ou documento. Nos testes, use tarifa fictícia de **R$ 500/h e 8 h por diária (R$ 4.000)** e organização "Cliente Teste".
- **Valores:** dinheiro em **centavos inteiros** (`hourly_cents`); exibição em `pt-BR` com `R$`.
- **Datas:** instantes gravados como texto ISO UTC (padrão do schema). Mês de faturamento e "vigente a partir de" pelo **horário de Brasília** (`America/Sao_Paulo`).
- **Regra da diária:**
  - janela de P horas corridas (P = `hours_per_day`, de 1 a 168);
  - fim igual ao fim da janela fica nela;
  - início igual ao fim da janela abre outra;
  - não reinicia à meia-noite;
  - valor da diária = `hourly_cents × P` pela tarifa vigente **no início da diária**;
  - a diária pertence à **OS que a abriu**.
- **"A conferir":**
  - fim automático (etapa ou cancelamento); ou
  - uso fora do período reservado do equipamento na OS por **mais de 30 min** (soma do que fica fora).
- **Registro:**
  - fim e início não no futuro (tolerância de 1 min) e não antes de 2020-01-01;
  - fim > início;
  - o mesmo equipamento não tem dois usos ao mesmo tempo, mas encostar é permitido;
  - se gerar mais de 1 diária, pede confirmação.
- **Acesso:**
  - novo acesso adicional `financeiro`, que a Gestão sempre tem;
  - a Operação registra o uso com a OS programada, em andamento ou em encerramento pendente;
  - Financeiro e Gestão registram e corrigem em qualquer situação;
  - correção exige motivo.
- **Nada é apagado:** tarifas não são alteradas (cada mudança é uma nova vigência) e usos não são apagados.
- **Commits:** terminam com as linhas `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` e `Claude-Session: https://claude.ai/code/session_01PNBgLJZmtVoD1kz7FadVGt`. Nenhum identificador de modelo em código ou PR.
- **Verificação de cada tarefa:**
  - `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm test`
  - `npx tsc --noEmit`
  - `npx eslint .`
- **Produção:** a migração **não** é aplicada em produção sem OK explícito do usuário.

## Review Focus

1. **Uso esquecido aberto por dias.** Etapa não finalizada e ninguém registra o fim. As diárias crescem até "agora", mas aparecem como **a conferir**, e o aviso surge no Painel central. *(teste na Tarefa 4)*
2. **Troca de tarifa no meio de uma sequência de diárias.** Cada diária usa a tarifa vigente no **seu** início, inclusive horas por diária diferentes. *(teste na Tarefa 1)*
3. **Dois usuários iniciando o mesmo equipamento ao mesmo tempo, ou clique duplo.** O segundo início é recusado com a OS que já usa o equipamento. A mesma `operationKey` devolve o mesmo registro. *(teste na Tarefa 3)*
4. **OS de cliente sem tarifa, ou equipamento sem tarifa.** A seção some da OS, e o início pela API é recusado com mensagem clara. *(teste na Tarefa 3)*
5. **Correção que cria sobreposição, ou correção sem motivo.** É recusada e nada muda. *(teste na Tarefa 3)*

---

### Task 1: Motor de diárias (puro)

**Files:**
- Create: `lib/recoverables.ts`
- Test: `tests/recoverables.test.ts`

**Interfaces:**
- Produces:
  - `type Rate={equipmentId:string,orgId:string,hourlyCents:number,hoursPerDay:number,validFrom:string,active:boolean}` (`validFrom` = `YYYY-MM-DD`)
  - `type Interval={id:string,orderId:string,orderNumber:number,equipmentId:string,orgId:string,start:number,end:number|null,pending:boolean}` (ms; `end=null` = em uso)
  - `type Daily={equipmentId:string,orgId:string,start:number,end:number,openerOrderId:string,openerNumber:number,orderIds:string[],intervalIds:string[],hoursPerDay:number,hourlyCents:number,valueCents:number,pending:boolean}`
  - `rateAt(rates:Rate[],equipmentId:string,orgId:string,at:number):Rate|null`: maior `validFrom` ≤ data de `at` em Brasília; `null` se nenhuma ou se a vigente estiver inativa.
  - `dailies(intervals:Interval[],rates:Rate[],now:number):Daily[]`: ordenado por início.
  - `minutesOutside(use:[number,number],windows:[number,number][]):number`: minutos do uso fora da união das janelas.
  - `billingMonth(at:number):string`: `YYYY-MM` em Brasília.

- [ ] **Step 1: Write the failing tests** (`tests/recoverables.test.ts`, sem banco)

  Tarifa `R={equipmentId:'pta',orgId:'cli',hourlyCents:50000,hoursPerDay:8,validFrom:'2026-01-01',active:true}` e helper `h(n)` = instante base + n horas. Testes:
  - `'diária: usos dentro da janela de 8 h contam uma vez'`:
    - 08–12 → 1 diária, `valueCents:400000`;
    - 08–12 + 14–15:30 → 1.
  - `'diária: uso que passa do fim abre a seguinte no fim da anterior; novo uso depois da janela abre outra'`:
    - 08–00 → 2, com inícios `[h(8),h(16)]`;
    - 08–00:30 → 3;
    - 08–12 + 17–18 → 2, com a 2ª começando em `h(17)`.
  - `'diária: limite exato e meia-noite'`:
    - uso que termina exatamente em `h(16)` → 1;
    - uso que começa em `h(16)` depois de 08–10 → 2;
    - 2ª diária aberta às 17:00 cobre um uso às 00:30 (janela 17–01).
  - `'diária: várias OS do mesmo cliente dividem a janela; a diária pertence à OS que abriu'`:
    - A 08–10, B 11–12, C 14–15, B 17–18 → 2 diárias;
    - a 1ª com `openerOrderId:'A'` e `orderIds:['A','B','C']`;
    - a 2ª com `openerOrderId:'B'`.
  - `'diária: A 08–20 e B 20–21 → 2 diárias, ambas abertas por A'`.
  - `'diária: uso em aberto conta até agora e marca pendente'`: início `h(8)`, `end:null`, `now=h(26)` → 3 diárias, todas `pending:true`.
  - `'diária: cliente ou equipamento sem tarifa não gera diária'`.
  - `'diária: troca de tarifa vale a partir do início de cada diária'`: segunda vigência no dia seguinte com `hourlyCents:60000`, `hoursPerDay:10` → a diária que começa nesse dia vale `600000` e dura 10 h.
  - `'minutesOutside: soma o que fica fora das janelas'`:
    - uso 08–12 com janela 09–11 → 120;
    - com janela 07–13 → 0.
  - `'billingMonth: usa o horário de Brasília'`: `Date.parse('2026-11-01T02:00:00Z')` → `'2026-10'`.

- [ ] **Step 2: Run to verify it fails**

  Run: `node --import tsx --test tests/recoverables.test.ts`
  Expected: FAIL ("Cannot find module '../lib/recoverables'").

- [ ] **Step 3: Implement `lib/recoverables.ts`**

  Algoritmo de `dailies`:
  1. Agrupe por `equipmentId|orgId` e ordene por `start`.
  2. Para cada intervalo, use `e = end ?? now`.
  3. Mantenha a janela corrente `[ws,we)`. Se não há janela ou `start >= we`:
     - pegue `r = rateAt(..., start)`;
     - se não houver tarifa, pule o intervalo;
     - abra uma janela em `start`, com `we = start + r.hoursPerDay h`, `opener` = OS do intervalo.
  4. Adicione a OS e o intervalo à janela, e propague `pending`.
  5. Enquanto `e > we`, abra a janela seguinte em `we` com `rateAt(..., we)`, mesmo `opener`. Se não houver tarifa em `we`, pare.

  Valor = `hourlyCents × hoursPerDay`.

- [ ] **Step 4: Run to verify it passes** (mesmo comando, todos PASS).

- [ ] **Step 5: Commit** com `git add lib/recoverables.ts tests/recoverables.test.ts` e a mensagem "Financeiro: motor de diárias de recobráveis (janela de horas corridas por equipamento e cliente)".

### Task 2: Banco e acesso "Financeiro"

**Files:**
- Create: `db/migrations/0019_financeiro_recobraveis.sql`
- Modify: `lib/permissions.ts` (tipo `Capability`, `capabilities`, `financeModules`, `modules()`)
- Modify: `app/registry.tsx` (`capabilityNames.financeiro='Financeiro'`)
- Modify: `app/navigation.tsx` (módulo `financeiro`)
- Test: `tests/finance.test.ts` (novo)

**Interfaces:**
- Produces:
  - tabelas `recovery_rates` e `equipment_uses` (colunas abaixo);
  - capability `'financeiro'`;
  - telas `fin-painel` e `fin-tarifas` em `financeModules`.

- [ ] **Step 1: Write the failing tests** (`tests/finance.test.ts`, com `freshDatabase`, `seedOperation` e `addMember`)
  - `'financeiro: acesso adicional libera as telas; sem ele, não'`: `modules()` de um operador com `capabilities:['operacao','financeiro']` inclui `'fin-painel'` e `'fin-tarifas'`; sem `financeiro`, não inclui; o gestor sempre inclui.
  - `'banco: uso não é apagado, não se sobrepõe e fim é depois do início'`, via SQL direto:
    - `DELETE` recusa com /não pode ser apagado/;
    - um segundo uso sobreposto do mesmo equipamento recusa com /já em uso/;
    - uso encostado (início = fim do outro) é aceito;
    - `ended_at <= started_at` recusa;
    - `UPDATE` de `equipment_id` recusa.
  - `'banco: tarifa não é alterada nem apagada'`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Write `0019_financeiro_recobraveis.sql`**
  - **Acesso:** troque `member_capabilities` para incluir `'financeiro'`.
  - **`recovery_rates`:**
    - colunas `id`, `equipment_id` (FK), `org_id` (FK `requester_orgs`);
    - `hourly_cents int` (de 0 a 100000000);
    - `hours_per_day int` (de 1 a 168);
    - `valid_from text` (formato `YYYY-MM-DD`);
    - `active smallint` (0 ou 1);
    - `created_at`, `created_by` (FK), `created_by_name`;
    - `UNIQUE (equipment_id, org_id, valid_from)`;
    - trigger que recusa UPDATE e DELETE com 'Tarifa não pode ser alterada'.
  - **`equipment_uses`:**
    - colunas `id`, `work_order_id` (FK), `equipment_id` (FK), `org_id` (FK), `started_at`, `ended_at`;
    - `end_source` em ('registrado','etapa','cancelamento'), nulo se e só se `ended_at` for nulo;
    - `review` em ('normal','a_conferir','conferido'), padrão 'normal';
    - `started_by`/`started_by_name`, `ended_by`/`ended_by_name`, `reviewed_by`/`reviewed_by_name`/`reviewed_at`;
    - `operation_key UNIQUE`, `created_at`;
    - índices `(equipment_id, started_at)` e `(work_order_id)`.
  - **Trigger `nautilus_equipment_use_guard`** (BEFORE INSERT/UPDATE/DELETE):
    - DELETE → 'Uso de equipamento não pode ser apagado';
    - fim ≤ início → 'Fim do uso deve ser depois do início';
    - UPDATE de `work_order_id`, `equipment_id`, `org_id`, `operation_key` ou `started_by` → 'Uso de equipamento não pode ser alterado';
    - travar a linha de `equipment` com `FOR UPDATE`;
    - sobreposição com `tstzrange(start, coalesce(end,'infinity'),'[)') && ...` contra outro uso do mesmo equipamento → 'Equipamento já em uso no período' `USING DETAIL = <número da OS do outro uso>`.
  - **Auditoria:** recrie `nautilus_audit_actor_guard` copiando o corpo atual de `db/migrations/0016_perfil_do_usuario.sql` e somando a linha `OR ('financeiro' = ANY(capabilities) AND NEW.action LIKE 'Financeiro:%')`.
  - **RLS e search_path:** habilite RLS e revogue de `anon`/`authenticated` nas duas tabelas (mesmo bloco da `0012_manutencao.sql`, linhas ~215–230) e termine com o bloco de `search_path` das funções `nautilus_%` (como no fim da 0016).

- [ ] **Step 4: `lib/permissions.ts` e telas**
  - Acrescente `'financeiro'` em `Capability` e `capabilities`.
  - Crie `export const financeModules=['fin-painel','fin-tarifas'];`.
  - Em `modules()`, use `if(has(a,'financeiro'))list.push(...financeModules)`.
  - Em `app/navigation.tsx`, crie o módulo `{id:'financeiro',label:'Financeiro',icon:Landmark,screens:[...]}`:
    - `fin-painel` "Painel de recobráveis", com o subtítulo "Diárias previstas e realizadas por equipamento, conferidas e a conferir.";
    - `fin-tarifas` "Tarifas", com o subtítulo "Valor por hora e horas por diária de cada equipamento cobrado, com vigência.".

- [ ] **Step 5: Run to verify it passes**, com as três verificações globais.

- [ ] **Step 6: Commit** ("Financeiro: tabelas de tarifas e usos, travas no banco e acesso Financeiro").

### Task 3: Serviço de tarifas e de usos (API)

**Files:**
- Create: `lib/finance.ts`
- Modify: `app/api/[...path]/route.ts` (GET `finance/rates` e `finance/order-uses`; POST `finance/*` → `financeMutate`)
- Test: `tests/finance.test.ts`

**Interfaces:**
- Consumes: `dailies`, `rateAt`, `minutesOutside` (Tarefa 1); tabelas (Tarefa 2).
- Produces:
  - `financeRates(member):Promise<{rates:Row[],equipment:Row[],orgs:Row[]}>`, para quem tem `financeiro`.
  - `orderUses(member,workOrderId):Promise<{eligible:boolean,equipment:{id:string,tag:string}[],uses:Row[],dailies:Daily[],can:{register:boolean,correct:boolean}}>`:
    - `eligible` = o cliente da OS tem tarifa ativa hoje para algum equipamento da versão vigente da OS;
    - `dailies` = as que contêm algum uso desta OS.
  - `financeMutate(path,b,member)`, com os caminhos:
    - `finance/rates`, campos `{equipmentId,orgId,hourly,hoursPerDay,validFrom,active}`, onde `hourly` vem em reais e é convertido para centavos;
    - `finance/uses/start`, campos `{operationKey,workOrderId,equipmentId,startedAt}`;
    - `finance/uses/end`, campos `{id,endedAt,confirm?}`;
    - `finance/uses/correct`, campos `{id,startedAt?,endedAt?,reason,confirm?}`;
    - `finance/uses/confirm`, campo `{id}`.
  - Quando o uso geraria mais de 1 diária e `confirm!==true`, a API devolve `{confirm:true,dailies:n,valueCents:v,message:'Este uso soma X h e gera n diárias (R$ …). Confirmar?'}` **sem gravar**.
  - `closeOpenUses(tx,a,workOrderId,at,source:'etapa'|'cancelamento',equipmentIds?:string[]):Promise<number>`, para a Tarefa 4.

- [ ] **Step 1: Write the failing tests** (`tests/finance.test.ts`)

  Prepare uma organização "Cliente Teste", uma OS lançada dela com `eq1` reservado das 08:00 às 18:00 e uma tarifa de 500/h e 8 h para `eq1`. Testes:
  - `'tarifas: só Financeiro/Gestão; nova vigência não altera a anterior; data repetida recusa'`.
  - `'uso: Operação inicia e encerra; idempotente pela operationKey; sem tarifa recusa'`:
    - OS de outro cliente → 400 /sem tarifa/;
    - segundo `start` com a mesma `operationKey` → mesmo `id`.
  - `'uso: sobreposição do mesmo equipamento em outra OS recusa citando a OS'` → 409 /OS \d{6}/.
  - `'uso: mais de uma diária pede confirmação e não grava sem ela'`:
    - fim 16 h depois → `{confirm:true,dailies:2}`;
    - nada gravado;
    - com `confirm:true` grava.
  - `'uso: fora do reservado por mais de 30 min fica a conferir; dentro fica normal'`.
  - `'uso: Operação não registra em OS concluída; Financeiro registra'`.
  - `'correção: exige motivo, audita antes/depois, não cria sobreposição; confirmar passa a conferido'`.
  - `'datas: futuro e antes de 2020 recusados'`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `lib/finance.ts`**
  - **Padrões:** use os de `lib/condition.ts` e `lib/maintenance.ts`: `requireAny`, `AppError`, `audit` de `lib/registry.ts`, `db().tx`.
  - **Erros do banco:** traduza 'Equipamento já em uso no período' (com `detail` = número da OS) para `AppError('O equipamento já está em uso nesse período na OS 000123.',409)`.
  - **Revisão ao gravar o fim:** `review='a_conferir'` quando `minutesOutside(uso, reservas do equipamento na versão vigente da OS) > 30`.
  - **Ações de auditoria:**
    - pela Operação: 'Operação: início de uso de equipamento' e 'Operação: fim de uso de equipamento';
    - pelo Financeiro: 'Financeiro: tarifa cadastrada', 'Financeiro: uso registrado', 'Financeiro: uso corrigido' (detalhe `{before,after,reason}`) e 'Financeiro: uso conferido'.

- [ ] **Step 4: Rotas** em `app/api/[...path]/route.ts`:
  - `if(path==='finance/rates')…financeRates`;
  - `if(path==='finance/order-uses')…orderUses(member,url.searchParams.get('os')||'')`;
  - no POST, `if(path.startsWith('finance/'))return json(await financeMutate(path,body,member));`.

- [ ] **Step 5: Run to verify it passes** e **Step 6: Commit** ("Financeiro: tarifas com vigência e registro de uso de equipamento na OS").

### Task 4: Fim automático e avisos

**Files:**
- Modify: `lib/operation.ts`, em `ops/finish` e em `dispense()`: depois de concluir ou dispensar a etapa, `closeOpenUses(tx,a,wo.id,t,'etapa',<equipamentos sem outra etapa aberta da OS>)`.
- Modify: `lib/cancel.ts`, em `cancelOrder`: `closeOpenUses(tx,a,w.id,t,'cancelamento')`.
- Modify: `lib/central.ts`: `Alert.module` passa a aceitar `'financeiro'`.
- Modify: `app/central.tsx`: `MOD.financeiro=['Financeiro',Landmark]`.
- Test: `tests/finance.test.ts`

**Interfaces:**
- Consumes: `closeOpenUses` (Tarefa 3).
- Produces:
  - avisos `use:<id>` ("<TAG> em uso há <h> sem fim registrado", módulo `financeiro`, severidade `atencao`, link `{view:'op-os',os}`), para quem tem `operacao` ou `financeiro` e o uso aberto há ≥ `hoursPerDay` horas;
  - aviso `uses:review` ("<n> uso(s) de equipamento a conferir", severidade `info`, link `{view:'fin-painel'}`), só para Financeiro e Gestão.

- [ ] **Step 1: Write the failing tests**
  - `'fim automático: finalizar a última etapa aberta com o equipamento encerra o uso como a conferir; etapa intermediária não'`.
  - `'fim automático: cancelar a OS encerra o uso aberto'` (`end_source='cancelamento'`).
  - `'aviso: uso aberto há 9 h aparece no Painel central; as diárias contam até agora e ficam a conferir'` (Review Focus 1).

- [ ] **Step 2: Run to verify it fails** → **Step 3: Implement** → **Step 4: Run to verify it passes** → **Step 5: Commit** ("Financeiro: fim automático do uso ao finalizar etapa ou cancelar OS; avisos no Painel central").

### Task 5: Seção na OS e tela de Tarifas

**Files:**
- Create: `app/equipment-uses.tsx`, com o componente `EquipmentUses({order,onChanged})`.
- Modify: `app/execution.tsx`: renderiza `<EquipmentUses …/>` na aba de Apontamentos da OS, só quando `eligible`.
- Create: `app/finance.tsx`, com o componente `Rates()` (e, na Tarefa 6, `RecoverablePanel()`).
- Modify: `app/workspace.tsx`: `view==='fin-tarifas'&&<Rates/>`.

**Interfaces:**
- Consumes: `finance/order-uses`, `finance/uses/*`, `finance/rates` (Tarefa 3).
- Produces: nada consumido por outras tarefas.

- [ ] **Step 1: Seção "Uso de equipamentos recobráveis"**
  - **Lista de usos:** início, fim (ou "em uso"), duração, selo de situação ("Fim automático", "A conferir" ou "Conferido") e quem registrou.
  - **Botão "Início de uso":** abre a lista suspensa com as TAGs de `equipment`, e o campo de data e hora vem com o momento atual e pode ser anterior.
  - **"Fim de uso":** botão em cada uso aberto.
  - **Confirmação:** se a resposta vier com `confirm:true`, mostra o diálogo com a mensagem e reenvia com `confirm:true`.
  - **Diárias desta OS:** período, "aberta por OS X" ou "atendida dentro da diária da OS X" e valor.
  - **Para `can.correct`:** "Corrigir", com início, fim e motivo, e "Confirmar".

- [ ] **Step 2: Tela Tarifas**
  - **Tabela por equipamento e cliente:** vigência, valor por hora, horas por diária, valor da diária e situação.
  - **"Nova vigência":** equipamento, cliente, valor por hora (R$), horas por diária, vigente a partir de e cobrança ativa.

- [ ] **Step 3: Verificar no app local** (`npx next dev` com a base `demo`). Cadastre a tarifa fictícia, inicie e encerre um uso numa OS e veja a confirmação de 2 diárias. Tire capturas sem erros no console.

- [ ] **Step 4: Rodar as verificações globais e fazer o commit** ("Financeiro: uso de equipamento na OS e tela de Tarifas").

### Task 6: Painel de recobráveis

**Files:**
- Modify: `lib/finance.ts`: `financePanel(member,url)`.
- Modify: `app/api/[...path]/route.ts`: GET `finance/panel`.
- Modify: `app/finance.tsx`: `RecoverablePanel()`.
- Modify: `app/workspace.tsx`: `view==='fin-painel'&&<RecoverablePanel/>`.
- Test: `tests/finance.test.ts`

**Interfaces:**
- Produces: `financePanel(member,url)`.
  - **Parâmetros:** `from`/`to` em `YYYY-MM-DD` (padrão: o mês atual em Brasília) e `org` opcional.
  - **Retorno:** `{period:{from,to},rows:PanelRow[],detail:Record<string,{dailies:Daily[],pending:Row[]}>}`, com a chave de `detail` igual a `equipmentId|orgId` e:

    `PanelRow={equipmentId,tag,orgId,orgName,requests,scheduled,plannedHours,plannedDailies,plannedCents,avgPerOrderCents,dailies,confirmedCents,pendingCents}`.

- [ ] **Step 1: Write the failing test** `'painel: previsto pelas reservas e realizado pelos usos, no período'`. Com duas OS do cliente com `eq1` (uma programada e outra concluída com usos):
  - `requests=2`, `scheduled=1`;
  - `plannedHours` = soma das reservas confirmadas recortadas ao período;
  - `plannedDailies` e `plannedCents` pelo motor sobre as reservas;
  - `confirmedCents` e `pendingCents` pelo motor sobre os usos;
  - diária que começa antes do período não entra.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**
  - **Previsto:**
    - reservas `status='confirmada'` das versões vigentes das OS do cliente com o equipamento;
    - OS com situação ≠ cancelada, ou cancelada com uso;
    - motor sobre essas reservas como intervalos `pending:false`.
  - **Realizado:** usos desde `from − 7 dias` até `to` (a janela máxima é de 168 h), passando pelo motor e filtrando diárias com início no período.
  - **`pending`:** a diária é pendente se algum uso dela estiver `a_conferir`, ou aberto.
  - **Interface:** linhas clicáveis abrem as diárias e os usos a conferir, com "Confirmar" e "Corrigir" (mesmas chamadas da Tarefa 5).

- [ ] **Step 4: Run to verify it passes**, conferir no app local e **Step 5: Commit** ("Financeiro: painel de recobráveis, previsto × realizado").

### Task 7: Exportação

**Files:**
- Modify: `lib/exports.ts`:
  - `Def.group` aceita `'financeiro'`;
  - `Def` ganha o campo opcional `load?:(f:Filters,s:Scope)=>Promise<Row[]>`, usado em `exportData` e `exportPreview` no lugar do SQL quando existe;
  - `allowedSets`: o grupo `financeiro` → `isManager(a)||has(a,'financeiro')`.
- Modify: `app/export-center.tsx`: mostrar o grupo "Financeiro".
- Test: `tests/finance.test.ts`

**Interfaces:**
- Produces: conjuntos `recobraveis_diarias` e `recobraveis_usos`.
  - **`recobraveis_diarias`** (`load` com o motor). Colunas, nesta ordem: 'Equipamento', 'Cliente', 'Início da diária', 'Fim da diária', 'OS que abriu', 'OS atendidas', 'Horas por diária', 'Valor por hora (R$)', 'Valor da diária (R$)', 'Situação'.
  - **`recobraveis_usos`** (SQL). Colunas, nesta ordem: 'OS', 'Equipamento', 'Início', 'Fim', 'Duração (h)', 'Origem do fim', 'Situação', 'Registrado por', 'Conferido por'.

- [ ] **Step 1: Write the failing test** `'exportação: diárias e usos com as colunas e valores; sem acesso Financeiro não aparece'`.
- [ ] **Step 2: Run to verify it fails** → **Step 3: Implement** → **Step 4: Run to verify it passes** → **Step 5: Commit** ("Financeiro: exportação de diárias e usos recobráveis").

### Task 8: Fechamento

- [ ] **Step 1: Documentação.** Criar `docs/FINANCEIRO-RECOBRAVEIS.md` com regras, telas e o passo a passo para cadastrar a primeira tarifa, sem valores reais. Atualizar o `README.md` com uma linha sobre o módulo.
- [ ] **Step 2: Verificação completa.** Rodar as três verificações globais e `npm run build`, e conferir no app local o fluxo inteiro: tarifa → uso → painel → exportação.
- [ ] **Step 3: Commit, push e PR.** Na descrição do PR, avisar que a **migração 0019 precisa ser aplicada em produção** e que isso só acontece com o OK do usuário.
