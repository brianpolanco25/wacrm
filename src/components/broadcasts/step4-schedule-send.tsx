'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface WhatsAppNumber {
  id: string;
  label: string | null;
  verified_name: string | null;
  display_phone_number: string | null;
  phone_number_id: string;
  is_default: boolean;
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  /**
   * Which of the account's numbers this campaign goes out through
   * (fase 4 §1). Frozen on the `broadcasts` row at creation: a resume
   * days later has to leave through the same number, or the 24-hour
   * window restarts and the quality rating of both numbers suffers.
   */
  whatsAppConfigId: string | null;
  onWhatsAppConfigIdChange: (id: string | null) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  whatsAppConfigId,
  onWhatsAppConfigIdChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);
  const [numbers, setNumbers] = useState<WhatsAppNumber[]>([]);

  // Sender numbers. Loaded here rather than passed down because this is
  // the only step that needs them, and a one-number account (the common
  // case) never sees the picker at all.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/whatsapp/config', { cache: 'no-store' });
        const payload = await res.json();
        if (cancelled) return;
        const rows = (payload.numbers ?? []) as WhatsAppNumber[];
        setNumbers(rows);
        if (!whatsAppConfigId) {
          const fallback = rows.find((r) => r.is_default) ?? rows[0];
          if (fallback) onWhatsAppConfigIdChange(fallback.id);
        }
      } catch {
        // A failed lookup just means no picker: the server falls back
        // to the account default, which is what it did before 053.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once: re-running on every keystroke of the selection would
    // fight the user for control of the select.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (
          audience.type === 'tags' &&
          audience.tagIds &&
          audience.tagIds.length > 0
        ) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set(
            (contactTags ?? []).map((ct) => ct.contact_id)
          );
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          {t('scheduleSend.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="text-foreground mb-1.5 block text-sm font-medium">
          {t('scheduleSend.broadcastName')}
        </label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Sender number. Only worth asking when there is a choice — an
          account with one number has nothing to pick. */}
      {numbers.length > 1 && (
        <div>
          <label className="text-foreground mb-1.5 block text-sm font-medium">
            {t('scheduleSend.sendFrom')}
          </label>
          <select
            value={whatsAppConfigId ?? ''}
            onChange={(e) => onWhatsAppConfigIdChange(e.target.value || null)}
            className="border-border bg-muted text-foreground w-full rounded-md border px-3 py-2 text-sm"
          >
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label ||
                  n.verified_name ||
                  n.display_phone_number ||
                  n.phone_number_id}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground mt-1.5 text-xs">
            {t('scheduleSend.sendFromHint')}
          </p>
        </div>
      )}

      {/* Summary Card */}
      <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
        <p className="text-foreground text-sm font-medium">
          {t('scheduleSend.summary')}
        </p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">
              {t('scheduleSend.template')}
            </p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">
              {t('scheduleSend.audience')}
            </p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Estimated Reach</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="text-primary h-3 w-3 animate-spin" />
              ) : (
                <>
                  <Users className="text-primary h-3.5 w-3.5" />
                  <p className="text-foreground font-medium">
                    {estimatedReach.toLocaleString()}
                  </p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Language</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="border-primary/20 bg-primary/5 rounded-xl border p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="text-primary h-4 w-4 animate-spin" />
              <p className="text-foreground text-sm font-medium">
                {t('scheduleSend.sending')}
              </p>
            </div>
            <span className="text-primary text-xs font-medium">
              {progress}%
            </span>
          </div>
          <div className="bg-muted h-1.5 w-full rounded-full">
            <div
              className="bg-primary h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!name.trim() || isProcessing}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              <Send className="h-4 w-4" />
              {t('scheduleSend.sendNow')}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  Confirm Broadcast
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  You are about to send this broadcast to{' '}
                  <span className="text-popover-foreground font-medium">
                    {estimatedReach.toLocaleString()}
                  </span>{' '}
                  contacts using the{' '}
                  <span className="text-popover-foreground font-medium">
                    {template.name}
                  </span>{' '}
                  template. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  {t('cancel')}
                </Button>
                <Button
                  onClick={() => {
                    setShowConfirm(false);
                    onSend();
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Send className="h-4 w-4" />
                  {t('scheduleSend.sendNow')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
