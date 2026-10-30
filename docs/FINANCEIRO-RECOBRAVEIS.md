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

   Para mudar o valor, cadastre uma nova vigência; diárias já contadas mantêm o valor da época. Para parar de cobrar, cadastre uma vigência com a cobrança desligada.
3. **Registrar o uso na OS.** Em Operação › Apontamentos, a seção **Uso de equipamentos recobráveis** aparece nas OS do cliente com tarifa.
   - Use **Início de uso** e **Fim de uso**.
   - Para registrar um uso que já terminou, informe início e fim juntos.
   - Se o uso gerar mais de uma diária, o sistema mostra a quantidade e o valor e pede confirmação.
4. **Conferir.** Ficam **a conferir**:
   - usos encerrados automaticamente (pelo fim da última etapa com o equipamento, pela dispensa dela ou pelo cancelamento da OS);
   - usos que saem do período reservado por mais de 30 min.

   O Financeiro confere ou corrige com motivo. A correção fica na auditoria.
5. **Acompanhar.** O **Painel de recobráveis** mostra, por equipamento e cliente, no período:
   - solicitações e programadas;
   - horas planejadas;
   - diárias e receita previstas pelas reservas, e a média por OS;
   - diárias realizadas, separadas em conferido e a conferir.
6. **Exportar.** Em Exportação, no grupo Financeiro, estão os conjuntos **Recobráveis: diárias** e **Recobráveis: usos**.

## Avisos

O Painel central avisa:

- **Uso aberto há uma diária inteira** (provável esquecimento): aparece para quem executa e para o Financeiro.
- **Usos a conferir:** aparecem só para o Financeiro.

## Banco

A migração `0019_financeiro_recobraveis.sql` cria:

- **`recovery_rates`:** as tarifas. Não são alteradas: cada mudança é uma nova vigência.
- **`equipment_uses`:** os usos. Não são apagados, o mesmo equipamento não tem dois usos ao mesmo tempo e o fim é sempre depois do início.

As diárias **não são gravadas**: o motor em `lib/recoverables.ts` as calcula a partir dos usos e das tarifas.
