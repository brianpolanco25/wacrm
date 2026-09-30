'use client';

// ============================================================
// /platform/operators (s9.4): who operates the platform, grant the role
// to an existing user by email, revoke it.
//
// The page asks; `/api/platform/operators*` decides. Revoking yourself
// and revoking the last operator are refused there (and in SQL, under a
// lock); the page only hides the button on your own row so the refusal
// is not the first thing an operator learns.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, ShieldAlert, ShieldPlus, UserMinus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { MIN_REASON_LENGTH } from '@/lib/auth/support-cookie';

export interface OperatorRow {
  userId: string;
  email: string | null;
  fullName: string | null;
  grantedAt: string | null;
  grantedBy: string | null;
  note: string | null;
}

export type OperatorsState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; operators: OperatorRow[]; currentUserId: string };

function day(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : '—';
}

/** The table, on its own — what the render tests pin. */
export function OperatorsTable({
  state,
  onRevoke,
  busy = false,
}: {
  state: OperatorsState;
  onRevoke: (operator: OperatorRow) => void;
  busy?: boolean;
}) {
  const t = useTranslations('Platform.operators');

  if (state.kind === 'loading') {
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg border p-4 text-sm">
        <ShieldAlert className="size-4" />
        {t('loadFailed')}
      </div>
    );
  }

  return (
    <div className="border-border rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('columns.name')}</TableHead>
            <TableHead>{t('columns.email')}</TableHead>
            <TableHead>{t('columns.grantedAt')}</TableHead>
            <TableHead>{t('columns.note')}</TableHead>
            <TableHead className="text-right">{t('columns.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.operators.map((op) => {
            const self = op.userId === state.currentUserId;
            return (
              <TableRow key={op.userId}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span>{op.fullName || op.email || op.userId}</span>
                    {self ? (
                      <Badge variant="secondary">{t('you')}</Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>{op.email ?? '—'}</TableCell>
                <TableCell>{day(op.grantedAt)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {op.note ?? '—'}
                </TableCell>
                <TableCell className="text-right">
                  {self ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onRevoke(op)}
                    >
                      <UserMinus className="size-4" />
                      {t('revoke')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function PlatformOperators() {
  const t = useTranslations('Platform.operators');
  const [state, setState] = useState<OperatorsState>({ kind: 'loading' });
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/platform/operators', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        operators: OperatorRow[];
        currentUserId: string;
      };
      setState({
        kind: 'ready',
        operators: body.operators ?? [],
        currentUserId: body.currentUserId,
      });
    } catch {
      setState({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const ready =
    email.trim().length > 0 && note.trim().length >= MIN_REASON_LENGTH;

  const grant = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!ready) return;
      setBusy(true);
      try {
        const res = await fetch('/api/platform/operators', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), note: note.trim() }),
        });
        if (res.status === 404) {
          toast.error(t('notRegistered'));
          return;
        }
        if (res.status === 409) {
          toast.error(t('alreadyOperator'));
          return;
        }
        if (!res.ok) {
          toast.error(t('failed'));
          return;
        }
        toast.success(t('granted', { email: email.trim() }));
        setEmail('');
        setNote('');
        await load();
      } finally {
        setBusy(false);
      }
    },
    [email, load, note, ready, t]
  );

  const revoke = useCallback(
    async (op: OperatorRow) => {
      // The prompt IS the confirmation: cancelling it, or leaving it
      // blank, revokes nothing.
      const reason = window.prompt(
        t('revokePrompt', {
          who: op.email ?? op.fullName ?? op.userId,
          min: MIN_REASON_LENGTH,
        })
      );
      if (reason === null) return;
      if (reason.trim().length < MIN_REASON_LENGTH) {
        toast.error(t('reasonTooShort', { min: MIN_REASON_LENGTH }));
        return;
      }
      setBusy(true);
      try {
        const res = await fetch(`/api/platform/operators/${op.userId}`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() }),
        });
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;
        if (res.status === 400 && body?.code === 'last') {
          toast.error(t('lastOperator'));
          return;
        }
        if (res.status === 400 && body?.code === 'self') {
          toast.error(t('selfRevoke'));
          return;
        }
        if (!res.ok) {
          toast.error(t('failed'));
          return;
        }
        toast.success(t('revoked'));
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load, t]
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-foreground text-xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <OperatorsTable state={state} onRevoke={revoke} busy={busy} />

      <Card>
        <CardContent className="p-4">
          <form className="flex flex-col gap-3" onSubmit={grant}>
            <div>
              <h2 className="text-foreground text-sm font-semibold">
                {t('grantTitle')}
              </h2>
              <p className="text-muted-foreground text-xs">{t('grantHelp')}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="operator-email">{t('emailLabel')}</Label>
                <Input
                  id="operator-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="operator@example.com"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="operator-note">{t('noteLabel')}</Label>
                <Input
                  id="operator-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              {t('noteHelp', { min: MIN_REASON_LENGTH })}
            </p>
            <div>
              <Button type="submit" size="sm" disabled={busy || !ready}>
                <ShieldPlus className="size-4" />
                {t('grant')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
