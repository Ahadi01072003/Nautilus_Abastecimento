# Manutenção, OS sem fluxo e Painel central

Registro do pedido de 21/10/2026, das decisões tomadas e do que foi entregue.

## 1. Pedido (resumo)

1. **Módulo de manutenção**:
   - Critérios de manutenção por equipamento: planos, pontos de atenção, principais inconformidades e o método (tempo corrido, horímetro ou odômetro), com um marco inicial a partir do qual o sistema calcula o ciclo.
   - Painel de preventivas:
     - linha do tempo interativa por equipamento;
     - marcadores verde, amarelo e vermelho;
     - caixa com quanto falta para o próximo marco;
     - filtros por tipo, TAG e situação;
     - cinco cartões;
     - registro da preventiva pelo marcador (início, responsável, fim, apontamentos e horas dedicadas).
   - Corretivas: registro com pontos manutenidos, observações, data e hora, com filtros e cartões.
2. **OS sem fluxo** no planejamento:
   - título, descrição e etapas Início e Fim presas às datas macro;
   - recursos (equipamento, função ou material) com quantidade e unidade, cadastrados na hora se não existirem.
3. **Painel central**: informações de cada módulo e um campo de avisos (OS abertas e fora do planejado, manutenção em aberto e em atraso, combustível no mínimo, pedidos de compra pendentes e outros), interativo e rolável.
4. Avaliar viabilidade e brechas, corrigir, aprimorar e propor módulos.

## 2. Decisões

| Tema | Decisão | Por quê |
| --- | --- | --- |
| Marco zero | A 1ª preventiva vence **um intervalo depois** do marco zero. A tela mostra a prévia dos próximos marcos. | Corresponde a "contar a partir da data x". A prévia elimina a ambiguidade. |
| Ciclo | **Fixo** por padrão (30, 60, 90… a partir do marco zero). Opção **pela última execução**. | O pedido descreve o fixo. O outro modo é comum em manutenção e fica disponível por critério. |
| Marcos vencidos acumulados | A manutenção registrada atende o marco vencido **mais recente**. Os anteriores ficam como **perdidos**. O vermelho conta a partir do primeiro marco em aberto. | Uma manutenção regulariza o atraso, sem esconder o que não foi feito. |
| Situação | Em dia: antes do marco. Pendente (amarelo): passou do marco, dentro da abrangência. Atrasada (vermelho): passou da abrangência. Sem leitura: critério por leitura sem dado. | Mesmas regras do pedido, com um estado explícito quando não há dado. |
| Cartões | Contam **equipamentos**, valendo a pior situação entre os critérios de cada um. | O pedido fala em quantidade de equipamentos. |
| Horas | Duração (fim − início) e **homem-hora** (duração × pessoas). Período selecionável. | Somar a duração simples esconde o esforço de equipes. |
| Leituras | Novo item **Leituras**. O horímetro dos abastecimentos entra sozinho. | Sem leituras, os critérios por horímetro ou odômetro não teriam como avançar. |
| OS sem fluxo | Os marcos **Início** e **Fim** são o início e o fim de uma execução única, presa às datas macro. | Duas etapas com durações inventadas não teriam significado. Assim, Gantt, painel, relatório e planilha seguem funcionando. |
| Acesso | "Liberação técnica" passa a se chamar **Manutenção**. Planejamento e Operação consultam o painel de preventivas. Operação registra leituras. | Quem mantém o equipamento também faz a liberação técnica. |
| Painel central | Tela inicial de **todos**, com conteúdo conforme o acesso de cada um. | Um cliente com escopo não vê a OS de outro cliente, e o solicitante só vê os próprios pedidos. |

## 3. Brechas tratadas

- **Leitura forjada**:
  - a leitura nunca é menor que a anterior, nem maior que uma posterior;
  - o horímetro não avança mais do que o tempo corrido.
  - Essas regras ficam **no banco**, e as leituras dos abastecimentos também contam.
  - Correção só pelo gestor, que **anula** a leitura com motivo.
- **Registro retroativo**:
  - data no futuro é recusada;
  - registro feito mais de 24 h depois do fim é marcado **tardio**;
  - tudo fica na auditoria.
- **Mudança de critério para esconder atraso**:
  - mudar intervalo, abrangência, marco zero ou contagem exige **motivo** e fica auditado com antes e depois;
  - trocar o método de um critério que já tem registros é recusado;
  - cada registro guarda o marco que atendeu.
- **Apagar manutenção**: o banco impede. O registro concluído só pode ser **anulado** pelo gestor, com motivo, e o marco volta a ficar em aberto.
- **Equipamento parado**: a opção de equipamento parado cria um impedimento técnico, que bloqueia reservas e o início de etapas. Ele é liberado automaticamente ao concluir. A corretiva pode fazer a liberação técnica de outros bloqueios (ex.: NC crítica), com justificativa.
- **Cadastro na hora**: um nome já existente reaproveita o cadastro, sem diferenciar maiúsculas. Um cadastro inativo não é reativado por esse caminho. Tudo é auditado.
- **Correção encontrada pelos testes**:
  - os detalhes JSON dos eventos da Operação eram gravados como texto, por isso os motivos de pausa e de dispensa não apareciam no histórico;
  - a gravação foi corrigida, e os eventos antigos são lidos normalizados, sem reescrever o histórico.

## 4. Entregue

- **Painel central**:
  - gravidade e filtro por módulo;
  - avisos clicáveis que levam ao item;
  - resumo por módulo e agenda dos próximos 7 dias.
- **Manutenção › Painel de preventivas**:
  - cinco cartões clicáveis (equipamentos, em dia, pendentes, atrasados, horas de manutenção);
  - filtros e linha do tempo com marcadores (feita, próxima, pendente, atrasada, em andamento, perdida);
  - "hoje" ou a leitura atual na linha do tempo;
  - caixa com quanto falta, o marco total e a data prevista.
  - O registro da preventiva parte do marcador.
- **Manutenção › Critérios**: lista de equipamentos com as leituras atuais, critérios com prévia dos marcos, editor de listas e motivo obrigatório para mudar a regra.
- **Manutenção › Corretivas**:
  - cartões (corretivas, em andamento, horas, MTTR, equipamento com mais corretivas) e filtros por período, tipo, TAG e situação;
  - registro concluído ou em andamento, com equipamento parado e liberação técnica.
- **Manutenção › Leituras**: última leitura de cada equipamento, origem, ritmo de uso, histórico e anulação pelo gestor.
- **Planejamento**:
  - **OS sem fluxo**;
  - recursos com **material**, quantidade e unidade de medida, e **cadastro na hora**;
  - aviso ao reservar um equipamento com preventiva pendente ou atrasada.
- **Cadastros gerais › Tipos e equipamentos › Materiais**.

## 5. Próximos passos sugeridos

- Ordem de manutenção programada: transformar o próximo marco em uma OS no Planejamento, reservando o equipamento no horário da preventiva.
- Disponibilidade e MTBF por equipamento, a partir das corretivas e do tempo parado.
- Estoque de peças e materiais, com consumo registrado nas manutenções e nas OS.
- Avisos por e-mail para preventivas atrasadas (a rotina diária já existe).
