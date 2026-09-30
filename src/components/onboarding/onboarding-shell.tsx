'use client';

// ============================================================
// OnboardingShell — the chrome of `/onboarding` (s9.6).
//
// Not the CRM's sidebar and header: nothing behind them works until the
// account pays, and a menu full of pages that bounce back here would be
// a maze. The brand, the step content, and the one way out that always
// has to exist — signing out.
//
// `AuthProvider` because the plan step reuses `PlanPicker`, whose
// "choose" button is gated with `RequireRole` (admin+) exactly as on
// `/billing`.
// ============================================================

import { useTranslations } from 'next-intl';
import { LogOut } from 'lucide-react';

import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { CabbityMark } from '@/components/auth/cabbity-logo';

function SignOutButton() {
  const t = useTranslations('Onboarding');
  const { signOut } = useAuth();
  return (
    <Button variant="ghost" size="sm" onClick={() => void signOut()}>
      <LogOut className="h-4 w-4" aria-hidden />
      {t('signOut')}
    </Button>
  );
}

export function OnboardingShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <div className="bg-background flex min-h-screen flex-col">
        <header className="border-border flex items-center justify-between border-b px-4 py-3 sm:px-6">
          <div className="text-foreground flex items-center gap-2 font-semibold">
            <CabbityMark className="text-brand-ink size-7" />
            <span>Cabbity CRM</span>
          </div>
          <SignOutButton />
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
          {children}
        </main>
      </div>
    </AuthProvider>
  );
}
