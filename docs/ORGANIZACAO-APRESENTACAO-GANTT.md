# Organização das OS, Apresentação em duas telas, barras do Gantt e uso de equipamento (27/10/2026)

## 1. Rascunho com ano errado (ex.: 0026) travava a tela

**Causa.** O ano 0026 era gravado no rascunho. Ao reabrir, a conversão para o campo de data gerava `26-10-28`, que não é uma data válida, e a tela inteira caía. Digitar um ano de 5 dígitos derrubava a tela da mesma forma.

**Agora:**

- **Conversão das datas:** nunca lança erro e sempre usa ano com 4 dígitos. Vale no Planejamento, na Manutenção e nos Apontamentos.
- **Campo com data inválida ou fora da faixa:** fica com borda vermelha e mostra a mensagem (ex.: "Ano 26 fora da faixa aceita (2000 a 2100)"). O salvamento automático aguarda a correção, e nada inválido chega ao servidor.
- **Servidor:** recusa anos fora de 2000 a 2100, como segunda barreira.
- **Erro inesperado numa tela:** mostra "Esta tela encontrou um erro inesperado", com os botões *Tentar de novo* e *Voltar*. O menu e a sessão continuam, e não é preciso recarregar a página.
- **Produção:** nenhum dado com ano fora da faixa (conferido em 27/10).

## 2. Organização compartilhada: Lista, Gantt e Apresentação

**Uma regra só, em `lib/os-order.ts`.** A Lista, o Gantt e a Apresentação recebem os mesmos grupos e as mesmas linhas. No Gantt, a organização muda só a ordem vertical; a posição das barras segue as datas.

**Configuração:** a escolha fica guardada no navegador e vale nas três telas: modo, sentido, solicitante, setor e Lista/Gantt.

| Modo | Grupos | Ordem |
| --- | --- | --- |
| **Ordem de execução** | Uma sequência; no fim, "Sem início planejado". | Início planejado (data e hora), crescente ou decrescente. Empate: término planejado e número da OS. |
| **Por setor** | Um grupo por setor, com a quantidade de OS; "Sem setor" no fim. | Setores de A→Z ou Z→A; dentro de cada setor, cronológica nos dois sentidos. |
| **Por status** | Em andamento → Encerramento pendente → Em atraso → Previstas → Outras situações → Concluídas → Canceladas. | Fixa; o sentido não se aplica. |

**Ordem dentro de cada grupo no modo por status:**

- **Em andamento** (e **Encerramento pendente**): início real mais antigo primeiro.
- **Em atraso:** início planejado vencido há mais tempo primeiro.
- **Previstas, Concluídas e Canceladas:** início planejado crescente.
- **Sem data:** sempre no fim, em qualquer modo e sentido. Nenhuma data é inventada.

**Atraso:**

- Usa a regra que já existia: programada com o início planejado vencido.
- OS **em andamento** com o término planejado vencido fica no grupo "Em andamento", com o sinalizador "Prazo vencido". Não aparece também em "Em atraso".

**Outras situações:**

- **Encerramento pendente:** tem grupo próprio.
- **Situação sem regra:** vai para "Outras situações". Nenhuma OS some.
- **Concluídas:** aparecem quando já fazem parte da lista. A situação "Sem canceladas" mostra as concluídas; "Todas, inclusive canceladas" mostra também as canceladas.

**Filtros de solicitante e setor:**

- Aceitam vários valores: OU dentro do mesmo filtro e E entre os dois filtros. Sem seleção, valem todos.
- Os filtros ativos aparecem como etiquetas que podem ser removidas, e há o botão "Limpar filtros".
- Sem resultado, a tela explica o motivo e mantém os controles à vista.

**Datas inconsistentes** recebem o sinalizador "Datas inconsistentes", com o motivo, e nada é corrigido:

- término planejado igual ou anterior ao início;
- término real sem início real;
- término real antes do início real;
- início real no futuro.

**Atalho:** o botão **Apresentação** na Lista de OS abre a TV com a mesma organização e os mesmos filtros (pela URL).

## 3. Apresentação (TV): duas telas e apresentação automática

**Telas:**

1. **Ordens de Serviço**, em lista ou Gantt.
2. **Recursos alocados** das OS exibidas.

**Controles.** Ficam fixos acima da área que rola:

- tela;
- Lista/Gantt;
- período;
- organização, sentido, solicitante e setor;
- Iniciar / Pausar / Continuar / Encerrar apresentação;
- Ritmo (velocidade da rolagem, pausa de leitura e tempo de permanência quando a tela cabe inteira);
- tela cheia;
- voltar.

**Modo manual (início).** A tela abre em modo manual: rola pelo mouse, pela barra, pelo teclado ou pelo toque.

**Apresentação automática.** Repete o ciclo: OS → rolagem até o fim → pausa de leitura → Recursos → rolagem até o fim → pausa de leitura → volta às OS.

- Cada tela começa no topo.
- Uma tela que cabe inteira fica parada pelo tempo configurado, sem rolagem artificial.
- A troca de tela é um esmaecimento curto.

**Pausas e interrupções:**

- **Pausar:** mantém a tela e a posição. **Continuar** retoma do mesmo ponto.
- **Encerrar:** devolve o controle manual.
- **Rolar manualmente durante a apresentação** (roda, toque, barra ou teclas): pausa a apresentação.
- **Mudar filtro, organização, Lista/Gantt ou período:** pausa a apresentação e volta ao topo da tela atual.
- **Garantias técnicas:**
  - Um único laço de animação roda por vez.
  - Ao sair da tela, os temporizadores e a consulta pendente param.

**Tela 2 · Recursos alocados:**

- **Equipamentos:** cada equipamento com tipo e descrição, a quantidade de alocações e cada alocação (OS, setor, período e etapa). No total, cada equipamento conta uma vez ("3 distintos · 11 alocações").
- **Materiais:** total por material e unidade (unidades diferentes nunca se somam), com a quantidade de cada OS e o setor.
- **Colaboradores:** nome, funções e cada alocação (OS, setor, etapa e período), com distintos × alocações.
- **Categoria vazia:** a tela informa que não há recursos daquele tipo; nenhum dado é estimado.

## 4. Gantt: planejado à frente, executado atrás

**Barras de cada OS e de cada etapa:**

- **Planejado:** barra da frente.
- **Executado:** barra de trás, com a mesma altura e 10 px abaixo. Começa no início real e termina no término real ou no "agora", para OS em execução, mostrada listrada. O "agora" nunca é apresentado como término.

**Leitura dos desvios:**

- A barra de trás usa as próprias datas, na mesma escala. Começar antes ou terminar depois do planejado aparece como a barra de trás saindo para a esquerda ou para a direita.
- Sem início real, não há barra de trás.
- Datas inconsistentes não viram barra e são sinalizadas.
- O tamanho da barra é sempre tempo; não há percentual de avanço desenhado.

**Informações ao passar o mouse:**

- planejado e real, com as durações;
- desvio de início ("2h10 depois do planejado");
- desvio de término, ou "Término planejado vencido há …" para OS em execução.

**Estrutura:**

- O Gantt mostra todas as OS da lista, na mesma ordem. As que estão fora do período visível têm um marcador **◂ dd/mm** ou **dd/mm ▸**, que leva até elas.
- "Ajustar ao período" considera o planejado e o executado (antecipações, prolongamentos e OS em curso).
- Os cabeçalhos de grupo têm a mesma altura nas duas colunas, e as linhas ficam alinhadas.

## 5. OS sem fluxo: período de uso de cada equipamento

**Como funciona:**

- Em *Recursos*, cada equipamento escolhido ganha uma linha **Período de uso**, com o início do uso e as horas de uso. O fim é calculado.
- Sem período informado, a reserva cobre a OS inteira, como antes.
- O período fica sempre dentro do início e fim da OS.

**Consequências:**

- A agenda do equipamento é consultada só para esse período (Livre / Conflito / Bloqueado), e o restante da OS fica livre para outras OS.
- Equipamento reservado em parte da OS pode ser escolhido; basta ajustar o período de uso para um horário livre.
- O período passa para a reserva confirmada no lançamento e aparece na revisão e na Apresentação.

**Correção junto (disponibilidade).** O banco já tratava como ocupado, até o término real, o equipamento de uma etapa em execução, pausada ou bloqueada. Já a consulta de disponibilidade mostrava "Livre" depois do fim reservado, e a gravação falhava com "Outro planejamento reservou…". Agora a consulta segue a mesma regra e mostra "em uso na etapa … ainda não finalizada".

## 6. Validações

**Testes automatizados.** O `npm test` tem agora 85 testes (eram 77), e a última execução completa terminou com 85 aprovados. O teste do cancelamento com etapa em andamento falhou uma vez numa execução isolada e passou nas três repetições seguintes; já havia oscilado antes, independente desta mudança. Os testes novos são:

- **Organização (`tests/os-order.test.ts`):**
  - os dois sentidos;
  - empates;
  - "sem data" no fim;
  - setores A→Z e Z→A;
  - hierarquia por status sem duplicar OS em andamento atrasada;
  - filtros OU/E;
  - datas inconsistentes;
  - ida e volta pela URL.
- **Período de uso (`tests/free.test.ts`):**
  - reserva parcial;
  - outra OS no mesmo dia;
  - sobreposição recusada;
  - período fora da OS recusado;
  - lançamento mantendo o período;
  - ano 0026 recusado.
- **Disponibilidade (`tests/setores.test.ts`):** etapa em execução continua ocupando o equipamento.

**Testes de ponta a ponta (navegador, dados fictícios):**

- **Lista × Gantt:** mesma ordem em ordem de execução (↑ e ↓), por setor (A→Z e Z→A), por status, com canceladas e com filtros de solicitante e setor.
- **Apresentação, ciclo automático completo:** OS (topo → rolando → pausa de leitura) → Recursos (topo → rolando → pausa) → volta às OS.
- **Apresentação, interrupções:**
  - a roda do mouse durante a apresentação pausa e preserva a posição;
  - Continuar retoma;
  - mudança de filtro pausa e volta ao topo;
  - Encerrar devolve o modo manual.
- **Apresentação, filtro sem resultado:** a tela mostra o aviso, e a apresentação permanece e troca de tela.
- **Rascunho com ano 0026:**
  - abre sem travar e mostra o aviso no campo;
  - corrigido, salva;
  - ano de 5 dígitos não derruba a tela.
- **Período de uso:** 10:00 + 2,5 h grava a reserva de 10:00 às 12:30.

`tsc`, `eslint` e `next build` passaram.

## 7. Limitações reais

- **Volume:** a Lista de OS traz até 1.000 OS por consulta e avisa quando passa disso. A Apresentação traz até 400 OS por período (de 1 a 14 dias, recuando até 30 dias para OS em andamento).
- **Filtros passados à Apresentação:** são só os desta etapa (solicitante e setor). Período, tipo, local e situação da Lista não são levados; a Apresentação usa o próprio período.
- **Informações ao passar o mouse:** usam o recurso nativo do navegador. Numa TV sem mouse, os desvios aparecem pela posição das barras.
- **Avanço físico:** não existe campo de avanço físico cadastrado, então só a duração é representada.
- **Período de uso por equipamento:** vale para OS sem fluxo, incluindo atividade realizada. Nas OS com fluxo, o equipamento segue o horário da etapa.
