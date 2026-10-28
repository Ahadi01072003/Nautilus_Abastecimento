# Ajustes de 28/10/2026 (parte 2): agenda de recursos, exportação, Apresentação e ocupação de equipamentos

## 1. Agenda de recursos legível

- **Navegação igual à do Gantt de atividades** (atualizado):
  - a roda do mouse aproxima ou afasta mantendo a data sob o cursor, e pode ser desligada;
  - arrastar o fundo move o período;
  - setas e + − funcionam no teclado;
  - botões Ano, Mês e Dia, aproximar e afastar, Hoje e Ajustar ao período;
  - o período visível aparece em data e hora.
- **O período fica onde você deixou:** fica guardado na sessão e continua igual ao trocar de tela ou quando a lista se atualiza. Só o botão Hoje leva até hoje.

  Antes, a agenda voltava sozinha para hoje a cada atualização da lista, inclusive a cada minuto.
- **Recurso sem alocação no período visível:** aparece um atalho "◂ data" ou "data ▸" que leva até a alocação anterior ou seguinte.
- **Barra que começa antes do período visível:** é recortada na borda, com o texto à vista.
- **Exportar PDF:** o período sugerido é o período visível na tela, a não ser que os filtros de data da lista estejam preenchidos.
- **Largura mínima da barra:** 140 px. Uma alocação curta ocupa ao menos essa largura e sempre mostra:
  - a OS;
  - o horário (início → fim);
  - a etapa;
  - a quantidade, para funções e materiais.
- **Período real à vista:** o trecho preenchido da barra é o período real. A parte hachurada é só a extensão mínima para leitura.
- **Sem sobreposição:** as faixas são calculadas pela extensão visível da barra, com a largura mínima, e não só pelo horário. Duas alocações curtas e próximas nunca se sobrepõem: vão para faixas separadas.
- **Agora:** uma linha vermelha marca o momento atual, atrás das barras.
- **Regra única:** a mesma regra serve à tela e ao PDF (`lib/resource-agenda.ts`).

## 2. Exportar a agenda de recursos em PDF

- **Na agenda de recursos:** botão **Exportar PDF**. O diálogo pede o período (datas) e traz a mesma seleção da tela, que pode ser ajustada:
  - tipos separados ou juntos;
  - recursos específicos.
- **No Painel de OS › Exportar agenda:** nova visualização **Agenda de recursos**, ao lado de Gantt e Lista, com o mesmo seletor de tipos e recursos.
- **Página `/agenda/recursos` (A4 paisagem):**
  - resumo: recursos, alocações, horas de equipamento, recurso mais alocado e período;
  - o cronograma, com uma linha por recurso, as datas no eixo e a mesma largura mínima e faixas da tela;
  - o **detalhe de cada alocação** em tabela: recurso, OS e atividade, etapa, período, duração e quantidade.

  Um recurso com muitas faixas continua na folha seguinte.
- **Filtros:** valem os filtros da Lista de OS (tipo, local, situação, número, código, solicitante e setor). OS canceladas ficam de fora.
- **Segurança:** o servidor confere o acesso e o escopo de organizações. A exportação fica registrada na auditoria e conta no limite de exportações.
- **Esc no diálogo:** com a lista de recursos aberta, Esc fecha só a lista, não o diálogo.

## 3. Filtros de recurso na Apresentação

- **Tela 2 (Recursos alocados):**
  - tipos (Equipamentos, Materiais, Colaboradores), separados ou juntos;
  - seletor de recursos específicos.
- **Onde ficam guardados:** no endereço da Apresentação (a TV volta igual depois de recarregar) e no navegador.
- **Limpar:** o botão "Limpar filtros de recursos" volta a mostrar tudo.

## 4. Equipamento: ocupação e bloqueio

### Equipamento de etapa em andamento

**Antes:** uma etapa em execução, pausada ou bloqueada travava o equipamento para **qualquer data futura**. Exemplo: a reserva do PTA-001 de 16 a 20/11 era recusada por causa da OS 000040, prevista para terminar em 03/11.

**Agora:** o equipamento fica ocupado até o **fim previsto da etapa**. Se a etapa já passou do previsto, fica ocupado até agora, enquanto não for finalizada. Valem as mesmas regras:

- na consulta de disponibilidade;
- na gravação do rascunho;
- no banco (migração `0017_ocupacao_ate_fim_previsto.sql`, que atualiza `nautilus_reservation_guard`).

A mensagem diz até quando o equipamento está ocupado, por exemplo: "ocupado até 03/11/2026 12h00, fim previsto da etapa".

Iniciar uma etapa continua impedido enquanto o equipamento estiver em uso em outra etapa não finalizada (regra da execução, sem mudança).

### O equipamento bloqueia a criação da OS

O equipamento já bloqueava a criação da OS, e continua bloqueando. Função, colaborador e material só avisam.

- **Na gravação:** equipamento reservado no período ou com impedimento técnico é recusado.
- **No banco:** a reserva é revalidada no lançamento.
- **Novo, na revisão antes de lançar:** uma reserva do rascunho que passou a conflitar depois de gravada vira **pendência** e impede o lançamento. Exemplo: uma etapa de outra OS entrou em execução e ocupa o equipamento até o fim previsto. Antes, o problema só aparecia ao clicar em Lançar.

## 5. Setores inativos sem OS fora dos filtros

- **Regra:** setor inativo sem nenhuma OS com o seu código não aparece mais em nenhum filtro:
  - Lista de OS e Gantt;
  - Agenda de recursos;
  - Painel de OS, no filtro e no "Exportar agenda";
  - Apresentação.
- **O que continua aparecendo:** setores ativos e setores inativos que ainda têm OS com o seu código.
- **Onde fica a regra:** uma consulta só, `filterSectors` em `lib/board.ts`.
- **Formulário do planejamento:** continua oferecendo só setores ativos, mais o já escolhido.

## Validações

- **Testes automatizados:** `npm test` com 89 de 89 aprovados. Os testes novos cobrem setores inativos fora dos filtros, além de:
  - faixas pela largura mínima;
  - tipos e recursos;
  - seleção na URL;
  - ocupação até o fim previsto;
  - conflito de equipamento como pendência na revisão.
- **Verificação estática:** `tsc`, `eslint` e `next build` passaram.
- **Ponta a ponta (navegador, dados fictícios):**
  - agenda: arrastar, roda, Mês e Ajustar ao período;
  - o período continua o mesmo depois de 65 s e ao sair e voltar da tela;
  - nada se sobrepõe e as colunas ficam alinhadas;
  - exportação com seleção;
  - PDF com cronograma e detalhe;
  - Painel de OS › Exportar agenda › Agenda de recursos;
  - Apresentação com filtro de tipo e recurso, mantido depois de recarregar.

## 6. Detalhes da OS sem abrir revisão

- **Consultar não cria versão:** clicar numa OS na Lista de OS ou numa barra do Gantt abre os **detalhes completos só para leitura**. É o mesmo formulário do planejamento, travado, com:
  - dados da atividade e datas;
  - etapas e local;
  - equipamentos com as horas de uso;
  - colaboradores, funções e materiais.

  Nada é gravado.
- **Ações nos detalhes:**
  - **Voltar à lista** (filtros e organização mantidos);
  - **Abrir em Apontamentos**;
  - **Cancelar OS**, pedindo a justificativa;
  - **Editar OS (nova versão)**: só este botão abre a revisão.
- **Histórico de versões:** fica na própria tela. Clicar numa versão anterior mostra como ela era, também só leitura.
- **Tela só leitura:** sem os atalhos de cadastro e de edição.

## 7. Revisão sem alterações

- **Antes:** a revisão sem nenhuma mudança era recusada.
- **Agora:**
  - a conferência avisa "Nenhuma alteração em relação à versão vigente";
  - o botão vira **Relançar sem alterações**;
  - o motivo continua obrigatório;
  - o histórico mostra a revisão com o selo **Sem alterações**.

## 8. Horas de uso do equipamento respeitadas em todas as fases (migração `0018`)

| Como o equipamento foi alocado | Fica reservado |
| --- | --- |
| Com horas de uso definidas (OS sem fluxo) | Só nesse período, mesmo com a OS em andamento. Depois, livre para outras OS. |
| OS inteira / etapa inteira (o padrão) | A etapa toda. Se a etapa passar do previsto, segue ocupado até ser finalizada. |

- **Onde vale:**
  - na disponibilidade;
  - na gravação do rascunho;
  - no banco (`nautilus_reservation_guard`);
  - no início da etapa na Operação.
- **Corrige a regra da 0017**, que segurava o equipamento até o fim previsto da etapa mesmo com horas de uso menores. Era o caso da PTA-001 na OS 000040: reservada de 26/10 09:00 a 30/10 08:00, mas travando 31/10 a 02/11.
- **OS inteira que passou do previsto:**
  - a disponibilidade mostra o equipamento ocupado no período que inclui o momento atual;
  - o futuro fica aceito, com aviso na revisão antes de lançar;
  - a etapa da OS seguinte só começa quando a anterior for finalizada.

## 9. Brechas corrigidas na varredura

- **Início de etapa fora do horário reservado:**
  - se outra OS tem o equipamento reservado para agora, iniciar antes ou depois do próprio horário fica barrado;
  - o aviso mostra os dois horários.
- **Horas de uso que começam depois:** um equipamento que a OS sem fluxo só usa mais tarde não impede o início da OS. Antes, impedia se o equipamento estivesse em uso em outra OS naquele momento.
- **Inativar equipamento:** recusado enquanto houver reservas a partir de agora (OS ou rascunhos) ou abastecimento solicitado ou agendado. A mensagem diz quais OS precisam de substituição ou cancelamento.
- **Avisos novos na revisão antes de lançar:**
  - início previsto no passado;
  - equipamento numa etapa de outra OS que passou do previsto.

## Validações (parte 3)

- **Testes automatizados:** `npm test` com 98 de 98 aprovados. O novo `tests/rules.test.ts` cobre:
  - horas de uso com a OS em andamento (caso da PTA);
  - OS inteira atrasada (disponibilidade, aviso, bloqueio no início e liberação ao finalizar);
  - início antecipado com equipamento reservado por outra OS;
  - horas de uso futuras que não barram o início;
  - revisão sem alterações (motivo, histórico, reservas);
  - revisão estendendo horas de uso sobre outra OS;
  - versões anteriores e acesso de consulta (Acompanhamento não revisa nem grava);
  - inativação de equipamento com reservas ou abastecimento;
  - aviso de início no passado.
- **Ponta a ponta (navegador, dados fictícios):**
  - clique na Lista e no Gantt abre os detalhes;
  - Voltar à lista;
  - Editar OS abre a revisão;
  - relançar sem alterações, com o motivo;
  - histórico com "Sem alterações";
  - menus e telas principais sem regressão.
