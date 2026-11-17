# Programação do dia (reformulação do planejamento) — desenho

Data: 17/11/2026 · Substitui as seções 12 a 14 de `2026-11-11-planejamento-dmais1-design.md` (o modelo por dia do P0 continua).

## 1. Intenção

As OS da Equinor chegam por e-mail, com um dia de antecedência ou no próprio dia; as da OCP também só têm o dia. Não dá para
prever horário, só **o que** será feito em cada dia, **em que ordem** e **com quais recursos**. O planejador planeja sempre o
dia seguinte (D+1), a reunião das 16h consolida o dia e, na manhã seguinte, a liderança põe os nomes e a equipe executa na
ordem, "quando der". O limite do dia é o **HH disponível** da equipe, calculado sozinho a partir do cadastro e da escala.

Sucesso: o planejador registra uma OS em segundos, vê na hora se o dia ainda cabe, a reunião sai com lista, ordem, recursos e
relatório, e a gestão acompanha cumprimento, ocupação e precisão das estimativas por dia e no mês.

## 2. Metas, não metas e antimetas

- **Metas:** registro rápido com duração estimada; duas barras do dia por barra (HH = limite; duração = informativa); reunião
  com consolidação e relatório PDF; OS emergencial evidenciada; recursos do dia; indicadores com Excel.
- **Não metas:** horário de execução; nomes de pessoas no planejamento (só no alinhamento da manhã, fora deste escopo);
  envio automático do relatório; integração com o e-mail da Equinor.
- **Antimetas (seria fracasso mesmo funcionando):** voltar a ter telas e configurações demais; exigir estimativas que vocês não
  têm (horário, peso por pessoa); travar o planejador em vez de avisar.

## 3. Regras de negócio

### 3.1 Barras
- **Equinor:** OS de solicitantes Equinor, SIA e Technip FMC (e demais clientes). **OCP:** OS da OCP. A barra vem do campo
  *Barra de HH* do solicitante (já existe; padrão OCP/OCPT/OceanPact → OCP, demais → Equinor).
- **Planejadores:** Ivo, Wilhan, Jorge e Kissila → Equinor; Jefferson e Thiago Almeida → OCP (campo *Barras que planeja* do
  usuário; Thiago Almeida é Gestão e já planeja as duas). A Gestão planeja as duas.

### 3.2 HH disponível do dia (limite)
Calculado do cadastro de colaboradores: cada colaborador tem **barra** (OCP, Equinor ou fora) e **escala** (ADM, Turno A,
Turno B ou *fora do HH*). Supervisor e TST ficam *fora do HH*.

| Escala | Seg–sex | Sábado | Domingo |
|---|---|---|---|
| ADM Equinor | 08–17, 1 h de almoço = 8 h | 08–12 = 4 h | — |
| ADM OCP | 08–17, 1 h de almoço = 8 h | — | — |
| Turno A/B (Equinor) | 08–20, 1 h de almoço = 11 h, só no dia de escala | idem | idem |

- Escala 2x2: Turno B trabalha 17 e 18/11/2026; Turno A, 19 e 20/11; e assim por diante (âncora: **Turno A em 19/11/2026**).
- Resultado com a planilha de 17/11 (7 ADM, 7 Turno A, 7 Turno B na Equinor; 5 ADM na OCP):
  Equinor 133 HH (seg–sex), 105 (sábado), 77 (domingo); OCP 40 HH (seg–sex), 0 no fim de semana.
- As jornadas (horas por escala e dia da semana) ficam em uma configuração da barra, editável só pela Gestão.
- **Ajuste do dia:** o planejador da barra pode trocar o HH disponível de um dia específico (falta, reforço), com observação;
  "voltar ao padrão" desfaz.

### 3.3 A atividade (OS) no planejamento
- Com ou sem fluxo, a OS ganha **Duração estimada (h)** — número de 0,25 a 24, de quarto em quarto de hora — e mantém as
  **funções com a quantidade de pessoas** (sem horas por função; o campo h/dia por função sai).
- **HH da OS no dia = duração × total de pessoas.** OS de vários dias consome a duração e o HH **em cada dia** dela (e não nos
  domingos se marcada *Não trabalha aos domingos*, que continua existindo).
- **Equipamento** usa a duração da atividade (o campo *horas por dia* da reserva de equipamento sai; para cálculo e conflitos,
  vale a duração).
- Rascunho aparece nas barras (tracejado) mas só OS lançada entra na consolidação.

### 3.4 Barras do dia
- **HH:** soma do HH das OS do dia contra o HH disponível; avisa (vermelho) quando passa, não bloqueia.
- **Duração:** soma das durações do dia, informativa; avisa só se uma atividade sozinha for maior que a jornada mais longa do
  dia na barra (Equinor 11 h; OCP 8 h).
- A barra aparece **na tela Programação do dia** e **ao vivo no Planejamento de atividade** (para o dia e a barra da OS que está
  sendo preenchida, já com o HH dela somado).

### 3.5 Ordem
A lista de cada barra no dia é ordenada arrastando (prioridade da OS, já existe); a ordem vale para todos os dias da OS.

### 3.6 Reunião das 16h e consolidação
- A tela tem um **modo reunião** (tela cheia, as duas barras lado a lado, listas ordenáveis).
- **Consolidar dia** (um botão, as duas barras juntas): registra participantes (lista de nomes) e observações livres, grava um
  retrato imutável do dia (listas, ordem, HH, duração, recursos) e gera o **relatório** (PDF pelo navegador, disponível para
  baixar; sem envio automático). Consolidar de novo cria a versão seguinte; as anteriores ficam no histórico.
- Pode consolidar: Gestão e planejadores (qualquer barra).

### 3.7 OS emergencial
- Toda OS cujo dia já foi consolidado e que entra nesse dia depois da consolidação (nova, ou movida/adiada para ele) recebe a
  classificação **Emergencial** (gravada na OS para aquele dia, com selo próprio em todas as telas, TV, relatório e Excel).
- Se ainda há espaço na barra de HH, ocupa o espaço; se não, aparece no trecho **Extra** depois do limite.
- Não altera o retrato consolidado; nos indicadores, fica separada do consolidado.

### 3.8 Recursos do dia
Para cada barra: funções (em quantas atividades e de quantas pessoas cada uma precisa), equipamentos (atividades que usam, soma
das durações; alerta se passar da jornada do dia ou se o equipamento tiver impedimento técnico aberto) e materiais (total, que
gera a lista de separação existente).

### 3.9 Indicadores (dia e mês até hoje, por barra)
- **Cumprimento do plano** = HH das OS consolidadas para o dia que foram concluídas ÷ HH consolidado do dia. Uma OS de vários
  dias conta como cumprida em cada dia em que teve execução apontada, e a parcela do último dia só com a OS concluída
  (*proposta do desenho, ver §6*).
- **Ocupação da equipe** = HH programado ÷ HH disponível.
- **Precisão da estimativa** = 1 − |real − estimado| ÷ estimado, com o tempo efetivo da Operação (já calculado em
  `lib/exports.ts`), por OS concluída; mínimo 0.
- Emergenciais: quantidade e HH mostrados à parte.
- **Exportar Excel:** por dia e por barra — HH disponível, programado, concluído, emergencial, os três indicadores e a lista das OS.

## 4. Telas (enxutas)

Menu Planejamento fica com 4 telas:
1. **Cadastro de fluxo** (como está).
2. **Planejamento de atividade:** + Duração estimada e barra ao vivo; sai h/dia por função e horas do equipamento.
3. **Lista de OS:** lista e Gantt; **saem** a visão *Recursos* e a *Agenda em PDF*.
4. **Programação do dia** (substitui *D+1*): abas **Dia** (barras, lista ordenável, ajuste do HH, adiar, recursos, consolidar,
   relatório, modo reunião) e **Indicadores** (os três, dia e mês, Excel).

Fora do menu: **TV/celular** (`/programacao`) mostra o dia consolidado (com emergenciais) — **sai** a *Apresentação* antiga;
**lista de separação** (`/separacao`) continua; **relatório da reunião** em página própria para imprimir/PDF.
No cadastro do colaborador, o bloco do planejamento volta, enxuto: **Barra** e **Escala** (ADM, Turno A, Turno B, fora do HH).
Saem do teste: efetivo ADM+Turno digitado, padrão por funcionários, publicar/versões do D+1 como estavam.

## 5. Abordagens consideradas

1. **Evoluir o que está no teste (escolhida):** reaproveita planejamento por dia, barras, lista ordenável, adiar, TV e
   separação; troca o cálculo de capacidade e acrescenta consolidação, emergencial, recursos e indicadores. Mais rápido e já
   testado; exige limpar o que sobrou das versões anteriores.
2. Módulo novo e separado: rápido, mas dois lugares para registrar OS.
3. Refazer o Planejamento inteiro: longo e mexe em Operação e Financeiro.

## 6. Decisões tomadas no desenho (para conferir)
- Escala por colaborador volta ao cadastro (é o que faz o HH sair sozinho); a configuração de jornadas é da barra.
- Duração estimada é por OS (não por etapa); vale para cada dia da OS.
- Cumprimento de OS de vários dias: conta por dia com execução apontada; ver §3.9.
- Consolidação única para as duas barras; qualquer planejador ou a Gestão consolida.
- Emergencial é automático (entrou no dia depois da consolidação), não um campo que o planejador escolhe.
- Passar do limite só avisa.
- OS consolidada que for adiada ou não concluída no dia conta como **não cumprida** naquele dia; concluída em outro dia não
  conta para o dia planejado.
- Mudança numa OS já consolidada (duração, pessoas, ordem) não a torna emergencial: o dia mostra "mudou depois da
  consolidação" e pode ser consolidado de novo (nova versão).
- Dia nunca consolidado (ex.: fim de semana sem reunião): sem emergenciais e sem cumprimento; ocupação continua valendo.
- Precisão de OS de vários dias: tempo efetivo total contra a duração estimada × dias trabalhados.
- OS lançada sem duração estimada (as antigas): HH 0 e aviso "sem duração" no cartão.
- Cadastro: Thiago Almeida entra como colaborador da OCP (ADM); um dos dois "Yan Lacerda" duplicados é desativado.

## 7. Para quem constrói
- Migrações 0030/0034/0035 ainda não foram para produção: reescrever na forma final; o banco de teste é adaptado à parte; a
  produção recebe 0029 + as novas quando o usuário validar.
- Reaproveitar: `lib/d1.ts` (lista, ordem, adiar, retrato imutável), `lib/capacity.ts` (refazer o cálculo), `app/d1.tsx`,
  `app/programacao`, `app/separacao`, `effective()` de `lib/exports.ts`, exportação Excel existente.
- Remover: telas e código das abordagens anteriores que não estão no §4.
