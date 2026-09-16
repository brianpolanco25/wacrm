'use client';

import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

// ============================================================
// Bloque de código con botón de copiar.
//
// Sin resaltador de sintaxis: S-A3 no admite dependencias nuevas y un
// resaltador propio sería mentir sobre lenguajes que no entendemos.
// Lo que sí tiene que funcionar es copiar, que es lo que la gente hace
// de verdad con estos bloques.
// ============================================================

interface CodeBlockProps {
  code: string;
  /** Etiqueta del lenguaje, solo informativa (`bash`, `json`, `php`…). */
  lang?: string;
  /** Título opcional encima del bloque ("Respuesta", "Verificar la firma"). */
  label?: string;
  className?: string;
}

export function CodeBlock({ code, lang, label, className }: CodeBlockProps) {
  const t = useTranslations('Developers.ui');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Un navegador sin permiso de portapapeles (o sin https) no puede
      // copiar: el texto sigue ahí para seleccionarlo a mano, así que no
      // hay nada útil que decirle al usuario más que no fingir éxito.
      setCopied(false);
    }
  };

  return (
    <figure
      className={cn(
        'border-border bg-card group relative my-5 overflow-hidden rounded-xl border',
        className
      )}
    >
      <figcaption className="border-border/70 bg-card-2 flex items-center justify-between gap-3 border-b px-4 py-2">
        <span className="text-muted-foreground truncate text-xs font-medium">
          {label ?? lang ?? ''}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? t('copied') : t('copy')}
          className="text-muted-foreground hover:text-foreground hover:bg-background focus-visible:ring-ring inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {copied ? (
            <Check className="text-positive size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
          {copied ? t('copied') : t('copy')}
        </button>
      </figcaption>
      <pre className="overflow-x-auto px-4 py-3.5 text-[0.8125rem] leading-relaxed">
        <code className="font-mono whitespace-pre">{code}</code>
      </pre>
    </figure>
  );
}
