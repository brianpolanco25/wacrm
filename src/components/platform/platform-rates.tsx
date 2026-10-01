'use client';

// ============================================================
// /platform/rates (s10.2): Meta's rate card for the operator.
//
//   1. Rates by market and category, newest first, each marked «vigente»
//      (prices today's deliveries), «programada» (later date) or
//      «histórica». «Nueva tarifa» adds a row with its effective date: a
//      rate in force is never edited, so there is no edit button.
//   2. CSV import: paste `market,category,usd_per_message,effective_from`
//      lines, preview the classification the server makes (nothing is
//      written), then import — all or nothing.
//   3. Country → market table, editable. A country without a row is
//      billed as `rest_of_world`.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Eye,
  Loader2,
  Plus,
  Save,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { META_CATEGORIES, REST_OF_WORLD } from '@/lib/billing/meta-rates';

const SELECT_CLASS =
  'border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

export interface RateView {
  market: string;
  category: string;
  usdPerMessage: number;
  effectiveFrom: string;
  inForce: boolean;
  scheduled: boolean;
}

export interface MarketCountryView {
  countryCode: string;
  market: string;
}

type ImportStatus =
  'new' | 'exists' | 'conflict' | 'retroactive' | 'invalid' | 'duplicate';

interface ImportPreviewView {
  rows: Array<{
    line: number;
    status: ImportStatus;
    value: {
      market: string;
      category: string;
      usd_per_message: number;
      effective_from: string;
    } | null;
    error: string | null;
  }>;
  toInsert: unknown[];
  importable: boolean;
}

export interface RatesData {
  today: string;
  rates: RateView[];
  markets: MarketCountryView[];
}

type RateState = 'inForce' | 'scheduled' | 'past';

function rateState(rate: RateView): RateState {
  return rate.inForce ? 'inForce' : rate.scheduled ? 'scheduled' : 'past';
}

const STATE_VARIANT: Record<RateState, 'secondary' | 'outline' | 'default'> = {
  inForce: 'default',
  scheduled: 'secondary',
  past: 'outline',
};

const IMPORT_VARIANT: Record<
  ImportStatus,
  'secondary' | 'outline' | 'destructive'
> = {
  new: 'secondary',
  exists: 'outline',
  conflict: 'destructive',
  retroactive: 'destructive',
  invalid: 'destructive',
  duplicate: 'destructive',
};

function rateText(value: number): string {
  return `${value.toFixed(5)} USD`;
}

function useCountryName(): (code: string) => string {
  const locale = useLocale();
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }
    return (code: string) => {
      try {
        return names?.of(code) ?? code;
      } catch {
        return code;
      }
    };
  }, [locale]);
}

export function PlatformRates({
  initial = null,
}: {
  /** Pre-loaded data, for tests; the page loads it itself. */
  initial?: RatesData | null;
}) {
  const t = useTranslations('Platform.rates');
  const countryName = useCountryName();
  const [data, setData] = useState<RatesData | null>(initial);
  const [loading, setLoading] = useState(initial === null);
  const [failed, setFailed] = useState(false);

  const [editor, setEditor] = useState<{
    market: string;
    category: string;
    usd: string;
    effectiveFrom: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportPreviewView | null>(null);
  const [importing, setImporting] = useState(false);

  const [draft, setDraft] = useState<MarketCountryView[]>(
    initial?.markets ?? []
  );
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [newCountry, setNewCountry] = useState({ code: '', market: '' });
  const [savingMarkets, setSavingMarkets] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const [ratesRes, marketsRes] = await Promise.all([
        fetch('/api/platform/rates', { cache: 'no-store' }),
        fetch('/api/platform/rates/markets', { cache: 'no-store' }),
      ]);
      if (!ratesRes.ok || !marketsRes.ok) throw new Error('load');
      const rates = (await ratesRes.json()) as {
        today: string;
        rates: RateView[];
      };
      const markets = (await marketsRes.json()) as {
        markets: MarketCountryView[];
      };
      setData({ ...rates, markets: markets.markets });
      setDraft(markets.markets);
      setRemoved(new Set());
    } catch {
      // Said out loud: an empty table would read as «no rates».
      setFailed(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initial === null) load();
  }, [initial, load]);

  const knownMarkets = useMemo(
    () =>
      [
        ...new Set([
          ...(data?.rates ?? []).map((r) => r.market),
          ...draft.map((m) => m.market),
          REST_OF_WORLD,
        ]),
      ]
        .filter(Boolean)
        .sort(),
    [data, draft]
  );

  const unpriced = useMemo(() => {
    if (!data) return [];
    const priced = new Set(
      data.rates.filter((r) => r.inForce).map((r) => r.market)
    );
    return knownMarkets.filter((m) => !priced.has(m));
  }, [data, knownMarkets]);

  async function saveRate() {
    if (!editor) return;
    setSaving(true);
    try {
      const res = await fetch('/api/platform/rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market: editor.market,
          category: editor.category,
          usd_per_message: Number(editor.usd),
          effective_from: editor.effectiveFrom,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        reason?: 'exists' | 'conflict' | 'retroactive';
      } | null;
      if (!res.ok) {
        toast.error(
          res.status === 409 && body?.reason
            ? t(`refused.${body.reason}`)
            : body?.error
              ? t('saveFailedWith', { error: body.error })
              : t('saveFailed')
        );
        return;
      }
      setEditor(null);
      toast.success(t('saved'));
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function runImport(dryRun: boolean) {
    setImporting(true);
    try {
      const res = await fetch('/api/platform/rates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, dryRun }),
      });
      const body = (await res.json().catch(() => null)) as {
        preview?: ImportPreviewView;
        inserted?: number;
        error?: string;
      } | null;
      if (body?.preview) setPreview(body.preview);
      if (!res.ok) {
        toast.error(
          body?.preview
            ? t('import.blocked')
            : body?.error
              ? t('saveFailedWith', { error: body.error })
              : t('saveFailed')
        );
        return;
      }
      if (!dryRun) {
        toast.success(t('import.done', { count: body?.inserted ?? 0 }));
        setCsv('');
        setPreview(null);
        await load();
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setImporting(false);
    }
  }

  function addCountry() {
    const code = newCountry.code.trim().toUpperCase();
    const market = newCountry.market.trim().toLowerCase();
    if (!/^[A-Z]{2}$/.test(code) || !/^[a-z][a-z0-9_]{1,39}$/.test(market)) {
      toast.error(t('markets.invalid'));
      return;
    }
    setDraft((current) => [
      ...current.filter((m) => m.countryCode !== code),
      { countryCode: code, market },
    ]);
    setRemoved((current) => {
      const next = new Set(current);
      next.delete(code);
      return next;
    });
    setNewCountry({ code: '', market: '' });
  }

  async function saveMarkets() {
    const entries = [
      ...draft.map((m) => ({ country_code: m.countryCode, market: m.market })),
      ...[...removed].map((code) => ({ country_code: code, market: null })),
    ];
    if (entries.length === 0) return;
    setSavingMarkets(true);
    try {
      const res = await fetch('/api/platform/rates/markets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      const body = (await res.json().catch(() => null)) as {
        markets?: MarketCountryView[];
        error?: string;
      } | null;
      if (!res.ok || !body?.markets) {
        toast.error(
          body?.error
            ? t('saveFailedWith', { error: body.error })
            : t('saveFailed')
        );
        return;
      }
      setDraft(body.markets);
      setRemoved(new Set());
      setData((current) =>
        current ? { ...current, markets: body.markets! } : current
      );
      toast.success(t('markets.saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSavingMarkets(false);
    }
  }

  const today = data?.today ?? new Date().toISOString().slice(0, 10);
  const toInsert = preview?.toInsert.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-foreground text-xl font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
        </div>
        <Button
          size="sm"
          disabled={!data}
          onClick={() =>
            setEditor({
              market: 'rest_of_latam',
              category: 'marketing',
              usd: '',
              effectiveFrom: today,
            })
          }
        >
          <Plus className="size-4" />
          {t('newRate')}
        </Button>
      </div>

      {failed ? (
        <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg border p-4 text-sm">
          <ShieldAlert className="size-4" />
          {t('loadFailed')}
        </div>
      ) : loading ? (
        <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('loading')}
        </div>
      ) : data ? (
        <>
          <section className="flex flex-col gap-3" data-section="rates">
            <p className="text-muted-foreground text-sm">{t('neverEdit')}</p>
            {unpriced.length > 0 ? (
              <div
                className="border-border bg-muted/40 text-muted-foreground rounded-lg border p-3 text-sm"
                data-unpriced-markets={unpriced.join(',')}
              >
                {t('unpriced', { markets: unpriced.join(', ') })}
              </div>
            ) : null}
            {data.rates.length === 0 ? (
              <p className="text-muted-foreground p-6 text-sm">{t('empty')}</p>
            ) : (
              <div className="border-border rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('columns.market')}</TableHead>
                      <TableHead>{t('columns.category')}</TableHead>
                      <TableHead className="text-right">
                        {t('columns.rate')}
                      </TableHead>
                      <TableHead>{t('columns.effectiveFrom')}</TableHead>
                      <TableHead>{t('columns.state')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rates.map((rate) => {
                      const state = rateState(rate);
                      return (
                        <TableRow
                          key={`${rate.market}|${rate.category}|${rate.effectiveFrom}`}
                          data-rate={`${rate.market}|${rate.category}|${rate.effectiveFrom}`}
                        >
                          <TableCell className="font-mono text-xs">
                            {rate.market}
                          </TableCell>
                          <TableCell>
                            {t(`categories.${rate.category}`)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {rateText(rate.usdPerMessage)}
                          </TableCell>
                          <TableCell>{rate.effectiveFrom}</TableCell>
                          <TableCell>
                            <Badge
                              variant={STATE_VARIANT[state]}
                              data-rate-state={state}
                            >
                              {t(`state.${state}`)}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3" data-section="import">
            <div>
              <h3 className="text-foreground text-base font-semibold">
                {t('import.title')}
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('import.help')}
              </p>
            </div>
            <Textarea
              aria-label={t('import.title')}
              className="min-h-32 font-mono text-xs"
              placeholder={t('import.placeholder')}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setPreview(null);
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={importing || csv.trim() === ''}
                onClick={() => runImport(true)}
              >
                {importing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Eye className="size-4" />
                )}
                {t('import.preview')}
              </Button>
              <Button
                size="sm"
                disabled={
                  importing || !preview || !preview.importable || toInsert === 0
                }
                onClick={() => runImport(false)}
                data-import-action
              >
                <Upload className="size-4" />
                {t('import.action', { count: toInsert })}
              </Button>
            </div>
            {preview ? (
              <div className="border-border rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('import.columns.line')}</TableHead>
                      <TableHead>{t('columns.market')}</TableHead>
                      <TableHead>{t('columns.category')}</TableHead>
                      <TableHead className="text-right">
                        {t('columns.rate')}
                      </TableHead>
                      <TableHead>{t('columns.effectiveFrom')}</TableHead>
                      <TableHead>{t('columns.state')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.rows.map((row) => (
                      <TableRow key={row.line} data-import-line={row.line}>
                        <TableCell>{row.line}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {row.value?.market ?? '—'}
                        </TableCell>
                        <TableCell>
                          {row.value
                            ? t(`categories.${row.value.category}`)
                            : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.value
                            ? rateText(row.value.usd_per_message)
                            : '—'}
                        </TableCell>
                        <TableCell>
                          {row.value?.effective_from ?? '—'}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={IMPORT_VARIANT[row.status]}
                            data-import-status={row.status}
                          >
                            {t(`import.status.${row.status}`)}
                          </Badge>
                          {row.error ? (
                            <span className="text-muted-foreground ml-2 text-xs">
                              {row.error}
                            </span>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </section>

          <section className="flex flex-col gap-3" data-section="markets">
            <div>
              <h3 className="text-foreground text-base font-semibold">
                {t('markets.title')}
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('markets.help', { fallback: REST_OF_WORLD })}
              </p>
            </div>
            <datalist id="meta-markets">
              {knownMarkets.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <div className="border-border rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('markets.columns.country')}</TableHead>
                    <TableHead>{t('markets.columns.market')}</TableHead>
                    <TableHead className="text-right">
                      {t('markets.columns.actions')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draft.map((m) => (
                    <TableRow key={m.countryCode} data-country={m.countryCode}>
                      <TableCell>
                        <span className="font-mono text-xs">
                          {m.countryCode}
                        </span>{' '}
                        <span className="text-muted-foreground text-xs">
                          {countryName(m.countryCode)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Input
                          aria-label={t('markets.columns.market')}
                          list="meta-markets"
                          className="h-8 font-mono text-xs"
                          value={m.market}
                          onChange={(e) =>
                            setDraft((current) =>
                              current.map((x) =>
                                x.countryCode === m.countryCode
                                  ? { ...x, market: e.target.value }
                                  : x
                              )
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('markets.remove', {
                            country: m.countryCode,
                          })}
                          onClick={() => {
                            setDraft((current) =>
                              current.filter(
                                (x) => x.countryCode !== m.countryCode
                              )
                            );
                            setRemoved((current) =>
                              new Set(current).add(m.countryCode)
                            );
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell>
                      <Input
                        aria-label={t('markets.columns.country')}
                        className="h-8 w-20 font-mono text-xs uppercase"
                        maxLength={2}
                        placeholder="DO"
                        value={newCountry.code}
                        onChange={(e) =>
                          setNewCountry((c) => ({ ...c, code: e.target.value }))
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        aria-label={t('markets.columns.market')}
                        list="meta-markets"
                        className="h-8 font-mono text-xs"
                        placeholder="rest_of_latam"
                        value={newCountry.market}
                        onChange={(e) =>
                          setNewCountry((c) => ({
                            ...c,
                            market: e.target.value,
                          }))
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={addCountry}>
                        <Plus className="size-4" />
                        {t('markets.add')}
                      </Button>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <div>
              <Button
                size="sm"
                onClick={saveMarkets}
                disabled={savingMarkets}
                data-save-markets
              >
                {savingMarkets ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                {t('markets.save')}
              </Button>
            </div>
          </section>
        </>
      ) : null}

      <Dialog
        open={editor !== null}
        onOpenChange={(next) => !next && !saving && setEditor(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('editor.title')}</DialogTitle>
            <DialogDescription>{t('neverEdit')}</DialogDescription>
          </DialogHeader>
          {editor ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="rate-market">{t('columns.market')}</Label>
                <Input
                  id="rate-market"
                  list="meta-markets"
                  className="font-mono"
                  value={editor.market}
                  onChange={(e) =>
                    setEditor({ ...editor, market: e.target.value })
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rate-category">{t('columns.category')}</Label>
                <select
                  id="rate-category"
                  className={SELECT_CLASS}
                  value={editor.category}
                  onChange={(e) =>
                    setEditor({ ...editor, category: e.target.value })
                  }
                >
                  {META_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`categories.${c}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rate-usd">{t('columns.rate')}</Label>
                <Input
                  id="rate-usd"
                  inputMode="decimal"
                  placeholder="0.07400"
                  value={editor.usd}
                  onChange={(e) =>
                    setEditor({ ...editor, usd: e.target.value })
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rate-from">{t('columns.effectiveFrom')}</Label>
                <Input
                  id="rate-from"
                  type="date"
                  value={editor.effectiveFrom}
                  onChange={(e) =>
                    setEditor({ ...editor, effectiveFrom: e.target.value })
                  }
                />
                <p className="text-muted-foreground text-xs">
                  {t('editor.dateHelp')}
                </p>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditor(null)}
              disabled={saving}
            >
              {t('cancel')}
            </Button>
            <Button onClick={saveRate} disabled={saving}>
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              {t('editor.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
