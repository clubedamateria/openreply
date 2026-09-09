# Design brief: Clube da Matéria · Automações

Painel interno (uso do dono) que transforma comentários do Instagram em DMs e leads do quiz.
Tom: amigável, claro, "app de professor", nunca corporativo frio. Idioma: pt-BR. Sem travessões (—) em texto.

## Marca
- Logo: `/brand/clube-logo.png` (362x400, fundo transparente). Usar com `next/image`.
- Nome do produto na UI: **Clube da Matéria** (subtítulo: "Automações do Instagram"). Nunca mostrar "OpenReply", "Zernio", "GitHub", "star the repo", "demo", "self-hosted/auto-hospedado" ou "apoiado por".
- Azul marca `brand` (#0f4c9c) = navegação, títulos, links, botões secundários fortes.
- Laranja `accent` (#f97316) = ação principal (1 por tela), destaques.
- Amarelo `sun` (#fbbf24) = detalhes lúdicos (ícone tile, badge de destaque).

## Tokens e classes (já em `app/globals.css`)
Cores Tailwind: `bg-brand`, `text-brand`, `bg-brand-soft`, `bg-accent`, `bg-sun-soft`, `bg-surface`, `bg-surface-hover`, `border-border`, `text-muted`, `text-foreground`, `bg-success-soft text-success`, `bg-error-soft text-error`, `bg-warning-soft text-warning`, `bg-info-soft text-info`.
Classes semânticas: `.card`, `.card-hover`, `.brand-hero`, `.btn .btn-primary|btn-brand|btn-secondary|btn-ghost|btn-danger|btn-sm`, `.field`, `.label`, `.helper`, `.badge badge-success|error|warning|info|neutral|accent`, `.icon-tile`, `.skeleton`, `.stagger`, `.animate-fade-in`.
Raio: cards 16px (`rounded-2xl`), controles 10px (`rounded-[10px]`). Fonte: Nunito (carregada em `app/layout.tsx` via `next/font/google`).

## Ícones
`lucide-react` (instalado). Sempre com `aria-hidden` + texto visível, ou `aria-label`. Nunca emoji como ícone. Tamanho 18 a 20 em botões, 20 a 22 em tiles.

## Regras de UX
- Toque mínimo 44px; espaçamento 8px+ entre alvos.
- 1 CTA primário laranja por tela; secundários `btn-secondary`/`btn-ghost`.
- Labels visíveis nos inputs; helper text abaixo; erro abaixo do campo em `text-error`.
- Estados vazios com ilustração leve (ícone em `.icon-tile bg-sun-soft`), frase curta e CTA.
- Loading: `.skeleton` (não spinner longo).
- Tabelas: cabeçalho `text-xs uppercase tracking-wide text-muted`, linhas com `hover:bg-surface-hover`, scroll horizontal dentro do container em mobile.
- Nunca informação só por cor: badge sempre tem texto.
- Mobile-first, `min-h-dvh`, sem scroll horizontal na página.

## Layout
- Sidebar branca com logo no topo (imagem 40px + "Clube da Matéria" em `text-brand font-extrabold`), itens com ícone + label, ativo = `bg-brand-soft text-brand font-bold` + barra esquerda `bg-accent`.
- Top bar: título da página + chip da conta conectada (`badge badge-info` com ícone Instagram).
- Conteúdo: `max-w-7xl`, grid de cards.
