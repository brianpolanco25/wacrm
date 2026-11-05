'use client';

// ============================================================
// IntegrationsSettings — Ajustes → Integraciones (n13.1, R19).
//
// Una tarjeta por integración del catálogo activo (y por las retiradas
// que la cuenta aún tiene activadas). Cualquier miembro ve el estado;
// quien tenga `canManage` (admin+ y fuera de una sesión de soporte, D3)
// activa con su credencial, prueba la conexión, la cambia o desactiva.
//
// La credencial se teclea en un campo de contraseña, viaja una vez en el
// PUT y no vuelve: lo único que se enseña es `••••<last4>`. Al guardarla,
// la prueba se lanza sola y su resultado se dice en voz alta.
//
// n13.3: con la integración activada, «Usar en IA» (PATCH inmediato) y un
// diálogo con instrucciones para la IA y zona horaria.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Blocks, Loader2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';
import { AI_INSTRUCTIONS_MAX } from '@/lib/ai/tools/types';
import {
  IntegrationAiControls,
  type IntegrationViewWithAi,
} from './integration-ai-controls';
import {
  activateAndTest,
  cardStatus,
  credentialLabel,
  runConnectionTest,
  UPGRADE_PATH,
  visibleActions,
  type CardStatus,
  type TestOutcome,
} from './integration-card-state';
import { SettingsPanelHead } from './settings-panel-head';

type AccountIntegrationView = IntegrationViewWithAi;

const SELECT_CLASS =
  'border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Zonas IANA del navegador; la guardada va siempre aunque no esté. */
function timeZoneOptions(current: string | null): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  if (current && !zones.includes(current)) zones = [current, ...zones];
  return zones;
}

export interface IntegrationsPayload {
  integrations: AccountIntegrationView[];
  planAllows: boolean;
  canManage: boolean;
}

const STATUS_VARIANT: Record<
  CardStatus,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  active: 'default',
  inactive: 'outline',
  planRequired: 'secondary',
  retired: 'secondary',
};

export function IntegrationsSettings({
  initial = null,
}: {
  /** Datos precargados, para los tests; el panel los carga solo. */
  initial?: IntegrationsPayload | null;
}) {
  const t = useTranslations('Settings.integrations');
  const [data, setData] = useState<IntegrationsPayload | null>(initial);
  const [loading, setLoading] = useState(initial === null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<AccountIntegrationView | null>(null);
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<AccountIntegrationView | null>(
    null
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [aiEditing, setAiEditing] = useState<AccountIntegrationView | null>(
    null
  );
  const [aiInstructions, setAiInstructions] = useState('');
  const [aiTimezone, setAiTimezone] = useState('');
  const [aiSaving, setAiSaving] = useState(false);
  const zones = useMemo(
    () => (aiEditing ? timeZoneOptions(aiEditing.aiTimezone ?? null) : []),
    [aiEditing]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch('/api/account/integrations', {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as IntegrationsPayload);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initial === null) void load();
  }, [initial, load]);

  function patchView(id: string, patch: Partial<AccountIntegrationView>) {
    setData((current) =>
      current
        ? {
            ...current,
            integrations: current.integrations.map((i) =>
              i.id === id ? { ...i, ...patch } : i
            ),
          }
        : current
    );
  }

  function announce(test: TestOutcome | null) {
    if (!test) {
      toast.warning(t('testUnavailable'));
      return;
    }
    const message = t(`testResult.${test.result}`);
    if (test.result === 'ok') toast.success(message);
    else toast.error(message);
  }

  async function saveCredential() {
    if (!editing || !credential) return;
    setSaving(true);
    const result = await activateAndTest(editing.id, credential);
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error ?? t('failed'));
      return;
    }
    setCredential('');
    setEditing(null);
    if (result.integration) patchView(editing.id, result.integration);
    if (result.test) {
      patchView(editing.id, {
        lastTestStatus: result.test.result,
        lastTestedAt: result.test.testedAt,
      });
    }
    announce(result.test);
  }

  async function test(view: AccountIntegrationView) {
    setBusy(view.id);
    const outcome = await runConnectionTest(view.id);
    setBusy(null);
    if (outcome) {
      patchView(view.id, {
        lastTestStatus: outcome.result,
        lastTestedAt: outcome.testedAt,
      });
    }
    announce(outcome);
  }

  async function deactivate() {
    if (!confirming) return;
    const view = confirming;
    setBusy(view.id);
    try {
      const res = await fetch(
        `/api/account/integrations/${encodeURIComponent(view.id)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(body?.error ?? t('failed'));
        return;
      }
      patchView(view.id, {
        enabled: false,
        credentialLast4: null,
        enabledAt: null,
        lastTestedAt: null,
        lastTestStatus: null,
        aiEnabled: false,
        aiInstructions: null,
        aiTimezone: null,
      });
      setConfirming(null);
      toast.success(t('deactivated'));
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(null);
    }
  }

  /** PATCH de los ajustes de IA (n13.3, R32). */
  async function patchAi(
    view: AccountIntegrationView,
    body: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `/api/account/integrations/${encodeURIComponent(view.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        integration?: AccountIntegrationView | null;
        error?: string;
      } | null;
      if (!res.ok) {
        toast.error(data?.error ?? t('aiSaveFailed'));
        return false;
      }
      if (data?.integration) patchView(view.id, data.integration);
      toast.success(t('aiSaved'));
      return true;
    } catch {
      toast.error(t('aiSaveFailed'));
      return false;
    }
  }

  async function toggleAi(view: AccountIntegrationView, next: boolean) {
    setBusy(view.id);
    await patchAi(view, { aiEnabled: next });
    setBusy(null);
  }

  async function saveAiSettings() {
    if (!aiEditing) return;
    setAiSaving(true);
    const ok = await patchAi(aiEditing, {
      aiInstructions,
      aiTimezone: aiTimezone || null,
    });
    setAiSaving(false);
    if (ok) setAiEditing(null);
  }

  const label = editing ? credentialLabel(editing) : null;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('desc')} />

      {failed ? (
        <p className="text-destructive text-sm">{t('loadFailed')}</p>
      ) : loading || !data ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('loading')}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {!data.planAllows ? (
            <div
              className="border-border bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              data-plan-required
            >
              <span>{t('planRequired')}</span>
              <Link
                href={UPGRADE_PATH}
                className="text-primary font-medium hover:underline"
              >
                {t('upgrade')}
              </Link>
            </div>
          ) : null}
          {!data.canManage ? (
            <p className="text-muted-foreground text-sm" data-read-only>
              {t('readOnly')}
            </p>
          ) : null}
          {data.integrations.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('empty')}</p>
          ) : null}
          {data.integrations.map((view) => (
            <IntegrationCard
              key={view.id}
              view={view}
              planAllows={data.planAllows}
              canManage={data.canManage}
              busy={busy === view.id}
              onActivate={() => {
                setCredential('');
                setEditing(view);
              }}
              onTest={() => void test(view)}
              onDeactivate={() => setConfirming(view)}
              onToggleAi={(next) => void toggleAi(view, next)}
              onEditAi={() => {
                setAiInstructions(view.aiInstructions ?? '');
                setAiTimezone(view.aiTimezone ?? '');
                setAiEditing(view);
              }}
            />
          ))}
        </div>
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next && !saving) {
            setEditing(null);
            setCredential('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? t('activateTitle', { name: editing.name }) : null}
            </DialogTitle>
            {editing?.credentialHelp ? (
              <DialogDescription>{editing.credentialHelp}</DialogDescription>
            ) : null}
          </DialogHeader>
          <form
            id="integration-credential"
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void saveCredential();
            }}
          >
            <Label htmlFor="integration-credential-input">
              {label?.key === 'credentialLabelHeader'
                ? t('credentialLabelHeader', { header: label.header })
                : t('credentialLabelBearer')}
            </Label>
            <Input
              id="integration-credential-input"
              type="password"
              autoComplete="off"
              maxLength={4096}
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
            />
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => {
                setEditing(null);
                setCredential('');
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              form="integration-credential"
              disabled={saving || credential.length === 0}
              aria-busy={saving}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={aiEditing !== null}
        onOpenChange={(next) => {
          if (!next && !aiSaving) setAiEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {aiEditing
                ? t('aiInstructionsTitle', { name: aiEditing.name })
                : null}
            </DialogTitle>
            <DialogDescription>{t('aiInstructionsDesc')}</DialogDescription>
          </DialogHeader>
          <form
            id="integration-ai-settings"
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void saveAiSettings();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="integration-ai-instructions">
                {t('aiInstructionsLabel')}
              </Label>
              <Textarea
                id="integration-ai-instructions"
                rows={5}
                maxLength={AI_INSTRUCTIONS_MAX}
                placeholder={t('aiInstructionsPlaceholder')}
                value={aiInstructions}
                onChange={(e) => setAiInstructions(e.target.value)}
              />
              <p
                className="text-muted-foreground self-end text-xs"
                aria-live="polite"
              >
                {t('aiInstructionsCount', { count: aiInstructions.length })}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="integration-ai-timezone">
                {t('aiTimezoneLabel')}
              </Label>
              <select
                id="integration-ai-timezone"
                className={SELECT_CLASS}
                value={aiTimezone}
                onChange={(e) => setAiTimezone(e.target.value)}
              >
                <option value="">{t('aiTimezoneNone')}</option>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
              <p className="text-muted-foreground text-xs">
                {t('aiTimezoneHint')}
              </p>
            </div>
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={aiSaving}
              onClick={() => setAiEditing(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              form="integration-ai-settings"
              disabled={aiSaving}
              aria-busy={aiSaving}
            >
              {aiSaving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirming !== null}
        onOpenChange={(next) => !next && busy === null && setConfirming(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirming
                ? t('deactivateTitle', { name: confirming.name })
                : null}
            </DialogTitle>
            <DialogDescription>
              {confirming
                ? t('deactivateConfirm', { name: confirming.name })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => setConfirming(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== null}
              aria-busy={busy !== null}
              onClick={() => void deactivate()}
            >
              {t('deactivate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function IntegrationCard({
  view,
  planAllows,
  canManage,
  busy,
  onActivate,
  onTest,
  onDeactivate,
  onToggleAi,
  onEditAi,
}: {
  view: AccountIntegrationView;
  planAllows: boolean;
  canManage: boolean;
  busy: boolean;
  onActivate: () => void;
  onTest: () => void;
  onDeactivate: () => void;
  onToggleAi: (next: boolean) => void;
  onEditAi: () => void;
}) {
  const t = useTranslations('Settings.integrations');
  const format = useFormatter();
  const status = cardStatus(view, planAllows);
  const actions = visibleActions(view, { planAllows, canManage });

  return (
    <Card data-integration-card={view.slug} data-status={status}>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          {view.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo https del operador, sin optimizar
            <img
              src={view.logoUrl}
              alt=""
              className="size-10 shrink-0 rounded-lg object-contain"
            />
          ) : (
            <span
              aria-hidden
              className="bg-primary-soft text-primary flex size-10 shrink-0 items-center justify-center rounded-lg text-base font-semibold"
            >
              {view.name.charAt(0).toUpperCase() || (
                <Blocks className="size-4" />
              )}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-foreground text-sm font-semibold">
                {view.name}
              </h3>
              <Badge variant={STATUS_VARIANT[status]}>
                {t(`status.${status}`)}
              </Badge>
            </div>
            {view.description ? (
              <p className="text-muted-foreground mt-1 text-sm">
                {view.description}
              </p>
            ) : null}
          </div>
        </div>

        {view.operations.length > 0 ? (
          <div>
            <p className="text-muted-foreground text-xs font-medium">
              {t('operations')}
            </p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {view.operations.map((op) => (
                <li key={op.key}>
                  <Badge variant="outline" title={op.description}>
                    {op.name}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {view.enabled ? (
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span data-credential-mask>
              {view.credentialLast4
                ? t('credentialSaved', { last4: view.credentialLast4 })
                : t('credentialSavedHidden')}
            </span>
            {view.lastTestedAt && view.lastTestStatus ? (
              <span data-last-test={view.lastTestStatus}>
                {t('lastTested', {
                  when: format.dateTime(new Date(view.lastTestedAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })}{' '}
                · {t(`testResult.${view.lastTestStatus}`)}
              </span>
            ) : null}
          </div>
        ) : null}

        <IntegrationAiControls
          integration={view}
          disabled={!canManage || !planAllows || view.retired || busy}
          onToggle={onToggleAi}
          onEdit={onEditAi}
        />

        {actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {actions.includes('activate') ? (
              <Button size="sm" onClick={onActivate} data-action="activate">
                {t('activate')}
              </Button>
            ) : null}
            {actions.includes('test') ? (
              <Button
                size="sm"
                variant="outline"
                onClick={onTest}
                disabled={busy}
                aria-busy={busy}
                data-action="test"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {busy ? t('testing') : t('test')}
              </Button>
            ) : null}
            {actions.includes('change') ? (
              <Button
                size="sm"
                variant="outline"
                onClick={onActivate}
                data-action="change"
              >
                {t('change')}
              </Button>
            ) : null}
            {actions.includes('deactivate') ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={onDeactivate}
                disabled={busy}
                data-action="deactivate"
              >
                {t('deactivate')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
