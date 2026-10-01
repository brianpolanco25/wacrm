'use client';

// ============================================================
// Cuota gratis de Meta en Ajustes → WhatsApp (p11.3, R17/R18).
//
//   ServiceUsageLine  bajo cada tarjeta de número: «Mensajes de servicio
//                     este mes: {used} de {freeTier} gratis» y, si se
//                     agotó, la etiqueta «Cuota gratis agotada».
//   ServiceCapCard    el ajuste de la cuenta: «Solo avisar» / «Pausar la
//                     IA del número». Editable solo con `canEditSettings`;
//                     guarda con PATCH /api/whatsapp/service-cap y, si
//                     falla, vuelve a la opción anterior con un toast.
//
// Ambos se ocultan en cuentas `managed` (Cabbity paga a Meta) y sin dato.
// Solo pintan: el conteo lo hizo el servidor.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type {
  ServiceCapNumber,
  ServiceCapStatus,
} from '@/hooks/use-service-cap';

export type ServiceCapAction = ServiceCapStatus['action'];

export function ServiceUsageLine({
  number,
  freeTier,
  metaBilling,
}: {
  number: ServiceCapNumber | undefined;
  freeTier: number;
  metaBilling: ServiceCapStatus['metaBilling'] | undefined;
}) {
  const t = useTranslations('Settings.whatsapp.serviceCap');
  if (metaBilling !== 'direct' || !number) return null;
  return (
    <p
      data-service-usage
      className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-xs"
    >
      <span>{t('usage', { used: number.used, freeTier })}</span>
      {number.exhausted && (
        <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-px font-medium text-amber-400">
          {t('exhausted')}
        </span>
      )}
    </p>
  );
}

/**
 * Guarda la acción. Devuelve la acción que queda puesta: la nueva si el
 * servidor la aceptó; la anterior si no (R18: revertir). `fetchImpl` es
 * la costura de los tests.
 */
export async function saveServiceCapAction(
  next: ServiceCapAction,
  previous: ServiceCapAction,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; action: ServiceCapAction }> {
  try {
    const res = await fetchImpl('/api/whatsapp/service-cap', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: next }),
    });
    if (!res.ok) return { ok: false, action: previous };
    const body = (await res.json()) as { action?: unknown };
    return {
      ok: true,
      action: body.action === 'pause_ai' ? 'pause_ai' : 'warn',
    };
  } catch {
    return { ok: false, action: previous };
  }
}

export function ServiceCapCard({
  status,
  canEdit,
  onSaved,
  fetchImpl,
}: {
  status: ServiceCapStatus | null;
  canEdit: boolean;
  onSaved?: (action: ServiceCapAction) => void;
  fetchImpl?: typeof fetch;
}) {
  const t = useTranslations('Settings.whatsapp.serviceCap');
  // Lo elegido aquí manda sobre lo leído hasta que el padre refresque.
  const [chosen, setChosen] = useState<ServiceCapAction | null>(null);
  const [saving, setSaving] = useState(false);

  if (!status || status.metaBilling !== 'direct') return null;
  if (status.numbers.length === 0) return null;

  const current = chosen ?? status.action;
  const disabled = !canEdit || saving;

  const handleChange = async (value: unknown) => {
    const next: ServiceCapAction = value === 'pause_ai' ? 'pause_ai' : 'warn';
    if (next === current || !canEdit) return;
    const previous = current;
    setChosen(next);
    setSaving(true);
    const result = await saveServiceCapAction(next, previous, fetchImpl);
    setSaving(false);
    setChosen(result.action);
    if (result.ok) {
      toast.success(t('saved'));
      onSaved?.(result.action);
    } else {
      toast.error(t('saveFailed'));
    }
  };

  const options: Array<{
    value: ServiceCapAction;
    label: string;
    desc: string;
  }> = [
    { value: 'warn', label: t('warn'), desc: t('warnDesc') },
    { value: 'pause_ai', label: t('pauseAi'), desc: t('pauseAiDesc') },
  ];

  return (
    <Card data-service-cap-card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('cardTitle')}</CardTitle>
        <CardDescription>
          {t('cardDesc', { freeTier: status.freeTier })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RadioGroup
          value={current}
          onValueChange={handleChange}
          disabled={disabled}
        >
          {options.map((o) => (
            <div key={o.value} className="flex items-start gap-3">
              <RadioGroupItem
                id={`service-cap-${o.value}`}
                value={o.value}
                disabled={disabled}
                className="mt-0.5"
              />
              <Label
                htmlFor={`service-cap-${o.value}`}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="text-foreground text-sm">{o.label}</span>
                <span className="text-muted-foreground text-xs font-normal">
                  {o.desc}
                </span>
              </Label>
            </div>
          ))}
        </RadioGroup>
      </CardContent>
    </Card>
  );
}
