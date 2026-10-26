# Revisão geral de usabilidade, visual e falhas (26/10/2026)

Varredura das 24 telas do sistema, do Painel central à Exportação, em computador (1440 px) e celular (390 px). Os dados usados são fictícios.

Além da varredura visual:

- cada tela foi conferida por estouro de largura e erros no console;
- o código do servidor foi revisado em autenticação, permissões, escopo, entradas e limites.

Este documento lista o que foi encontrado, o que foi corrigido e o que fica como sugestão.

Legenda:

- **Gravidade**: alta (informação errada ou ação inacessível), média (atrapalha o uso), baixa (acabamento).
- **Situação**: corrigido ou sugestão.

## 1. Resumo

| Área | Achados | Corrigidos | Sugestões |
| --- | --- | --- | --- |
| Tabelas e layout geral | 7 | 7 | 2 |
| Abastecimento | 7 | 7 | 0 |
| Planejamento | 5 | 5 | 0 |
| Operação (Painel, Apontamentos, Gantt) | 11 | 11 | 0 |
| Manutenção | 3 | 3 | 1 |
| Cadastros e textos | 3 | 3 | 0 |
| Servidor (validações) | 2 | 2 | 0 |
| Segurança (revisão) | 0 falhas | — | 1 |
| **Total** | **38** | **38** | **4** |

## 2. Tabelas e layout geral

| # | Achado | Gravidade | Correção |
| --- | --- | --- | --- |
| 1 | **Colunas fora da tela.** No computador, várias tabelas passavam da largura e escondiam colunas inteiras atrás de uma rolagem lateral pouco visível. Na Lista de OS a tabela tinha 2.481 px e ocultava Período, Real, Situação e Etapas. Também eram afetadas: Rascunhos (Responsável e "Abrir"), Tipos e equipamentos (botão de editar), Corretivas (Situação cortada) e Solicitações (Ações). | Alta | Texto das células passa a quebrar linha. Datas, números, etiquetas e botões continuam numa linha só, e o espaçamento interno ficou menor. Todas as tabelas cabem em 1440 px (conferido por medição). |
| 2 | **Rolagem lateral sem aviso no celular.** Nada indicava que a tabela continuava para o lado. | Média | Sombra na borda indica que há mais colunas. |
| 3 | **Abas cortadas no celular.** "Combustíveis e parâmetros", "Materiais", "Condição técnica" e outras ficavam ilegíveis. | Média | As abas rolam para o lado. |
| 4 | **Título estourando a tela no celular.** "Abastecimentos." deixava a página 3 px mais larga que a tela. | Baixa | O título se ajusta à largura da tela. |
| 5 | **Contador do menu lateral cortado.** "Alertas e reposições" mostrava "2.." em vez de "2". | Média | O contador nunca é cortado. |
| 6 | **Vírgula nas datas.** As datas apareciam como "25/10/2026, 10:51", diferente do resto do sistema. | Baixa | Formato único "25/10/2026 10:51" em todas as telas. |
| 7 | **Nota da tabela espremida.** "Mostrando até 100 registros…" ficava numa coluna de 106 px. A classe `table-caption` colidia com uma classe utilitária de mesmo nome (`display: table-caption`). | Média | Classe renomeada (`table-note`). Nenhuma outra colisão foi encontrada na varredura das classes. |

## 3. Abastecimento

| # | Achado | Gravidade | Correção |
| --- | --- | --- | --- |
| 8 | **Selo de estoque enganoso.** Arla 32 com 88 L e mínimo de 200 L aparecia como "No mínimo". O alerta do Painel central dizia o mesmo. | Alta | "Abaixo do mínimo" quando o saldo é menor que o mínimo; "No mínimo" só quando é igual. |
| 9 | **Plural errado.** Aparecia "1 cilindros". | Baixa | "1 cilindro", "2 cilindros". Siglas como L e kg não mudam. |
| 10 | **Contagem confusa nas Solicitações.** O cabeçalho dizia "100 solicitações" enquanto o rodapé dizia "217 registros". | Média | O cabeçalho diz "100 nesta página". O total segue no rodapé. |
| 11 | **Agendamento vencido sem destaque.** Um agendamento com horário passado continuava só como "Agendada". | Média | Aviso em vermelho: "Horário vencido: registre ou reagende". |
| 12 | **Movimentações de estoque numa página só.** As 200 movimentações apareciam de uma vez (página de ~14.000 px). | Média | 30 por vez, com "Mostrar mais" e a contagem. |
| 13 | **Nota da tabela espremida** (item 7). | Média | Corrigido. |
| 14 | **Datas sem padrão** (item 6). | Baixa | Corrigido. |

## 4. Planejamento

| # | Achado | Gravidade | Correção |
| --- | --- | --- | --- |
| 15 | **Real "em curso" mostrava a hora atual.** Na Lista de OS, a coluna Real de uma OS em andamento mostrava a hora de agora como se fosse o fim real. | Alta | Mostra "início → em curso". |
| 16 | **Períodos partidos no lugar errado.** Datas e horas eram cortadas no meio. | Média | Período em duas partes ("início →" e "fim"); só quebra linha entre elas. |
| 17 | **Solicitante ocupando espaço demais.** Na tabela de OS, o nome do solicitante deixava a linha larga. | Baixa | Na tabela aparece só a sigla; o nome fica na dica (a cor continua). |
| 18 | **Texto desatualizado.** O subtítulo de Planejamento de atividade ainda falava em "documentos" (os anexos foram removidos). | Baixa | Passa a dizer "recursos e equipe". |
| 19 | **Rascunhos e Lista de OS sem caber** (item 1). | Alta | Corrigido. |

## 5. Operação

| # | Achado | Gravidade | Correção |
| --- | --- | --- | --- |
| 20 | **Cronômetro inútil nas programadas.** OS programadas mostravam um cronômetro grande "00:00:00". | Média | Mostram o início planejado (data e hora) no lugar. |
| 21 | **Horas acima de 24 difíceis de ler.** Apareciam "início em 49:02" e "73:02". | Média | Acima de 24 h: "2 d 01:02". |
| 22 | **Período sem data no fim.** O cartão de OS programada mostrava o período quebrado e sem data no fim. | Média | "26/10 07:00–17:00" no mesmo dia; data nas duas pontas quando passa de um dia. |
| 23 | **Atraso invisível na régua.** A régua de uma OS programada com início vencido não mostrava o "agora" nem o atraso. | Média | A régua vai até agora e mostra o atraso. |
| 24 | **Rótulos da régua.** As horas da escala eram cruzadas pelos traços, e o primeiro e o último rótulo vazavam da borda. | Baixa | Rótulos acima dos traços e sem rótulo colado na borda. |
| 25 | **Gráfico "OS por solicitante" com escala irregular.** A escala era 0 · 3 · 5. | Baixa | Passo regular: 0, 1, 2, 3… ou 0, 2, 4…. |
| 26 | **Nomes cortados em "Horas efetivas por atividade".** Apareciam "Movimentação de car…". | Baixa | Nome em até duas linhas, sem cortar palavra. |
| 27 | **Instrução só para mouse.** "Passe o mouse na régua" não servia no celular. | Baixa | "Passe o mouse ou toque na régua". |
| 28 | **Gantt da Lista de OS com o mesmo erro da régua.** Uma OS de vários dias aparecia como "09:00–09:00". | Alta | Data nas duas pontas quando passa de um dia. |
| 29 | **Severidade sem acento.** Aparecia "severidade media". | Baixa | "média". |
| 30 | **Painel central: "Próximos 7 dias" sem indicar atraso.** Listava OS programadas com início vencido sem dizer que estavam atrasadas. | Média | Marca "início atrasado" em vermelho. |

## 6. Manutenção

| # | Achado | Gravidade | Correção |
| --- | --- | --- | --- |
| 31 | **Rótulos sobrepostos no Painel de preventivas.** Na linha do tempo, o rótulo "hoje/leitura" e os marcos se sobrepunham ("12.278,7 h" sobre "12.340 h"; "94.260 km" sobre "95.000 km"; "hoje" sobre "07/11"). | Média | Distribuição sem sobreposição: o rótulo do "agora" fica em cima e vira para a esquerda perto da borda. Cada marco tenta embaixo e depois em cima. Se não couber, o texto fica só na dica e no leitor de tela. |
| 32 | **Linha "hoje" sobre os rótulos.** A linha atravessava os rótulos de baixo. | Baixa | A linha ficou mais curta. |
| 33 | **Listas sem marcador.** Em Critérios de manutenção, Itens do plano, Pontos de atenção e Inconformidades apareciam recuadas mas sem marcador. | Baixa | Itens numerados e marcadores. |

## 7. Cadastros e textos

| # | Achado | Gravidade | Correção |
| --- | --- | --- | --- |
| 34 | **Aviso desatualizado em Checklists.** Dizia que a liberação seria feita "pelo futuro módulo de Manutenção". | Média | Indica o caminho atual: liberação técnica em Tipos e equipamentos › Condição técnica, com justificativa. |
| 35 | **Edição de equipamento escondida** (item 1). | Alta | Corrigido. |
| 36 | **Datas sem padrão** (item 6). | Baixa | Corrigido. |

## 8. Servidor

| # | Achado | Gravidade | Correção |
| --- | --- | --- | --- |
| 37 | **Equipamento inexistente no apontamento.** Um apontamento com equipamento inexistente caía num erro genérico do banco. | Baixa | Validação com mensagem clara: "Equipamento não encontrado". |
| 38 | **Impacto com início no futuro.** O início do impacto podia ser lançado no futuro. | Baixa | O servidor recusa, como já fazia com o momento ocorrido. |

## 9. Segurança e permissões (revisados, sem falhas)

- **Sessão**:
  - cookie protegido (`httpOnly`, `sameSite=lax`, `secure` em HTTPS);
  - expira com 12 h sem uso e com no máximo 7 dias;
  - o token é guardado só como hash.
- **Senha**:
  - PBKDF2-SHA256 com 310 mil iterações;
  - comparação em tempo constante;
  - bloqueio por 15 min após 5 tentativas;
  - a senha de primeiro acesso expira em 7 dias.
- **Origem**: todo envio confere a origem, contra ataques vindos de outros sites (CSRF).
- **Limites**:
  - corpo da requisição limitado em tamanho;
  - limite por minuto em leitura, escrita, exportação e login (no login, por endereço com hash).
- **Permissões**:
  - toda consulta e comando reconfere no cadastro atual o perfil, os acessos e o escopo de organizações, então revogações valem na hora;
  - detalhes de OS, plano, cancelamento, revisão e realizada respeitam o escopo de organizações.
- **Exportação**: textos que começam com `= + - @` são neutralizados na planilha.
- **Erros**: as mensagens do banco são traduzidas, sem vazar detalhes internos.

## 10. Sugestões (não aplicadas agora)

1. **Tabelas largas no celular.** Abastecimentos, Solicitações e Equipamentos poderiam virar cartões, como a Lista de OS já faz. Hoje elas rolam para o lado, agora com indicação.
2. **Exportação de Manutenção.** Incluir preventivas, corretivas e leituras na Exportação (Excel/CSV), para o Power BI.
3. **Limite de exportação.** São 5 por minuto e valem juntos para agenda, relatório e planilha. Quem gera vários PDFs seguidos pode receber "Muitas solicitações". Se for comum, subir para 10.
4. **Formato dos campos de data.** Os campos de data seguem o idioma do navegador. Em navegador em inglês aparecem como mm/dd/aaaa, o que não é controlável pela página.

## 11. Validação

- `tsc`, `eslint`, 76 testes automatizados e `next build`, sem erros.
- **Varredura antes e depois das correções** (24 telas em 1440 px e 390 px):
  - nenhuma tela com estouro de largura no computador;
  - no celular, só as tabelas largas rolam, dentro do próprio quadro;
  - nenhum erro no console.
- **E2E**: Painel de OS, filtros, Lista e Gantt, Apontamentos, Cancelar OS, régua, planejamento com setor, cadastro de setores, atividade realizada e OS de vários dias, todos sem erros.
- **Banco**: nenhuma migração.

## 12. Segunda revisão de layout (26/10/2026)

Pedido:

- no Painel de OS, o horário das OS programadas saía do cartão;
- a régua de uma OS programada se estendia até hoje e espremia o planejado.

**Como a revisão foi feita**

- Verificador automático: em cada uma das 24 telas e em 7 larguras (390, 768, 1024, 1280, 1440, 1660 e 1920 px), procura todo elemento que:
  - sai do seu cartão ou painel;
  - é cortado por ele;
  - tem texto cortado sem reticências;
  - passa da largura da página.
- Os dados de teste receberam títulos, locais e nomes de solicitante longos, como os reais.
- Resultado: 19 ocorrências antes; **nenhuma depois**; nenhum erro no console.

| # | Achado | Correção |
| --- | --- | --- |
| 39 | **Painel de OS: horário fora do cartão.** "Início atrasado 2 d 19:42 · 23/10 13:00–16:30" não quebrava linha (o separador estava dentro de um trecho que não quebra), e a coluna do horário saía do cartão. | O separador fica fora dos trechos; a linha quebra entre eles. |
| 40 | **Régua da OS programada esticada até hoje.** Uma OS de 23/10 das 15:00 às 17:00 virava uma barra minúscula numa régua de 23/10 a 26/10. | A régua fica só no período planejado. Se o momento atual passou do fim, aparece o selo "agora 26/10 09:02 ▸" na borda direita, sem esticar a escala. A régua só vai até agora quando a OS já está em execução. |
| 41 | **Seletores de filtro com texto cortado.** "Todos os combustíveis" e "Todas as organizações" perdiam letras. | Os seletores mostram reticências quando o texto não cabe, e os filtros ganham largura pelo conteúdo. |
| 42 | **Botão para fora da tela em 1024 px.** Em Abastecimentos, o botão "Registrar abastecimento" passava 96 px da tela. | O cabeçalho da página leva as ações para a linha de baixo quando não cabem. |
| 43 | **Telas médias (768 px com menu aberto).** Os resumos de Solicitações e Alertas passavam da tela, e o fluxo "1. Solicitar → 2. Agendar → 3. Realizar" ficava espremido. | Os resumos se reorganizam em colunas que cabem, e o fluxo fica empilhado. |
| 44 | **Selo de estoque cortado em cartões estreitos.** "Abaixo do mínimo" e "Acima do mínimo" eram cortados. | O selo desce para a linha de baixo quando não cabe. |
| 45 | **Selo cortado no cabeçalho de painel.** "Uma solicitação ativa por combustível" era cortado. | O texto quebra linha. |
| 46 | **Apontamentos: etiqueta do solicitante maior que a coluna.** | A etiqueta se limita à coluna e o nome ganha reticências. |
| 47 | **Critérios em 768 px.** "Principais inconformidades" saía do quadro. | O título quebra linha. |
| 48 | **Preventivas no celular.** O rótulo do último marco ("125.000 km") saía da linha. | Perto das bordas, o rótulo desliza para dentro. |
