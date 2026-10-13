---
name: visual-original
description: Obrigatório antes de criar ou redesenhar qualquer site, landing page, tela ou componente visual. Define uma direção visual própria para o projeto (DESIGN.md) antes de escrever código e audita o resultado contra os padrões que denunciam "cara de IA". Use sempre que o pedido envolver front-end, layout, identidade visual, paleta, tipografia ou "deixar mais bonito".
---

# Visual original, sem cara de IA

Cada projeto tem uma identidade própria. Nada de reaproveitar a estética do projeto anterior nem cair no padrão médio dos geradores de interface.

## 1. Antes do código: DESIGN.md

Se o projeto ainda não tem `DESIGN.md` na raiz, crie um antes de escrever qualquer tela. Ele precisa ter:

- **Contexto**: quem usa, onde (escritório, campo, celular sob sol, monitor de sala de controle), qual sensação o produto deve passar. Extraia isso do domínio real do projeto, não de adjetivos genéricos ("moderno", "clean").
- **Direção visual em uma frase**, ancorada numa referência concreta fora do mundo de SaaS: sinalização portuária, carta náutica, manual técnico dos anos 70, painel de instrumentos, editorial de revista, etc.
- **Paleta** com uma cor dominante escolhida (com o motivo), cores de apoio e cores de estado. Valores em tokens CSS.
- **Tipografia**: par de fontes com motivo. Inter, Roboto, Arial e a fonte padrão do sistema não valem como escolha de display.
- **Grid e ritmo**: escala de espaçamento, largura de leitura, densidade (painel operacional é denso; landing respira).
- **Assinatura**: 1 ou 2 elementos que só existem neste projeto (um tipo de divisor, um tratamento de número, um padrão gráfico derivado do domínio).
- **Proibições específicas** do projeto.

Para gerar opções use as skills instaladas: `ui-ux-pro-max` (paletas e pares de fonte por segmento), `taste-skill` (registros visuais), `impeccable` (`/impeccable` para critique, audit, polish, typeset) e `frontend-design`. Proponha 2 ou 3 direções bem diferentes entre si e escolha uma com o usuário quando for um projeto novo.

## 2. Durante o código

- Componentes shadcn/Radix servem de base de comportamento; o visual vem dos tokens do DESIGN.md. Nunca entregue shadcn com o tema padrão.
- Estrutura nasce do conteúdo. Evite o esqueleto hero centralizado + 3 cards de ícone + depoimentos + CTA.
- Ícones com moderação, sempre do mesmo conjunto e peso, e nunca como decoração de cada card.

## 3. Checklist anti-"cara de IA" (rodar antes de entregar)

Reprovar e refazer se aparecer qualquer um destes sem motivo explícito no DESIGN.md:

- Gradiente roxo/índigo/azul, fundo com blobs ou glow, glassmorphism genérico.
- Inter/Geist como única fonte; títulos com uma palavra pintada de outra cor.
- Creme + terracota, preto + verde-limão, rótulos em caixa-alta monoespaçada por todo lado (o "bom gosto de IA" de segunda ordem).
- Numeração decorativa 01/02/03, emojis como ícones, cards todos iguais com sombra suave e cantos `rounded-2xl`.
- Textos genéricos ("Unlock", "Seamless", "Elevate", "Potencialize", "Transforme").

Depois de renderizar, tire screenshot (Playwright ou Chrome DevTools MCP) em desktop e celular e compare com o DESIGN.md. Se o plugin `impeccable` estiver ativo, rode `/impeccable audit` e `/impeccable critique`.
