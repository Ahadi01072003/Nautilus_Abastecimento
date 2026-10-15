<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Skills instaladas neste repositório

Este repositório traz um conjunto de skills em `.claude/skills/`. Elas são
carregadas automaticamente pelo Claude Code. Use-as com liberdade e bom senso:
quando a tarefa casar com a descrição de uma skill, **invoque-a** em vez de
improvisar. Pode acioná-las por comando (`/nome-da-skill`) ou deixá-las
disparar sozinhas pela descrição. Combine skills quando fizer sentido
(ex.: `brainstorming` → `writing-plans` → `test-driven-development`).

## Fluxo de desenvolvimento (superpowers + caveman)
- `brainstorming` — antes de qualquer trabalho criativo/novo (feature, componente, planejamento).
- `writing-plans` — transformar requisitos em um plano de passos antes de tocar no código.
- `executing-plans` / `subagent-driven-development` / `dispatching-parallel-agents` — executar o plano (inline ou com subagentes paralelos).
- `test-driven-development` — escrever testes antes da implementação.
- `systematic-debugging` / `investigate-first` — investigar bugs e falhas antes de propor correção.
- `surgical-patch` — corrigir bug na camada mais estreita possível.
- `safe-refactor` — reestruturar preservando comportamento.
- `migration` — mudanças reversíveis de schema/dados/API/config.
- `lean-build` — construir com escopo estrito, evitando overbuilding.
- `requesting-code-review` / `receiving-code-review` / `caveman-review` — revisão de código.
- `verification-before-completion` / `verify-and-stop` — provar que o trabalho está pronto antes de dizer "concluído".
- `finishing-a-development-branch` — integrar o trabalho quando a branch está pronta.
- `using-git-worktrees` — isolar workspace para trabalho de feature.
- `caveman-commit` — mensagem de commit no padrão Conventional Commits.
- `caveman` / `ultracave` / `megacave` — modos de resposta compacta (economia de tokens).
- `writing-skills` — criar/editar skills.

## Segurança (strix)
Testes de segurança **autorizados** sobre este próprio projeto:
- `find-security-vulnerabilities-in-code` — revisão white-box do código.
- `application-security-testing` / `penetration-testing-with-strix` — pentest do app.
- `web-app-penetration-testing` / `api-security-testing` — pentest de web app / API.
- `owasp-top-10-testing` — avaliação contra o OWASP Top 10.
- `fix-security-vulnerabilities-with-strix` — corrigir e reprovar achados.
- `ci-security-scanning-with-strix` — scan de segurança no CI/CD.
- `managed-pentesting-with-strix` — pentest gerenciado via app.strix.ai.

> Requisitos externos: as skills `strix` precisam do CLI `strix` e/ou conta no
> app.strix.ai; `21st-ui` precisa do MCP da 21st.dev; as `caveman-*` de
> cloud/setup/optimize precisam do gateway Caveman Cloud. As demais funcionam sozinhas.

## UI
- `21st-ui` — encontrar, instalar e gerar componentes de UI (21st.dev).
