# Agenda em PDF, código do setor e ajustes da Operação

Registro do pedido de 23/10/2026, das decisões validadas com o gestor e do que foi entregue.

## 1. Pedido (resumo)

1. **Operação › Painel de OS › Exportar agenda em PDF**:
   - janela com data de início e fim (sem horas) e o código do setor, escolhido da lista cadastrada;
   - sem código, entram todas as OS do período;
   - cabeçalho com o resumo para o gestor, com foco em recursos;
   - abaixo, um Gantt renovado: datas no eixo vertical e blocos de OS com o título, sem texto saindo do bloco;
   - várias folhas quando preciso, sempre com a mesma quantidade de OS por folha.
2. **Lista de OS**:
   - descrição com limite padrão de caracteres e reticências;
   - Gantt com blocos e textos maiores, rolagem vertical e a execução como sombra atrás do planejado.
3. **Painel de OS**:
   - filtros de data, situação, código do setor e solicitante;
   - legenda da régua;
   - gráfico por solicitante com cores bem distintas e o valor exato ao passar o mouse.
4. **Apontamentos**:
   - "Revisar OS" sai da Operação;
   - pausar e bloquear exigem justificativa;
   - cancelar OS só para planejador ou gestor, com justificativa.
5. **Registrar atividade realizada**:
   - apontamentos na própria tela;
   - a OS aparece no Painel de OS com a marca de realizada sem planejamento.
6. **Régua**: o início do período planejado deve ficar claro, tanto em impressão colorida quanto em preto e branco.
7. **Checkup** do sistema e correção do que ficou para trás.

## 2. Decisões (validadas)

| Tema | Decisão |
| --- | --- |
| Código do setor | O **código da OS** passa a vir de um cadastro de setores (Cadastros gerais › Solicitantes e clientes › Setores). O número da OS não muda. Vale para OS com fluxo, sem fluxo e realizada. O código não muda depois de criado. Os códigos já usados entraram no cadastro. |
| PDF | Página de impressão que já abre "Salvar como PDF", como o relatório da OS. Sem biblioteca nova. |
| Folha | A4 paisagem, com **10 OS por folha**. O pedido inicial era de 12, mas com 12 o Gantt não cabia na 1ª folha junto do resumo. |
| Cancelar OS em andamento | Permitido para planejador ou gestor, com justificativa. As etapas abertas terminam como canceladas, os períodos de trabalho ficam registrados e os equipamentos são liberados dali em diante. |
| Filtro de situação | O padrão é "Em andamento". Há também Programadas, Concluídas (inclui as realizadas), Canceladas e Todas. |
| Limite da descrição | **90 caracteres**: mediana de 87 caracteres; 80% das descrições têm até 145. O texto completo aparece na dica e no detalhe. |

## 3. Entregue

### Agenda em PDF (`/agenda`)

- **Cabeçalho**:
  - período, setor, quem emitiu e quando;
  - total de OS por situação;
  - horas planejadas no período;
  - solicitantes, com barra de participação, quantidade, percentual e horas;
  - equipamentos reservados (OS e horas de cada um);
  - materiais previstos, somados por unidade;
  - pessoas alocadas e dia mais cheio.
- **Atenção**: equipamento da agenda bloqueado ou com preventiva pendente ou atrasada.
- **Gantt por data**:
  - uma linha por dia e o horário no eixo horizontal;
  - OS no mesmo horário em faixas separadas, sem sobrepor;
  - cor do bloco = solicitante;
  - situação identificada por padrão e símbolo, legível em preto e branco;
  - OS de vários dias aparece em cada dia, com ◂ ▸;
  - o texto do bloco se adapta à altura: uma linha, título em duas linhas ou também local e recursos, sempre dentro do bloco.
- **Folhas**: as seguintes têm cabeçalho curto. Os dias que continuam de outra folha ficam marcados.
- **Registro**: a emissão fica na auditoria ("Exportação: agenda de OS").

### Painel de OS

- Filtros persistentes na sessão.
- Botão "Exportar agenda".
- Legenda da régua.
- Marca "Realizada sem planejamento" nos cartões.
- Gráfico com paleta azul, âmbar, verde e cinza tracejado, com o valor exato ao passar o mouse ou com o foco do teclado.

### Régua da OS (tela e relatório)

- **Janela planejada**: pontilhada.
- **Início previsto**: linha dupla e bandeira cheia "▶ Início prev.".
- **Fim previsto**: linha tracejada e bandeira vazada.
- **Agora**: o rótulo desce quando fica perto das bandeiras.

### Lista de OS e Gantt

- **Lista**: descrição limitada a 90 caracteres.
- **Gantt**:
  - blocos de 34 px com título e situação, com o horário;
  - título ao lado da barra quando o zoom deixa o bloco estreito;
  - rolagem vertical com o cabeçalho fixo;
  - execução real como sombra atrás da barra planejada, visível quando passa do planejado.

### Apontamentos

- "Revisar OS" removido da Operação (continua na Lista de OS para quem planeja).
- "Cancelar OS" disponível para planejador ou gestor, com justificativa.
- Pausa e bloqueio pedem "Justificativa", e o servidor exige.

### Atividade realizada

- **Apontamentos no formulário**: ocorrência, impacto e bloqueio, dentro do período real.
- **Bloqueio**: precisa de início e fim e divide o período (trabalho → parado → trabalho), descontando do tempo efetivo.
- **Registro posterior**: tudo fica marcado como tal.

## 4. Correções da varredura

1. **Cancelar OS com revisão em aberto**: as reservas do rascunho de revisão ficavam presas. Agora o rascunho é descartado e as reservas liberadas.
2. **Dispensa de etapa**: o checklist de pré-uso do equipamento usado só naquela etapa deixa de ser exigido. Antes, a OS travava em encerramento pendente.
3. **Revisão depois de nova versão de checklist**: não cria uma segunda exigência do mesmo checklist.
4. **Etapa concluída antes do horário reservado**: a reserva é liberada. Antes, o equipamento continuava preso no horário original.
5. **Disponibilidade de equipamentos**: uma consulta só, em vez de uma por equipamento.
6. **Lista de OS**: a ordenação é feita no banco antes do limite de 1.000, com aviso quando há mais.
7. **Conferência de início de etapa**: só consulta, sem travar etapa nem equipamento.
8. **Gráfico "OS por solicitante"**: conta só os últimos 30 dias até hoje, sem OS futuras.
9. **Planilha da OS**: traz o histórico completo, sem o corte de 300 eventos.

## 5. Banco

Migração `0014_setores_agenda.sql`:

- tabela `sectors`, com código imutável e semeada com os códigos em uso;
- etapa `cancelada`;
- evento `cancelamento`;
- coluna `plans.realized_notes`.

## 6. Revisão de 23/10/2026: cronograma e régua

Pedido: "a visualização do cronograma ficou confusa; mostrar a OS toda, com as datas no eixo X e as OS no eixo Y; melhorar a forma de mostrar o planejamento na régua da OS".

**Agenda (cronograma)**

- Cada linha é uma OS inteira, sem trechos por dia.
  - À esquerda: número, setor, situação, período (data e horas), título, solicitante, local e recursos.
  - À direita: uma barra contínua do início ao fim planejado.
- **Eixo X** são as datas do período:
  - fim de semana sombreado;
  - hoje destacado, com linha vermelha no momento da emissão;
  - em períodos de até 3 dias, aparecem também as horas.
- **OS fora do período**: a que começa ou termina fora dele tem a ponta tracejada (◂ ▸).
- **Folhas**: continuam com 10 OS por folha.

**Régua da OS**

- Saem a janela pontilhada, as linhas dupla e tracejada e as bandeiras.
- Cada faixa tem duas trilhas:
  - em cima, **Planejado**: barra contornada com as horas de início e fim escritas;
  - embaixo, **Executado**: trabalho, pausas, bloqueios e apontamentos.
- A comparação planejado × real é direta e funciona em cor e em preto e branco.
- **Relatório da OS**: mostra só a OS inteira, em duas linhas (Planejado e Executado). O detalhe por etapa continua na tabela de etapas.

## 7. Revisão de 26/10/2026: régua de vários dias, totais, início e fim planejados, folha da agenda

Pedido:

- tirar da régua as marcas de apontamento e mostrar só os tempos;
- corrigir a régua de OS de vários dias (tela e PDF): marcas de 6 em 6 horas e virada de dia visível;
- mostrar início **e** fim planejados (painel lateral dos Apontamentos e relatório da OS);
- fechar a moldura da agenda em folhas com poucas OS;
- deixar o setor visível em todas as OS.

**Régua da OS (tela, Painel de OS e relatório)**

- Sem marcas de ocorrência, impacto ou bloqueio na régua.
- Abaixo dela ficam os totais:
  - período executado (início → fim ou "em curso");
  - trabalho, pausa, bloqueio e impacto (períodos sobrepostos contam uma vez);
  - quantidade de apontamentos.
- **Mais de 20 h**:
  - escala fixa de 6 em 6 horas;
  - datas numa linha própria acima das horas;
  - dias alternados sombreados;
  - linha cheia escura na virada de cada dia, que também funciona em preto e branco.
- Janela curta que passa da meia-noite também ganha a data e a linha da virada.
- Barra planejada de OS que começa e termina em dias diferentes mostra a data nas duas pontas (24/10 09:00 … 26/10 09:00).
- A grade começa abaixo da escala e não corta mais os rótulos.

**Início e fim planejados**

- **Painel lateral dos Apontamentos**:
  - "Início planejado" e "Fim planejado", com data;
  - início e fim reais, quando houver;
  - a etapa selecionada mostra os mesmos dados.
- **Relatório da OS**: o planejado, o real, as etapas e os impactos trazem data e hora completas no início e no fim.
- **Painel de OS**: o cartão mostra o fim com data.

**Agenda em PDF**

- Toda folha tem 10 linhas que ocupam o quadro até o rodapé. Linhas sem OS continuam a grade de datas, então a moldura fica fechada.
- O setor aparece como etiqueta em todas as OS. Sem código, aparece "sem setor".
- Barra de OS de vários dias com data no início e no fim.
- Períodos de até 7 dias mostram a marca das 12h.
