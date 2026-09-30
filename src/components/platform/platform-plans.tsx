'use client';

// ============================================================
// /platform/plans (s9.3): the plan catalogue for the operator.
//
// Every plan, public or not, with its prices, order and — per billing
// cycle — where it stands at PayPal: «sin publicar», «sincronizado»,
// «precio desincronizado» or «verificar». Creating and editing happen in
// a dialog; publishing to PayPal is a separate button per cycle with a
// confirmation, because a price change there creates a NEW PayPal plan
// and existing customers keep paying the old price (decision 5).
//
// There is no delete. A plan that should stop being sold is unpublished.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { PLAN_FEATURES, PLAN_LIMIT_KEYS } from '@/lib/billing/plan-catalog';
import {
  emptyPlanForm,
  formToPayload,
  planToForm,
  type PlanForm,
} from './plan-form';

type Cycle = 'month' | 'year';
type SyncState = 'unpublished' | 'synced' | 'price_mismatch' | 'unknown';

interface CycleSync {
  state: SyncState;
  providerPlanId: string | null;
  syncedPrice: string | null;
}

interface HistoryEntry {
  id: string;
  cycle: Cycle;
  providerPlanId: string;
  priceUsd: string;
  providerEnv: 'sandbox' | 'live';
  createdAt: string;
  replacedAt: string | null;
}

export interface PlatformPlanView {
  id: string;
  name: string;
  description: string | null;
  priceMonth: number;
  priceYear: number | null;
  limits: Record<string, number | null>;
  features: string[];
  isPublic: boolean;
  sortOrder: number;
  sync: Record<Cycle, CycleSync>;
  history: HistoryEntry[];
}

interface Catalogue {
  providerEnv: 'sandbox' | 'live';
  paypalConfigured: boolean;
  plans: PlatformPlanView[];
}

const CYCLES: Cycle[] = ['month', 'year'];

const STATE_VARIANT: Record<
  SyncState,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  unpublished: 'outline',
  synced: 'secondary',
  price_mismatch: 'destructive',
  unknown: 'outline',
};

function usd(value: number | string | null): string {
  if (value === null || value === '') return '—';
  return `${Number(value).toFixed(2)} USD`;
}

function day(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : '—';
}

export function SyncBadge({ state }: { state: SyncState }) {
  const t = useTranslations('Platform.plans');
  return (
    <Badge variant={STATE_VARIANT[state]} data-sync-state={state}>
      {t(`state.${state}`)}
    </Badge>
  );
}

export function PlatformPlans({
  initial = null,
}: {
  /** Pre-loaded catalogue, for tests; the page loads it itself. */
  initial?: Catalogue | null;
}) {
  const t = useTranslations('Platform.plans');
  const [data, setData] = useState<Catalogue | null>(initial);
  const [loading, setLoading] = useState(initial === null);
  const [failed, setFailed] = useState(false);
  const [editor, setEditor] = useState<{
    mode: 'create' | 'edit';
    form: PlanForm;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<{
    plan: PlatformPlanView;
    cycle: Cycle;
    action: 'sync' | 'unpublish';
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch('/api/platform/plans', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as Catalogue);
    } catch {
      // Said out loud: an empty table would read as «no plans».
      setFailed(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initial === null) load();
  }, [initial, load]);

  const nextSortOrder = useMemo(
    () =>
      (data?.plans ?? []).reduce(
        (max, plan) => Math.max(max, plan.sortOrder),
        0
      ) + 1,
    [data]
  );

  function replacePlan(plan: PlatformPlanView) {
    setData((current) => {
      if (!current) return current;
      const exists = current.plans.some((p) => p.id === plan.id);
      const plans = exists
        ? current.plans.map((p) => (p.id === plan.id ? plan : p))
        : [...current.plans, plan];
      plans.sort((a, b) => a.sortOrder - b.sortOrder);
      return { ...current, plans };
    });
  }

  async function save() {
    if (!editor) return;
    const payload = formToPayload(editor.form, editor.mode);
    if (!payload.ok) {
      toast.error(
        payload.field
          ? t('errors.limit', { metric: t(`limits.${payload.field}`) })
          : t(`errors.${payload.error}`)
      );
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        editor.mode === 'create'
          ? '/api/platform/plans'
          : `/api/platform/plans/${encodeURIComponent(editor.form.id)}`,
        {
          method: editor.mode === 'create' ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload.body),
        }
      );
      const body = (await res.json().catch(() => null)) as {
        plan?: PlatformPlanView;
        error?: string;
      } | null;
      if (!res.ok || !body?.plan) {
        toast.error(
          res.status === 409
            ? t('errors.duplicate')
            : body?.error
              ? t('saveFailedWith', { error: body.error })
              : t('saveFailed')
        );
        return;
      }
      replacePlan(body.plan);
      setEditor(null);
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function sync() {
    if (!confirm) return;
    setSyncing(true);
    try {
      const res = await fetch(
        `/api/platform/plans/${encodeURIComponent(confirm.plan.id)}/sync`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cycle: confirm.cycle,
            action: confirm.action,
          }),
        }
      );
      const body = (await res.json().catch(() => null)) as {
        action?: 'noop' | 'created' | 'replaced';
        unpublished?: boolean;
        plan?: PlatformPlanView | null;
        error?: string;
      } | null;
      if (!res.ok) {
        toast.error(
          body?.error
            ? t('syncFailedWith', { error: body.error })
            : t('syncFailed')
        );
        return;
      }
      if (body?.plan) replacePlan(body.plan);
      toast.success(
        body?.unpublished
          ? t('syncDone.unpublished')
          : t(`syncDone.${body?.action ?? 'noop'}`)
      );
      setConfirm(null);
    } catch {
      toast.error(t('syncFailed'));
    } finally {
      setSyncing(false);
    }
  }

  function toggleHistory(id: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const env = data?.providerEnv ?? 'sandbox';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-foreground text-xl font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {data ? (
            <Badge
              variant={env === 'live' ? 'destructive' : 'secondary'}
              data-paypal-env={env}
            >
              {t('env', { env: t(`envName.${env}`) })}
            </Badge>
          ) : null}
          <Button
            size="sm"
            onClick={() =>
              setEditor({
                mode: 'create',
                form: emptyPlanForm(nextSortOrder),
              })
            }
            disabled={!data}
          >
            <Plus className="size-4" />
            {t('newPlan')}
          </Button>
        </div>
      </div>

      {data && !data.paypalConfigured ? (
        <div className="border-border bg-muted/40 text-muted-foreground rounded-lg border p-3 text-sm">
          {t('paypalMissing')}
        </div>
      ) : null}

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
      ) : data && data.plans.length === 0 ? (
        <p className="text-muted-foreground p-6 text-sm">{t('empty')}</p>
      ) : (
        <div className="border-border rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.plan')}</TableHead>
                <TableHead className="text-right">
                  {t('columns.priceMonth')}
                </TableHead>
                <TableHead className="text-right">
                  {t('columns.priceYear')}
                </TableHead>
                <TableHead>{t('columns.public')}</TableHead>
                <TableHead className="text-right">
                  {t('columns.order')}
                </TableHead>
                <TableHead>{t('columns.syncMonth')}</TableHead>
                <TableHead>{t('columns.syncYear')}</TableHead>
                <TableHead className="text-right">
                  {t('columns.actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.plans.map((plan) => (
                <PlanRows
                  key={plan.id}
                  plan={plan}
                  expanded={open.has(plan.id)}
                  onToggle={() => toggleHistory(plan.id)}
                  onEdit={() =>
                    setEditor({ mode: 'edit', form: planToForm(plan) })
                  }
                  onSync={(cycle) =>
                    setConfirm({ plan, cycle, action: 'sync' })
                  }
                  onUnpublish={(cycle) =>
                    setConfirm({ plan, cycle, action: 'unpublish' })
                  }
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <PlanEditor
        editor={editor}
        saving={saving}
        onChange={(form) => setEditor((e) => (e ? { ...e, form } : e))}
        onClose={() => setEditor(null)}
        onSave={save}
      />

      <Dialog
        open={confirm !== null}
        onOpenChange={(next) => !next && !syncing && setConfirm(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirm
                ? t(
                    confirm.action === 'unpublish'
                      ? 'unpublish.title'
                      : 'confirm.title',
                    {
                      plan: confirm.plan.name,
                      cycle: t(`cycle.${confirm.cycle}`),
                    }
                  )
                : null}
            </DialogTitle>
            <DialogDescription>
              {t('confirm.env', { env: t(`envName.${env}`) })}
            </DialogDescription>
          </DialogHeader>
          {confirm?.action === 'unpublish' ? (
            <p className="text-muted-foreground text-sm">
              {t('unpublish.body')}
            </p>
          ) : confirm ? (
            <div className="flex flex-col gap-2 text-sm">
              <p>
                {t('confirm.price', {
                  price: usd(
                    confirm.cycle === 'year'
                      ? confirm.plan.priceYear
                      : confirm.plan.priceMonth
                  ),
                })}
              </p>
              <p className="text-muted-foreground">
                {t('confirm.newPlanRule')}
              </p>
              {confirm.plan.sync[confirm.cycle].state === 'unknown' ? (
                <p className="text-muted-foreground">
                  {t('confirm.verifyRule')}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirm(null)}
              disabled={syncing}
            >
              {t('cancel')}
            </Button>
            <Button onClick={sync} disabled={syncing}>
              {syncing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {confirm?.action === 'unpublish'
                ? t('unpublish.action')
                : t('confirm.action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PlanRows({
  plan,
  expanded,
  onToggle,
  onEdit,
  onSync,
  onUnpublish,
}: {
  plan: PlatformPlanView;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onSync: (cycle: Cycle) => void;
  onUnpublish: (cycle: Cycle) => void;
}) {
  const t = useTranslations('Platform.plans');
  return (
    <>
      <TableRow data-plan-id={plan.id}>
        <TableCell>
          <div className="flex flex-col">
            <span className="text-foreground font-medium">{plan.name}</span>
            <span className="text-muted-foreground font-mono text-xs">
              {plan.id}
            </span>
          </div>
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {usd(plan.priceMonth)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {usd(plan.priceYear)}
        </TableCell>
        <TableCell>
          <Badge variant={plan.isPublic ? 'secondary' : 'outline'}>
            {plan.isPublic ? t('public') : t('hidden')}
          </Badge>
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {plan.sortOrder}
        </TableCell>
        {CYCLES.map((cycle) => {
          const sync = plan.sync[cycle];
          const price = cycle === 'year' ? plan.priceYear : plan.priceMonth;
          // Published, but the price is now empty or 0: syncing cannot
          // publish it (nothing free goes to PayPal); unpublishing can.
          const freeButPublished =
            sync.providerPlanId !== null && !(Number(price) > 0);
          return (
            <TableCell key={cycle}>
              <div className="flex max-w-48 flex-col items-start gap-1">
                <SyncBadge state={sync.state} />
                {freeButPublished ? (
                  <>
                    <p className="text-muted-foreground text-xs">
                      {t('hint.freeButPublished')}
                    </p>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => onUnpublish(cycle)}
                      data-unpublish-cycle={cycle}
                    >
                      {t(`unpublish.${cycle}`)}
                    </Button>
                  </>
                ) : (
                  <>
                    {sync.state === 'price_mismatch' ? (
                      <p
                        className="text-destructive text-xs"
                        data-mismatch-hint={cycle}
                      >
                        {t('hint.priceMismatch')}
                      </p>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => onSync(cycle)}
                      data-sync-cycle={cycle}
                    >
                      <RefreshCw className="size-3" />
                      {t(`sync.${cycle}`)}
                    </Button>
                  </>
                )}
              </div>
            </TableCell>
          );
        })}
        <TableCell className="text-right">
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="outline" onClick={onEdit}>
              {t('edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onToggle}
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
              {t('history.toggle')}
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow data-history-for={plan.id}>
          <TableCell colSpan={8} className="bg-muted/30">
            <p className="text-muted-foreground mb-2 text-xs">
              {t('history.note')}
            </p>
            {plan.history.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {t('history.empty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {plan.history.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap gap-x-3">
                    <span>{t(`cycle.${entry.cycle}`)}</span>
                    <span className="font-mono text-xs">
                      {entry.providerPlanId}
                    </span>
                    <span className="tabular-nums">{usd(entry.priceUsd)}</span>
                    <span>{t(`envName.${entry.providerEnv}`)}</span>
                    <span className="text-muted-foreground">
                      {entry.replacedAt
                        ? t('history.replaced', {
                            from: day(entry.createdAt),
                            to: day(entry.replacedAt),
                          })
                        : t('history.current', { from: day(entry.createdAt) })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function PlanEditor({
  editor,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  editor: { mode: 'create' | 'edit'; form: PlanForm } | null;
  saving: boolean;
  onChange: (form: PlanForm) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const t = useTranslations('Platform.plans');
  const form = editor?.form;

  function set<K extends keyof PlanForm>(key: K, value: PlanForm[K]) {
    if (form) onChange({ ...form, [key]: value });
  }

  return (
    <Dialog
      open={editor !== null}
      onOpenChange={(next) => !next && !saving && onClose()}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editor?.mode === 'create'
              ? t('editor.createTitle')
              : t('editor.editTitle')}
          </DialogTitle>
          <DialogDescription>{t('editor.priceNote')}</DialogDescription>
        </DialogHeader>

        {form ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              onSave();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-id">{t('editor.id')}</Label>
                <Input
                  id="plan-id"
                  value={form.id}
                  onChange={(e) => set('id', e.target.value)}
                  disabled={editor?.mode === 'edit'}
                  className="font-mono"
                />
                <p className="text-muted-foreground text-xs">
                  {t('editor.idHelp')}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-name">{t('editor.name')}</Label>
                <Input
                  id="plan-name"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-price-month">
                  {t('editor.priceMonth')}
                </Label>
                <Input
                  id="plan-price-month"
                  inputMode="decimal"
                  value={form.priceMonth}
                  onChange={(e) => set('priceMonth', e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-price-year">{t('editor.priceYear')}</Label>
                <Input
                  id="plan-price-year"
                  inputMode="decimal"
                  value={form.priceYear}
                  onChange={(e) => set('priceYear', e.target.value)}
                  placeholder={t('editor.priceYearEmpty')}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-order">{t('editor.sortOrder')}</Label>
                <Input
                  id="plan-order"
                  inputMode="numeric"
                  value={form.sortOrder}
                  onChange={(e) => set('sortOrder', e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <Switch
                  id="plan-public"
                  checked={form.isPublic}
                  onCheckedChange={(checked) => set('isPublic', checked)}
                />
                <Label htmlFor="plan-public">{t('editor.isPublic')}</Label>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-description">
                {t('editor.description')}
              </Label>
              <Textarea
                id="plan-description"
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                rows={2}
              />
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-foreground mb-1 text-sm font-medium">
                {t('editor.limits')}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {PLAN_LIMIT_KEYS.map((key) => {
                  const field = form.limits[key];
                  return (
                    <div
                      key={key}
                      className="flex items-center gap-2"
                      data-limit={key}
                    >
                      <Label
                        htmlFor={`limit-${key}`}
                        className="min-w-0 flex-1 text-xs"
                      >
                        {t(`limits.${key}`)}
                      </Label>
                      <Input
                        id={`limit-${key}`}
                        inputMode="numeric"
                        className="w-28"
                        value={field.unlimited ? '' : field.value}
                        disabled={field.unlimited}
                        onChange={(e) =>
                          set('limits', {
                            ...form.limits,
                            [key]: { ...field, value: e.target.value },
                          })
                        }
                      />
                      <label className="flex items-center gap-1 text-xs">
                        <Checkbox
                          checked={field.unlimited}
                          onCheckedChange={(checked) =>
                            set('limits', {
                              ...form.limits,
                              [key]: { ...field, unlimited: checked === true },
                            })
                          }
                        />
                        {t('editor.unlimited')}
                      </label>
                    </div>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-foreground mb-1 text-sm font-medium">
                {t('editor.features')}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {PLAN_FEATURES.map((feature) => (
                  <label
                    key={feature}
                    className="flex items-center gap-2 text-sm"
                    data-feature={feature}
                  >
                    <Checkbox
                      checked={form.features.includes(feature)}
                      onCheckedChange={(checked) =>
                        set(
                          'features',
                          checked === true
                            ? [...form.features, feature]
                            : form.features.filter((f) => f !== feature)
                        )
                      }
                    />
                    {t(`features.${feature}`)}
                  </label>
                ))}
              </div>
            </fieldset>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={saving}
              >
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('save')}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
