import Link from 'next/link';

import { withDocsLang } from '@/content/developers/nav';
import type { DocBlock, DocPage, DocsLocale } from '@/content/developers/types';

import { CodeBlock } from './code-block';
import { Inline } from './inline';

// ============================================================
// Renderizador de bloques de contenido. Un `switch` sobre el modelo de
// `src/content/developers/types.ts`: cada clase de bloque tiene un
// único sitio donde se decide cómo se ve.
// ============================================================

const NOTE_STYLES: Record<'info' | 'warn' | 'good', string> = {
  info: 'border-primary/40 bg-primary-soft',
  warn: 'border-brand/50 bg-brand/10',
  good: 'border-positive/40 bg-positive/10',
};

function Block({ block, locale }: { block: DocBlock; locale: DocsLocale }) {
  switch (block.kind) {
    case 'lead':
      return (
        <p className="text-muted-foreground mt-0 mb-6 text-lg leading-relaxed">
          <Inline text={block.text} locale={locale} />
        </p>
      );
    case 'p':
      return (
        <p className="text-muted-foreground my-4 leading-relaxed">
          <Inline text={block.text} locale={locale} />
        </p>
      );
    case 'h2':
      return (
        <h2
          id={block.id}
          className="text-foreground mt-12 scroll-mt-24 text-xl font-semibold tracking-tight"
        >
          {block.text}
        </h2>
      );
    case 'h3':
      return (
        <h3
          id={block.id}
          className="text-foreground mt-8 scroll-mt-24 text-base font-semibold"
        >
          {block.text}
        </h3>
      );
    case 'ul':
      return (
        <ul className="text-muted-foreground my-4 space-y-2 pl-5">
          {block.items.map((item, i) => (
            <li key={i} className="marker:text-brand list-disc leading-relaxed">
              <Inline text={item} locale={locale} />
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="text-muted-foreground my-4 space-y-2 pl-5">
          {block.items.map((item, i) => (
            <li
              key={i}
              className="marker:text-brand-ink list-decimal leading-relaxed marker:font-semibold"
            >
              <Inline text={item} locale={locale} />
            </li>
          ))}
        </ol>
      );
    case 'table':
      return (
        <div className="border-border my-6 overflow-x-auto rounded-xl border">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-card-2">
              <tr>
                {block.head.map((cell) => (
                  <th
                    key={cell}
                    scope="col"
                    className="text-foreground px-4 py-2.5 font-semibold"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-border/70 border-t">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="text-muted-foreground px-4 py-2.5 align-top"
                    >
                      <Inline text={cell} locale={locale} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'note':
      return (
        <aside
          className={`text-muted-foreground my-6 rounded-xl border-l-4 px-4 py-3 leading-relaxed ${NOTE_STYLES[block.tone]}`}
        >
          <Inline text={block.text} locale={locale} />
        </aside>
      );
    case 'code':
      return (
        <CodeBlock code={block.code} lang={block.lang} label={block.label} />
      );
    case 'cards':
      return (
        <div className="my-6 grid gap-3 sm:grid-cols-2">
          {block.items.map((item) => (
            <Link
              key={item.href}
              href={withDocsLang(item.href, locale)}
              className="border-border bg-card hover:border-brand/60 hover:bg-card-2 group rounded-xl border p-4 transition-colors"
            >
              <span className="text-foreground group-hover:text-brand-ink block font-semibold">
                {item.title}
              </span>
              <span className="text-muted-foreground mt-1 block text-sm leading-relaxed">
                {item.text}
              </span>
            </Link>
          ))}
        </div>
      );
  }
}

export function DocBlocks({
  blocks,
  locale,
}: {
  blocks: DocBlock[];
  locale: DocsLocale;
}) {
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} block={block} locale={locale} />
      ))}
    </>
  );
}

export function DocArticle({
  page,
  locale,
  children,
}: {
  page: DocPage;
  locale: DocsLocale;
  children?: React.ReactNode;
}) {
  return (
    <article className="min-w-0">
      <h1 className="text-foreground text-3xl font-semibold tracking-tight">
        {page.title}
      </h1>
      <div className="mt-6">
        <DocBlocks blocks={page.blocks} locale={locale} />
        {children}
      </div>
    </article>
  );
}
