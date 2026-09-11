import type { Metadata } from "next";
import { DashboardShell } from "./dashboard-shell";
import { supportBanner } from "@/lib/auth/support-view";

// Server layout whose only job is to declare "do not index" metadata
// for the authed app. robots.ts already disallows these paths at the
// crawler-level and middleware redirects unauthenticated visitors, so
// this is belt-and-suspenders — but SEO-critical if a URL ever leaks
// via a link shared externally.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

// Async because it resolves the support session server-side (see
// `supportBanner`): the impersonation notice has to render for the
// operator on every page, and reading it here costs nothing on the normal
// path — no support cookie, no queries.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const support = await supportBanner();
  return <DashboardShell support={support}>{children}</DashboardShell>;
}
