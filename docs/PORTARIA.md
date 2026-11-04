# Portaria · controle de entradas e saídas (Base Açu)

Módulo **isolado**: não se liga a OS, Planejamento, Operação nem Financeiro. Especificação completa em
`docs/superpowers/specs/2026-11-04-portaria-design.md`.

## Quem acessa
- **Porteiro** (perfil novo) e **Gestão**. Qualquer usuário pode receber o acesso adicional *Portaria*. Cliente não vê.
- O servidor confere o acesso a cada consulta e comando; revogar corta a próxima chamada, com a sessão aberta.

## Telas
- **Registro do dia**: entrada (busca por nome, empresa ou documento completo), saída, quem está na base agora, movimentos do dia, fechamento e reabertura do relatório. Mostra relatórios de dias anteriores ainda abertos e movimentos feitos depois do fechamento.
- **Relatórios e revisões**: histórico, revisões emitidas, reabertura, impressão.
- **Indicadores**: entradas, saídas, pessoas únicas, presentes agora, presença em um instante, por empresa; por dia, mês ou ano.
- **Impressão** (`/portaria/relatorio`): A4 retrato, documento completo, com revisão, fuso, quem fechou e quando foi consultada. Dia aberto só sai como **PARCIAL**.
- **Cadastros › Colaboradores › Visitantes** (gestão): visitantes e empresas criados na hora, pendências de revisão. Ficam separados dos colaboradores do Planejamento e de Solicitantes e clientes.

## Regras principais
- Uma base (Base Açu). Datas operacionais no fuso da base.
- Um relatório por dia; cada fechamento gera uma **revisão imutável**: *original*, *atualizada* (movimento posterior) ou *retificada* (correção). Reabrir não apaga nada.
- Retroativo livre até 30 minutos; acima disso exige justificativa. Futuro além de 2 minutos é recusado.
- Fechar com pessoas na base exige confirmação e justificativa; fechar confere a versão e quem está na base (outra tela mudando algo recusa o fechamento).
- Nada é apagado: correções, anulações e "desfazer saída" guardam antes e depois. Corrigir dado de relatório fechado exige reabrir.
- Visita que atravessa a meia-noite conta a entrada no dia da entrada e a saída no dia da saída.
- **Documento**: texto livre, mascarado em listas, busca e auditoria; completo na impressão e no detalhe (cada consulta é auditada); nunca em URL ou log. Respostas sem cache. Sem criptografia no banco nesta versão.
- Cada comando leva `idempotencyKey`: repetir o mesmo envio devolve o mesmo resultado.

## API
`GET`/`POST /api/portaria/...` (contratos na seção 17 da especificação). Erros trazem `code` estável (`ALREADY_PRESENT`, `REPORT_CLOSED`, `VERSION_CONFLICT`, `JUSTIFICATION_REQUIRED`, ...).

## Variáveis
`PORTARIA_RETRO_MINUTES` (30) e `PORTARIA_FUTURE_SKEW_MINUTES` (2).

## Banco
Migração `0024_portaria.sql` (aditiva): perfil `porteiro`, acesso `portaria`, tabelas `portaria_*`, travas contra apagar e contra sobreposição de visitas da mesma pessoa, auditoria por ator.
