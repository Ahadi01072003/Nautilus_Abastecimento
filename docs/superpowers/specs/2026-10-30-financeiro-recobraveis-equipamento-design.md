# Financeiro · Recobráveis por equipamento (Frente A): especificação

Data: 30/10/2026. Situação: aguardando revisão.

Os valores em reais deste documento são **fictícios**. A tarifa real e o cliente cobrado são cadastrados na tela do Financeiro e não ficam no código (o repositório é público).

## 1. Objetivo

Alguns equipamentos usados nas OS de um cliente são cobrados por diária (hoje, só a PTA e só para um cliente). O módulo deve:

- registrar o uso real do equipamento na OS (início e fim, com registro retroativo);
- calcular as diárias pela regra abaixo;
- mostrar à Gestão, de forma rápida:
  - quanto foi solicitado e programado;
  - quanto se prevê faturar pelas horas planejadas;
  - quanto já foi usado, conferido e a faturar;
- exportar esses dados para o faturamento.

**Fora desta frente:** a Frente B (solicitações de recobráveis por atividade, com 3 cotações, margem, impostos e relatório assinado) terá especificação própria.

## 2. Regra da diária

1. A diária é **por equipamento e por cliente**, não por OS.
2. O primeiro uso abre uma janela de **P horas corridas** (P = horas por diária da tarifa; hoje 8). Todo uso daquele equipamento, em qualquer OS do mesmo cliente, que caia dentro da janela entra na mesma diária. A diária é cobrada uma única vez.
3. **Uso que passa do fim da janela:** abre a diária seguinte exatamente no fim da anterior. A nova diária é aberta pela mesma OS.
4. **Uso que começa no fim da janela ou depois:** abre uma nova diária nesse início.
5. **Limite exato:** um uso que termina no instante do fim da janela fica nela; um instante depois, abre a próxima.
6. A janela **não reinicia à meia-noite**.
7. Valor da diária = valor por hora × P, pela tarifa vigente no início da diária.
8. A diária pertence à **OS que a abriu** (é ela que carrega o valor). As demais OS atendidas aparecem como "atendidas dentro da diária da OS X", sem valor.
9. A diária entra no mês de faturamento em que começa (horário de Brasília).
10. Usos de clientes sem tarifa para aquele equipamento não abrem nem contam diária.

### Exemplos (tarifa fictícia: R$ 500/h, P = 8 h, diária de R$ 4.000)

| Usos | Diárias |
|---|---|
| OS A 08:00–12:00 | 1 (08–16) |
| OS A 08:00–12:00 e 14:00–15:30 | 1 |
| OS A 08:00–12:00 e 17:00–18:00 | 2 (08–16; 17–01) |
| OS A 08:00–00:00 | 2 (08–16; 16–00) |
| OS A 08:00–00:30 | 3 |
| OS A 08:00–10:00, OS B 11:00–12:00, OS C 14:00–15:00, OS B 17:00–18:00 | 2 (08–16 da OS A, atendendo também B e C; 17–01 da OS B) |
| OS A 08:00–20:00, OS B 20:00–21:00 | 2 (08–16 e 16–00, ambas da OS A; a OS B é atendida dentro da 2ª) |

## 3. Tarifas (Financeiro › Tarifas)

- **Campos:**
  - equipamento;
  - cliente (organização solicitante);
  - valor por hora (R$);
  - horas por diária (P, de 1 a 168);
  - vigente a partir de (data);
  - cobrança ativa (sim ou não).
- **Alteração:** cria uma nova vigência. Nada é apagado: diárias já contadas mantêm a tarifa da época. Para parar de cobrar a partir de uma data, cria-se uma vigência com cobrança inativa.
- **Exclusividade:** não pode haver duas vigências com a mesma data para o mesmo equipamento e cliente.
- **Quem edita:** quem tem o acesso Financeiro e a Gestão.

## 4. Registro de uso na OS

**Onde aparece:** a seção "Uso de equipamentos recobráveis" aparece no detalhe da OS (tela da Operação) quando o cliente da OS tem tarifa ativa para algum equipamento da OS.

**Início de uso**
- O equipamento é escolhido numa lista suspensa com as TAGs dos equipamentos com tarifa da OS.
- Data e hora vêm preenchidas com o momento atual e podem ser alteradas para trás (registro retroativo).

**Fim de uso**
- O botão fica em cada uso aberto.
- Data e hora vêm preenchidas com o momento atual e podem ser alteradas para trás.

**Quem registra**
- **Operação:** enquanto a OS está programada, em andamento ou em encerramento pendente.
- **Financeiro e Gestão:** em qualquer situação da OS, inclusive concluída ou cancelada. Também corrigem início e fim (ver 5.3).

**Travas**
- O início e o fim não podem estar no futuro (tolerância de 1 min) nem ser anteriores a 2020.
- O fim tem de ser depois do início.
- **O mesmo equipamento não tem dois usos ao mesmo tempo, em nenhuma OS.**
  - Encostar é permitido: um termina às 20:00 e o outro começa às 20:00.
  - A mensagem cita a OS que já usa o equipamento.
- Se o uso fizer surgir mais de uma diária, o sistema pede confirmação mostrando a quantidade e o valor. Exemplo: "Este uso soma 16 h e gera 2 diárias (R$ 8.000). Confirmar?".

**O que a seção mostra:** os usos da OS (início, fim, duração e situação) e as diárias em que entraram, com a OS que abriu cada uma.

## 5. Esquecimentos, revisão e correção

### 5.1 Fim automático
Um uso sem fim é encerrado automaticamente no momento em que:
- a última etapa aberta da OS que tem o equipamento reservado é finalizada; ou
- a OS é cancelada.

O uso fica marcado como **fim automático**.

### 5.2 Aviso e "a conferir"
- **Aviso:** uso aberto há P horas ou mais gera aviso no Painel central e no Financeiro. Exemplo: "PTA-001 em uso há 9 h na OS 000123, sem fim registrado".
- **"A conferir":** estes usos ficam assim, e as diárias que eles tocam ficam separadas no painel e na exportação até o responsável revisar:
  - usos com fim automático;
  - usos que saem do período reservado para o equipamento na OS em mais de 30 min, antes ou depois.

### 5.3 Correção e confirmação
- O Financeiro ou a Gestão **confirma** o uso ou **corrige** o início ou o fim.
- A correção exige motivo.
- O histórico guarda o valor anterior, o novo, quem fez e quando, na auditoria. Nada é apagado.
- Depois de revisado, o uso passa a **conferido**.

## 6. Painel de recobráveis (Financeiro › Painel)

**Filtros:** período (mês atual por padrão) e cliente. **Uma linha por equipamento com tarifa**, com estas colunas:

| Coluna | Definição |
|---|---|
| Solicitações | OS lançadas do cliente com reserva do equipamento no período. Não entram as canceladas sem uso. |
| Programadas | Entre essas, as que ainda não começaram. |
| Horas planejadas | Soma das reservas do equipamento nessas OS, recortada ao período. |
| Diárias previstas | Regra da seção 2 aplicada aos períodos reservados, juntando todas as OS do cliente. |
| Receita prevista | Diárias previstas × valor da diária. |
| Média por OS | Receita prevista ÷ solicitações. |
| Diárias realizadas | Regra da seção 2 aplicada aos usos registrados. |
| Receita conferida / a conferir | Diárias realizadas separadas pela situação dos usos que as compõem. |

Ao clicar num equipamento, o painel mostra as diárias (início, fim, OS que abriu, OS atendidas, valor e situação) e os usos a conferir, com os botões de confirmar e corrigir.

## 7. Exportação

Dois conjuntos novos na Exportação, no grupo Financeiro:

- **Recobráveis: diárias.** Colunas:
  - equipamento e cliente;
  - início e fim da diária;
  - OS que abriu e OS atendidas;
  - horas por diária e valor por hora;
  - valor da diária;
  - situação (conferida ou a conferir).
- **Recobráveis: usos.** Colunas:
  - OS e equipamento;
  - início, fim e duração;
  - origem do fim (registrado, fim automático da etapa ou cancelamento);
  - situação;
  - quem registrou e quem conferiu.

## 8. Acesso

- Novo acesso adicional **Financeiro**, que a Gestão sempre tem.
- Novo item de menu **Financeiro**, com:
  - Painel de recobráveis;
  - Tarifas;
  - Solicitação de recobráveis, na Frente B.
- A Operação registra uso na OS sem precisar do acesso Financeiro.

## 9. Dados

- **Tarifas** (`recovery_rates`): equipamento, cliente, valor por hora em centavos, horas por diária, vigente a partir de, ativa, autor e data.
- **Usos** (`equipment_uses`):
  - OS, equipamento e cliente (copiado da OS);
  - início e fim (fim vazio = em uso);
  - origem do fim: registrado, etapa ou cancelamento;
  - situação: normal, a conferir ou conferido;
  - autores;
  - chave de operação, para que um clique repetido não duplique o registro.
- **Diárias:** são **calculadas** a partir dos usos e das tarifas (função pura em `lib/`, a mesma para OS, painel e exportação). Não são gravadas, para nunca ficarem desatualizadas.
- **Regras no banco:**
  - fim depois do início;
  - sem sobreposição de usos do mesmo equipamento;
  - uso não apagado;
  - alteração de início ou fim só por quem tem o acesso Financeiro ou é da Gestão, sempre com auditoria.

## 10. Integração com o que existe

- **Operação** (`lib/operation.ts`): ao finalizar etapa, aplica o fim automático (5.1).
- **Cancelamento** (`lib/cancel.ts`): aplica o fim automático ao cancelar a OS.
- **Painel central** (`lib/central.ts`): aviso de uso aberto há P horas ou mais.
- **Exportação** (`lib/exports.ts`): os dois conjuntos da seção 7.
- **Permissões** (`lib/permissions.ts` e banco): acesso `financeiro`.

## 11. Testes

- **Função de diárias:** todos os exemplos da seção 2, incluindo:
  - limite exato;
  - virada de meia-noite;
  - uso em aberto;
  - troca de tarifa no meio;
  - cliente sem tarifa.
- **Registro:**
  - permissões por situação da OS;
  - sobreposição;
  - datas no futuro;
  - confirmação de mais de uma diária;
  - clique repetido.
- **Fim automático:** ao finalizar a última etapa com o equipamento e ao cancelar a OS. Etapa intermediária não encerra.
- **Revisão:** "a conferir", correção com motivo e auditoria.
- **Painel:** previsão pelas reservas e realizado pelos usos.
- **Exportação:** colunas e valores.
