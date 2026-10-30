# Financeiro · Solicitação de recobráveis por atividade (Frente B): especificação

Data: 30/10/2026. Situação: aguardando revisão.

Os valores em reais deste documento vêm da planilha de exemplo do usuário ou são fictícios. Nomes de clientes e percentuais reais são cadastrados na tela e não ficam no código (o repositório é público).

## 1. Objetivo

Controlar as atividades recobráveis que o cliente pede e que são executadas por um fornecedor externo:

1. O Financeiro registra a solicitação: solicitante, atividade, data prevista e recursos.
2. Cota com fornecedores externos. As cotações vão sendo registradas à medida que chegam.
3. O sistema calcula a margem OCP, os impostos e o valor a faturar de cada cotação.
4. O sistema gera o relatório em PDF para o cliente escolher e assinar.
5. O responsável marca a cotação escolhida e anexa o relatório assinado.
6. A solicitação vira OS no Planejamento (com ou sem fluxo) e o valor fica disponível para faturamento.

**Depende da Frente A:** acesso Financeiro, menu Financeiro e configuração por cliente (seção 3).

## 2. Telas

- **Financeiro › Solicitação de recobráveis**, abaixo do Painel de recobráveis.
  - **Lista com estas colunas:**
    - número (REC-000001);
    - solicitante;
    - atividade;
    - data prevista;
    - situação;
    - cotações recebidas (ex.: 2 de 3);
    - fornecedor escolhido;
    - valor a faturar;
    - OS vinculada.
  - **Filtros:** situação, solicitante e período.
  - Botão **Criar nova solicitação**.
- **Solicitação (tela auxiliar):**
  - dados;
  - recursos;
  - cotações;
  - cálculo;
  - anexos;
  - histórico;
  - ações conforme a situação.
- **Financeiro › Configurações:** clientes habilitados, margem e impostos por cliente (seção 3) e cadastro de fornecedores.

## 3. Configuração por cliente

- **Cliente habilitado para recobráveis:** sim ou não. Só clientes habilitados aparecem como solicitantes.
- **Margem OCP (%) e impostos (%)**, com data de vigência:
  - uma mudança cria uma nova vigência;
  - para um cliente novo, o padrão sugerido é 15% e 11,75%;
  - cada solicitação guarda os percentuais vigentes na data em que foi criada, para que mudanças futuras não alterem solicitações existentes.
- **Tarifas de equipamentos:** são as da Frente A, já por cliente.
- **Cliente novo:** basta habilitar e cadastrar margem, impostos e, se houver, tarifas.

## 4. Solicitação

**Dados**
- **Solicitante:** organização habilitada e pessoa solicitante, do cadastro.
- **Atividade:** um tipo de atividade cadastrado (vira **OS com fluxo**) ou uma atividade livre com título e descrição (vira **OS sem fluxo**).
- **Data prevista:** de início, com fim opcional.
- **Recursos necessários:** equipamentos, funções e materiais com quantidade, no mesmo seletor da OS sem fluxo.
- **Observações.**

**Cotações**
- **Registro aos poucos:** cada cotação é salva quando chega e pode ser editada enquanto a solicitação está **Em cotação**. Os campos são:
  - fornecedor (cadastro, com "cadastrar na hora");
  - valor da proposta (R$);
  - número da proposta;
  - validade;
  - prazo de execução;
  - data de recebimento;
  - observações;
  - anexo da proposta.
- **Andamento:** a lista mostra "1 de 3", "2 de 3" e assim por diante.
- **Mínimo de 3:** para enviar ao cliente. Com menos, é preciso escrever a justificativa, que sai no relatório. Pode haver mais de 3.
- **Fornecedor repetido:** o mesmo fornecedor não aparece duas vezes na mesma solicitação.

## 5. Cálculo (para cada cotação)

| Linha | Regra |
|---|---|
| Valor cotado (P) | valor da proposta |
| Margem OCP | arredondar(P × margem%) |
| Subtotal | P + margem |
| **Valor a faturar** | arredondar(P × (1 + margem%) ÷ (1 − impostos%)) |
| Impostos | valor a faturar − subtotal |

- **Arredondamento:** sempre em centavos, com metade para cima. Os impostos absorvem a diferença de arredondamento, então a soma sempre fecha. **Regra A, escolhida pelo usuário.**
- **Exemplo da planilha** (Aços do Brasil, 15% e 11,75%):

  | Linha | Valor |
  |---|---|
  | Valor cotado | 52.770,56 |
  | Margem OCP | 7.915,58 |
  | Subtotal | 60.686,14 |
  | Impostos | 8.080,03 |
  | **Valor a faturar** | **68.766,17** |

- **Outras linhas da planilha:**
  - Aços Vital: 72.555,36 → 10.883,30 → 83.438,66 → 11.109,40 → **94.548,06**;
  - Conceito Offshore: 47.115,67 → 7.067,35 → 54.183,02 → 7.214,17 → **61.397,19**.
- **Exibição:** as cotações aparecem lado a lado, e a escolhida fica em destaque.

## 6. Situações

| Situação | Como chega | O que permite |
|---|---|---|
| Em cotação | ao criar | editar dados, recursos e cotações; enviar ao cliente (3 cotações ou justificativa) |
| Enviada ao cliente | "Enviar ao cliente": gera e guarda o relatório (versão 1, 2…) | imprimir; reabrir a cotação (com motivo, volta a "Em cotação"); autorizar |
| Autorizada | marcar a cotação escolhida + nome e cargo de quem assinou pelo cliente + data da assinatura + **anexo do relatório assinado (obrigatório)** | valores travados; planejar ou vincular OS |
| Em execução | OS vinculada | acompanhar a OS |
| Concluída | a OS foi concluída | só consulta |
| Cancelada | a qualquer momento antes de concluir, com motivo | só consulta |

- **Reabrir uma solicitação autorizada** é exclusivo do Financeiro ou da Gestão e exige justificativa. A solicitação volta a "Em cotação".
- **Auditoria:** cada mudança de situação, cada cotação e cada correção ficam registradas.

## 7. Relatório em PDF (imprimível)

- **Cabeçalho:** a logo, o número REC, a versão do relatório e a data de emissão.
- **Dados:** solicitante, atividade, data prevista, recursos e observações.
- **Cotações:** uma tabela com fornecedor, número da proposta, validade, prazo, valor cotado, margem, subtotal, impostos e valor a faturar.
  - Se a cotação já estiver escolhida, ela aparece em destaque.
  - Se ainda não, há uma coluna "Escolha do cliente" em branco, para marcar.
- **Justificativa:** quando houver menos de 3 cotações.
- **Assinaturas:** blocos **Gestão Interna** e **Gestão do Cliente**, com nome, cargo, data e assinatura.
- **Impressão:** o mesmo padrão dos PDFs atuais (página de impressão no navegador, A4).

## 8. Anexos (só no Financeiro)

- **Onde:**
  - em cada cotação, a proposta do fornecedor;
  - na autorização, o relatório assinado pelo cliente;
  - na solicitação, outros documentos com descrição.
- **Formato:** PDF, JPG ou PNG de até **4 MB** (limite de envio do servidor). O tipo é conferido pelo conteúdo do arquivo, não pelo nome.
- **Guarda:** no banco do sistema, sem serviço externo.
- **Download:** só pelo próprio sistema, com sessão e acesso Financeiro ou da Gestão.
- **Nada é apagado:** enviar outro arquivo no mesmo lugar marca o anterior como **substituído**, e ele continua no histórico.

## 9. Ligação com o Planejamento

- **Solicitação autorizada:**
  - **Planejar OS** abre o Planejamento de atividade já preenchido com solicitante, atividade (com ou sem fluxo), data e recursos, ligado à solicitação.
  - **Vincular OS existente:** escolhe uma OS do mesmo cliente que ainda não tem solicitação.
- **Lançamento:** quando a OS é lançada, a solicitação passa a **Em execução**. Quando a OS é concluída, a solicitação passa a **Concluída**. Se a OS for cancelada, a solicitação volta a **Autorizada**, sem OS.
- **Na OS e na Lista de OS:** o selo "Recobrável REC-000001", que mostra o fornecedor e o valor a faturar a quem tem acesso Financeiro.

## 10. Painel e exportação

- **Painel de recobráveis:** ganha o bloco **Atividades** (no período), com:
  - quantidade de solicitações em cotação, enviadas e autorizadas;
  - valor a faturar das autorizadas;
  - valor a faturar das concluídas.
- **Exportação:** novo conjunto **"Recobráveis: atividades"**, com as colunas:
  - REC e situação;
  - solicitante e atividade;
  - data prevista;
  - fornecedor escolhido e valor cotado;
  - margem, subtotal, impostos e valor a faturar;
  - OS;
  - data da autorização.

## 11. Acesso

- **Criar, cotar, enviar, autorizar, anexar e configurar:** acesso Financeiro e Gestão.
- **Planejar OS a partir da solicitação:** quem tem acesso ao Planejamento, na solicitação autorizada.

## 12. Dados

- **`finance_clients`:** cliente (organização), habilitado, autor e data.
- **`finance_client_rates`:** cliente, margem em centésimos de % (1500 = 15%), impostos em centésimos de % (1175 = 11,75%), vigente a partir de, autor e data. Não é alterada.
- **`suppliers`:** nome (único, sem diferenciar maiúsculas), CNPJ opcional, contato opcional e ativo.
- **`recovery_requests`:**
  - número sequencial, cliente e pessoa;
  - tipo de atividade ou título e descrição livres;
  - início e fim previstos;
  - recursos (lista com tipo, id e quantidade);
  - margem e impostos copiados;
  - situação;
  - justificativa de menos de 3 cotações;
  - cotação escolhida;
  - nome e cargo de quem assinou pelo cliente e data da assinatura;
  - OS vinculada;
  - versão;
  - autor e datas.
- **`recovery_quotes`:** solicitação, fornecedor, valor em centavos, número da proposta, validade, prazo, data de recebimento, observações e autor.
  - Os valores calculados **não** são gravados; saem de uma função pura em `lib/`.
  - A exceção é a cotação escolhida: ao autorizar, o valor a faturar é copiado para a solicitação.
- **`recovery_reports`:** solicitação, versão, data de emissão e retrato dos dados usados no relatório (JSON).
- **`finance_attachments`:** solicitação, cotação (opcional), tipo (proposta, relatório assinado ou outro), nome do arquivo, tipo do conteúdo, tamanho, conteúdo (bytea), substituído por, autor e data.
- **Regras no banco:**
  - situação só avança pelos caminhos da seção 6;
  - cotação não é alterada fora de "Em cotação";
  - anexo não é apagado;
  - autorização exige cotação escolhida e anexo do relatório assinado.

## 13. Testes

- **Cálculo:** as três linhas da planilha, conferidas centavo a centavo pela regra A; percentuais diferentes por cliente; vigência.
- **Fluxo:**
  - cotações chegando em dias diferentes;
  - envio com menos de 3 sem justificativa recusado;
  - reabrir com motivo gera a versão 2 do relatório;
  - autorizar sem anexo recusado;
  - valores travados depois de autorizar.
- **Anexos:** tipo errado e tamanho acima de 4 MB recusados; substituição sem apagar; download sem acesso recusado.
- **Planejamento:**
  - planejar OS preenche os dados;
  - lançar → Em execução;
  - concluir → Concluída;
  - cancelar a OS → volta a Autorizada.
- **Configuração:** cliente não habilitado não aparece; nova vigência não altera solicitações antigas.
- **Exportação:** colunas e valores.
