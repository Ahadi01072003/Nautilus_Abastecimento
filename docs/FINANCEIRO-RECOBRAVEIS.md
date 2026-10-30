# Financeiro · recobráveis por equipamento

Os valores em reais deste documento são fictícios. A tarifa real e o cliente cobrado são cadastrados na tela.

## O que faz

Alguns equipamentos usados nas OS de um cliente são cobrados por **diária**. O módulo:

- registra o uso real do equipamento na OS;
- calcula as diárias;
- mostra o previsto e o realizado;
- exporta tudo para o faturamento.

## Regra da diária

- **Escopo:** a diária é **por equipamento e por cliente**, não por OS.
- **Janela:** o primeiro uso abre uma janela de **P horas corridas**, onde P são as horas por diária da tarifa. Todo uso daquele equipamento, em qualquer OS do mesmo cliente, que caia dentro da janela entra na mesma diária, cobrada uma vez.
- **Uso que passa do fim:** abre a diária seguinte exatamente no fim da anterior.
- **Uso que começa no fim da janela ou depois:** abre uma nova diária a partir desse início.
- **Meia-noite:** a janela não reinicia.
- **Valor:** valor por hora × P, pela tarifa vigente no início da diária.
- **Faturamento:** a diária pertence à **OS que a abriu**. As demais OS atendidas aparecem sem valor.

**Exemplo** (R$ 500/h, 8 h por diária = R$ 4.000): OS A de 08:00 a 20:00 e OS B de 20:00 a 21:00 geram **2 diárias**, 08–16 e 16–00. As duas são da OS A, e a OS B é atendida dentro da 2ª.

## Passo a passo

1. **Dar o acesso Financeiro.** Em Cadastros gerais › Colaboradores e funções, marque o acesso adicional **Financeiro** para quem cuida do faturamento. A Gestão já tem.
2. **Cadastrar a tarifa.** Em Financeiro › Tarifas › Nova vigência, informe:
   - equipamento;
   - cliente;
   - valor por hora;
   - horas por diária;
   - data de início da vigência.

   Para mudar o valor, cadastre uma nova vigência; diárias já contadas mantêm o valor da época. Por isso a nova vigência só pode começar **depois do último uso já registrado** daquele equipamento para o cliente. Para parar de cobrar, cadastre uma vigência com a cobrança desligada.

   Quem tem escopo de organizações vê e cadastra tarifas só dos clientes do seu escopo.
3. **Registrar o uso na OS.** Em Operação › Apontamentos, a seção **Uso de equipamentos recobráveis** aparece nas OS do cliente com tarifa.
   - Use **Início de uso** e **Fim de uso**.
   - Para registrar um uso que já terminou, informe início e fim juntos.
   - Se o uso gerar mais de uma **diária nova**, o sistema mostra a quantidade e o valor e pede confirmação. Diária já aberta por outra OS do cliente não conta.
   - Um início em aberto no passado também é conferido: se até agora ele já soma mais de uma diária nova, o sistema pede confirmação.
   - Mudou um campo depois do aviso? O sistema faz uma nova prévia antes de gravar.
   - **Atividade realizada sem planejamento** (Operação › Registrar atividade realizada): depois dos apontamentos, o bloco **Horas de uso dos equipamentos** registra cada uso com equipamento (da lista de "Recursos usados"), início e fim; as horas são calculadas na hora. A marca **"Entra no cálculo de recobráveis"** só aparece para equipamento com tarifa para o cliente. Na conferência aparecem as horas recobráveis, as diárias novas e o valor. Ao registrar, as linhas recobráveis viram usos no Financeiro ligados à OS; as demais ficam guardadas na OS (detalhe da OS e exportação **Horas de uso realizadas**). O período ocupado na agenda vai do primeiro início ao último fim de cada equipamento.
4. **Conferir.** Ficam **a conferir**:
   - usos encerrados automaticamente (pelo fim da última etapa com o equipamento, pela dispensa dela, pela conclusão da OS ou pelo cancelamento);
   - usos que saem do período reservado por mais de 30 min.

   O Financeiro confere ou corrige com motivo, na OS ou direto no Painel de recobráveis (quem só tem o acesso Financeiro corrige pelo painel). A correção fica na auditoria.
5. **Acompanhar.** O **Painel de recobráveis** mostra, por equipamento e cliente, no período:
   - solicitações e programadas;
   - horas planejadas;
   - diárias e receita previstas pelas reservas, e a média por OS;
   - diárias realizadas, separadas em conferido e a conferir, com a OS que abriu e as OS atendidas;
   - **Previsto: de onde vem** (ao clicar na linha): cada OS do cliente que reserva o equipamento no período, com a situação, o período reservado, as horas no período, as diárias que ela abre e o valor. A soma fecha com a linha. Uma OS atendida dentro da diária de outra aparece com 0 diária e a indicação "atendida na diária da OS X";
   - **Não entram no previsto:** as OS de outros clientes com o mesmo equipamento no período, com o motivo (por exemplo, "cliente sem tarifa"). É o que explica a diferença para a Agenda de recursos, que mostra todas as OS;
   - usos a conferir: os que começam no período e os que geram diária a conferir nele (um uso esquecido em aberto desde o mês anterior aparece no mês em que gera valor).
6. **Exportar.** Em Exportação, no grupo Financeiro, estão os conjuntos **Recobráveis: previsto** (uma linha por OS, com horas, diárias, valor e se entra ou não, com o motivo), **Recobráveis: diárias** e **Recobráveis: usos**.

## Avisos

O Painel central avisa:

- **Uso aberto há uma diária inteira** (provável esquecimento): aparece para quem executa e para o Financeiro. O aviso leva à OS; para quem não abre OS, leva ao Painel de recobráveis.
- **Usos a conferir:** aparecem só para o Financeiro, contando só os clientes do seu escopo.

## Banco

A migração `0019_financeiro_recobraveis.sql` cria:

- **`recovery_rates`:** as tarifas. Não são alteradas: cada mudança é uma nova vigência.
- **`equipment_uses`:** os usos. Não são apagados, o mesmo equipamento não tem dois usos ao mesmo tempo e o fim é sempre depois do início. Início ou fim já registrado só muda pela correção de quem tem o acesso Financeiro ou é da Gestão; registrar o fim de um uso aberto é livre.

**Ordem de publicação:** aplicar a `0019` no banco de produção **antes** do merge. Finalizar etapa, dispensar, cancelar e o Painel central passam a consultar as tabelas novas.

As diárias **não são gravadas**: o motor em `lib/recoverables.ts` as calcula a partir dos usos e das tarifas.
