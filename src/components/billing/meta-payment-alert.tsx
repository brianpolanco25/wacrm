'use client';

// ============================================================
// MetaPaymentAlert — «tu WABA no tiene método de pago en Meta» (p11.1).
//
// Desde el 2026-10-01 Meta deja de entregar los mensajes de un WABA sin
// método de pago. El cliente ve «Conectado» en Ajustes y sus mensajes no
// llegan; este aviso dice por qué y lleva al Billing Hub de Meta.
//
// Aparte de `BillingStatusAlert` a propósito: ese es la escalera de
// cobro de Cabbity; esto es una deuda con Meta, de otra persona y con
// otra salida. Comparten el hook (`useBillingStatus`, sin petición
// nueva) y nada más. El servidor ya decidió qué pintar
// (`metaPaymentBanner`): `managed`, interruptor puesto o todo en orden
// llegan como `banner: null` y aquí no se pinta nada.
//
//   missing  rojo, persistente (sin cerrar), con cuántos números.
//   unknown  aviso suave: no se pudo comprobar.
//
// No bloquea nada: quien deja de entregar es Meta (R23).
// ============================================================

import { useTranslations } from 'next-intl';
import { CreditCard, ExternalLink } from 'lucide-react';

import { useBillingStatus } from '@/hooks/use-billing-status';
import { buttonVariants } from '@/components/ui/button';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { META_BILLING_HUB_URL } from '@/lib/whatsapp/payment-method';

export function MetaPaymentAlert() {
  const t = useTranslations('Billing.metaPayment');
  const status = useBillingStatus();
  const meta = status?.metaPayment;
  if (!meta || meta.banner === null) return null;

  const missing = meta.banner === 'missing';

  return (
    <Alert variant={missing ? 'destructive' : 'default'} className="mb-4">
      <CreditCard />
      <AlertTitle>{missing ? t('missingTitle') : t('unknownTitle')}</AlertTitle>
      <AlertDescription>
        {missing
          ? t('missingBody', { count: meta.missingNumbers })
          : t('unknownBody')}
      </AlertDescription>
      <AlertAction>
        <a
          href={META_BILLING_HUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('openBillingHub')}
          <ExternalLink aria-hidden="true" />
        </a>
      </AlertAction>
    </Alert>
  );
}
