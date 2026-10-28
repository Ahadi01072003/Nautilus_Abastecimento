# Ajustes de 28/10/2026 (parte 2): agenda de recursos, exportação, Apresentação e ocupação de equipamentos

## 1. Agenda de recursos legível

- **Escala em horas:** a agenda (Lista de OS programadas › Agenda de recursos) tem três escalas:
  - Compacta: 12 px por hora;
  - Normal: 24 px por hora, a padrão;
  - Detalhada: 48 px por hora.

  Cada dia tem largura fixa, com marcas de hora. A rolagem é horizontal e os nomes dos recursos ficam fixos à esquerda.
- **Largura mínima da barra:** 140 px. Uma alocação curta ocupa ao menos essa largura e sempre mostra:
  - a OS;
  - o horário (início → fim);
  - a etapa;
  - a quantidade, para funções e materiais.
- **Período real à vista:** o trecho preenchido da barra é o período real. A parte hachurada é só a extensão mínima para leitura.
- **Sem sobreposição:** as faixas são calculadas pela extensão visível da barra, com a largura mínima, e não só pelo horário. Duas alocações curtas e próximas nunca se sobrepõem: vão para faixas separadas.
- **Agora:** uma linha vermelha marca o momento atual. Ao abrir, a agenda já rola até perto de agora.
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

## Validações

- **Testes automatizados:** `npm test` com 89 de 89 aprovados. Os testes novos cobrem:
  - faixas pela largura mínima;
  - tipos e recursos;
  - seleção na URL;
  - ocupação até o fim previsto;
  - conflito de equipamento como pendência na revisão.
- **Verificação estática:** `tsc`, `eslint` e `next build` passaram.
- **Ponta a ponta (navegador, dados fictícios):**
  - agenda nas três escalas, sem sobreposição;
  - exportação com seleção;
  - PDF com cronograma e detalhe;
  - Painel de OS › Exportar agenda › Agenda de recursos;
  - Apresentação com filtro de tipo e recurso, mantido depois de recarregar.
