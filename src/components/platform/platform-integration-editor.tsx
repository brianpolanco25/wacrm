'use client';

// ============================================================
// /platform/integrations/[id] (n13.1, R11): el formulario de una
// integración y la lista editable de sus operaciones, cada una con sus
// filas de parámetros y salidas.
//
// No hay borrado (R10): ni la integración ni una operación se eliminan;
// se desactivan con su interruptor. Todo lo valida el servidor otra vez;
// un 400 trae el `field`, que aquí se traduce a la etiqueta del campo.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, Plus, ShieldAlert, Trash2 } from 'lucide-react';

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
import { Textarea } from '@/components/ui/textarea';
import {
  AUTH_SCHEMES,
  HTTP_METHODS,
  OUTPUT_TYPES,
  PARAM_LOCATIONS,
  PARAM_TYPES,
  type HttpMethod,
  type IntegrationRow,
  type OperationRow,
  type OutputType,
  type ParamLocation,
  type ParamType,
} from '@/lib/integrations/types';
import {
  emptyOperationForm,
  emptyOutputRow,
  emptyParamRow,
  integrationFormToBody,
  integrationToForm,
  operationFormToBody,
  operationToForm,
  type IntegrationForm,
  type OperationForm,
} from './integration-form';

export const SELECT_CLASS =
  'border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

export interface PlatformIntegrationDetailView extends IntegrationRow {
  operations: OperationRow[];
}

/** `field` del servidor → clave de la etiqueta en `Platform.integrations`. */
const INTEGRATION_FIELD_LABEL: Record<string, string> = {
  slug: 'form.slug',
  name: 'form.name',
  description: 'form.description',
  logo_url: 'form.logoUrl',
  base_url: 'form.baseUrl',
  auth_scheme: 'form.authScheme',
  auth_header_name: 'form.headerName',
  credential_help: 'form.credentialHelp',
  test_path: 'form.testPath',
  sort_order: 'form.sortOrder',
};
const OPERATION_FIELD_LABEL: Record<string, string> = {
  key: 'operations.key',
  name: 'operations.name',
  description: 'operations.description',
  method: 'operations.method',
  path: 'operations.path',
  params: 'operations.params',
  outputs: 'operations.outputs',
  response_description: 'operations.responseDescription',
  sort_order: 'operations.sortOrder',
};

type T = ReturnType<typeof useTranslations>;

export function fieldError(
  t: T,
  field: string | undefined,
  labels: Record<string, string>
): string {
  const label = field ? labels[field] : undefined;
  return label ? t('errors.field', { field: t(label) }) : t('errors.failed');
}

/** Envía un cuerpo y traduce la respuesta a éxito o a un toast. */
async function send<R>(
  t: T,
  url: string,
  method: 'POST' | 'PATCH',
  body: Record<string, unknown>,
  labels: Record<string, string>,
  /** Devuelve true si se ocupó de la respuesta (no se avisa nada más). */
  intercept?: (status: number, json: Record<string, unknown> | null) => boolean
): Promise<R | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      (R & { field?: string }) | null;
    if (intercept?.(res.status, json as Record<string, unknown> | null)) {
      return null;
    }
    if (res.status === 409) {
      toast.error(t('errors.exists'));
      return null;
    }
    if (!res.ok || !json) {
      toast.error(
        res.status === 400
          ? fieldError(t, json?.field, labels)
          : t('errors.failed')
      );
      return null;
    }
    return json;
  } catch {
    toast.error(t('errors.failed'));
    return null;
  }
}

export function IntegrationFields({
  form,
  mode,
  onChange,
}: {
  form: IntegrationForm;
  mode: 'create' | 'edit';
  onChange: (form: IntegrationForm) => void;
}) {
  const t = useTranslations('Platform.integrations');
  const set = <K extends keyof IntegrationForm>(k: K, v: IntegrationForm[K]) =>
    onChange({ ...form, [k]: v });

  return (
    <div className="grid gap-4 sm:grid-cols-2" data-integration-fields={mode}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="int-name">{t('form.name')}</Label>
        <Input
          id="int-name"
          value={form.name}
          maxLength={80}
          onChange={(e) => set('name', e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="int-slug">{t('form.slug')}</Label>
        <Input
          id="int-slug"
          value={form.slug}
          maxLength={40}
          disabled={mode === 'edit'}
          className="font-mono"
          onChange={(e) => set('slug', e.target.value)}
        />
        <p className="text-muted-foreground text-xs">{t('form.slugHelp')}</p>
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="int-description">{t('form.description')}</Label>
        <Textarea
          id="int-description"
          value={form.description}
          maxLength={500}
          rows={2}
          onChange={(e) => set('description', e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="int-base-url">{t('form.baseUrl')}</Label>
        <Input
          id="int-base-url"
          value={form.baseUrl}
          placeholder="https://"
          className="font-mono"
          onChange={(e) => set('baseUrl', e.target.value)}
        />
        <p className="text-muted-foreground text-xs">{t('form.baseUrlHelp')}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="int-auth">{t('form.authScheme')}</Label>
        <select
          id="int-auth"
          className={SELECT_CLASS}
          value={form.authScheme}
          onChange={(e) =>
            set('authScheme', e.target.value as IntegrationForm['authScheme'])
          }
        >
          {AUTH_SCHEMES.map((scheme) => (
            <option key={scheme} value={scheme}>
              {t(scheme === 'bearer' ? 'form.authBearer' : 'form.authHeader')}
            </option>
          ))}
        </select>
      </div>
      {form.authScheme === 'header' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="int-header">{t('form.headerName')}</Label>
          <Input
            id="int-header"
            value={form.headerName}
            maxLength={64}
            placeholder="X-Api-Key"
            className="font-mono"
            onChange={(e) => set('headerName', e.target.value)}
          />
        </div>
      ) : (
        <div />
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="int-test-path">{t('form.testPath')}</Label>
        <Input
          id="int-test-path"
          value={form.testPath}
          className="font-mono"
          onChange={(e) => set('testPath', e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          {t('form.testPathHelp')}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="int-logo">{t('form.logoUrl')}</Label>
        <Input
          id="int-logo"
          value={form.logoUrl}
          placeholder="https://"
          onChange={(e) => set('logoUrl', e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="int-help">{t('form.credentialHelp')}</Label>
        <Textarea
          id="int-help"
          value={form.credentialHelp}
          maxLength={500}
          rows={2}
          onChange={(e) => set('credentialHelp', e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="int-order">{t('form.sortOrder')}</Label>
        <Input
          id="int-order"
          inputMode="numeric"
          value={form.sortOrder}
          onChange={(e) => set('sortOrder', e.target.value)}
        />
      </div>
      {mode === 'edit' ? (
        <div className="flex items-center gap-2 self-end pb-1.5">
          <Switch
            id="int-active"
            checked={form.isActive}
            onCheckedChange={(checked) => set('isActive', checked === true)}
          />
          <Label htmlFor="int-active">{t('form.active')}</Label>
        </div>
      ) : null}
    </div>
  );
}

export function PlatformIntegrationEditor({
  id,
  initial = null,
}: {
  id: string;
  /** Integración precargada, para los tests; la página la carga sola. */
  initial?: PlatformIntegrationDetailView | null;
}) {
  const t = useTranslations('Platform.integrations');
  const [data, setData] = useState<PlatformIntegrationDetailView | null>(
    initial
  );
  const [form, setForm] = useState<IntegrationForm | null>(
    initial ? integrationToForm(initial) : null
  );
  const [loading, setLoading] = useState(initial === null);
  const [state, setState] = useState<'ok' | 'failed' | 'missing'>('ok');
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState<number[]>([]);
  const [confirmReset, setConfirmReset] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/platform/integrations/${encodeURIComponent(id)}`,
        { cache: 'no-store' }
      );
      if (res.status === 404) {
        setState('missing');
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        integration: PlatformIntegrationDetailView;
      };
      setData(body.integration);
      setForm(integrationToForm(body.integration));
      setState('ok');
    } catch {
      setState('failed');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (initial === null) load();
  }, [initial, load]);

  async function save(resetActivations = false) {
    if (!form) return;
    const payload = integrationFormToBody(form, 'edit');
    if (!payload.ok) {
      toast.error(fieldError(t, payload.field, INTEGRATION_FIELD_LABEL));
      return;
    }
    setSaving(true);
    const body = await send<{ integration: IntegrationRow }>(
      t,
      `/api/platform/integrations/${encodeURIComponent(id)}`,
      'PATCH',
      resetActivations
        ? { ...payload.body, reset_activations: true }
        : payload.body,
      INTEGRATION_FIELD_LABEL,
      (status, json) => {
        // Cambia a dónde viaja la credencial de cuentas que la usan: se
        // pide confirmación explícita antes de desactivarla en todas.
        if (status === 409 && json?.code === 'integration_in_use') {
          setConfirmReset(Number(json.accountsEnabled) || 0);
          return true;
        }
        return false;
      }
    );
    setSaving(false);
    if (!body) return;
    setConfirmReset(null);
    setData((current) =>
      current ? { ...current, ...body.integration } : current
    );
    setForm(integrationToForm(body.integration));
    toast.success(t('form.saved'));
  }

  function upsertOperation(op: OperationRow) {
    setData((current) => {
      if (!current) return current;
      const exists = current.operations.some((o) => o.id === op.id);
      return {
        ...current,
        operations: exists
          ? current.operations.map((o) => (o.id === op.id ? op : o))
          : [...current.operations, op],
      };
    });
  }

  const back = (
    <Link
      href="/platform/integrations"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
    >
      <ArrowLeft className="size-4" />
      {t('back')}
    </Link>
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('loading')}
        </div>
      </div>
    );
  }
  if (state !== 'ok' || !data || !form) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg border p-4 text-sm">
          <ShieldAlert className="size-4" />
          {state === 'missing' ? t('notFound') : t('loadFailed')}
        </div>
      </div>
    );
  }

  const nextOrder =
    data.operations.reduce((max, o) => Math.max(max, o.sort_order), 0) + 1;

  return (
    <div className="flex flex-col gap-6" data-integration-editor={data.id}>
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-foreground text-xl font-semibold">{data.name}</h2>
        <span className="text-muted-foreground font-mono text-sm">
          {data.slug}
        </span>
        <Badge variant={data.is_active ? 'secondary' : 'outline'}>
          {t(data.is_active ? 'status.active' : 'status.draft')}
        </Badge>
      </div>

      <form
        className="border-border flex flex-col gap-4 rounded-lg border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <IntegrationFields form={form} mode="edit" onChange={setForm} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('form.save')}
          </Button>
        </div>
      </form>

      <Dialog
        open={confirmReset !== null}
        onOpenChange={(next) => !next && !saving && setConfirmReset(null)}
      >
        <DialogContent className="sm:max-w-md" data-confirm-reset>
          <DialogHeader>
            <DialogTitle>{t('errors.inUseTitle')}</DialogTitle>
            <DialogDescription>
              {t('errors.inUse', { count: confirmReset ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setConfirmReset(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              aria-busy={saving}
              onClick={() => void save(true)}
            >
              {t('errors.inUseConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-foreground text-lg font-semibold">
            {t('operations.title')}
          </h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDrafts((d) => [...d, Date.now()])}
          >
            <Plus className="size-4" />
            {t('operations.add')}
          </Button>
        </div>
        {data.operations.length === 0 && drafts.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t('operations.empty')}
          </p>
        ) : null}
        {data.operations.map((op) => (
          <OperationEditor
            key={op.id}
            integrationId={data.id}
            operation={op}
            initialForm={operationToForm(op)}
            onSaved={upsertOperation}
          />
        ))}
        {drafts.map((draftId, i) => (
          <OperationEditor
            key={draftId}
            integrationId={data.id}
            operation={null}
            initialForm={emptyOperationForm(nextOrder + i)}
            onSaved={(op) => {
              setDrafts((d) => d.filter((x) => x !== draftId));
              upsertOperation(op);
            }}
          />
        ))}
      </section>
    </div>
  );
}

function OperationEditor({
  integrationId,
  operation,
  initialForm,
  onSaved,
}: {
  integrationId: string;
  operation: OperationRow | null;
  initialForm: OperationForm;
  onSaved: (op: OperationRow) => void;
}) {
  const t = useTranslations('Platform.integrations');
  const [form, setForm] = useState<OperationForm>(initialForm);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof OperationForm>(k: K, v: OperationForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const prefix = operation?.id ?? 'new';

  async function save() {
    const payload = operationFormToBody(form);
    if (!payload.ok) {
      toast.error(fieldError(t, payload.field, OPERATION_FIELD_LABEL));
      return;
    }
    setSaving(true);
    const base = `/api/platform/integrations/${encodeURIComponent(integrationId)}/operations`;
    const body = await send<{ operation: OperationRow }>(
      t,
      operation ? `${base}/${encodeURIComponent(operation.id)}` : base,
      operation ? 'PATCH' : 'POST',
      payload.body,
      OPERATION_FIELD_LABEL
    );
    setSaving(false);
    if (!body) return;
    onSaved(body.operation);
    toast.success(t('operations.saved'));
  }

  function setParam(
    i: number,
    patch: Partial<OperationForm['params'][number]>
  ) {
    set(
      'params',
      form.params.map((p, j) => (j === i ? { ...p, ...patch } : p))
    );
  }
  function setOutput(
    i: number,
    patch: Partial<OperationForm['outputs'][number]>
  ) {
    set(
      'outputs',
      form.outputs.map((o, j) => (j === i ? { ...o, ...patch } : o))
    );
  }

  return (
    <form
      className="border-border flex flex-col gap-4 rounded-lg border p-4"
      data-operation={operation?.key ?? 'new'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono">
          {form.method}
        </Badge>
        <span className="font-mono text-sm">{form.path}</span>
        {operation ? null : (
          <Badge variant="secondary">{t('operations.new')}</Badge>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`${prefix}-key`}>{t('operations.key')}</Label>
          <Input
            id={`${prefix}-key`}
            value={form.key}
            maxLength={64}
            className="font-mono"
            onChange={(e) => set('key', e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`${prefix}-name`}>{t('operations.name')}</Label>
          <Input
            id={`${prefix}-name`}
            value={form.name}
            maxLength={80}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${prefix}-method`}>{t('operations.method')}</Label>
          <select
            id={`${prefix}-method`}
            className={SELECT_CLASS}
            value={form.method}
            onChange={(e) => set('method', e.target.value as HttpMethod)}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-3">
          <Label htmlFor={`${prefix}-path`}>{t('operations.path')}</Label>
          <Input
            id={`${prefix}-path`}
            value={form.path}
            className="font-mono"
            onChange={(e) => set('path', e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            {t('operations.pathHelp')}
          </p>
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-4">
          <Label htmlFor={`${prefix}-description`}>
            {t('operations.description')}
          </Label>
          <Textarea
            id={`${prefix}-description`}
            value={form.description}
            maxLength={1000}
            rows={2}
            onChange={(e) => set('description', e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            {t('operations.descriptionHelp')}
          </p>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">
          {t('operations.params')}
        </legend>
        {form.params.map((p, i) => (
          <div
            key={i}
            className="grid items-end gap-2 sm:grid-cols-12"
            data-param-row={i}
          >
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label className="text-xs">{t('params.name')}</Label>
              <Input
                value={p.name}
                className="font-mono"
                onChange={(e) => setParam(i, { name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label className="text-xs">{t('params.in')}</Label>
              <select
                className={SELECT_CLASS}
                value={p.in}
                onChange={(e) =>
                  setParam(i, { in: e.target.value as ParamLocation })
                }
              >
                {PARAM_LOCATIONS.map((loc) => (
                  <option key={loc} value={loc}>
                    {t(`params.in_${loc}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label className="text-xs">{t('params.type')}</Label>
              <select
                className={SELECT_CLASS}
                value={p.type}
                onChange={(e) =>
                  setParam(i, { type: e.target.value as ParamType })
                }
              >
                {PARAM_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-3">
              <Label className="text-xs">{t('params.description')}</Label>
              <Input
                value={p.description}
                maxLength={500}
                onChange={(e) => setParam(i, { description: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-1.5 pb-2 sm:col-span-2">
              <Checkbox
                id={`${prefix}-p${i}-req`}
                checked={p.in === 'path' || p.required}
                disabled={p.in === 'path'}
                onCheckedChange={(c) => setParam(i, { required: c === true })}
              />
              <Label htmlFor={`${prefix}-p${i}-req`} className="text-xs">
                {t('params.required')}
              </Label>
            </div>
            <div className="flex justify-end sm:col-span-1">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t('params.remove')}
                onClick={() =>
                  set(
                    'params',
                    form.params.filter((_, j) => j !== i)
                  )
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            {p.type === 'string' ? (
              <div className="flex flex-col gap-1 sm:col-span-12">
                <Label className="text-xs">{t('params.enum')}</Label>
                <Input
                  value={p.enumText}
                  placeholder={t('params.enumHelp')}
                  onChange={(e) => setParam(i, { enumText: e.target.value })}
                />
              </div>
            ) : null}
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => set('params', [...form.params, emptyParamRow()])}
          >
            <Plus className="size-4" />
            {t('params.add')}
          </Button>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">
          {t('operations.outputs')}
        </legend>
        {form.outputs.map((o, i) => (
          <div
            key={i}
            className="grid items-end gap-2 sm:grid-cols-12"
            data-output-row={i}
          >
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label className="text-xs">{t('outputs.name')}</Label>
              <Input
                value={o.name}
                className="font-mono"
                onChange={(e) => setOutput(i, { name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-3">
              <Label className="text-xs">{t('outputs.path')}</Label>
              <Input
                value={o.path}
                placeholder="data.items.0.id"
                className="font-mono"
                onChange={(e) => setOutput(i, { path: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label className="text-xs">{t('outputs.type')}</Label>
              <select
                className={SELECT_CLASS}
                value={o.type}
                onChange={(e) =>
                  setOutput(i, { type: e.target.value as OutputType })
                }
              >
                {OUTPUT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-4">
              <Label className="text-xs">{t('outputs.description')}</Label>
              <Input
                value={o.description}
                maxLength={500}
                onChange={(e) => setOutput(i, { description: e.target.value })}
              />
            </div>
            <div className="flex justify-end sm:col-span-1">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t('outputs.remove')}
                onClick={() =>
                  set(
                    'outputs',
                    form.outputs.filter((_, j) => j !== i)
                  )
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => set('outputs', [...form.outputs, emptyOutputRow()])}
          >
            <Plus className="size-4" />
            {t('outputs.add')}
          </Button>
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="flex flex-col gap-1.5 sm:col-span-4">
          <Label htmlFor={`${prefix}-response`}>
            {t('operations.responseDescription')}
          </Label>
          <Textarea
            id={`${prefix}-response`}
            value={form.responseDescription}
            maxLength={1000}
            rows={2}
            onChange={(e) => set('responseDescription', e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${prefix}-order`}>{t('operations.sortOrder')}</Label>
          <Input
            id={`${prefix}-order`}
            inputMode="numeric"
            value={form.sortOrder}
            onChange={(e) => set('sortOrder', e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 self-end pb-1.5">
          <Switch
            id={`${prefix}-active`}
            checked={form.isActive}
            onCheckedChange={(c) => set('isActive', c === true)}
          />
          <Label htmlFor={`${prefix}-active`}>{t('operations.active')}</Label>
        </div>
        <div className="flex items-end justify-end sm:col-span-2">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('operations.save')}
          </Button>
        </div>
      </div>
    </form>
  );
}
