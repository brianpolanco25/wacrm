'use client';

// The failure screen of /auth/callback/complete, apart from the page so
// it can be rendered in a test (the page only reaches it after an
// effect). Its links keep `?invite=` (i12.1).

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { MailX } from 'lucide-react';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import {
  callbackExitLinks,
  type CallbackErrorReason,
} from '@/lib/auth/callback';

export function CallbackFailure({
  reason,
  search,
}: {
  reason: CallbackErrorReason;
  search: string;
}) {
  const t = useTranslations('AuthCallback');
  const links = callbackExitLinks(search);
  return (
    <AuthCard
      title={t('errorTitle')}
      description={t(`errors.${reason}`)}
      icon={<MailX className="size-6" />}
    >
      <Link href={links.forgotPassword}>
        <Button className="bg-primary text-primary-foreground hover:bg-primary-hover h-12 w-full rounded-xl text-base font-semibold">
          {t('requestNewLink')}
        </Button>
      </Link>
      <Link
        href={links.login}
        className="text-muted-foreground hover:text-foreground text-center text-sm transition-colors"
      >
        {t('backToSignIn')}
      </Link>
    </AuthCard>
  );
}
