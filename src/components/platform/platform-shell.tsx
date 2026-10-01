'use client';

// ============================================================
// Chrome of the operator's panel (s9.1): its own sidebar and header, not
// the CRM's. No inbox, contacts or pipelines — nothing here belongs to a
// single company. Same Cabbity tokens as the CRM with a NAVY accent
// (`--cb-token-navy`) where the CRM uses amber, so an operator can tell
// at a glance that they are looking at the whole service.
//
// Access is NOT decided here: the `(platform)` layout and every page call
// `guardPlatformPage()` on the server before this renders. `useAuth` is
// used only for the user menu (name, email) and for `signOut`, which also
// closes an open support session (see `use-auth.tsx`).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Building2,
  Coins,
  CreditCard,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  Menu,
  ShieldUser,
  X,
} from 'lucide-react';

import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { CabbityMark } from '@/components/auth/cabbity-logo';
import { ImpersonationBanner } from '@/components/layout/impersonation-banner';
import { ModeToggle } from '@/components/layout/mode-toggle';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SupportBanner } from '@/lib/auth/support-view';

export type PlatformSection =
  'overview' | 'accounts' | 'plans' | 'rates' | 'operators';

export const PLATFORM_NAV: ReadonlyArray<{
  key: PlatformSection;
  href: string;
  icon: typeof LayoutDashboard;
}> = [
  { key: 'overview', href: '/platform', icon: LayoutDashboard },
  { key: 'accounts', href: '/platform/accounts', icon: Building2 },
  { key: 'plans', href: '/platform/plans', icon: CreditCard },
  { key: 'rates', href: '/platform/rates', icon: Coins },
  { key: 'operators', href: '/platform/operators', icon: ShieldUser },
];

/**
 * Which nav item a pathname belongs to. An account's file
 * (`/platform/<uuid>`) is part of «Cuentas»: it is where the census
 * links to, and its back link returns there.
 */
export function platformSectionFor(pathname: string): PlatformSection {
  if (pathname === '/platform' || pathname === '/platform/') return 'overview';
  for (const item of PLATFORM_NAV) {
    if (item.key === 'overview') continue;
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      return item.key;
    }
  }
  return 'accounts';
}

function PlatformNav({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('Platform.shell');
  const pathname = usePathname() ?? '/platform';
  const active = platformSectionFor(pathname);

  // Close the mobile drawer once a destination is picked.
  useEffect(() => {
    onClose();
    // Only pathname drives this, same as the CRM sidebar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <>
      <button
        type="button"
        aria-label={t('closeMenu')}
        onClick={onClose}
        className={cn(
          'bg-background/70 fixed inset-0 z-30 backdrop-blur-sm transition-opacity lg:hidden',
          open
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        )}
      />
      <aside
        data-platform-nav
        aria-label={t('navLabel')}
        className={cn(
          'bg-navy text-cream fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col',
          'transition-transform duration-200 ease-out will-change-transform',
          open ? 'translate-x-0' : '-translate-x-full',
          'lg:static lg:z-0 lg:w-60 lg:translate-x-0 lg:transition-none'
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4">
          <Link href="/platform" className="flex min-w-0 items-center gap-2">
            <CabbityMark className="text-brand size-8 shrink-0" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-semibold">
                {t('title')}
              </span>
              <span className="text-brand truncate text-[10px] font-semibold tracking-wider uppercase">
                {t('badge')}
              </span>
            </span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('closeMenu')}
            className="text-cream/70 hover:text-cream flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10 lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="flex flex-col gap-1">
            {PLATFORM_NAV.map((item) => {
              const isActive = item.key === active;
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2',
                      isActive
                        ? 'bg-brand text-navy'
                        : 'text-cream/75 hover:text-cream hover:bg-white/10'
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {t(`nav.${item.key}`)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="shrink-0 border-t border-white/10 p-3">
          <Link
            href="/dashboard"
            className="text-cream/75 hover:text-cream flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-white/10"
          >
            <LayoutGrid className="h-4 w-4" />
            {t('goToCrm')}
          </Link>
        </div>
      </aside>
    </>
  );
}

function PlatformHeader({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const t = useTranslations('Platform.shell');
  const pathname = usePathname() ?? '/platform';
  const { profile, signOut } = useAuth();
  const section = platformSectionFor(pathname);

  const initial =
    profile?.full_name?.charAt(0)?.toUpperCase() ??
    profile?.email?.charAt(0)?.toUpperCase() ??
    'U';

  return (
    <header className="border-navy/15 bg-background flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label={t('openMenu')}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-10 w-10 items-center justify-center rounded-md transition-colors lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="text-foreground truncate text-base font-semibold sm:text-lg">
          {t(`nav.${section}`)}
        </h1>
      </div>

      <div className="flex min-w-0 items-center gap-1 sm:gap-2">
        <ModeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger
            className="hover:bg-muted/70 focus:bg-muted/70 data-popup-open:bg-muted/70 flex items-center gap-2 rounded-md px-1 py-1 transition-colors focus:outline-none sm:gap-3 sm:pr-3 sm:pl-1"
            aria-label={t('openAccountMenu')}
          >
            <Avatar className="size-8">
              {profile?.avatar_url ? (
                <AvatarImage
                  src={profile.avatar_url}
                  alt={profile.full_name ?? t('defaultUser')}
                />
              ) : null}
              <AvatarFallback className="bg-navy text-cream text-sm font-medium">
                {initial}
              </AvatarFallback>
            </Avatar>
            <span className="text-foreground hidden text-sm font-medium sm:inline">
              {profile?.full_name ?? t('defaultUser')}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={6}
            className="bg-popover text-popover-foreground ring-border min-w-56"
          >
            <div className="px-2 py-1.5">
              <p className="text-foreground truncate text-sm font-medium">
                {profile?.full_name ?? t('defaultUser')}
              </p>
              <p className="text-muted-foreground truncate text-xs">
                {profile?.email ?? ''}
              </p>
            </div>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              render={
                <Link
                  href="/dashboard"
                  className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                />
              }
            >
              <LayoutGrid className="size-4" />
              {t('goToCrm')}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              onClick={signOut}
              className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
            >
              <LogOut className="size-4" />
              {t('signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

export function PlatformFrame({
  children,
  support,
}: {
  children: React.ReactNode;
  support: SupportBanner | null;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);

  return (
    <div className="bg-background flex h-screen flex-col overflow-hidden">
      <ImpersonationBanner session={support} />
      <div className="flex flex-1 overflow-hidden">
        <PlatformNav open={navOpen} onClose={closeNav} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <PlatformHeader onOpenSidebar={() => setNavOpen(true)} />
          <main className="relative flex-1 overflow-y-auto p-4 sm:p-6">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

export function PlatformShell({
  children,
  support,
}: {
  children: React.ReactNode;
  support: SupportBanner | null;
}) {
  return (
    <AuthProvider>
      <PlatformFrame support={support}>{children}</PlatformFrame>
    </AuthProvider>
  );
}
