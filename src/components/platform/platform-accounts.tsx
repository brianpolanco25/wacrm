'use client';

// ============================================================
// The census (fase 4 §2, «Listado de cuentas»): name, plan, subscription
// state, members, consumption of the cycle, signup date and last
// activity — every account of the service, one row each.
//
// Read-only. Everything that CHANGES an account lives on its file, one
// click away, because "suspend" next to a row in a list of every
// customer is a mis-click away from the wrong company.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Loader2, Search, ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { USAGE_METRICS } from '@/lib/billing/subscription-view';

interface AccountRow {
  accountId: string;
  name: string;
  createdAt: string;
  memberCount: number;
  planId: string | null;
  subscriptionStatus: string | null;
  manualHoldAt: string | null;
  lastActivityAt: string | null;
  usage: Record<string, number>;
}

interface Page {
  accounts: AccountRow[];
  total: number;
  limit: number;
  offset: number;
}

/** Dates are shown in the operator's locale, never re-formatted by us. */
function day(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : '—';
}

export function PlatformAccounts() {
  const t = useTranslations('Platform');
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const params = new URLSearchParams({ offset: String(offset) });
      if (query) params.set('q', query);
      const res = await fetch(`/api/platform/accounts?${params}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      setPage((await res.json()) as Page);
    } catch {
      // A failed census is said out loud rather than shown as "no
      // customers", which is the one reading an operator must never get.
      setFailed(true);
      setPage(null);
    } finally {
      setLoading(false);
    }
  }, [offset, query]);

  useEffect(() => {
    load();
  }, [load]);

  const limit = page?.limit ?? 50;
  const total = page?.total ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-xl font-semibold">
            {t('title')}
          </h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setQuery(search.trim());
          }}
        >
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="w-56"
          />
          <Button type="submit" size="sm" variant="outline">
            <Search className="size-4" />
            {t('search')}
          </Button>
        </form>
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
      ) : page && page.accounts.length === 0 ? (
        <p className="text-muted-foreground p-6 text-sm">{t('empty')}</p>
      ) : (
        <div className="border-border rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.name')}</TableHead>
                <TableHead>{t('columns.plan')}</TableHead>
                <TableHead>{t('columns.status')}</TableHead>
                <TableHead className="text-right">
                  {t('columns.members')}
                </TableHead>
                <TableHead className="text-right">
                  {t('columns.usage')}
                </TableHead>
                <TableHead>{t('columns.createdAt')}</TableHead>
                <TableHead>{t('columns.lastActivity')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page?.accounts.map((row) => (
                <TableRow key={row.accountId}>
                  <TableCell>
                    <Link
                      href={`/platform/${row.accountId}`}
                      className="text-primary font-medium hover:underline"
                    >
                      {row.name || row.accountId}
                    </Link>
                  </TableCell>
                  <TableCell>{row.planId ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant="outline">
                        {row.subscriptionStatus ?? '—'}
                      </Badge>
                      {/* The hold is its own chip, not a status: the two
                          are independent, and an operator has to see
                          that PayPal says `active` while we say no. */}
                      {row.manualHoldAt ? (
                        <Badge variant="destructive">{t('held')}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.memberCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {USAGE_METRICS.map((metric) => row.usage[metric] ?? 0).join(
                      ' / '
                    )}
                  </TableCell>
                  <TableCell>{day(row.createdAt)}</TableCell>
                  <TableCell>{day(row.lastActivityAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {page && total > limit ? (
        <div className="text-muted-foreground flex items-center justify-between text-sm">
          <span>
            {t('pageOf', {
              from: offset + 1,
              to: Math.min(offset + limit, total),
              total,
            })}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              {t('previous')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + limit >= total}
              onClick={() => setOffset(offset + limit)}
            >
              {t('next')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
