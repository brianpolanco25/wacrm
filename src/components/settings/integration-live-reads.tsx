'use client';

// ============================================================
// IntegrationLiveReads — «Datos en vivo antes de responder» en el diálogo
// «Instrucciones para la IA» (n13.7, R7).
//
// Presentacional y sin estado: el valor y el PATCH viven en
// `integrations-settings.tsx`. Hasta 3 lecturas: una operación `GET` de la
// integración y un campo por parámetro de llamada (número para
// `integer`/`number` salvo que lleve una plantilla, desplegable con
// `enum`, interruptor para `boolean`). Las transformaciones del valor son
// funciones puras exportadas, para testearlas sin DOM.
// ============================================================

import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  AI_LIVE_READS_MAX,
  type AiLiveRead,
  type AiReadOperation,
} from '@/lib/ai/tools/types';

const SELECT_CLASS =
  'border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

type ReadParam = AiReadOperation['params'][number];

/** Una lectura nueva: la primera operación, sin parámetros. */
export function addLiveRead(
  value: AiLiveRead[],
  operations: AiReadOperation[]
): AiLiveRead[] {
  if (value.length >= AI_LIVE_READS_MAX || operations.length === 0) {
    return value;
  }
  return [...value, { operation: operations[0].key, params: {} }];
}

export function removeLiveRead(
  value: AiLiveRead[],
  index: number
): AiLiveRead[] {
  return value.filter((_, i) => i !== index);
}

/** Cambiar de operación vacía los parámetros (son de otra operación). */
export function setLiveReadOperation(
  value: AiLiveRead[],
  index: number,
  operation: string
): AiLiveRead[] {
  return value.map((read, i) =>
    i === index ? { operation, params: {} } : read
  );
}

/**
 * El valor de un parámetro desde su campo: vacío lo quita; un número
 * válido sin plantilla en un parámetro numérico se guarda como número.
 */
export function setLiveReadParam(
  value: AiLiveRead[],
  index: number,
  param: Pick<ReadParam, 'name' | 'type'>,
  raw: string | boolean
): AiLiveRead[] {
  return value.map((read, i) => {
    if (i !== index) return read;
    const params = { ...read.params };
    if (typeof raw === 'boolean') {
      params[param.name] = raw;
    } else if (raw.trim() === '') {
      delete params[param.name];
    } else if (
      (param.type === 'integer' || param.type === 'number') &&
      !raw.includes('{{') &&
      Number.isFinite(Number(raw))
    ) {
      params[param.name] = Number(raw);
    } else {
      params[param.name] = raw;
    }
    return { ...read, params };
  });
}

function ParamField({
  id,
  param,
  value,
  disabled,
  onChange,
}: {
  id: string;
  param: ReadParam;
  value: string | number | boolean | undefined;
  disabled: boolean;
  onChange: (raw: string | boolean) => void;
}) {
  const label = (
    <Label htmlFor={id} className="text-xs">
      {param.name}
      {param.required ? ' *' : ''}
    </Label>
  );
  if (param.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-2">
        {label}
        <Switch
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(next) => onChange(next)}
        />
      </div>
    );
  }
  if (param.enum && param.enum.length > 0) {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <select
          id={id}
          className={SELECT_CLASS}
          value={value === undefined ? '' : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          data-live-param={param.name}
        >
          <option value="">—</option>
          {param.enum.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>
    );
  }
  const text = value === undefined ? '' : String(value);
  const numeric =
    (param.type === 'integer' || param.type === 'number') &&
    !text.includes('{{');
  return (
    <div className="flex flex-col gap-1">
      {label}
      <Input
        id={id}
        type={numeric ? 'number' : 'text'}
        step={param.type === 'integer' ? 1 : undefined}
        value={text}
        disabled={disabled}
        placeholder={param.description || undefined}
        onChange={(e) => onChange(e.target.value)}
        data-live-param={param.name}
      />
    </div>
  );
}

export function IntegrationLiveReads({
  operations,
  value,
  onChange,
  disabled = false,
  error = null,
}: {
  operations: AiReadOperation[];
  value: AiLiveRead[];
  onChange: (next: AiLiveRead[]) => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const t = useTranslations('Settings.integrations');
  const full = value.length >= AI_LIVE_READS_MAX;

  return (
    <fieldset className="flex flex-col gap-2" data-live-reads>
      <legend className="text-sm font-medium">{t('aiLiveTitle')}</legend>
      <p className="text-muted-foreground text-xs">{t('aiLiveHint')}</p>
      {value.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-live-empty>
          {t('aiLiveEmpty')}
        </p>
      ) : null}
      {value.map((read, index) => {
        const op = operations.find((o) => o.key === read.operation);
        const opId = `live-read-${index}-operation`;
        return (
          <div
            key={index}
            className="border-border flex flex-col gap-2 rounded-lg border p-2.5"
            data-live-read={index}
          >
            <div className="flex items-end gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor={opId} className="text-xs">
                  {t('aiLiveOperation')}
                </Label>
                <select
                  id={opId}
                  className={SELECT_CLASS}
                  value={read.operation}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange(setLiveReadOperation(value, index, e.target.value))
                  }
                >
                  {op ? null : (
                    <option value={read.operation}>{read.operation}</option>
                  )}
                  {operations.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => onChange(removeLiveRead(value, index))}
                aria-label={t('aiLiveRemove')}
                data-action="live-remove"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
            {op ? null : (
              <p className="text-destructive text-xs" data-live-stale>
                {t('aiLiveStale')}
              </p>
            )}
            {op && op.params.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {op.params.map((param) => (
                  <ParamField
                    key={param.name}
                    id={`live-read-${index}-${param.name}`}
                    param={param}
                    value={read.params[param.name]}
                    disabled={disabled}
                    onChange={(raw) =>
                      onChange(setLiveReadParam(value, index, param, raw))
                    }
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      <p className="text-muted-foreground text-xs">
        {t('aiLiveTemplatesHelp')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || full || operations.length === 0}
          onClick={() => onChange(addLiveRead(value, operations))}
          data-action="live-add"
        >
          <Plus className="size-4" aria-hidden />
          {t('aiLiveAdd')}
        </Button>
        {full ? (
          <span className="text-muted-foreground text-xs" data-live-max>
            {t('aiLiveMax', { max: AI_LIVE_READS_MAX })}
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-xs" data-live-error>
          {t('aiLiveInvalid', { error })}
        </p>
      ) : null}
    </fieldset>
  );
}
