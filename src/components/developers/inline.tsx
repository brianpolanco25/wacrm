import Link from 'next/link';

import { withDocsLang } from '@/content/developers/nav';
import type { DocsLocale, InlineText } from '@/content/developers/types';

// ============================================================
// Marcado en línea de la documentación pública.
//
// S-A3 prohíbe dependencias nuevas, así que no hay markdown ni MDX: la
// prosa lleva tres marcas y este archivo las convierte en nodos. Es
// deliberadamente pobre —sin anidación— porque tres marcas planas
// cubren toda la sección y un parser de veinte líneas se puede leer
// entero antes de confiar en él.
//
//   `código`          → <code>
//   **fuerte**        → <strong>
//   [texto](/ruta)    → enlace
// ============================================================

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'link'; value: string; href: string };

/**
 * El orden de la alternancia importa: el código va primero, así un
 * `**` dentro de comillas invertidas se queda como texto literal (que
 * es lo que hace falta al documentar, por ejemplo, un glob).
 */
const PATTERN = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: InlineText): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  for (const match of text.matchAll(PATTERN)) {
    const at = match.index;
    if (at > last) nodes.push({ type: 'text', value: text.slice(last, at) });
    if (match[1] !== undefined) nodes.push({ type: 'code', value: match[1] });
    else if (match[2] !== undefined)
      nodes.push({ type: 'strong', value: match[2] });
    else nodes.push({ type: 'link', value: match[3], href: match[4] });
    last = at + match[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', value: text.slice(last) });
  return nodes;
}

/** Los `href` que aparecen en un texto. Lo usa el test de enlaces rotos. */
export function inlineLinks(text: InlineText): string[] {
  return parseInline(text)
    .filter(
      (node): node is Extract<InlineNode, { type: 'link' }> =>
        node.type === 'link'
    )
    .map((node) => node.href);
}

export function Inline({
  text,
  locale,
}: {
  text: InlineText;
  locale: DocsLocale;
}) {
  return (
    <>
      {parseInline(text).map((node, i) => {
        switch (node.type) {
          case 'code':
            return (
              <code
                key={i}
                className="bg-card-2 text-foreground rounded px-1.5 py-0.5 font-mono text-[0.85em] break-words"
              >
                {node.value}
              </code>
            );
          case 'strong':
            return (
              <strong key={i} className="text-foreground font-semibold">
                {node.value}
              </strong>
            );
          case 'link':
            return node.href.startsWith('/') ? (
              <Link
                key={i}
                href={withDocsLang(node.href, locale)}
                className="text-primary decoration-primary/40 hover:decoration-primary underline underline-offset-2"
              >
                {node.value}
              </Link>
            ) : (
              <a
                key={i}
                href={node.href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary decoration-primary/40 hover:decoration-primary underline underline-offset-2"
              >
                {node.value}
              </a>
            );
          default:
            return <span key={i}>{node.value}</span>;
        }
      })}
    </>
  );
}
