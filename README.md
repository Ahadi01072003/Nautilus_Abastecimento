# NAUTILUS · Gestão operacional

Sistema web da Base Açu. Módulos (menu lateral expansível):

- **Painel central** (tela inicial de todos): resumo de cada módulo e **avisos** de todo o sistema, com gravidade (crítico, atenção, informativo), filtro por módulo e lista rolável. São avisos de: OS com início vencido, OS fora do planejado, bloqueios abertos, encerramento pendente, equipamentos bloqueados, preventivas pendentes ou atrasadas, corretivas em aberto, leituras desatualizadas, combustível no mínimo, reposições pendentes ou vencidas e solicitações aguardando agendamento. Tudo é clicável e leva ao item. A agenda mostra os próximos 7 dias. O conteúdo segue o acesso de cada pessoa.

- **Abastecimento**: solicitação, agendamento e registro de abastecimentos, controle de **estoque**, **reposições** por estoque mínimo e avisos por e-mail.
- **Planejamento**: cadastro de fluxos versionados; planejamento de atividade em rascunho (salvamento automático, reservas exclusivas de equipamentos), revisão e lançamento da OS; rascunhos; lista de OS.
  - **OS sem fluxo**: título da atividade, marcos **Início** e **Fim** presos às datas macro da OS e recursos livres (tipo de equipamento, função ou **material** com quantidade e unidade de medida), com **cadastro na hora** do recurso que não existir.
  - **Revisão de OS lançada** (programada ou em andamento): nova versão do planejamento com o **mesmo número**, preparada em rascunho enquanto a OS segue valendo; ao lançar, com motivo, troca planejamento e reservas de uma vez. Etapas concluídas/dispensadas não mudam, etapas iniciadas mantêm o início previsto e não saem da OS, etapas não iniciadas retiradas viram dispensa registrada. Histórico de versões no detalhe da OS, no relatório e na planilha.
- **Operação**:
  - **Painel de OS**: indicadores do turno, cada OS em andamento com a **régua** (compacta; abre as etapas ao passar o mouse) e o **cronômetro do tempo efetivo**, pausa e retomada rápidas, próximas programadas, OS por solicitante (30 dias) e horas efetivas por atividade (7 dias).
  - **Apontamentos** (substitui “Ordens de serviço”): lista Em andamento / Programadas / Concluídas / Todas com busca, e a execução da OS escolhida: régua por etapa, painel lateral com o cronômetro e as ações da etapa (iniciar, pausar, retomar, bloquear, finalizar, apontar), ocorrências, impactos, bloqueios, checklists com NC crítica, histórico, **relatório PDF** e **planilha Excel** da OS.
  - Tempo efetivo da OS = união dos períodos de trabalho das etapas (etapas em paralelo não contam em dobro). Detalhes da execução em [docs/REVISAO-PROMPT-v2.1.md](docs/REVISAO-PROMPT-v2.1.md).
- **Manutenção** (acesso "Manutenção"; Planejamento e Operação consultam o painel; Operação registra leituras):
  - **Critérios de manutenção**: por equipamento, um ou mais planos com itens, pontos de atenção, principais inconformidades, **método** (tempo corrido em dias, horímetro ou odômetro), intervalo, **abrangência**, **marco zero** (data ou leitura inicial) e contagem do ciclo (fixa ou pela última execução). O sistema calcula os marcos.
  - **Painel de preventivas**: cartões clicáveis (equipamentos, em dia, pendentes, atrasados, horas de manutenção), filtros por tipo, TAG e situação e uma **linha do tempo por equipamento/critério**. Os marcadores são verde (em dia), amarelo (passou do marco) ou vermelho (passou da abrangência). A caixa no fim mostra quanto falta, o marco total e a data prevista pelo ritmo de uso. Clicar no marcador abre as especificações e o registro da preventiva: início, responsável e equipe, itens executados, inconformidades, apontamentos, fim e leitura. As horas e as homem-hora são calculadas.
  - **Corretivas**: registro com equipamento, pontos manutenidos, falha, observações, início e fim (ou em andamento), com cartões e filtros (corretivas, em andamento, horas, tempo médio de reparo, equipamento com mais corretivas). O equipamento pode ficar **parado** (bloqueia reservas até o fim), e a corretiva pode fazer a **liberação técnica** de bloqueios abertos.
  - **Leituras**: horímetro e odômetro. As leituras de horímetro dos abastecimentos entram sozinhas. Uma leitura nunca volta, e o horímetro não avança mais do que o tempo corrido.
- **Cadastros gerais**: solicitantes e clientes, locais, tipos e equipamentos, colaboradores e funções (com usuários e senhas), checklists versionados e categorias de ocorrências, impactos e bloqueios.
- **Exportação**, fora dos módulos: Excel (.xlsx, uma aba por conjunto) ou CSV (.zip quando há vários conjuntos), com prévia das contagens. Conjuntos de Operação (OS, etapas, períodos, apontamentos, checklists) para quem consulta OS, no seu escopo de organizações; conjuntos de Abastecimento só para o gestor.

Identidade visual **Sonar**: moldura abissal com batimetria animada (respeita “reduzir movimento”), papel claro, sinal lima, ciano “ao vivo”; Archivo (títulos), Instrument Sans (texto) e JetBrains Mono (números), servidas pelo próprio site.

> *Precisão. Profundidade. Clareza.*

**Versão 8** — migração da v7 (ChatGPT Sites + Cloudflare D1) para uma hospedagem própria e pública, com **login por usuário e senha**.

| Item | Onde |
| --- | --- |
| Site | https://nautilus-abastecimentos.vercel.app |
| Hospedagem | Vercel (projeto `nautilus-abastecimentos`, região `gru1` – São Paulo) |
| Banco | Supabase Postgres 17 (projeto `nautilus-abastecimentos`, região `sa-east-1`), schema `nautilus` |
| Código | Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · `postgres` (driver) |

## Acesso: usuário, senha padrão e senha definitiva

1. O **gestor** cria o usuário em *Cadastros gerais › Colaboradores e funções › Usuários e acessos* (nome, usuário `nome.sobrenome`, perfil e e-mail opcional para avisos).
2. A pessoa abre o site e entra com o **usuário** e a **senha padrão de primeiro acesso** (exibida ao gestor no próprio módulo; definida na variável `DEFAULT_PASSWORD`). O gestor também pode informar uma senha provisória específica.
3. No primeiro acesso o sistema **exige** a criação da **senha definitiva** (mín. 8 caracteres, letras e números, diferente da senha padrão e sem conter o usuário). Nada mais é liberado antes disso.
4. A senha provisória **expira em 7 dias**. Depois disso o gestor redefine.

Gestão pelo gestor: criar/editar usuário, mudar perfil, desativar (encerra as sessões na hora), **redefinir senha** (volta a ser provisória e derruba as sessões) e **desbloquear** usuário. Cada pessoa troca a própria senha pelo ícone de chave no rodapé do menu.

Proteções: senhas com PBKDF2-SHA256 (310 mil iterações, sal individual); sessão em cookie `HttpOnly`/`Secure`/`SameSite=Lax`, guardada no banco só como hash; expira após 12 h sem uso e no máximo 7 dias; bloqueio de 15 min após 5 senhas erradas; limite de tentativas por endereço; mensagens que não revelam se o usuário existe; trilha de auditoria sem conteúdo de senha.

## Perfis

| Perfil | Pode |
| --- | --- |
| Solicitante | Solicitar abastecimento e acompanhar/cancelar os próprios pedidos (enquanto não agendados) |
| Planejador | Agendar, reagendar e cancelar solicitações |
| Abastecedor | Ver a agenda compartilhada, registrar o consumo de agendamentos e ver os próprios registros |
| Gestor | Tudo: estoque, reposições, cadastros, usuários e senhas, parâmetros, auditoria e exportação |

Além do perfil, o gestor pode dar **acessos adicionais** acumuláveis:
- *Cadastros gerais*: não inclui usuários e senhas, que continuam exclusivos do gestor.
- *Planejamento*.
- *Operação*: executa as etapas das OS.
- *Acompanhamento de OS*.
- *Manutenção*: módulo de manutenção (critérios, preventivas, corretivas, leituras) e liberação técnica.

Clientes usam o perfil *Sem acesso ao abastecimento* com *Organizações visíveis* marcadas: eles veem só as OS da sua organização.

Permissões são verificadas no servidor **e** no banco (triggers), não apenas na tela.

## Fluxo

Solicitar → Agendar → Registrar em *Abastecimentos* (debita o estoque) → ao atingir o mínimo, abre uma reposição → recebimento (parcial ou total) repõe o estoque. Cancelar um abastecimento estorna o estoque e devolve a solicitação para novo agendamento.

## Desenvolvimento local

Requisitos: Node 22+, Postgres 15+.

```sh
npm ci
export DATABASE_URL=postgres://usuario:senha@localhost:5432/nautilus
npm run db:migrate                                   # aplica db/migrations/*.sql
npm run db:create-admin -- gestor "Nome do Gestor" "SenhaProvisoria1"
DEFAULT_PASSWORD='SenhaPadrao@2026' npm run dev      # http://localhost:3000
```

Verificações:

```sh
npm run typecheck && npm run lint && npm run build
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm test   # cria bancos descartáveis
```

## Publicação

A conta da Vercel ainda **não está conectada ao GitHub**, então os deploys atuais usam um “inicializador”: a Vercel recebe só um `package.json` e um `vercel.json` cujo `installCommand` baixa este repositório (público) em um **commit fixo** e roda `npm ci` + `next build`. Para publicar uma nova versão nesse modo, gere um deploy com o novo SHA do commit.

Recomendado (deploy automático a cada push): na Vercel, *Project › Settings › Git › Connect Git Repository*, autorize o GitHub e escolha `Ahadi01072003/Nautilus_Abastecimento`; defina como branch de produção o branch que for usado (ex.: `main`). As variáveis de ambiente já estão no projeto.

Mudanças de banco: aplique os arquivos novos de `db/migrations/` com `npm run db:migrate` usando a `DATABASE_URL` de produção (o usuário `nautilus_app` já usa o schema `nautilus`).

## Variáveis de ambiente

Veja `.env.example`. Em produção ficam na Vercel (as sensíveis como *Sensitive*).

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | Pooler do Supabase (porta 6543) com o usuário restrito `nautilus_app` |
| `DEFAULT_PASSWORD` | Senha padrão de primeiro acesso (obrigatória em produção) |
| `APP_URL` | Endereço público usado nos links dos e-mails |
| `CRON_SECRET` | Protege a rotina diária `/api/cron/notifications` |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_ENABLED` | Avisos por e-mail (Resend). Pausados até configurar |

## Banco de dados

* `db/migrations/0001_schema.sql` – tabelas; `0002_integrity.sql` – regras (estoque nunca negativo, capacidade, autoria por perfil, agenda, estorno, último gestor); `0003_function_search_path.sql` – endurecimento.
* `0009_exportacao.sql` – a auditoria aceita o registro de exportações (`Exportação: …`) de quem consulta OS; o acesso é conferido pelo servidor.
* `0010_revisao_os.sql` – revisão de OS: número da revisão e motivo no planejamento, uma revisão em rascunho por OS, reserva “transportada” da versão vigente (não disputa com a própria OS nem reavalia a agenda), etapa da OS sempre ligada a um planejamento da própria OS e checklist previsto que deixa de valer sem ser apagado.
* `0011_os_sem_fluxo_materiais.sql` – OS sem fluxo (tipo de sistema, título), materiais e necessidades com quantidade e unidade.
* `0012_manutencao.sql` – critérios, leituras (com trava no banco), visão única de leituras (digitadas e de abastecimentos), registros de preventiva e corretiva imutáveis depois de concluídos (anulação só pelo gestor, com motivo), apontamentos e parada do equipamento.
* Em produção as tabelas ficam no schema `nautilus`, pertencente ao usuário `nautilus_app` (sem superpoderes), com RLS ativo e sem acesso para os papéis públicos da API do Supabase.
* `scripts/import-v7.py` converte o SQLite exportado da v7. **O SQL gerado contém dados pessoais e nunca deve ser versionado.**

## Limitações conhecidas

* Plano gratuito do Supabase pausa o projeto após 7 dias sem acesso; a rotina diária da Vercel consulta o banco e evita isso, mas o plano pago remove o risco.
* Os e-mails dependem de configurar `RESEND_API_KEY` e `EMAIL_FROM` na Vercel e `EMAIL_ENABLED=true`. A rotina diária reprocessa avisos pendentes; as ações do sistema também disparam o envio.
* Não há recuperação de senha por e-mail: quem esquecer pede ao gestor para redefinir.
* Busca e filtros do histórico de abastecimentos valem para a página carregada (100 registros); a exportação cobre o período inteiro (até 10.000 linhas por conjunto).
* O relatório da OS é gerado pelo navegador (Imprimir › Salvar como PDF). Cada abertura do relatório, cada planilha e cada exportação ficam na auditoria (`Exportação: …`).
