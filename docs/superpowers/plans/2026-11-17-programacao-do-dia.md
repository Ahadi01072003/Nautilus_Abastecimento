# Programação do dia Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reformular o planejamento em "Programação do dia": OS com duração estimada, barras de HH (limite, calculado do cadastro e da escala por janelas) e de duração, reunião com consolidação e relatório, OS emergencial, recursos do dia e indicadores com Excel.

**Architecture:** Reaproveita o planejamento por dia (P0) e o D+1 do teste. `lib/capacity.ts` passa a calcular o HH do dia a partir dos colaboradores (barra + escala) e da configuração de jornadas da barra, por janelas. `lib/d1.ts` monta o dia, consolida (retrato imutável das duas barras) e marca emergenciais; `lib/day-indicators.ts` calcula os indicadores. A tela `app/d1.tsx` vira "Programação do dia" com abas Dia e Indicadores.

**Tech Stack:** Next.js 16, React 19, TypeScript, postgres.js (`db().first/all/run/tx`), node:test, `lib/files.ts` (`xlsx`).

**Spec:** `docs/superpowers/specs/2026-11-17-programacao-do-dia-design.md`

## Global Constraints

- Equinor: ADM seg–sex 08–17 (almoço 1 h), sáb 08–12; Turno 2x2 08–20 (almoço 1 h) todo dia; Turno A em 19/11/2026 (B em 17 e 18/11). OCP: ADM seg–sex 08–17 (almoço 1 h); sáb/dom sem expediente.
- Almoço: 12:00–13:00, descontado na janela que o contém, só para quem está presente e com almoço no seu horário.
- Valores esperados (7 ADM, 7 A, 7 B; OCP 5 ADM): Equinor 133 (112 + 21) seg–sex, 105 (56 + 49) sábado, 77 domingo; OCP 40 seg–sex, 0 fim de semana.
- HH da OS no dia = duração estimada × total de pessoas das funções; duração de 0,25 a 24 h, de quarto em quarto.
- Passar do limite só avisa. Rascunho aparece, mas não entra na consolidação.
- Supervisor e TST: escala "fora do HH".
- Migrações 0030, 0034, 0035 reescritas (nunca foram para produção); produção só após validação do usuário.
- Textos em português; nada de nomes de modelo em commits.

## Review Focus

- Dia sem nenhum colaborador com escala (cadastro vazio): HH 0, aviso "sem equipe cadastrada", sem quebrar.
- OS de vários dias com "Não trabalha aos domingos": não consome no domingo.
- OS movida para um dia já consolidado (adiar): vira emergencial naquele dia.
- Ajuste manual de HH do dia: substitui o calculado e "voltar ao padrão" restaura.
- OS lançada antiga sem duração: HH 0 e aviso "sem duração", sem erro.

---

### Task 1: Banco + HH do dia por janelas (`lib/capacity.ts`)

**Files:** Modify `db/migrations/0030_planejamento_barras_equipes.sql`, `lib/capacity.ts`, `lib/registry.ts` (colaborador: `bar`, `schedule`); Test `tests/efetivo.test.ts` (reescrito).

**Interfaces — Produces:**
- `operators.bar text NULL REFERENCES plan_bars`, `operators.schedule text NULL CHECK IN ('adm','turno_a','turno_b')` (NULL = fora do HH).
- `plan_bars.schedule jsonb` = `{adm:{weekday,saturday,sunday},turno:{weekday,saturday,sunday},anchor:'2026-11-19'}`, cada dia `{start:'HH:MM',end:'HH:MM',lunch:boolean}|null`.
- `plan_day_staff(bar, day, hh numeric, note, updated_*)` — ajuste do dia.
- `staffFor(bar, days): {day, windows:{label:string,hh:number,groups:string[]}[], computedHh, hh, source:'padrao'|'dia', note, byName, people:{adm,turno}, turnoOfDay:'turno_a'|'turno_b'|null, maxShiftHours:number}[]`.
- `capacityMutate('planning/bars/save', {id, schedule})` (só Gestão); `registryMutate('registry/operators', {..., bar, schedule})`.

- [ ] Teste: com 7 ADM/7 A/7 B Equinor e 5 ADM OCP, `staffFor('equinor',['2026-11-17'])` → janelas `[{label:'08–17',hh:112},{label:'17–20',hh:21}]`, hh 133, turnoOfDay `turno_b`; sábado 2026-11-21 → 56 + 49 = 105; domingo 2026-11-22 → 77; OCP seg 40, sáb 0; supervisor (schedule NULL) não conta; Gestão salva jornada, planejador recebe 403.
- [ ] Rodar e ver falhar; implementar; rodar e passar; commit.

### Task 2: Duração estimada na OS

**Files:** Modify `db/migrations/0034_planejamento_d1.sql` (`plans.estimated_hours numeric(5,2) CHECK 0.25–24`; remove `plan_step_needs.hours_per_day`), `lib/planning.ts` (salvar/validar `estimatedHours`, reserva de equipamento usa `hours_per_day = estimated_hours ?? 12`), `lib/revision.ts` (copiar), `app/planning.tsx` (campo + remove h/dia de função e de equipamento); Test `tests/d1.test.ts`.

- [ ] Teste: salvar com `estimatedHours: 2.5` grava; `0.3` → 400 "/duração/"; revisão copia; reserva de equipamento herda as horas.
- [ ] Falhar → implementar → passar → commit.

### Task 3: Dia, consolidação e emergencial (`lib/d1.ts`)

**Files:** Modify `db/migrations/0035_planejamento_publicacao.sql` (`plan_day_consolidations(id, day, version, snapshot jsonb, participants text[], notes, consolidated_*)`, UNIQUE(day,version), imutável), `lib/d1.ts`, `lib/central.ts`; Test `tests/d1.test.ts`, `tests/d1-publish.test.ts`.

**Interfaces — Produces:**
- `GET planning/d1?bar&day` → `{bar, day, staff (de staffFor), demandHh, durationTotal, over, extraHh, longest:{title,hours}|null, cards:[{planId,workOrderId,label,title,status,hours,people,hh,byFunction,equipment,materials,cumulative,exceeds,emergency,noDuration}], resources:{functions,equipment:[{tag,activities,hours,over,impeded}],materials}, consolidation:{version,at,by,changed}|null}`.
- `POST planning/d1/staff {bar,day,hh|'',note}`, `planning/d1/order`, `planning/d1/postpone` (mantidos), `POST planning/d1/consolidate {day, participants:string[], notes}` → `{version}`.
- `GET planning/d1/consolidated?day[&version]` → `{day, version, snapshot:{bars:{equinor,ocp}}, participants, notes, versions}`.
- `d1Late(nowMs)` → dia seguinte não consolidado depois das 16h, com OS.

- [ ] Testes: HH da OS = horas × pessoas; ordem e `exceeds`; `extraHh`; duração total e `longest` > 11 h; consolidar grava v1 com as duas barras e participantes; OS lançada para o dia depois da v1 → `emergency:true` (também após adiar para ele) e continua emergencial na v2; rascunho fora do retrato; recursos de equipamento somam horas e marcam `over` acima de 11 h; `d1Late`.
- [ ] Falhar → implementar → passar → commit.

### Task 4: Indicadores e Excel (`lib/day-indicators.ts`)

**Files:** Create `lib/day-indicators.ts`; Modify `app/api/[...path]/route.ts`; Test `tests/day-indicators.test.ts`.

**Interfaces — Produces:** `GET planning/indicators?bar&month=YYYY-MM` → `{days:[{day, availableHh, plannedHh, doneHh, emergencyCount, emergencyHh, compliance, occupancy, precision}], month:{compliance,occupancy,precision,emergencyCount,emergencyHh}}`; `GET planning/indicators/export?bar&month` → xlsx (abas "Dias" e "OS").

- [ ] Testes: cumprimento = HH concluído ÷ HH consolidado (OS concluída no dia conta; adiada não); ocupação = programado ÷ disponível; precisão = 1 − |real − estimado| ÷ estimado com `step_intervals` ativos; mês = soma dos dias.
- [ ] Falhar → implementar → passar → commit.

### Task 5: Telas

**Files:** `app/d1.tsx`, `app/d1.css` (Programação do dia: abas Dia | Indicadores, barras com janelas e trecho Extra, barra de duração, cartões com selo Emergencial/Rascunho/Sem duração, ajuste de HH, recursos, modo reunião, diálogo Consolidar, jornadas da barra para Gestão), `app/planning.tsx` (barra ao vivo), `app/registry.tsx` (Barra + Escala), `app/navigation.tsx`, `lib/permissions.ts`, `tests/setores.test.ts`, `app/programacao/view.tsx`, `app/separacao/page.tsx`, `app/programacao/relatorio/page.tsx` (novo, PDF), remoção de `app/apresentacao`, visão Recursos e Agenda PDF da Lista de OS.

- [ ] tsc, lint, build; capturas no demo (desktop e celular); commit.

### Task 6: Banco de teste, cadastro e entrega

- [ ] Script de adaptação aplicado no `nautilus_teste` (com aprovação do usuário); escalas dos colaboradores pela planilha; Thiago Almeida (OCP, ADM); desativar um "Yan Lacerda"; Supervisor e TST fora do HH; planejadores com barras.
- [ ] Suíte completa, push para `teste`, deploy READY, manual atualizado.
