# Kit de desenvolvimento do Claude Code

O que está nesta pasta, como usar e como levar para um projeto novo.

## Levar para um projeto novo

Copie estes itens da raiz deste repositório para a raiz do projeto novo e faça commit:

- `.claude/settings.json`: marketplaces e plugins
- `.claude/skills/`: skills `visual-original` e `avoid-ai-design`
- `.mcp.json`: servidor n8n-mcp

Na primeira sessão do projeto novo, o Claude Code instala os plugins sozinho. Outra opção é pedir: "configura este repositório com o kit do Nautilus".

## Fluxo recomendado para um site ou sistema novo

1. **Ideia e requisitos**: "vamos fazer um brainstorm de X" (superpowers:brainstorming). Para pôr o plano à prova: "grill me sobre este plano".
2. **Contexto do projeto**: `/conductor:setup` cria `conductor/` com produto, stack e fluxo de trabalho. Cada funcionalidade nova entra com `/conductor:new-track` e é implementada com `/conductor:implement`.
3. **Identidade visual**: a skill `visual-original` entra sozinha em pedidos de tela. Ela cria o `DESIGN.md` com paleta, fontes e um elemento exclusivo do projeto. Para explorar direções, peça "me mostra 3 direções visuais bem diferentes" (usa ui-ux-pro-max, taste-skill e frontend-design).
4. **Back-end**: `/backend-development:feature-development` ou `/full-stack-orchestration:full-stack-feature`. Para modelar o banco, peça "desenha o schema Postgres" (skill postgresql-table-design).
5. **Fluxos e processos**: peça "desenha o fluxo do processo X em Mermaid" (renderiza em SVG com `npx -p @mermaid-js/mermaid-cli mmdc`), "monta um workflow n8n para X" (n8n-mcp) ou `/c4-architecture:c4-architecture` para a arquitetura.
6. **Polimento visual**: `/impeccable critique`, `/impeccable audit`, `/impeccable polish`; "audita esta página com avoid-ai-design".
7. **Teste no navegador**: "abre o site e tira print no desktop e no celular" (Playwright ou Chrome DevTools). Também: "roda o Lighthouse".
8. **Revisão e entrega**: `/pr-review-toolkit:review-pr`, `/code-review`, `/security-review` e, no fim, `/commit-commands:commit-push-pr`.

## Comandos úteis

| Para quê | Comando ou pedido |
| --- | --- |
| Funcionalidade guiada do começo ao fim | `/feature-dev:feature-dev` |
| Criar componente de UI | `/ui-design:create-component` |
| Montar design system (tokens) | `/ui-design:design-system-setup` |
| Revisar uma tela | `/ui-design:design-review` |
| Acessibilidade | `/accessibility-compliance:accessibility-audit` |
| Protótipo descartável | "faz um protótipo rápido de X" (mattpocock-skills:prototype) |
| Playground interativo em HTML | "faz um playground de X" |
| Criar regra para impedir um erro repetido | `/hookify:hookify` |
| Atualizar o CLAUDE.md com o que foi aprendido | `/claude-md-management:revise-claude-md` |
| Sugestões de automação para o repositório | "recomenda automações do Claude Code para este projeto" |

## Observações

- **n8n**: sem conexão com um servidor n8n, o n8n-mcp funciona só como documentação e validador de nós. Para criar workflows direto no seu n8n, adicione `N8N_API_URL` e `N8N_API_KEY` em `env` no `.mcp.json`. Use variáveis do ambiente, nunca a chave escrita no arquivo.
- **context7** (documentação atualizada de bibliotecas): precisa que `mcp.context7.com` esteja liberado no acesso de rede do ambiente de nuvem.
- **Muitos plugins pesam**: para desligar um no projeto, troque `true` por `false` em `enabledPlugins` no `.claude/settings.json`.
