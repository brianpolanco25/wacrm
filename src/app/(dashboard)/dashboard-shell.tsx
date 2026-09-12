"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { AccountAccessAlert } from "@/components/layout/account-access-alert";
import { ImpersonationBanner } from "@/components/layout/impersonation-banner";
import { BillingStatusAlert } from "@/components/billing/billing-status-alert";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import type { SupportBanner } from "@/lib/auth/support-view";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({
  children,
  support,
}: {
  children: React.ReactNode;
  // Resolved by the server layout; null on every request outside a
  // support session.
  support: SupportBanner | null;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      {/* Outside the scroll area and above the header: "you are looking at
          someone else's company" must never scroll away. Renders nothing
          unless a support session is in force. */}
      <ImpersonationBanner session={support} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar open={sidebarOpen} onClose={closeSidebar} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header onOpenSidebar={() => setSidebarOpen(true)} />
          {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
          <main className="flex-1 overflow-y-auto p-4 sm:p-6">
            {/* Above every page: writes are being rejected and here's why.
                Renders nothing unless the account/role failed to resolve. */}
            <AccountAccessAlert />
            {/* Fase 3 §5: which rung of the dunning ladder this account is
                on, and a button to settle it. Renders nothing while the
                subscription is healthy. */}
            <BillingStatusAlert />
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

export function DashboardShell({
  children,
  support,
}: {
  children: React.ReactNode;
  support: SupportBanner | null;
}) {
  return (
    <AuthProvider>
      <DashboardShellInner support={support}>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
