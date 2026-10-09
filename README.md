# NAUTILUS · Abastecimentos

Sistema web da Base Açu para **solicitação, agendamento e registro de abastecimentos**, controle de **estoque** de combustíveis, **reposições** por estoque mínimo, avisos por e-mail e exportação CSV.

> *Precisão. Profundidade. Clareza.*

**Versão 8** — migração da v7 (ChatGPT Sites + Cloudflare D1) para uma hospedagem própria e pública, com **login por usuário e senha**.

| Item | Onde |
| --- | --- |
| Site | https://nautilus-abastecimentos.vercel.app |
| Hospedagem | Vercel (projeto `nautilus-abastecimentos`, região `gru1` – São Paulo) |
| Banco | Supabase Postgres 17 (projeto `nautilus-abastecimentos`, região `sa-east-1`), schema `nautilus` |
| Código | Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · `postgres` (driver) |

## Acesso: usuário, senha padrão e senha definitiva

1. O **gestor** cria o usuário em *Operadores e usuários › Usuários e senhas* (nome, usuário `nome.sobrenome`, perfil e e-mail opcional para avisos).
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
* Em produção as tabelas ficam no schema `nautilus`, pertencente ao usuário `nautilus_app` (sem superpoderes), com RLS ativo e sem acesso para os papéis públicos da API do Supabase.
* `scripts/import-v7.py` converte o SQLite exportado da v7. **O SQL gerado contém dados pessoais e nunca deve ser versionado.**

## Limitações conhecidas

* Plano gratuito do Supabase pausa o projeto após 7 dias sem acesso; a rotina diária da Vercel consulta o banco e evita isso, mas o plano pago remove o risco.
* Os e-mails dependem de configurar `RESEND_API_KEY` e `EMAIL_FROM` na Vercel e `EMAIL_ENABLED=true`. A rotina diária reprocessa avisos pendentes; as ações do sistema também disparam o envio.
* Não há recuperação de senha por e-mail: quem esquecer pede ao gestor para redefinir.
* Busca e filtros do histórico de abastecimentos valem para a página carregada (100 registros); a exportação CSV cobre o período inteiro (até 10.000 linhas).
