# Ferramentaria e Inventário · especificação

Data: 11/11/2026 · Status: **aprovada pelo usuário em 11/11/2026**; implementação por fases. **Fase A entregue** (migração 0026). Substitui o módulo Portaria (removido).

## 1. Objetivo
Controlar entrada e saída de tudo que há no estoque (ferramentas e materiais), manter o inventário com quantidades e registrar empréstimos para terceirizadas, com baixa automática e termo em PDF assinado.

## 2. Decisões do usuário
- Tipos de item: **Ferramenta** (volta no empréstimo) e **Material** (consumível, só baixa). Controle **por quantidade** (sem número de série).
- Campos do item: nome, código opcional, categoria, local, **unidade de medida configurável**, quantidade, mínimo. **Sem** preço, foto, lote ou validade.
- Empréstimo **não gera OS** e não se liga a OS.
- Terceirizada: **cadastro novo** (nome e responsáveis). Sem CNPJ.
- Assinatura: **na tela do tablet e/ou em papel com o escaneado anexado** (os dois).
- Sem uso offline. Perfil novo **Almoxarife** (acesso `ferramentaria`); a Gestão tem sempre.
- PDF pela impressão do navegador ("Salvar como PDF"), com a assinatura gravada; 2ª via a qualquer momento.

## 3. Regras
1. O saldo **nunca é editado**: é a soma de um livro de movimentos que não se apaga nem se altera (triggers, como o estoque de combustível).
2. Movimento: entrada, saída, ajuste, empréstimo, devolução, perda, contagem. Sempre com motivo, autor e hora; guarda o saldo depois.
3. Não deixa sair ou emprestar mais que o saldo disponível (saldo − reservado).
4. **Emitir o empréstimo abate o inventário na hora**. O termo nasce "aguardando assinatura"; alerta se passar de 24 h sem assinatura ou anexo.
5. Ferramenta emprestada volta na devolução (ok, danificada ou perdida; perdida gera movimento de perda). Material emprestado é consumo: a devolução aceita só a sobra.
6. Empréstimo emitido não se edita: correção = cancelar (devolve tudo ao estoque, com motivo) e emitir outro. O termo emitido é imutável.
7. Idempotência em todo comando (chave por envio), como nos demais módulos.
8. Contagem de inventário: a diferença só vira ajuste com aprovação da Gestão.

## 4. Modelo (proposta)
`tool_units` · `tool_categories` · `tool_locations` · `tool_items(type ferramenta|material, name, code, category, location, unit, min_qty, active)` · `tool_balances` (derivado do livro) · `tool_movements` (livro imutável) · `tool_contractors` + `tool_contractor_people` · `tool_kits` + `tool_kit_lines` · `tool_loans(code EMP-0001, contractor, contractor_person, ocp_member, purpose, expected_return, status rascunho|emitido|parcial|encerrado|cancelado, signatures, signed_at)` · `tool_loan_lines(item, qty_out, qty_returned, qty_lost, condition)` · `tool_loan_files` (escaneado, PDF/JPG/PNG até 4 MB, como no Financeiro) · `tool_counts` + `tool_count_lines`. Fase D: `tool_reservations` (material do D+1).

## 5. Telas
- **Painel:** 4 botões grandes (Saída, Empréstimo, Receber, Devolução) + alertas (abaixo do mínimo, empréstimos atrasados, sem assinatura).
- **Inventário:** busca e filtros (tipo, categoria, local, situação); detalhe do item com saldo, histórico e empréstimos em aberto.
- **Movimentar:** item (buscar ou escanear) → quantidade → motivo → confirmar; vários itens de uma vez.
- **Empréstimos:** lista por situação; assistente em 4 passos (terceirizada e responsável → itens com disponibilidade ao vivo e kits → revisão → emitir e assinar). Devolução item a item. **Posição da terceirizada:** tudo que ela tem em mãos.
- **Contagem** (geral ou por local/categoria, opção cega) e **Cadastros** (itens, categorias, locais, unidades, terceirizadas, kits).
- **Exportação** em Excel: extrato, posição, atrasos, perdas.

## 6. Celular, tablet e computador
- Celular: lista em cartões, barra de ações fixa embaixo, botões ≥ 44 px, carrinho fixo com o total, assinatura em tela cheia.
- Tablet: lista e detalhe lado a lado.
- Computador: tabela densa, atalhos, leitor USB de código de barras (digita na busca; Enter confirma). Escanear pela câmera do celular fica para depois.
- Visual do Nautilus (menu escuro, verde-azulado).

## 7. Fases
- **A:** cadastros, saldo e movimentos, inventário, painel.
- **B:** empréstimo, assinatura em tela, PDF, anexo do escaneado, devolução, posição da terceirizada.
- **C:** contagem, alertas, Excel.
- **D:** reserva de material do D+1 e lista de separação (depende do planejamento por dia).

## 8. Limites
Sem preço, sem lote, sem foto, sem número de série, sem offline, sem geração de OS, sem integração fiscal.
