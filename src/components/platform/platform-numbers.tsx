'use client';

// ============================================================
// The WhatsApp numbers of one account, on the operator's file
// (fase 4 §2; s10.6 adds what support needs to find a number in Meta).
//
// Per number: the display number, label, status, default flag and last
// registration error (as before), plus
//   - the WABA id and the `phone_number_id`, each with a copy button —
//     the two ids an operator pastes into Meta's Business Manager or a
//     support ticket;
//   - the connection mode: Embedded Signup (the dialog) or manual (the
//     form, with a token typed by hand);
//   - for managed accounts (Cabbity pays Meta, migration 076), the tag
//     «In the Cabbity CRM portfolio»: the WABA lives in Cabbity's own
//     Meta portfolio, not the customer's.
//
// No link to Meta's Billing Hub: no verified URL for it exists on this
// branch, and a guessed one rots silently.
//
// Lives in its own file so the file component (`platform-account-detail`)
// only changes by one line when this section does.
// ============================================================

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Copy } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export interface WhatsAppNumber {
  id: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  label: string | null;
  /** s10.6. Optional so an older payload still renders. */
  wabaId?: string | null;
  /** s10.6 (054). Optional so an older payload still renders. */
  provisionedVia?: 'embedded_signup' | 'manual';
  status: string;
  isDefault: boolean;
  registeredAt: string | null;
  lastRegistrationError: string | null;
}

/** Copy one id; the toast says whether it worked. */
export async function copyId(
  value: string,
  messages: { copied: string; copyFailed: string },
  clipboard: Pick<Clipboard, 'writeText'> | undefined = typeof navigator !==
  'undefined'
    ? navigator.clipboard
    : undefined
): Promise<boolean> {
  try {
    if (!clipboard) throw new Error('no clipboard');
    await clipboard.writeText(value);
    toast.success(messages.copied);
    return true;
  } catch {
    toast.error(messages.copyFailed);
    return false;
  }
}

function IdLine({
  label,
  value,
  missing,
  copyLabel,
  onCopy,
}: {
  label: string;
  value: string | null | undefined;
  missing: string;
  copyLabel: string;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      {value ? (
        <>
          <code className="font-mono" data-id={label}>
            {value}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={copyLabel}
            title={copyLabel}
            onClick={() => onCopy(value)}
          >
            <Copy className="size-3" />
          </Button>
        </>
      ) : (
        <span className="text-muted-foreground italic">{missing}</span>
      )}
    </div>
  );
}

export function AccountNumbersCard({
  numbers,
  metaBilling,
}: {
  numbers: WhatsAppNumber[];
  metaBilling?: 'direct' | 'managed';
}) {
  const t = useTranslations('Platform');
  const tn = useTranslations('Platform.numbers');
  const managed = metaBilling === 'managed';
  const onCopy = (value: string) =>
    void copyId(value, { copied: tn('copied'), copyFailed: tn('copyFailed') });

  return (
    <Card data-testid="account-numbers">
      <CardContent className="flex flex-col gap-3 p-4">
        <h2 className="text-foreground text-sm font-semibold">
          {t('whatsappTitle')}
        </h2>
        {managed ? (
          <p className="text-muted-foreground text-xs">{tn('managedHint')}</p>
        ) : null}
        {numbers.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('whatsappNone')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {numbers.map((number) => (
              <li
                key={number.id}
                data-number={number.id}
                className="border-border flex flex-col gap-1 rounded-md border p-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {number.displayPhoneNumber ?? number.phoneNumberId}
                  </span>
                  {number.label ? (
                    <span className="text-muted-foreground">
                      {number.label}
                    </span>
                  ) : null}
                  <Badge
                    variant={
                      number.status === 'connected' ? 'outline' : 'destructive'
                    }
                  >
                    {number.status}
                  </Badge>
                  {number.isDefault ? (
                    <Badge variant="secondary">{t('defaultNumber')}</Badge>
                  ) : null}
                  <Badge variant="outline" data-mode={number.provisionedVia}>
                    {number.provisionedVia === 'embedded_signup'
                      ? tn('modeEmbedded')
                      : tn('modeManual')}
                  </Badge>
                  {managed ? (
                    <Badge variant="secondary" data-portfolio="cabbity">
                      {tn('inCabbityPortfolio')}
                    </Badge>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-x-4">
                  <IdLine
                    label={tn('wabaId')}
                    value={number.wabaId}
                    missing={tn('missing')}
                    copyLabel={tn('copy', { what: tn('wabaId') })}
                    onCopy={onCopy}
                  />
                  <IdLine
                    label={tn('phoneNumberId')}
                    value={number.phoneNumberId}
                    missing={tn('missing')}
                    copyLabel={tn('copy', { what: tn('phoneNumberId') })}
                    onCopy={onCopy}
                  />
                </div>
                {number.lastRegistrationError ? (
                  <span className="text-destructive text-xs">
                    {number.lastRegistrationError}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
