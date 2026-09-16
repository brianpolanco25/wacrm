'use client';

// ============================================================
// WebhooksSettings — Ajustes → Webhooks
//
// Los endpoints a los que empujamos los eventos de la cuenta. Cualquier
// miembro ve la lista y la bitácora de entregas (diagnóstico); crear,
// editar, borrar, probar y rotar el secreto es de admin+, exigido por
// <RequireRole>, por las rutas y por la RLS de la 028.
//
// Dos cosas que la interfaz tiene que decir en voz alta:
//   - el secreto de firma se enseña UNA vez (al crear y al rotar). No
//     hay «volver a copiar» porque el servidor solo guarda la copia
//     cifrada; la salida es rotar.
//   - una entrega fallida se reintenta sola (1 min, 5 min, 30 min, 2 h,
//     12 h) y el endpoint se desactiva solo tras 15 fallos seguidos.
//     Sin eso, «failed» parecería «perdido».
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  BookOpen,
  Copy,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Webhook,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_DESCRIPTIONS,
  type WebhookEvent,
} from '@/lib/webhooks/events';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * La guía de webhooks de la sección pública `/developers` (fase 7 §7):
 * firma, reintentos y receptores de ejemplo en Node, Python y PHP. Es
 * pública, así que el enlace funciona igual para quien no tiene sesión
 * en este navegador (un compañero al que le pasas la URL).
 */
const WEBHOOK_DOCS_URL = '/developers/guides/webhooks';

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  last_delivery_at: string | null;
  failure_count: number;
  created_at: string;
}

interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event: string;
  attempt: number;
  status: 'pending' | 'delivered' | 'failed' | 'dead';
  next_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WebhooksSettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.webhooks');

  const [hooks, setHooks] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookEndpoint | null>(
    null
  );
  const [revealed, setRevealed] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/webhooks', { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const data = (await res.json()) as { webhooks: WebhookEndpoint[] };
      setHooks(data.webhooks);
    } catch (err) {
      console.error('[WebhooksSettings] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patchHook(
    hook: WebhookEndpoint,
    body: Record<string, unknown>
  ) {
    setBusy(hook.id);
    try {
      const res = await fetch(`/api/account/webhooks/${hook.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('updateFailed'));
        return false;
      }
      setHooks((prev) =>
        prev.map((h) => (h.id === hook.id ? payload.webhook : h))
      );
      return true;
    } catch (err) {
      console.error('[WebhooksSettings] patch error:', err);
      toast.error(t('networkError'));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(hook: WebhookEndpoint) {
    setBusy(hook.id);
    try {
      const res = await fetch(`/api/account/webhooks/${hook.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('deleteFailed'));
        return;
      }
      setHooks((prev) => prev.filter((h) => h.id !== hook.id));
      toast.success(t('deleteSuccess'));
    } catch (err) {
      console.error('[WebhooksSettings] delete error:', err);
      toast.error(t('networkError'));
    } finally {
      setBusy(null);
    }
  }

  async function handleTest(hook: WebhookEndpoint) {
    setBusy(hook.id);
    try {
      const res = await fetch(`/api/account/webhooks/${hook.id}/test`, {
        method: 'POST',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('testFailed'));
        return;
      }
      if (payload.result === 'delivered') {
        toast.success(t('testSuccess'));
      } else {
        toast.error(
          t('testRejected', {
            detail: payload.delivery?.last_error ?? t('unknownError'),
          })
        );
      }
      void load();
    } catch (err) {
      console.error('[WebhooksSettings] test error:', err);
      toast.error(t('networkError'));
    } finally {
      setBusy(null);
    }
  }

  async function handleRotate(hook: WebhookEndpoint) {
    setBusy(hook.id);
    try {
      const res = await fetch(
        `/api/account/webhooks/${hook.id}/rotate-secret`,
        {
          method: 'POST',
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('rotateFailed'));
        return;
      }
      setRevealed(payload.secret as string);
    } catch (err) {
      console.error('[WebhooksSettings] rotate error:', err);
      toast.error(t('networkError'));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('newWebhook')}
            </Button>
          </RequireRole>
        }
      />

      <a
        href={WEBHOOK_DOCS_URL}
        className="text-primary inline-flex items-center gap-1.5 text-sm underline underline-offset-2"
      >
        <BookOpen className="size-4" aria-hidden="true" />
        {t('docsLink')}
      </a>

      {hooks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Webhook className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">
              {t('noWebhooks')}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {canEditSettings ? t('createOneHint') : t('askAdminHint')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {hooks.map((hook) => (
                <li
                  key={hook.id}
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`truncate font-mono text-sm ${
                          hook.is_active
                            ? 'text-foreground'
                            : 'text-muted-foreground line-through'
                        }`}
                      >
                        {hook.url}
                      </span>
                      {!hook.is_active && (
                        <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                          {t('inactive')}
                        </Badge>
                      )}
                    </div>

                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {hook.events.map((e) => (
                        <Badge
                          key={e}
                          className="border-border bg-muted text-muted-foreground text-[10px]"
                        >
                          {e}
                        </Badge>
                      ))}
                    </div>

                    <p className="text-muted-foreground mt-1.5 text-xs">
                      {hook.last_delivery_at
                        ? t('lastDelivery', {
                            date: fmtDateTime(hook.last_delivery_at),
                          })
                        : t('neverDelivered')}
                      {hook.failure_count > 0
                        ? ` · ${t('failures', { count: hook.failure_count })}`
                        : ''}
                    </p>
                    {!hook.is_active && hook.failure_count > 0 ? (
                      <p className="mt-1 text-xs text-amber-500">
                        {t('autoDisabled')}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeliveriesFor(hook)}
                    >
                      {t('deliveries')}
                    </Button>
                    <RequireRole min="admin">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === hook.id}
                          onClick={() => handleTest(hook)}
                        >
                          <Send className="size-4" />
                          {t('test')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditing(hook)}
                        >
                          {t('edit')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === hook.id}
                          onClick={() =>
                            patchHook(hook, { is_active: !hook.is_active })
                          }
                        >
                          {hook.is_active ? t('disable') : t('enable')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === hook.id}
                          onClick={() => {
                            if (window.confirm(t('rotateConfirm')))
                              void handleRotate(hook);
                          }}
                        >
                          <RefreshCw className="size-4" />
                          {t('rotate')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === hook.id}
                          onClick={() => {
                            if (window.confirm(t('deleteConfirm')))
                              void handleDelete(hook);
                          }}
                          className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                        >
                          <Trash2 className="size-4" />
                          {t('delete')}
                        </Button>
                      </div>
                    </RequireRole>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <WebhookFormDialog
        open={createOpen || editing !== null}
        endpoint={editing}
        onOpenChange={(next) => {
          if (!next) {
            setCreateOpen(false);
            setEditing(null);
          }
        }}
        onSaved={(secret) => {
          void load();
          if (secret) setRevealed(secret);
        }}
      />

      <SecretDialog secret={revealed} onClose={() => setRevealed(null)} />

      <DeliveriesDialog
        endpoint={deliveriesFor}
        onClose={() => setDeliveriesFor(null)}
      />
    </section>
  );
}

// ------------------------------------------------------------
// Alta / edición. El mismo formulario: crear devuelve secreto, editar no.
// ------------------------------------------------------------

function WebhookFormDialog({
  open,
  endpoint,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  endpoint: WebhookEndpoint | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (secret: string | null) => void;
}) {
  const t = useTranslations('Settings.webhooks');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUrl(endpoint?.url ?? '');
    setEvents((endpoint?.events ?? []) as WebhookEvent[]);
  }, [open, endpoint]);

  function toggleEvent(event: WebhookEvent, checked: boolean) {
    setEvents((prev) =>
      checked ? [...prev, event] : prev.filter((e) => e !== event)
    );
  }

  async function handleSubmit() {
    const trimmed = url.trim();
    if (!trimmed.startsWith('https://')) {
      toast.error(t('urlRequired'));
      return;
    }
    if (events.length === 0) {
      toast.error(t('eventsRequired'));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        endpoint
          ? `/api/account/webhooks/${endpoint.id}`
          : '/api/account/webhooks',
        {
          method: endpoint ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmed, events }),
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      onSaved((payload.secret as string | undefined) ?? null);
      onOpenChange(false);
    } catch (err) {
      console.error('[WebhookFormDialog] submit error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {endpoint ? t('editTitle') : t('newTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('formDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="webhook-url" className="text-muted-foreground">
              {t('urlLabel')}
            </Label>
            <Input
              id="webhook-url"
              value={url}
              placeholder="https://api.example.com/wacrm"
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('eventsLabel')}</Label>
            <div className="border-border max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
              {WEBHOOK_EVENTS.map((event) => (
                <label
                  key={event}
                  className="flex cursor-pointer items-start gap-2.5"
                >
                  <Checkbox
                    checked={events.includes(event)}
                    onCheckedChange={(checked) =>
                      toggleEvent(event, checked === true)
                    }
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="text-foreground block font-mono text-xs">
                      {event}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {WEBHOOK_EVENT_DESCRIPTIONS[event]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Revelado del secreto: una sola vez, al crear y al rotar.
// ------------------------------------------------------------

function SecretDialog({
  secret,
  onClose,
}: {
  secret: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('Settings.webhooks');

  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  return (
    <Dialog open={secret !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('secretTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('secretDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label className="text-muted-foreground">{t('secretLabel')}</Label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={secret ?? ''}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button type="button" variant="outline" onClick={copy}>
              <Copy className="size-4" />
              {t('copy')}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Bitácora de entregas: estado, código, error y reintento manual.
// ------------------------------------------------------------

function DeliveriesDialog({
  endpoint,
  onClose,
}: {
  endpoint: WebhookEndpoint | null;
  onClose: () => void;
}) {
  const t = useTranslations('Settings.webhooks');
  const [rows, setRows] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!endpoint) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/account/webhooks/${endpoint.id}/deliveries?limit=20`,
        { cache: 'no-store' }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('deliveriesFailed'));
        return;
      }
      setRows(payload.deliveries as WebhookDelivery[]);
    } catch (err) {
      console.error('[DeliveriesDialog] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [endpoint, t]);

  useEffect(() => {
    if (endpoint) void load();
    else setRows([]);
  }, [endpoint, load]);

  async function retry(delivery: WebhookDelivery) {
    if (!endpoint) return;
    setRetrying(delivery.id);
    try {
      const res = await fetch(
        `/api/account/webhooks/${endpoint.id}/deliveries/${delivery.id}/retry`,
        { method: 'POST' }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('retryFailed'));
        return;
      }
      toast.success(
        payload.result === 'delivered' ? t('retrySuccess') : t('retryStill')
      );
      void load();
    } catch (err) {
      console.error('[DeliveriesDialog] retry error:', err);
      toast.error(t('networkError'));
    } finally {
      setRetrying(null);
    }
  }

  return (
    <Dialog
      open={endpoint !== null}
      onOpenChange={(next) => !next && onClose()}
    >
      <DialogContent className="border-border bg-popover sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('deliveriesTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('deliveriesDesc')}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-primary size-5 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t('noDeliveries')}
          </p>
        ) : (
          <ul className="divide-border max-h-96 divide-y overflow-y-auto">
            {rows.map((d) => (
              <li
                key={d.id}
                className="flex items-start justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground font-mono text-xs">
                      {d.event}
                    </span>
                    <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                      {t(`status.${d.status}`)}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {fmtDateTime(d.created_at)}
                    {' · '}
                    {t('attempt', { n: d.attempt })}
                    {d.last_status_code ? ` · HTTP ${d.last_status_code}` : ''}
                  </p>
                  {d.last_error ? (
                    <p className="mt-0.5 truncate text-xs text-red-400">
                      {d.last_error}
                    </p>
                  ) : null}
                  {d.status === 'failed' && d.next_attempt_at ? (
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {t('nextAttempt', {
                        date: fmtDateTime(d.next_attempt_at),
                      })}
                    </p>
                  ) : null}
                </div>

                <RequireRole min="admin">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={retrying === d.id || d.status === 'pending'}
                    onClick={() => retry(d)}
                  >
                    {retrying === d.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      t('retry')
                    )}
                  </Button>
                </RequireRole>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
