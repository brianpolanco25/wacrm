'use client';

// ============================================================
// Support sessions on one account's file (s9.5): every session opened on
// it and, folded under each, what was changed during it.
//
// Mounted at the end of `platform-account-detail.tsx`. Reads
// `GET /api/platform/accounts/[id]/support-actions`; the list itself is
// `SupportSessionList`, a pure render so it can be tested without a DOM.
// The fold is a native <details>: keyboard and screen readers get it for
// free, and there is no open/closed state to keep in sync.
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { History, Loader2, ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { SupportActivity } from '@/lib/platform/support-activity';

function moment(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

export function SupportSessionList({
  activity,
  actionLimit,
}: {
  activity: SupportActivity;
  actionLimit: number;
}) {
  const t = useTranslations('Platform.support');

  if (activity.sessions.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('none')}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {activity.truncated ? (
        <p className="text-muted-foreground text-xs">
          {t('truncated', { count: actionLimit })}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {activity.sessions.map((session) => (
          <li
            key={session.id}
            className="border-border flex flex-col gap-1 rounded-md border p-3 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {t('session', {
                  start: moment(session.startedAt),
                  actor: session.actorUserId,
                })}
              </span>
              {session.open ? (
                <Badge variant="destructive">{t('open')}</Badge>
              ) : (
                <span className="text-muted-foreground text-xs">
                  {t('endedAt', {
                    date: moment(session.endedAt ?? session.expiresAt),
                  })}
                </span>
              )}
              <Badge variant="outline">
                {t('actionsCount', { count: session.actions.length })}
              </Badge>
            </div>
            <p className="text-muted-foreground">
              {t('reason', { reason: session.reason })}
            </p>
            {session.actions.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                {/* With the list cut off, an empty session may just be an
                    older one whose actions fell past the limit. */}
                {activity.truncated ? t('olderActionsHidden') : t('noActions')}
              </p>
            ) : (
              <details className="group">
                <summary className="text-primary w-fit cursor-pointer text-xs select-none">
                  <span className="group-open:hidden">{t('showActions')}</span>
                  <span className="hidden group-open:inline">
                    {t('hideActions')}
                  </span>
                </summary>
                <ul className="mt-2 flex flex-col gap-1">
                  {session.actions.map((action) => (
                    <li
                      key={action.id}
                      className="flex flex-wrap items-center gap-2 font-mono text-xs"
                    >
                      <span className="text-muted-foreground">
                        {moment(action.at)}
                      </span>
                      <Badge variant="secondary">
                        {action.source === 'db'
                          ? t('sourceDb')
                          : t('sourceHttp')}
                      </Badge>
                      <span className="font-semibold">{action.method}</span>
                      <span className="break-all">{action.path}</span>
                      {action.status !== null && action.status >= 400 ? (
                        <Badge variant="destructive">
                          {t('refused', { status: action.status })}
                        </Badge>
                      ) : action.source === 'http' && action.status === null ? (
                        // Written before the route answered: whether it
                        // succeeded is not known here (see the db rows).
                        <span className="text-muted-foreground">
                          {t('statusUnknown')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Mirrors `ACTION_LIMIT` in `@/lib/platform/support-activity` (server-only module). */
const ACTION_LIMIT = 500;

export function ImpersonationActions({ accountId }: { accountId: string }) {
  const t = useTranslations('Platform.support');
  const [activity, setActivity] = useState<SupportActivity | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/platform/accounts/${accountId}/support-actions`,
          { cache: 'no-store' }
        );
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as SupportActivity;
        if (!cancelled) setActivity(body);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-foreground flex items-center gap-2 text-sm font-semibold">
            <History className="size-4" />
            {t('title')}
          </h2>
          <p className="text-muted-foreground text-xs">{t('description')}</p>
        </div>
        {failed ? (
          <div className="text-destructive flex items-center gap-2 text-sm">
            <ShieldAlert className="size-4" />
            {t('loadFailed')}
          </div>
        ) : activity ? (
          <SupportSessionList activity={activity} actionLimit={ACTION_LIMIT} />
        ) : (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t('loading')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
