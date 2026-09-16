'use client';

// ============================================================
// ApiKeysSettings — Settings → API keys
//
// Manage the credentials that authenticate the public REST API
// (`/api/v1/*`). Any member sees the roster (read-only); admin+ can
// mint and revoke (gated by <RequireRole min="admin"> here and the
// admin-only API routes + RLS on the server).
//
// One-time reveal: a freshly-minted key's plaintext is shown ONCE in
// the creation dialog. After it closes, only the prefix remains —
// the server stores just the hash. The UI states this explicitly so
// the absence of a "copy again" button reads as intentional, not a
// bug (same lesson as the invite-link flow).
//
// Fase 7 §1 adds the two things that make a credential manageable over
// time: an optional EXPIRY at creation, and ROTATION — mint the
// replacement now, let the old one keep working for 24 h. A key inside
// that window shows as "rotating" with its deadline, because "revoked"
// would be a lie (it still authenticates) and showing nothing would
// leave an admin wondering why the roster has two keys with one name.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import {
  API_SCOPES,
  SCOPE_DESCRIPTIONS,
  type ApiScope,
} from '@/lib/api-keys/scopes';
import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** The grace window is measured in hours, so the hour has to show. */
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type KeyStatus = 'active' | 'rotating' | 'revoked' | 'expired';

/**
 * Mirrors the server's liveness rules in `findActiveKeyByHash`: a
 * `revoked_at` in the FUTURE is a rotation grace window, not a dead
 * key. Keep the two in step — a badge that says "revoked" while the
 * key still works is worse than no badge.
 */
function keyStatus(k: ApiKey): KeyStatus {
  const now = Date.now();
  if (k.revoked_at) {
    return new Date(k.revoked_at).getTime() <= now ? 'revoked' : 'rotating';
  }
  if (k.expires_at && new Date(k.expires_at).getTime() <= now) return 'expired';
  return 'active';
}

/**
 * Expiry choices offered at creation, in days. `0` means "never" — the
 * historical behaviour and still the default, because silently putting
 * a clock on existing habits would break integrations nobody warned.
 */
const EXPIRY_CHOICES = [0, 30, 90, 365] as const;

/** Where the public API is documented (fase 7 §7 builds this page). */
const DEVELOPERS_URL = '/developers';

export function ApiKeysSettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.apiKeys');

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [rotatingKey, setRotatingKey] = useState<ApiKey | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/api-keys', { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const data = (await res.json()) as { keys: ApiKey[] };
      setKeys(data.keys);
    } catch (err) {
      console.error('[ApiKeysSettings] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRevoke(key: ApiKey) {
    setRevoking(key.id);
    try {
      const res = await fetch(`/api/account/api-keys/${key.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('revokeFailed'));
        return;
      }
      toast.success(t('revokeSuccess', { name: key.name }));
      // Reflect the revoke locally without a refetch.
      setKeys((prev) =>
        prev.map((k) =>
          k.id === key.id ? { ...k, revoked_at: new Date().toISOString() } : k
        )
      );
    } catch (err) {
      console.error('[ApiKeysSettings] revoke error:', err);
      toast.error(t('networkError'));
    } finally {
      setRevoking(null);
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
        description={t.rich('description', {
          apiCode: (chunks: React.ReactNode) => (
            <code className="text-xs">{chunks}</code>
          ),
          headerCode: (chunks: React.ReactNode) => (
            <code className="text-xs">{chunks}</code>
          ),
          docs: (chunks: React.ReactNode) => (
            <a
              href={DEVELOPERS_URL}
              className="text-primary underline underline-offset-2"
            >
              {chunks}
            </a>
          ),
        })}
        action={
          <RequireRole min="admin">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('newApiKey')}
            </Button>
          </RequireRole>
        }
      />

      {keys.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <KeyRound className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">
              {t('noApiKeys')}
            </p>
            {canEditSettings ? (
              <p className="text-muted-foreground mt-1 text-xs">
                {t.rich('createOneHint', {
                  bold: (chunks: React.ReactNode) => (
                    <span className="text-foreground">{chunks}</span>
                  ),
                })}
              </p>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">
                {t('askAdminHint')}
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {keys.map((k) => {
                const status = keyStatus(k);
                // "Rotating" is still a working credential, so it is not
                // struck through — only genuinely dead keys are.
                const inactive = status === 'revoked' || status === 'expired';
                return (
                  <li
                    key={k.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`truncate text-sm font-medium ${
                            inactive
                              ? 'text-muted-foreground line-through'
                              : 'text-foreground'
                          }`}
                        >
                          {k.name}
                        </span>
                        {status === 'revoked' && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            {t('revoked')}
                          </Badge>
                        )}
                        {status === 'expired' && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            {t('expired')}
                          </Badge>
                        )}
                        {status === 'rotating' && (
                          <Badge className="border-amber-500/40 bg-amber-500/10 text-[10px] tracking-wide text-amber-300 uppercase">
                            {t('rotating')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                        {k.key_prefix}…
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {k.scopes.length === 0 ? (
                          <span className="text-muted-foreground text-xs">
                            {t('noScopes')}
                          </span>
                        ) : (
                          k.scopes.map((s) => (
                            <Badge
                              key={s}
                              className="border-border bg-muted text-muted-foreground text-[10px]"
                            >
                              {s}
                            </Badge>
                          ))
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1.5 text-xs">
                        {t('created', { date: fmtDate(k.created_at) })}
                        {' · '}
                        {k.last_used_at
                          ? t('lastUsed', { date: fmtDate(k.last_used_at) })
                          : t('neverUsed')}
                        {k.expires_at && status !== 'expired'
                          ? ` · ${t('expires', { date: fmtDate(k.expires_at) })}`
                          : ''}
                      </p>
                      {status === 'rotating' && k.revoked_at && (
                        <p className="mt-1 text-xs text-amber-300">
                          {t('rotatingHint', {
                            date: fmtDateTime(k.revoked_at),
                          })}
                        </p>
                      )}
                    </div>

                    {(status === 'active' || status === 'rotating') && (
                      <RequireRole min="admin">
                        <div className="flex gap-2 self-start sm:self-auto">
                          {status === 'active' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setRotatingKey(k)}
                            >
                              <RefreshCw className="size-4" />
                              {t('rotate')}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRevoke(k)}
                            disabled={revoking === k.id}
                            className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                          >
                            {revoking === k.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                            {status === 'rotating'
                              ? t('revokeNow')
                              : t('revoke')}
                          </Button>
                        </div>
                      </RequireRole>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={load}
      />

      <RotateKeyDialog
        apiKey={rotatingKey}
        onOpenChange={(open) => {
          if (!open) setRotatingKey(null);
        }}
        onRotated={load}
      />
    </section>
  );
}

// ------------------------------------------------------------
// Create dialog — form → one-time plaintext reveal.
// ------------------------------------------------------------

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const t = useTranslations('Settings.apiKeys');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // Once set, we switch from the form to the reveal view.
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  function reset() {
    setName('');
    setScopes([]);
    setExpiresInDays(0);
    setSubmitting(false);
    setCreatedKey(null);
  }

  function toggleScope(scope: ApiScope, checked: boolean) {
    setScopes((prev) =>
      checked ? [...prev, scope] : prev.filter((s) => s !== scope)
    );
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t('nameRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, scopes, expiresInDays }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('createError'));
        return;
      }
      setCreatedKey(payload.plaintext as string);
      onCreated();
    } catch (err) {
      console.error('[CreateKeyDialog] create error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t('copyTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('copyDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground">
                {t('apiKeyLabel')}
              </Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={createdKey}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={copyKey}>
                  <Copy className="size-4" />
                  {t('copy')}
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                {t('done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t('newKeyTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('newKeyDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="api-key-name" className="text-muted-foreground">
                  {t('nameLabel')}
                </Label>
                <Input
                  id="api-key-name"
                  value={name}
                  maxLength={80}
                  placeholder={t('namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('scopesLabel')}
                </Label>
                <div className="border-border space-y-2 rounded-md border p-3">
                  {API_SCOPES.map((scope) => (
                    <label
                      key={scope}
                      className="flex cursor-pointer items-start gap-2.5"
                    >
                      <Checkbox
                        checked={scopes.includes(scope)}
                        onCheckedChange={(checked) =>
                          toggleScope(scope, checked === true)
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="text-foreground block font-mono text-xs">
                          {scope}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {SCOPE_DESCRIPTIONS[scope]}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  {t.rich('scopesHint', {
                    code: (chunks: React.ReactNode) => (
                      <code className="text-[11px]">{chunks}</code>
                    ),
                  })}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-muted-foreground">
                  {t('expiryLabel')}
                </Label>
                <Select
                  value={String(expiresInDays)}
                  onValueChange={(v) => setExpiresInDays(Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_CHOICES.map((days) => (
                      <SelectItem key={days} value={String(days)}>
                        {days === 0
                          ? t('expiryNever')
                          : t('expiryDays', { days })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  {t('expiryHint')}
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('creating')}
                  </>
                ) : (
                  t('createKey')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Rotate dialog — confirm, then reveal the replacement once.
//
// Two screens, like creation: a confirmation that spells out what
// happens to the OLD key (it keeps working for 24 h, then stops), and
// the one-time reveal of the new plaintext. The deadline is shown as a
// date and time because 24 h is a deadline someone has to plan around.
// ------------------------------------------------------------

function RotateKeyDialog({
  apiKey,
  onOpenChange,
  onRotated,
}: {
  apiKey: ApiKey | null;
  onOpenChange: (open: boolean) => void;
  onRotated: () => void;
}) {
  const t = useTranslations('Settings.apiKeys');
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{
    plaintext: string;
    revokedAt: string;
  } | null>(null);

  function close() {
    setCreated(null);
    setSubmitting(false);
    onOpenChange(false);
  }

  async function handleRotate() {
    if (!apiKey) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/account/api-keys/${apiKey.id}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('rotateFailed'));
        return;
      }
      setCreated({
        plaintext: payload.plaintext as string,
        revokedAt: payload.previous?.revoked_at as string,
      });
      onRotated();
    } catch (err) {
      console.error('[RotateKeyDialog] rotate error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyKey() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.plaintext);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  return (
    <Dialog
      open={apiKey !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t('rotateDoneTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {created.revokedAt
                  ? t('rotateDoneDesc', {
                      date: fmtDateTime(created.revokedAt),
                    })
                  : t('copyDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground">
                {t('apiKeyLabel')}
              </Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={created.plaintext}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={copyKey}>
                  <Copy className="size-4" />
                  {t('copy')}
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button onClick={close}>{t('done')}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t('rotateTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('rotateDesc', { name: apiKey?.name ?? '' })}
              </DialogDescription>
            </DialogHeader>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={close}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button onClick={handleRotate} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('rotateInProgress')}
                  </>
                ) : (
                  t('rotateConfirm')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
