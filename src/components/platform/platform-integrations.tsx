'use client';

// ============================================================
// /platform/integrations (n13.1, R11): el catálogo de integraciones para
// el operador. Todas, activas o no, con su identificador, estado, número
// de operaciones activas y de cuentas que la tienen activada. El alta va
// en un diálogo y lleva al editor; la edición vive en
// /platform/integrations/<id>.
//
// No hay borrado (R10): una integración se retira desactivándola.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Plus, ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { IntegrationRow } from '@/lib/integrations/types';
import {
  emptyIntegrationForm,
  integrationFormToBody,
  type IntegrationForm,
} from './integration-form';
import { fieldError, IntegrationFields } from './platform-integration-editor';

export interface PlatformIntegrationListItem extends IntegrationRow {
  operationsActive: number;
  accountsEnabled: number;
}

const FIELD_LABEL: Record<string, string> = {
  slug: 'form.slug',
  name: 'form.name',
  description: 'form.description',
  logo_url: 'form.logoUrl',
  base_url: 'form.baseUrl',
  auth_scheme: 'form.authScheme',
  auth_header_name: 'form.headerName',
  credential_help: 'form.credentialHelp',
  test_path: 'form.testPath',
  sort_order: 'form.sortOrder',
};

export function PlatformIntegrations({
  initial = null,
}: {
  /** Catálogo precargado, para los tests; la página lo carga solo. */
  initial?: PlatformIntegrationListItem[] | null;
}) {
  const t = useTranslations('Platform.integrations');
  const router = useRouter();
  const [items, setItems] = useState<PlatformIntegrationListItem[] | null>(
    initial
  );
  const [loading, setLoading] = useState(initial === null);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState<IntegrationForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch('/api/platform/integrations', {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        integrations: PlatformIntegrationListItem[];
      };
      setItems(body.integrations);
    } catch {
      // Dicho en voz alta: una tabla vacía se leería como «no hay ninguna».
      setFailed(true);
      setItems(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initial === null) load();
  }, [initial, load]);

  async function create() {
    if (!form) return;
    const payload = integrationFormToBody(form, 'create');
    if (!payload.ok) {
      toast.error(fieldError(t, payload.field, FIELD_LABEL));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/platform/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload.body),
      });
      const body = (await res.json().catch(() => null)) as {
        integration?: IntegrationRow;
        field?: string;
      } | null;
      if (res.status === 409) {
        toast.error(t('errors.exists'));
        return;
      }
      if (!res.ok || !body?.integration) {
        toast.error(
          res.status === 400
            ? fieldError(t, body?.field, FIELD_LABEL)
            : t('errors.failed')
        );
        return;
      }
      toast.success(t('form.saved'));
      setForm(null);
      router.push(`/platform/integrations/${body.integration.id}`);
    } catch {
      toast.error(t('errors.failed'));
    } finally {
      setSaving(false);
    }
  }

  const nextOrder =
    (items ?? []).reduce((max, i) => Math.max(max, i.sort_order), 0) + 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-foreground text-xl font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            {t('subtitle')}
          </p>
        </div>
        <Button
          size="sm"
          disabled={items === null}
          onClick={() => setForm(emptyIntegrationForm(nextOrder))}
        >
          <Plus className="size-4" />
          {t('create')}
        </Button>
      </div>

      {failed ? (
        <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg border p-4 text-sm">
          <ShieldAlert className="size-4" />
          {t('loadFailed')}
        </div>
      ) : loading ? (
        <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('loading')}
        </div>
      ) : items && items.length === 0 ? (
        <p className="text-muted-foreground p-6 text-sm">{t('empty')}</p>
      ) : (
        <div className="border-border rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.name')}</TableHead>
                <TableHead>{t('columns.slug')}</TableHead>
                <TableHead>{t('columns.status')}</TableHead>
                <TableHead className="text-right">
                  {t('columns.operations')}
                </TableHead>
                <TableHead className="text-right">
                  {t('columns.accounts')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items?.map((item) => (
                <TableRow key={item.id} data-integration={item.slug}>
                  <TableCell>
                    <Link
                      href={`/platform/integrations/${item.id}`}
                      className="text-foreground font-medium hover:underline"
                    >
                      {item.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.slug}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={item.is_active ? 'secondary' : 'outline'}
                      data-status={item.is_active ? 'active' : 'draft'}
                    >
                      {t(item.is_active ? 'status.active' : 'status.draft')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.operationsActive}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.accountsEnabled}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={form !== null}
        onOpenChange={(next) => !next && !saving && setForm(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('createTitle')}</DialogTitle>
            <DialogDescription>{t('createDesc')}</DialogDescription>
          </DialogHeader>
          {form ? (
            <form
              id="integration-create"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <IntegrationFields form={form} mode="create" onChange={setForm} />
            </form>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setForm(null)}
              disabled={saving}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" form="integration-create" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('form.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
