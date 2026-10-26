# Cancelamento libera recursos, uso de equipamentos, equipe no planejamento e Apresentação (26/10/2026)

## 1. OS cancelada libera todos os recursos

**Antes:**

- **Cancelamento durante a execução:** a reserva do equipamento era encurtada até o momento do cancelamento e continuava ativa. Em produção, a OS 000012 ficou com a reserva até 14:26 de 26/10.
- **Equipe:** os colaboradores de uma OS cancelada continuavam contando como ocupados no aviso "também está em outra etapa no mesmo horário".

**Agora:**

- **Equipamentos:** ao cancelar (OS programada ou em andamento), todas as reservas da OS são liberadas, com o motivo "OS cancelada". Datas e horários ficam livres para outras OS.
- **Equipe e funções:** colaboradores de OS cancelada não contam como ocupados.
- **Histórico:** o uso real continua registrado nos períodos de trabalho das etapas, no relatório, na planilha e na exportação.
- **Correção dos dados antigos:** a migração `0015_cancelada_libera_recursos.sql` libera as reservas que ainda estavam ativas em OS já canceladas.

## 2. Exportação: uso de equipamentos

Dois conjuntos novos em Exportação (Operação), no escopo de organizações de quem exporta:

| Conjunto | Linha | Colunas principais |
| --- | --- | --- |
| **Equipamentos por OS** | Uma por OS | Equipamentos planejados, equipamentos usados (etapas com trabalho registrado), TAGs, horas reservadas, horas de uso. |
| **Usos de equipamentos** | Uma por OS × etapa × equipamento | Reserva (início, fim e horas), horas de uso (trabalho da etapa), "Usado" (Sim/Não), situação da reserva e motivo da liberação. |

As horas saem com uma casa decimal, como número, para somar e filtrar no Excel e no Power BI.

## 3. Planejamento: disponibilidade dos colaboradores

- Cada colaborador aparece como os equipamentos: **Livre** ou **Ocupado**, com "Também em: etapa X da OS 000012, em 27/10 das 09h00 às 15h00".
- Na lista, os colaboradores com a função exigida vêm primeiro, os livres antes dos ocupados.
- O título mostra quantos estão livres por função (ex.: "2× Amarrador · 1 livre(s)").
- **Só aviso:** colaborador ocupado pode ser escolhido e não impede o lançamento da OS.
- **O que conta como ocupado:** etapas incluídas de OS lançadas no mesmo horário, sem as OS canceladas ou concluídas e sem etapas já encerradas, e também os rascunhos.

## 4. Apresentação (TV)

Botão **Apresentação** no Painel central, para quem consulta OS. Abre `/apresentacao` em outra aba, pensada para uma TV de escritório (1920×1080; ajusta-se a telas de 1280 px a 4K).

**Conteúdo da tela:**

- **Cabeçalho**: período, quantidade de OS e relógio.
- **Indicadores**:
  - em andamento e etapas em execução;
  - programadas no período e início atrasado;
  - bloqueios abertos;
  - horas efetivas hoje;
  - equipamentos em uso agora.
- **Cronograma**:
  - uma linha por OS: número, setor, situação, título, solicitante, local, equipamentos e equipe;
  - datas no eixo horizontal;
  - barra do planejado com a cor do solicitante;
  - faixa do executado, que pulsa nas OS em execução;
  - linha do "agora";
  - OS atrasada com contorno vermelho tracejado.
- **Lateral**:
  - **Em execução agora**: etapa atual, tempo efetivo correndo, progresso do prazo, equipamentos e equipe;
  - **Próximas**: horário e quanto falta;
  - **Recursos em uso agora**: equipamentos com reserva neste momento, equipe e materiais;
  - **Atenção**: início atrasado, prazo vencido, bloqueios e equipamentos bloqueados ou com preventiva vencida.

**Comportamento:**

- **Rolagem automática**: o cronograma e a lateral rolam sozinhos (pausa no topo, descida lenta, pausa no fim e volta).
- **Atualização**: a cada minuto. Se a conexão cai, os últimos dados continuam na tela, com o aviso "sem conexão desde…".
- **Controles**: aparecem ao mexer o mouse e somem em 4 s, junto com o cursor. São eles:
  - período (Hoje, 3, 7 ou 14 dias, guardado na URL);
  - pausar a rolagem;
  - tela cheia;
  - voltar.
- **Tela ligada**: a tela da TV não apaga enquanto a apresentação está aberta, quando o navegador permite.
- **Acesso**: o mesmo de quem está logado. Cada consulta confere a sessão e o escopo de organizações.
