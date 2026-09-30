'use client';

// ============================================================
// Placeholder for the panel sections that later features fill in:
// Resumen (s9.2), Planes (s9.3), Operadores (s9.4). Title, one line of
// what the section will do, and — for the Resumen — empty cards that
// say «coming soon» rather than a zero that reads like data.
// ============================================================

import { useTranslations } from 'next-intl';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export type PlaceholderSection = 'overview' | 'plans' | 'operators';
export type PlaceholderCard = 'accounts' | 'mrr' | 'signups' | 'delinquent';

export function PlatformPlaceholder({
  section,
  cards = [],
}: {
  section: PlaceholderSection;
  cards?: PlaceholderCard[];
}) {
  const t = useTranslations('Platform.placeholder');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-foreground text-xl font-semibold">
          {t(`${section}.title`)}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t(`${section}.subtitle`)}
        </p>
      </div>

      {cards.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => (
            <Card key={card} data-placeholder-card={card}>
              <CardHeader>
                <CardTitle className="text-muted-foreground text-sm font-medium">
                  {t(`cards.${card}`)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  {t('comingSoon')}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-foreground text-sm font-medium">
              {t('comingSoon')}
            </p>
            <p className="text-muted-foreground mt-1 text-sm">{t('body')}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
