# Portaria: especificação (somente backend)

Data: 04/11/2026. Situação: **aprovada em 04/11/2026**, com as decisões da seção 21. Entrega completa: backend e telas.

Nomes, documentos e placas deste documento são fictícios. Dados reais ficam só no banco: o repositório é público.

## 1. Objetivo e decisões já tomadas

Controlar as entradas e saídas de pessoas na base, com preenchimento contínuo do relatório do dia, histórico preservado, impressão e indicadores de acesso. **Backend e telas** na mesma entrega. Os contratos da seção 17 são a fronteira entre os dois.

Decisões do usuário em 04/11/2026:

| Tema | Decisão |
|---|---|
| Base | Uma só: **Base Açu** |
| Integração | **Nenhuma** com OS, Planejamento, Operação ou Financeiro. O módulo compartilha só empresas, usuários e auditoria |
| Empresa | O porteiro escolhe entre as empresas já cadastradas (Solicitantes e clientes) e pode **criar empresa na hora**. A empresa criada na hora fica **só na Portaria** (bloco Visitantes), sem entrar no cadastro dos demais módulos |
| Visitantes | Bloco novo em Cadastros › Colaboradores, **separado** dos colaboradores do Planejamento. Todo cadastro feito na hora, pelo porteiro ou pela gestão, fica ali, aguardando revisão |
| Documento | Texto livre, só para registro. Na **impressão** do relatório, porteiro e gestão veem o documento completo |
| Fechamento | O porteiro pode **reabrir** o dia e fechar de novo: isso gera uma **nova revisão do mesmo relatório diário** |
| Saída | **Impressão**. Não há PDF gerado no servidor. Consultas e dashboards usam os próprios registros |
| Acesso | Só **gestão** e **porteiro**. Cliente não vê |
| Vínculos | Uma empresa por pessoa |

## 2. Fora desta entrega

- PDF no servidor, links temporários e nova tentativa de geração.
- Várias bases, fuso por base e escopo por base (a coluna `base_id` existe, mas a API não recebe base).
- Várias empresas por pessoa.
- Modo offline.
- Criptografia do documento no nível do campo (explicada na seção 21; fora por padrão).
- Prazo de retenção e descarte: decisão do responsável do sistema, sem prazo inventado.

## 3. Conceitos

- **Porteiro:** usuário que registra. Não confundir com "colaborador" nem com o "operador" da Operação.
- **Pessoa:** quem entra e sai. Não precisa de conta.
- **Empresa:** organização de Cadastros gerais.
- **Visita:** permanência de uma pessoa, da entrada à saída.
- **Evento:** entrada, saída, correção, anulação ou desfazer saída. Fica gravado e não muda.
- **Relatório do dia:** um por base e data operacional. Fica aberto até o fechamento.
- **Versão do relatório:** fotografia imutável tirada a cada fechamento. Nas telas chama-se **revisão** (Rev. 1, Rev. 2…).

## 4. Acesso e permissões

- **Perfil novo "Porteiro":** o principal acesso desse perfil é a Portaria. Isso altera a constraint de perfil do banco (`members_profile_check`) e os rótulos de perfil das telas de Cadastros.
- **Gestão:** vê e faz tudo.
- **Negação por padrão:** toda rota exige sessão, perfil Porteiro ou Gestão e confere o acesso **no banco a cada chamada**. Revogar o acesso vale na próxima operação, mesmo com sessão ativa. O mecanismo atual já faz isso para os demais módulos, e a Portaria usa o mesmo.

| Ação | Porteiro | Gestão |
|---|---|---|
| Ver presentes, relatórios, versões e histórico | sim | sim |
| Buscar pessoas e empresas | sim | sim |
| Cadastrar pessoa e empresa na hora | sim | sim |
| Registrar entrada e saída | sim | sim |
| Lançar com hora retroativa | sim, com justificativa | sim, com justificativa |
| Corrigir, anular, desfazer saída | sim, com justificativa | sim, com justificativa |
| Fechar e reabrir relatório | sim | sim |
| Dashboard | sim | sim |
| Ver documento completo (impressão e detalhe) | sim | sim |
| Restaurar visita anulada | não | sim |
| Editar e inativar pessoa ou empresa; revisar pendências | não | sim |
| Conceder acesso | não | sim (função já existente) |

## 5. Pessoas e empresas

**Empresa** (`portaria_companies`, tabela da Portaria):
- as empresas já cadastradas em Solicitantes e clientes aparecem na busca e são **espelhadas** na tabela da Portaria na primeira vez que alguém as escolhe (só leitura; quem as altera continua sendo a gestão, em Solicitantes e clientes);
- **Cadastro na hora:** o porteiro (ou a gestão) informa só o nome. Se o nome já existir (nas empresas da Portaria ou nas do cadastro, sem diferenciar maiúsculas), reaproveita; se estiver inativa, devolve erro orientando a pedir à gestão que reative. Se não existir, cria a empresa **só na Portaria**, marcada como pendente de revisão;
- nada disso aparece em Planejamento, Financeiro ou nos demais módulos.

**Pessoa** (tabela própria da Portaria, `portaria_people`):
- nome (obrigatório);
- empresa (obrigatória, uma só);
- tipo de documento (CPF, RG, CNH, Passaporte, Outro);
- número do documento (obrigatório, 3 a 40 caracteres, texto livre sem validar dígitos);
- ativa ou inativa.

**Documento duplicado:** o par (tipo, número normalizado: maiúsculas, só letras e números) é único. Tentar cadastrar igual devolve `DOCUMENT_DUPLICATE` com a pessoa já existente (nome mascarado e empresa).

**Visitantes:** pessoas e empresas da Portaria ficam num bloco **Visitantes**, dentro de Cadastros › Colaboradores. Todo cadastro feito na hora nasce **pendente de revisão**, e a gestão o marca como revisado (ou corrige, ou inativa). Os colaboradores do Planejamento **não** entram na lista da Portaria, e o visitante **não** aparece como colaborador do Planejamento.

**Busca:** paginada, por nome, empresa ou documento. O documento só é encontrado por número completo. O resultado mostra nome, empresa, tipo de documento e documento **mascarado**. Homônimos se distinguem por empresa e final do documento. A seleção usa sempre o identificador.

**Inativar:** uma pessoa inativa não inicia visita nova. A saída de uma visita já em andamento continua permitida.

## 6. Visita e movimentos

Campos da visita:
- identificador, base e relatório da entrada;
- pessoa e **cópia histórica** do nome, do tipo e número do documento e da empresa;
- objetivo (obrigatório, até 200 caracteres) e observações (opcionais, até 500);
- meio de acesso: `a_pe`, `veiculo` ou `outro`;
- placa de entrada e placa de saída (opcionais, seção 7);
- `entry_at` e `exit_at` completos, a saída inicialmente nula;
- estado: `em_andamento`, `finalizada` ou `anulada`;
- quem registrou a entrada e a saída, e **quando foram registradas** (separado de quando ocorreram);
- versão (controle de concorrência), criação e atualização.

**Entrada** (tudo numa transação):
1. Confere acesso, pessoa ativa e empresa.
2. Obtém o relatório da data (cria se for a primeira movimentação).
3. Cria a visita e o evento de entrada.
4. Um índice único parcial (`base_id, person_id` onde `em_andamento`) impede duas visitas em andamento da mesma pessoa. A segunda tentativa devolve `ALREADY_PRESENT`.

**Saída:**
- Identifica a visita **explicitamente** por `visitId`. Nunca escolhe uma visita sozinho.
- Grava o evento de saída e finaliza a visita na mesma transação.
- Segunda saída com a mesma chave devolve o mesmo resultado. Com chave diferente devolve `VISIT_NOT_IN_PROGRESS`.

**Saída sem entrada:** não cria entrada falsa. O caminho autorizado é lançar a entrada retroativa (com justificativa) e depois a saída.

**Estados:** `em_andamento → finalizada`, `em_andamento → anulada`, `finalizada → anulada`, `finalizada → em_andamento` (desfazer saída, revalida a unicidade), `anulada → restaurar` (só a gestão).

## 7. Meio de acesso e placas

- **A pé ou outro meio:** sem placa.
- **Veículo:** a placa de entrada é obrigatória, e a de saída é opcional e pode ser diferente.
- **Normalização:** maiúsculas, só letras e números, de 3 a 10 caracteres. Não valida padrão de país.
- **Várias pessoas** podem usar a mesma placa.
- A placa é só um atributo do acesso da pessoa. O módulo não controla veículos.

## 8. Datas e fuso

- Base Açu em `America/Sao_Paulo`, gravado na tabela da base (sem tela de edição).
- Instantes em `timestamptz` (UTC). A data operacional é derivada no fuso da base.
- O horário padrão é o do servidor. O cliente pode informar `occurredAt`.
- **Retroativo:** acima de **30 minutos** antes de agora, exige justificativa e marca a visita como retroativa. Até 30 minutos passa direto, pois o porteiro costuma digitar um grupo depois de ele ter chegado. O valor é configurável.
- **Futuro:** recusado, com tolerância de 2 minutos (configurável).
- A saída não pode ser antes da entrada.
- Nada fecha visita à meia-noite.
- A data do evento define o relatório. Uma entrada às 23h50 digitada à 00h05 entra no relatório do dia anterior.

## 9. Relatório do dia

- **Unicidade:** `UNIQUE (base_id, op_date)` no banco. A criação é um "criar se não existir", seguro com dois porteiros ao mesmo tempo.
- O relatório fica **aberto** até o fechamento explícito. Cada operação grava na hora. Nenhum dado depende de navegador, memória local ou sessão.
- **Relatórios antigos abertos:** uma consulta lista os que ficaram pendentes de fechamento. Eles não impedem o dia seguinte.
- Todo evento acrescenta 1 ao contador de versão do relatório (`version`), que o fechamento usa para detectar mudança.

**Fechar** (`report/close`, uma transação):
1. Trava o relatório (`FOR UPDATE`).
2. Se já está fechado e a chave de idempotência é a mesma, devolve o resultado anterior.
3. Se `expectedVersion` ≠ `version`, devolve `VERSION_CONFLICT`: alguém registrou algo entre a conferência e a confirmação. Pede nova conferência.
4. Conta as visitas em andamento na base. Se houver e `confirmPresent` não vier, devolve `PRESENT_CONFIRMATION_REQUIRED` com o resumo de quem está na base. Com `confirmPresent`, exige justificativa.
5. Monta a **versão** (fotografia, seção abaixo), grava o fechamento (quem e quando) e passa o relatório para `fechado`.
6. Nunca preenche saída nem encerra visita.

**Conferir antes** (`report/check`): devolve os presentes, os totais, os movimentos posteriores pendentes e o `version` atual, para a tela confirmar.

**Reabrir** (`report/reopen`, porteiro ou gestão):
- exige justificativa e o motivo: `movimento_posterior` ou `correcao`;
- volta o relatório a `aberto`, sem apagar versão nenhuma;
- o próximo fechamento gera a **versão seguinte**, do tipo `atualizada` (movimento posterior) ou `retificada` (correção), com o motivo registrado.

**Versão do relatório:**
- número sequencial por relatório, tipo (`original`, `atualizada`, `retificada`), motivo, quem emitiu, quando (`issued_at`);
- conteúdo (JSON imutável): base, data operacional, fuso, totais, lista das entradas da data, lista das saídas da data (inclusive de visitas iniciadas antes), quem estava presente no instante do fechamento e totais por empresa;
- documentos **completos** dentro da fotografia (só porteiro e gestão acessam a revisão);
- o banco recusa alterar ou apagar uma versão.

## 10. Visita que atravessa dias e movimento depois do fechamento

- A entrada pertence ao relatório do dia 10, e a saída ao do dia 11. A visita liga as duas. A saída não conta como entrada nova e aparece no relatório do dia 11 como "saída de visita iniciada em 10/11".
- A saída continua possível mesmo com o relatório da entrada fechado. A versão antiga **não muda**: ela mostra aquela pessoa como presente no instante do fechamento. A consulta da visita mostra a saída posterior, identificada como posterior.
- **Movimento no dia já fechado:** o evento é gravado e não se perde. O relatório passa a indicar "movimentos posteriores ao fechamento" (todo evento do relatório mais novo que a última versão). Para incorporá-lo, o porteiro **reabre** e fecha de novo, o que gera a versão seguinte. A versão fechada anterior nunca é alterada.

## 11. Correções e anulações

- **Nada é apagado.** Cada correção grava um evento com valores antes e depois, quem fez, quando e a justificativa.
- **Corrigir:** pessoa, empresa, objetivo, observações, meio de acesso, placas e horários, com justificativa.
- **Anular:** a visita fica rastreável e sai dos indicadores. Anular uma visita em andamento libera a presença da pessoa, sem criar saída falsa.
- **Desfazer saída lançada por engano:** volta a `em_andamento` e revalida se a pessoa não tem outra visita em andamento.
- **Relatório fechado:** corrigir ou anular algo que entra numa versão já emitida **exige reabrir** esse relatório. A API devolve `REPORT_CLOSED` com o identificador. A correção de um horário de saída só afeta o relatório da saída.

## 12. Consultas e impressão

Consultas paginadas e filtráveis por:
- período, pessoa, empresa, placa;
- estado da visita e do relatório;
- presença atual;
- relatórios com movimentos posteriores pendentes.

A impressão usa os dados de uma **versão identificada**. A API devolve a versão pronta, com identificação da base, data operacional, fuso, identificador e número da versão, tipo, quem fechou e quando, quando foi consultada (diferente de quando fechou), totais, entradas, saídas e presentes. Documentos **completos** (só porteiro e gestão acessam). Relatório aberto só é devolvido marcado como **PARCIAL**. A resposta usa `Cache-Control: private, no-store`. Cada consulta para impressão entra na auditoria. A página de impressão faz parte desta entrega.

## 13. Indicadores

Endpoint com granularidade dia, mês ou ano, filtros de período e empresa. Devolve também o fuso, os filtros aplicados e o instante de atualização.

- **Entradas:** visitas **não anuladas** com `entry_at` no período (data local da base).
- **Saídas:** visitas **finalizadas** com `exit_at` no período.
- **Pessoas únicas:** `COUNT(DISTINCT pessoa)` sobre todo o período. Nunca soma de dias. Três entradas no dia = 3 entradas e 1 pessoa.
- **Presentes agora:** visitas em andamento.
- **Presença em um instante `t`:** `entry_at ≤ t` e (sem saída ou `exit_at > t`), não anulada. Inclui visitas iniciadas antes do período.
- **Por empresa:** entradas e pessoas únicas pela **empresa histórica** da visita. A soma das pessoas únicas por empresa pode passar do total se uma pessoa entrou por empresas diferentes. Isso fica documentado na resposta.
- **Visita anulada:** excluída de tudo.
- **Sem empresa:** categoria explícita, caso exista dado sem empresa.
- Calculado sempre dos registros válidos, sem contador gravado.
- Uma versão antiga do relatório mostra o momento da emissão. Se depois houve retificação, a divergência se explica pela versão seguinte.

## 14. Consistência, concorrência e segurança

- **Entrada simultânea da mesma pessoa:** índice único parcial no banco.
- **Dois relatórios do mesmo dia:** `UNIQUE (base_id, op_date)`.
- **Entradas, saídas e fechamento:** cada operação trava a linha do relatório da data (`FOR UPDATE`) antes de gravar. O fechamento trava a mesma linha, então serializa com os registros: não perde evento nem fecha com dado parcial. Se o relatório fechou antes do registro, o evento é gravado como posterior.
- **Controle de versão:** `version` na visita e no relatório. Alteração com versão antiga devolve `VERSION_CONFLICT`.
- **Idempotência:** chave obrigatória em entrada, saída, fechamento, reabertura e correção. A tabela guarda a chave, o usuário, a operação, o hash do conteúdo e a resposta. Mesma chave com conteúdo diferente devolve `IDEMPOTENCY_KEY_REUSED`.
- **Banco:** constraints (estado × saída, saída ≥ entrada, tamanhos), triggers que impedem apagar e que fixam eventos e versões.
- Consultas parametrizadas, paginação com limite, índices para as consultas reais, limite de tamanho dos campos e texto tratado antes de ir para a impressão.
- **Rate limit:** o mesmo mecanismo atual (leitura e escrita).
- Sem suporte offline.

## 15. Auditoria e privacidade

- **Auditoria:** reaproveita a tabela imutável atual. Registra entrada, saída, correção, anulação, fechamento, reabertura, cadastro na hora, revisão, consulta de documento completo, impressão e mudança de acesso. Cada registro leva ator, ação, entidade, momento, justificativa e identificador de correlação, no campo de detalhe estruturado. **Documento nunca entra** na auditoria nem em log, só identificador e máscara.
- **Documento:**
  - **mascarado** em listas, busca, painel e auditoria (só os 3 últimos caracteres aparecem);
  - **completo** na **impressão do relatório** e no detalhe da visita e do cadastro, para porteiro e gestão (decisão do usuário);
  - nunca em URL, nome de arquivo, log técnico ou auditoria;
  - toda resposta com dados de pessoa usa `Cache-Control: private, no-store`;
  - cada impressão e cada consulta de detalhe com documento completo vai para a auditoria.
- **Retenção e descarte:** sem prazo definido por enquanto. É decisão do responsável do sistema, sem inventar prazo legal.
- **Backup:** o do Supabase já existente. Falhas de gravação, conflitos de versão e relatórios abertos antigos saem como contadores e logs técnicos sem dado pessoal.

## 16. Modelo de dados

Migração `0024_portaria.sql`, aditiva. Reaproveita `members` e `requester_orgs`, e a auditoria atual. **Convenção nova:** `timestamptz` e `date` nativos (o resto do sistema usa texto ISO), porque os agrupamentos por dia local e os índices de intervalo dependem do tipo.

| Tabela | Campos principais | Regras |
|---|---|---|
| `portaria_bases` | id, nome, fuso | Uma linha semeada: Base Açu |
| `portaria_people` | id, nome, tipo e número do documento, documento normalizado, empresa, ativa, criação, atualização | Único (tipo, normalizado). Nunca apagada |
| `portaria_reports` | id, base, data operacional, estado, `version`, fechamento (quando, quem), motivo pendente de reabertura | Único (base, data). Nunca apagado |
| `portaria_visits` | ver seção 6, mais relatório de entrada e de saída | Único parcial (base, pessoa) onde em andamento. Saída ≥ entrada. Estado coerente com a saída. Nunca apagada |
| `portaria_events` | id, visita, tipo, `occurred_at`, `registered_at`, ator, justificativa, antes, depois, relatório | Imutável |
| `portaria_report_versions` | id, relatório, número, tipo, motivo, fotografia (JSON), totais, emitida em, por | Único (relatório, número). Imutável |
| `portaria_idempotency` | chave, usuário, operação, hash, resposta, criada em | Único (usuário, chave) |
| `portaria_pending_review` | id, tipo (pessoa ou empresa), entidade, criado por e em, revisado por e em | Alimenta a revisão da gestão |

Índices: visitas por (base, `entry_at`), por (base, `exit_at`) parcial onde há saída, por pessoa, por (empresa, `entry_at`); eventos por relatório; versões por relatório.

Todas as tabelas com RLS e sem acesso do público, como as demais. As funções com o `search_path` do schema.

## 17. Contratos da API

Segue o padrão do sistema: `GET`/`POST` em `/api/portaria/...`, JSON. O erro devolve `{error, code, field?}` (hoje devolve só `{error}`: a Portaria acrescenta o `code` estável, sem mudar o que os outros módulos recebem). Toda rota exige sessão e acesso Porteiro ou Gestão, **salvo as marcadas como gestão**.

**Consultas**

| Rota | Para quê | Erros |
|---|---|---|
| `GET portaria/people?q&page` | Buscar pessoas (nome, empresa, documento completo) | `FORBIDDEN` |
| `GET portaria/companies?q` | Listar empresas ativas | `FORBIDDEN` |
| `GET portaria/present` | Pessoas presentes agora (com `visitId`) | `FORBIDDEN` |
| `GET portaria/visits?from&to&person&company&plate&status&present` | Visitas filtradas | `FORBIDDEN`, `VALIDATION` |
| `GET portaria/visit?id` | Visita, eventos e relatórios ligados | `VISIT_NOT_FOUND` |
| `GET portaria/report?date` | Relatório do dia, lista e pendências | `REPORT_NOT_FOUND` |
| `GET portaria/reports?status&from&to&pending` | Histórico e relatórios antigos abertos | `FORBIDDEN` |
| `GET portaria/report/versions?reportId` | Versões do relatório | `REPORT_NOT_FOUND` |
| `GET portaria/report/version?id` | Versão pronta para impressão (audita) | `VERSION_NOT_FOUND` |
| `GET portaria/report/check?reportId` | Conferência antes de fechar | `REPORT_NOT_FOUND` |
| `GET portaria/dashboard?from&to&granularity&company` | Indicadores | `VALIDATION` |
| `GET portaria/person/document?id` (**gestão**) | Documento completo (audita) | `FORBIDDEN`, `PERSON_NOT_FOUND` |
| `GET portaria/pending-review` (**gestão**) | Cadastros feitos na portaria aguardando revisão | `FORBIDDEN` |

**Comandos** (todos com `idempotencyKey`, exceto os de gestão)

| Rota | Entrada | Erros principais |
|---|---|---|
| `POST portaria/company/quick` | `name` | `VALIDATION`, `COMPANY_INACTIVE` |
| `POST portaria/person/quick` | `name`, `documentType`, `documentNumber`, `companyId` | `VALIDATION`, `DOCUMENT_DUPLICATE`, `COMPANY_NOT_FOUND` |
| `POST portaria/report/open` | `date?` (cria se não existir) | `FORBIDDEN` |
| `POST portaria/entry` | `personId`, `purpose`, `accessMode`, `plateIn?`, `notes?`, `occurredAt?`, `justification?` | `PERSON_NOT_FOUND`, `PERSON_INACTIVE`, `ALREADY_PRESENT`, `PLATE_REQUIRED`, `PLATE_INVALID`, `FUTURE_TIME`, `JUSTIFICATION_REQUIRED` |
| `POST portaria/exit` | `visitId`, `version`, `plateOut?`, `occurredAt?`, `justification?` | `VISIT_NOT_FOUND`, `VISIT_NOT_IN_PROGRESS`, `EXIT_BEFORE_ENTRY`, `FUTURE_TIME`, `VERSION_CONFLICT` |
| `POST portaria/visit/correct` | `visitId`, `version`, `changes`, `justification` | `REPORT_CLOSED`, `JUSTIFICATION_REQUIRED`, `VERSION_CONFLICT`, `ALREADY_PRESENT` |
| `POST portaria/visit/annul` | `visitId`, `version`, `justification` | `REPORT_CLOSED`, `JUSTIFICATION_REQUIRED` |
| `POST portaria/visit/undo-exit` | `visitId`, `version`, `justification` | `ALREADY_PRESENT`, `REPORT_CLOSED` |
| `POST portaria/report/close` | `reportId`, `expectedVersion`, `confirmPresent?`, `justification?` | `VERSION_CONFLICT`, `PRESENT_CONFIRMATION_REQUIRED`, `JUSTIFICATION_REQUIRED` |
| `POST portaria/report/reopen` | `reportId`, `reasonKind`, `justification` | `JUSTIFICATION_REQUIRED`, `REPORT_NOT_CLOSED` |
| `POST portaria/person/save` (**gestão**) | cadastro completo, ativar e inativar | `VALIDATION`, `DOCUMENT_DUPLICATE` |
| `POST portaria/visit/restore` (**gestão**) | `visitId`, `justification` | `ALREADY_PRESENT` |
| `POST portaria/review/mark` (**gestão**) | `id` | `FORBIDDEN` |

**Códigos de erro estáveis:** `AUTH_REQUIRED` (401), `FORBIDDEN` (403), `VALIDATION` (400), `*_NOT_FOUND` (404) e os conflitos (409): `ALREADY_PRESENT`, `VISIT_NOT_IN_PROGRESS`, `VERSION_CONFLICT`, `REPORT_CLOSED`, `REPORT_NOT_CLOSED`, `DOCUMENT_DUPLICATE`, `PERSON_INACTIVE`, `PRESENT_CONFIRMATION_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`.

## 18. Cenários de aceite e testes

Cada cenário vira teste automatizado com banco real. Nada conta como pronto sem o teste verde.

1. Usuário sem acesso na API: 403. Revogar o acesso corta a próxima chamada, com a sessão ativa.
2. Porteiro não consulta documento completo nem altera cadastro de gestão.
3. Homônimos escolhidos pelo identificador, distinguidos por empresa e final do documento.
4. Mudança no cadastro não altera visita antiga.
5. Vários porteiros registram ao longo do dia, e tudo persiste na hora.
6. Duas entradas simultâneas da mesma pessoa: uma passa, a outra recebe `ALREADY_PRESENT`.
7. A mesma requisição reenviada: mesmo resultado, sem duplicar. Chave reusada com conteúdo diferente: `IDEMPOTENCY_KEY_REUSED`.
8. Entra e sai várias vezes no mesmo dia: 3 entradas, 1 pessoa.
9. Visita atravessa a meia-noite: entrada no dia 10, saída no dia 11, sem contar como entrada nova.
10. Saída depois do fechamento do relatório de entrada: a versão antiga não muda.
11. Fechar com pessoas presentes só com confirmação e justificativa.
12. Movimentação concorrente ao fechamento: `VERSION_CONFLICT`, sem fechar conteúdo diferente do conferido.
13. Entrada depois do fechamento na mesma data: gravada como posterior, relatório indica pendência. Reabrir e fechar gera a versão seguinte.
14. Correção preserva a versão emitida e a versão nova mostra a mudança.
15. Saída de pessoa inativada depois da entrada: permitida.
16. Acesso a pé: sem placa.
17. Placa de entrada diferente da de saída; mesma placa em pessoas diferentes.
18. Documento completo protegido: respostas do porteiro e versão impressa só com a máscara; auditoria e log sem documento; endpoint da gestão audita.
19. Indicadores: entradas × pessoas únicas × presença, inclusive visita iniciada antes do período e pessoas únicas calculadas sobre o período todo.
20. Anulação e retificação atualizam os indicadores.
21. Horários perto da meia-noite caem no dia local certo.
22. Cadastro na hora de pessoa e empresa: pendente de revisão, duplicidade recusada, empresa reaproveitada pelo nome.
23. Retroativo: até 30 minutos sem justificativa, acima disso exige justificativa e fica marcado.

**Não se aplicam nesta entrega** (e ficam registrados): consulta a registro de outra base, falha e repetição de geração de PDF.

## 19. Entrega em fases

1. **Base:** migração, perfil Porteiro, pessoas e empresas (cadastro na hora e revisão), entrada, saída, presentes, relatório do dia, idempotência, auditoria.
2. **Fechamento:** conferir, fechar, reabrir, versões, movimentos posteriores, relatórios antigos abertos.
3. **Correções:** corrigir, anular, desfazer saída, restaurar, consultas filtradas.
4. **Indicadores:** dashboard.

Cada fase termina com testes e revisão. A aplicação da migração em produção e o merge dependem do seu OK.

## 20. Premissas que adotei sem perguntar

- Placa sem validar padrão de país; saída pode ter outra placa.
- Duplicidade de documento bloqueia o cadastro.
- Porteiro corrige e anula com justificativa; a gestão restaura.
- Toda saída precisa do `visitId` explícito.
- Tolerância de futuro de 2 minutos; retroativo livre até 30 minutos.
- Porteiro enxerga o histórico completo, de todos os dias.

## 21. Decisões do usuário (04/11/2026) e ponto em aberto

1. **Visitantes:** bloco novo em Cadastros › Colaboradores, separado dos colaboradores do Planejamento. Todo cadastro feito na hora por porteiro ou gestão fica ali.
2. **Empresas:** as criadas na hora ficam separadas, só na Portaria. Não entram no cadastro dos demais módulos.
3. **Reabrir:** gera uma **revisão nova do mesmo relatório diário**.
4. **Impressão:** porteiro e gestão veem tudo, inclusive o documento completo.
5. **Retroativo:** livre até 30 minutos.
6. **Criptografia do documento:** em aberto (explicação enviada ao usuário). Padrão adotado até decisão: **sem** criptografia.
7. **Telas:** entram nesta entrega, junto com o backend.
