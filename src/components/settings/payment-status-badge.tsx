'use client';

// ============================================================
// PaymentStatusBadge — el método de pago del WABA en una tarjeta de
// número de Ajustes → WhatsApp (p11.1, R20/R11).
//
// Extraído de `whatsapp-config.tsx` para poder probarlo sin montar las
// 1 300 líneas de la página. Solo pinta: el estado lo guardó el
// servidor (migración 079) y el botón llama a `onRecheck`, que es quien
// habla con `POST /api/whatsapp/config/payment-status`.
//
//   ok       «Método de pago en Meta: activo»
//   missing  en rojo
//   unknown  «No se pudo comprobar» (sin aviso global en cuentas con
//            token propio: esta etiqueta es todo el ruido que hacen)
//   NULL     «Pendiente de comprobar»
//
// En cuentas `managed` (Cabbity paga a Meta) no se pinta nada; tampoco
// mientras `metaBilling` no se conoce.
// ============================================================

import { useTranslations } from 'next-intl';
import { CreditCard, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';

export interface PaymentStatusBadgeProps {
  status: 'ok' | 'missing' | 'unknown' | null | undefined;
  checkedAt: string | null | undefined;
  metaBilling: 'direct' | 'managed' | undefined;
  canRecheck: boolean;
  busy: boolean;
  onRecheck: () => void;
}

export function PaymentStatusBadge({
  status,
  checkedAt,
  metaBilling,
  canRecheck,
  busy,
  onRecheck,
}: PaymentStatusBadgeProps) {
  const t = useTranslations('Settings.whatsapp');
  // Hasta saber quién paga a Meta no se pinta: un cliente `managed` no
  // debe ver ni un instante «sin método de pago» de un WABA que no es
  // suyo de pagar.
  if (metaBilling !== 'direct') return null;

  const label =
    status === 'ok'
      ? t('paymentOk')
      : status === 'missing'
        ? t('paymentMissing')
        : status === 'unknown'
          ? t('paymentUnknown')
          : t('paymentPending');
  const tone =
    status === 'missing'
      ? 'text-red-400'
      : status === 'ok'
        ? 'text-muted-foreground'
        : 'text-amber-400';
  // Fecha formateada desde el dato, no desde el reloj: sin `Date.now()`
  // en render.
  const date = checkedAt ? new Date(checkedAt).toLocaleString() : null;

  return (
    <div
      className="mt-0.5 flex flex-wrap items-center gap-2 text-xs"
      data-payment-status={status ?? 'pending'}
    >
      <span className={`flex items-center gap-1 ${tone}`}>
        <CreditCard className="size-3" aria-hidden="true" />
        {label}
      </span>
      {date && (
        <span className="text-muted-foreground">
          {t('paymentCheckedAt', { date })}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={!canRecheck || busy}
        onClick={onRecheck}
        className="border-border text-muted-foreground hover:text-foreground h-6 bg-transparent px-2 text-xs"
      >
        <RefreshCw className="size-3" aria-hidden="true" />
        {t('paymentRecheck')}
      </Button>
    </div>
  );
}
