# Planejamento por dia, barras de HH e D+1 · especificação

Data: 11/11/2026 · Status: **desenho aprovado pelo usuário em 11/11/2026**; faltam os dados da seção 9. Base: "Plano de Gestão Inteligente de HH" (enviado pelo usuário), adaptado ao Nautilus e às respostas dele.

## 1. Ideia
O planejador, no fim de cada dia, empilha as atividades do dia seguinte (D+1), arrasta, e uma **barra de HH** por cliente vai enchendo. Ao chegar no limite ele decide: esticar até um teto definido, ou replanejar para outro dia. Reunião com as lideranças às **16:00** valida o que será feito. Na manhã do dia, o planejador **designa quem faz o quê**.

## 2. Decisões do usuário
- O planejamento passa a ter **só dia de início e dia de fim**, sem hora. A hora real fica na Operação.
- **Duas barras separadas, cada uma com a sua equipe e os seus planejadores:** **OCP** (azul-marinho) e **Equinor** (vermelha: Equinor, SIA, Technip). OS cujo solicitante não for OCP OCEANPACT vai para a barra Equinor. Quem planeja uma não planeja a outra.
- Pessoas que entram no HH: Assistentes, Especialista e **Líder**. **Fora:** Supervisor e TST.
- Jornada cheia, **sem desconto** de almoço ou pausa.
- Zonas: meta **85%**, **100%**, teto de ultrapassagem **115%** (configuráveis).
- Fechamento do D+1 todo dia às **16:00**. **Na sexta se planeja o fim de semana.**
- Existe uma visão da manhã (**Designação do dia**) para escolher quem faz cada atividade.
- Equipamento: bloqueia acima de **12 h/dia** (não estica).
- A operação **para às 20h** (não há turno noturno).
- **A equipe de cada barra e os planejadores de cada barra são configurados pela Gestão no próprio sistema** (sem planilha). Os planejadores planejam **a qualquer momento**: não há regra fixa de quem fecha a segunda-feira. **Equipe da barra OCP:** Phillip (Artífice), Yan (Assistente de Eletromecânica), Italo (Técnico em Elétrica) e Jefferson (Analista de PCM), todos **ADM da OCP de segunda a sexta (sem sábado)**. **Jefferson não entra no HH** (planeja). Capacidade OCP: 3 pessoas × 9 h = **27 HH por dia útil** (9 HH por função), **0 no fim de semana**. **Equipe da barra Equinor:** todos os demais (os 25 da planilha). **Planejadores:** OCP: Thiago Almeida e Jefferson; Equinor: Jorge, Ivo, Wilhan e Kíssila. **No cadastro do usuário com perfil Planejador, a Gestão escolhe a barra que ele planeja: OCP, Equinor ou as duas.**
- Feriados ficam fora do escopo. **Wilhan** é Líder de Operações no cadastro (sem "função atuante").

## 3. Calendário e capacidade
- ADM: segunda a sexta 08–17 (9 h) e **todo sábado 08–12 (4 h)**.
- Turno: 12 h (08–20), **2x2**. Turno A trabalha em 11/11 e 12/11, folga 13 e 14; o B trabalha 13 e 14; e assim em ciclo de 4 dias (âncora: A em 11/11/2026).
- Capacidade por **dia e por função**, por barra = soma das pessoas marcadas para aquela barra e presentes no dia, × jornada. Faltas, férias e folgas reduzem a capacidade. Feriados e exceções por data.
- Checagem simples: pessoas exigidas por função ≤ pessoas presentes naquele dia.
- Sem faixas horárias (decorrência de não haver hora no planejamento).

## 4. Demanda e reserva
- **HH da atividade** = pessoas × horas por dia × dias, por função. As "funções necessárias" da etapa (hoje só função × quantidade) ganham **horas por dia**. Reparte igual pelos dias (todos os 7), editável por dia; opção de pular o domingo por atividade.
- **Equipamento:** a atividade declara **horas de uso por dia**; a soma por equipamento e dia não passa de 12 h. A ordem dentro do dia é do líder, na execução.
- **Material:** reserva por dia contra o saldo da Ferramentaria (fase D).
- Intertravamento de equipamento mantém as regras atuais: rascunho não segura, passado o fim previsto libera, impedimento técnico bloqueia, atividade realizada não bloqueia.

## 5. Zonas, pilha e linha de corte
- Por barra e por função: até a meta (sólido), até 100% (sólido com borda), **esticado** 100–115% (listrado, borda âmbar, exige registrar quem validou), acima do teto (**bloqueado**, cadeado).
- Cores: azul-marinho e vermelho **identificam a barra**; o estado usa preenchimento, listras, borda e ícone, nunca vermelho ou azul.
- A pilha do dia é ordenada por prioridade; a **linha de corte** cai onde estoura. O que fica abaixo vai para o próximo dia com 1 clique e **prévia da cadeia** (pode estourar o dia seguinte). Dependências e reservas de equipamento acompanham.
- Atividade só entra no limite se **todas as funções** couberem; a barra principal mostra também cada função.

## 6. Ciclo diário
1. **08h, chamada:** o líder confirma presença; a capacidade do dia recalcula e avisa se estourou.
2. **Manhã, Designação do dia:** planejador vê as atividades de hoje, a cobertura por função e designa as pessoas (sem choque, só quem está presente na barra).
3. **Durante o dia:** fila de solicitações → arrastar para um dia; urgência mostra quem perde o lugar.
4. **16:00, Fechar D+1:** cada cartão fica Confirmado, Ajustar ou Adiar; registram-se as lideranças presentes; conferência automática (equipamento, material, função, dependência, impedimento). **Publicar** gera a versão, congela e alimenta a TV, o celular do líder e a lista de separação. Depois do corte, mudança = nova versão com justificativa. Passa de 16:00 sem publicar: aviso à Gestão (não trava).
5. **Fim do dia:** cada cartão fica Concluído, Parcial (HH que restou) ou Não feito (motivo); a rolagem é automática com **contador de adiamentos** (alerta no 2º, sobe a prioridade).
6. **Sexta:** fecha sábado e domingo. Os planejadores podem planejar a segunda e qualquer outro dia a qualquer momento (cada um só na sua barra).

## 7. Impacto no que existe
- `plans` e `plan_steps`: `planned_start/end` passam a **datas**. OS já lançadas: a parte da data é mantida; a hora antiga fica só como histórico.
- `reservations` de equipamento (hoje `start_at/end_at`): passa a **horas por dia**; as regras das migrações 0017/0018/0023 são reescritas por dia.
- Gantt, Agenda (PDF), Agenda de recursos, Lista de OS e Apresentação (TV): viram **por dia**.
- `plan_step_people` (pessoas por etapa) vira **por dia** na Designação.
- Operação continua apontando a hora **real**; o Financeiro e os apontamentos não mudam. Para o HH executado falta registrar **pessoas × horas** na etapa (decidir na fase final).
- Cadastros: `operators` ganham equipe (ADM/Turno A/Turno B), **barra** (OCP/Equinor), função atuante e escala; planejador ganha **escopo de barra**.

## 8. Fases
- **P0:** planejamento por dia (a maior mudança, base de tudo).
- **P1:** calendário, equipes, escala 2x2, **telas de configuração da barra de cada colaborador e dos planejadores de cada barra**, capacidade (somente leitura) e zonas.
- **P2:** tela D+1: pilha, arrastar, zonas, linha de corte, prévia de rolagem.
- **P3:** reunião, publicar, versões, congelamento, TV e lista de separação.
- **P4:** Designação do dia e chamada.
- **P5:** fechamento do dia, rolagem, indicadores (ocupação, rolagem, aderência, motivos).

## 9. Dados que faltam (bloqueiam a P1)
Nenhum bloqueio de dados: a Gestão configura no sistema a **barra de cada colaborador** (OCP ou Equinor) e os **planejadores de cada barra**. Falta só: como registrar falta e férias (o líder na chamada ou a Gestão).

## 10. Limites
Não substitui ponto ou folha; não decide jornada nem direito trabalhista; não move atividade publicada sem confirmação; esticar acima do teto não é possível; se o HH por atividade ou a marcação por barra estiverem errados, as barras mentem.
