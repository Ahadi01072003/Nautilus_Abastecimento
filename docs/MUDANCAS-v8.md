# NAUTILUS v8 — o que mudou e por quê

Data: 09/10/2026. Base: exportação da v7 (commit `4e4add5a`, ChatGPT Sites + Cloudflare D1).

## 1. Diagnóstico da v7

A v7 era tecnicamente sólida (regras de estoque, perfis, auditoria, fila de e-mails), mas **dependia do ChatGPT Sites**:

* O login era “Entrar com ChatGPT”: cada pessoa da empresa precisava de uma conta ChatGPT, e o e-mail dela tinha de coincidir com o cadastro. Esse era o principal bloqueio para uso real pela equipe.
* A hospedagem, o banco (D1) e as variáveis secretas ficavam presos ao projeto do Sites; o código exportado não rodava publicamente em outro lugar sem reescrever a autenticação.
* Fora do Sites, o servidor confiava em cabeçalhos `oai-authenticated-*`. Publicado em outro provedor, qualquer pessoa poderia forjá-los e se passar por um gestor.

## 2. Decisões

| Decisão | Motivo |
| --- | --- |
| Next.js 16 real (no lugar do Vinext/Workers) | O código já seguia as convenções do Next; roda nativamente na Vercel |
| Postgres no Supabase (no lugar do D1) | Banco gerenciado, gratuito para o porte atual, com transações e triggers equivalentes |
| Vercel `gru1` + Supabase `sa-east-1` | Servidor e banco em São Paulo, perto da operação |
| Login próprio (usuário + senha) | Pedido do responsável; ninguém precisa de conta externa |
| Schema `nautilus` com usuário `nautilus_app` e RLS | No Supabase o schema `public` fica exposto pela API REST; os dados ficam fora dela e só o app acessa |

## 3. Login e gestão de senhas (novo)

* Tela inicial de login (usuário e senha), responsiva para celular.
* **Primeiro acesso:** entra com a senha padrão (ou provisória), e o sistema bloqueia tudo até a definição da **senha definitiva** (com checklist de requisitos ao vivo).
* **Gestor**, em *Operadores e usuários › Usuários e senhas*: vê a senha padrão, cria usuários (sugestão automática `nome.sobrenome`), edita perfil/e-mail, desativa, **redefine senha** (opcionalmente com senha provisória própria) e **desbloqueia**. A tabela mostra situação da senha (primeiro acesso pendente, definida, expirada, bloqueado) e último acesso.
* **Todos:** “Alterar minha senha” e “Sair” no rodapé do menu.
* Segurança: PBKDF2-SHA256 (310 mil iterações), sessão `HttpOnly` armazenada como hash, expiração por inatividade (12 h) e absoluta (7 dias), bloqueio após 5 tentativas (15 min), senha provisória válida por 7 dias, troca de senha encerra as outras sessões, desativação/troca de perfil derruba a sessão na hora, proteção contra CSRF por origem.

## 4. Falhas corrigidas

1. **Identidade forjável fora do Sites** (cabeçalhos `oai-*`) — substituída por sessão própria.
2. **Erros 500** quando campos obrigatórios chegavam vazios (`fuelId`, `equipmentId`, `operatorId`, `id` no cancelamento) — agora mensagem clara (400).
3. **“Marcar em compra” apagava um recebimento parcial** (status `partial` voltava a `purchasing`) — agora só vale para reposições abertas.
4. **Feriado com data inexistente** (ex.: 30/02) derrubava a requisição — validação de data civil.
5. **Edição com ID inexistente criava cadastro novo** (equipamento, operador, combustível) — agora retorna “não encontrado”.
6. **Concorrência de estoque:** no Postgres a linha do combustível é bloqueada durante a movimentação; duas baixas simultâneas não passam do saldo. A abertura de reposição concorrente não derruba mais o abastecimento.
7. **Livro de movimentações imutável** no banco (não pode ser editado nem apagado).
8. **Visão geral presa a “diesel” e “gás”** por ID fixo — agora mostra todos os combustíveis ativos, com gráfico selecionável.
9. **Textos obsoletos** (“Acesso privado”, “conta ChatGPT”, “compartilhe o site no Sites”, “diesel 100 L / gás 2 cilindros” fixos).
10. **CSP permitia o site dentro de frames do ChatGPT** — agora `frame-ancestors 'none'`.
11. Avisos por e-mail só para quem tem e-mail cadastrado (o e-mail virou opcional).

## 5. Dados migrados

Importados da v7: 5 usuários (como `nome.sobrenome`, todos com primeiro acesso pendente), 2 combustíveis, 3 equipamentos, 6 operadores, 5 solicitações, 6 abastecimentos, 3 reposições, 12 movimentações, 38 registros de auditoria e 1 feriado. Estoques conferidos: saldo = soma das movimentações. O histórico de e-mails já enviados não foi importado (não afeta a operação e evita reenvios).

## 6. Validação executada

* `npm run typecheck`, `npm run lint` e `npm run build` sem erros.
* 20 testes automatizados contra Postgres real: login/primeiro acesso/bloqueio/expiração/sessões, perfis, fluxo completo, idempotência, estoque negativo, frações, reposição, recebimento parcial, estorno, conflitos de versão e horário, cadastros, CSV.
* Teste ponta a ponta em navegador (Chromium) com os dados reais importados, conectado como o usuário restrito do banco: login → primeiro acesso → solicitar → agendar → registrar → estoque baixou e reconciliou; sem erros no console.
* Linter de segurança do Supabase sem alertas pendentes (apenas o aviso informativo de RLS sem políticas, intencional).

## 7. Pendências

* **E-mails:** configurar `RESEND_API_KEY` e `EMAIL_FROM` na Vercel e definir `EMAIL_ENABLED=true` (a chave antiga ficou no Sites e não é exportável).
* **Domínio próprio** (opcional): adicionar na Vercel e atualizar `APP_URL`.
* O projeto antigo no ChatGPT Sites continua no ar com o banco antigo; recomenda-se desativá-lo depois que a equipe migrar, para não haver lançamentos em dois lugares.
