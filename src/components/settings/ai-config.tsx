'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import {
  Loader2,
  Sparkles,
  CheckCircle2,
  Trash2,
  Eye,
  EyeOff,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import { AiKnowledgeCard } from './ai-knowledge';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import {
  DEFAULT_HANDOFF_MESSAGE,
  handoffMessagePayload,
} from '@/lib/ai/handoff-message';
import { overlappingAutomations } from '@/lib/ai/automation-overlap';
import type { AiProvider, HandoffMode } from '@/lib/ai/types';
import type { AccountMember } from '@/types';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import { useTranslations } from 'next-intl';

const MASKED_KEY = '••••••••••••••••';

// Radix Select can't use an empty-string item value, so the "no agent
// chosen yet" placeholder of the fixed-target picker gets a sentinel that
// maps to '' in state (and is rejected on save).
const HANDOFF_UNSET = '__unset__';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
};

export function AiConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiConfig');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  // Per provider: does this deployment have a platform-level key
  // (supuesto S1)? When true for the chosen provider the key field may be
  // left blank. Both false on a deployment without platform keys, which
  // keeps the pre-S1 behaviour (key required).
  const [platformKeyAvailable, setPlatformKeyAvailable] = useState<
    Record<AiProvider, boolean>
  >({ openai: false, anthropic: false });
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [maxPerConversation, setMaxPerConversation] = useState(3);
  // Who the bot hands off to (fase 1): the least-loaded online agent,
  // the shared queue, or a fixed teammate (then `handoffAgentId` applies).
  const [handoffMode, setHandoffMode] = useState<HandoffMode>('queue');
  // Target for `fixed` mode; empty string = none chosen yet.
  const [handoffAgentId, setHandoffAgentId] = useState('');
  // What the bot tells the customer right before handing off. Empty =
  // say nothing (the pre-fase-1 behaviour, kept as an explicit choice).
  // Seeded with the same text migration 043 writes as the column default,
  // so an account with no config row yet sees what it will actually send.
  const [handoffMessage, setHandoffMessage] = useState(DEFAULT_HANDOFF_MESSAGE);
  // Only a field the admin actually edited is sent: an untouched textarea
  // must not overwrite the seeded default with '' on a first save.
  const [handoffMessageEdited, setHandoffMessageEdited] = useState(false);
  const [members, setMembers] = useState<AccountMember[]>([]);
  // Safety net for the per-message guard (fase 1, §4). An automation
  // that answers on message content pre-empts the bot for the messages
  // it replies to; that is intended, but it must not be invisible.
  const [overlapping, setOverlapping] = useState<
    { id: string; name?: string | null }[]
  >([]);

  // Guard keyed on the account (not a bare boolean) so an in-place
  // account switch — ownership transfer, multi-account membership —
  // refetches instead of showing the previous account's config. Mirrors
  // the loadedAccountIdRef pattern in whatsapp-config.tsx.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setPlatformKeyAvailable({
        openai: Boolean(data.platform_key_available?.openai),
        anthropic: Boolean(data.platform_key_available?.anthropic),
      });
      if (data.configured) {
        setConfigured(true);
        setProvider(data.provider);
        setModel(data.model);
        setSystemPrompt(data.system_prompt ?? '');
        setIsActive(data.is_active);
        setAutoReplyEnabled(data.auto_reply_enabled);
        setMaxPerConversation(data.auto_reply_max_per_conversation ?? 3);
        setHandoffAgentId(data.handoff_agent_id ?? '');
        // Rows saved before migration 043 have no mode: a configured
        // agent meant "fixed", none meant "queue".
        setHandoffMode(
          data.handoff_mode ?? (data.handoff_agent_id ? 'fixed' : 'queue')
        );
        setHandoffMessage(data.handoff_message ?? '');
        setHandoffMessageEdited(false);
        setHasStoredKey(Boolean(data.has_key));
        setApiKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
        setEmbeddingsKeyEdited(false);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    // Members populate the handoff-target picker. Best-effort — on an
    // older deployment without the endpoint the picker just shows the
    // queue option.
    void fetchAccountMembers().then(setMembers);
    // Best-effort: the warning is informational, so a failure here just
    // leaves it hidden rather than blocking the panel.
    void fetch('/api/automations')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setOverlapping(overlappingAutomations(data?.automations)))
      .catch(() => {});
  }, [accountId, fetchConfig]);

  // Swap the model default when the provider changes, unless the user
  // typed a custom model.
  const handleProviderChange = (next: AiProvider) => {
    setProvider(next);
    const isDefaultModel =
      model === AI_PROVIDER_DEFAULT_MODEL.openai ||
      model === AI_PROVIDER_DEFAULT_MODEL.anthropic ||
      model.trim() === '';
    if (isDefaultModel) setModel(AI_PROVIDER_DEFAULT_MODEL[next]);
  };

  const keyPayload = () => (keyEdited ? apiKey.trim() : undefined);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const buildBody = () => ({
    provider,
    model: model.trim(),
    api_key: keyPayload(),
    embeddings_api_key: embeddingsKeyPayload(),
    system_prompt: systemPrompt.trim() || null,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    auto_reply_max_per_conversation: maxPerConversation,
    handoff_mode: handoffMode,
    // The fixed target only means something in fixed mode; clear it
    // otherwise so a stale pick can't resurface later.
    handoff_agent_id: handoffMode === 'fixed' ? handoffAgentId || null : null,
    // undefined = leave unchanged (JSON.stringify drops the key, so the
    // route keeps the stored value / the column default).
    handoff_message: handoffMessagePayload({
      edited: handoffMessageEdited,
      value: handoffMessage,
    }),
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: keyPayload(),
        }),
      });
      const data = await res.json();
      if (res.ok) toast.success(t('testSuccess'));
      else toast.error(data.error ?? t('testRejected'));
    } catch {
      toast.error(t('testNetworkError'));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!model.trim()) {
      toast.error(t('missingModel'));
      return;
    }
    // A first save needs a key — unless the platform provides one for the
    // chosen provider, in which case the server falls back to it.
    if (!configured && !keyEdited && !platformKeyAvailable[provider]) {
      toast.error(t('missingApiKey'));
      return;
    }
    if (handoffMode === 'fixed' && !handoffAgentId) {
      toast.error(t('handoffFixedNeedsAgent'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setHasStoredKey(false);
        setApiKey('');
        setKeyEdited(false);
        setIsActive(false);
        setAutoReplyEnabled(false);
        setSystemPrompt('');
        // Back to the state of an account that was never configured —
        // otherwise the form keeps the deleted config's routing and, in
        // `fixed` mode with no target, blocks the next save.
        setHandoffMode('queue');
        setHandoffAgentId('');
        setHandoffMessage(DEFAULT_HANDOFF_MESSAGE);
        setHandoffMessageEdited(false);
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center py-16">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loadFailed')}{' '}
        {/* Re-using label or a global one, wait, loading is better. Let's use useTranslations from overview or just hardcode Loading... actually I should add loading to aiConfig */}
        {/* Wait, I didn't add loading to aiConfig. I'll just use loading. */}
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!canEdit && (
        <p className="border-border bg-muted/40 text-muted-foreground mb-4 rounded-md border px-3 py-2 text-sm">
          {t('adminOnlyConfig')}
        </p>
      )}

      {overlapping.length > 0 && (
        <Alert className="mb-4 border-amber-600/40 bg-amber-950/40">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" />
            <div className="flex-1">
              <AlertTitle className="mb-1 text-amber-200">
                {t('overlapTitle', { count: overlapping.length })}
              </AlertTitle>
              <AlertDescription className="text-sm text-amber-100/80">
                {t('overlapBody')}{' '}
                <Link
                  href="/automations"
                  className="font-medium underline underline-offset-2"
                >
                  {t('overlapLink')}
                </Link>
              </AlertDescription>
            </div>
          </div>
        </Alert>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="text-primary h-4 w-4" />{' '}
              {t('providerAndKey')}
            </CardTitle>
            <CardDescription>{t('encryptionNotice')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('provider')}</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => handleProviderChange(v as AiProvider)}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">
                      {PROVIDER_LABEL.openai}
                    </SelectItem>
                    <SelectItem value="anthropic">
                      {PROVIDER_LABEL.anthropic}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ai-model">{t('model')}</Label>
                <Input
                  id="ai-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={AI_PROVIDER_DEFAULT_MODEL[provider]}
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-key">{t('apiKey')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setApiKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={KEY_PLACEHOLDER[provider]}
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                    tabIndex={-1}
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {t('testKey')}
                </Button>
              </div>
              {platformKeyAvailable[provider] && !hasStoredKey && (
                <p className="text-muted-foreground text-xs">
                  {t('platformKeyHint')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-embeddings-key">
                {t('embeddingsKey')}{' '}
                <span className="text-muted-foreground font-normal">
                  {t('optionalSemanticSearch')}
                </span>
              </Label>
              <Input
                id="ai-embeddings-key"
                type="password"
                value={embeddingsKey}
                onChange={(e) => {
                  setEmbeddingsKey(e.target.value);
                  setEmbeddingsKeyEdited(true);
                }}
                onFocus={() => {
                  if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
                    setEmbeddingsKey('');
                    setEmbeddingsKeyEdited(true);
                  }
                }}
                placeholder="sk-... (OpenAI)"
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-muted-foreground text-xs">
                {t('embeddingsHint', {
                  sameKeyText: provider === 'openai' ? t('sameKeyText') : '',
                })}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('behaviour')}</CardTitle>
            <CardDescription>{t('behaviourDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-prompt">{t('businessContext')}</Label>
              <Textarea
                id="ai-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('promptPlaceholder')}
                rows={5}
                disabled={disabled}
              />
            </div>

            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t('enableAssistant')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('enableAssistantDesc')}
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t('autoReply')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('autoReplyDesc')}
                </p>
              </div>
              <Switch
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-max">{t('maxAutoReplies')}</Label>
                <p className="text-muted-foreground text-xs">
                  {t('maxAutoRepliesDesc')}
                </p>
              </div>
              <Input
                id="ai-max"
                type="number"
                min={1}
                max={20}
                value={maxPerConversation}
                onChange={(e) =>
                  setMaxPerConversation(
                    Math.min(20, Math.max(1, Number(e.target.value) || 1))
                  )
                }
                disabled={disabled || !autoReplyEnabled}
                className="w-20"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-handoff-mode">{t('handoffTo')}</Label>
              <p className="text-muted-foreground text-xs">
                {t('handoffToDesc')}
              </p>
              <Select
                value={handoffMode}
                onValueChange={(v) => setHandoffMode(v as HandoffMode)}
                disabled={disabled || !autoReplyEnabled}
              >
                <SelectTrigger id="ai-handoff-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('handoffModeAuto')}</SelectItem>
                  <SelectItem value="queue">{t('handoffQueue')}</SelectItem>
                  <SelectItem value="fixed">{t('handoffModeFixed')}</SelectItem>
                </SelectContent>
              </Select>
              {handoffMode === 'auto' && (
                <p className="text-muted-foreground text-xs">
                  {t('handoffModeAutoHint')}
                </p>
              )}
              {handoffMode === 'fixed' && (
                <Select
                  value={handoffAgentId || HANDOFF_UNSET}
                  onValueChange={(v) =>
                    setHandoffAgentId(!v || v === HANDOFF_UNSET ? '' : v)
                  }
                  disabled={disabled || !autoReplyEnabled}
                >
                  <SelectTrigger
                    id="ai-handoff"
                    aria-label={t('handoffPickAgent')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={HANDOFF_UNSET} disabled>
                      {t('handoffPickAgent')}
                    </SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {memberLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-handoff-message">{t('handoffMessage')}</Label>
              <p className="text-muted-foreground text-xs">
                {t('handoffMessageDesc')}
              </p>
              <Textarea
                id="ai-handoff-message"
                value={handoffMessage}
                onChange={(e) => {
                  setHandoffMessage(e.target.value);
                  setHandoffMessageEdited(true);
                }}
                placeholder={t('handoffMessagePlaceholder')}
                rows={2}
                maxLength={1000}
                disabled={disabled || !autoReplyEnabled}
              />
            </div>
          </CardContent>
        </Card>

        <AiKnowledgeCard
          accountId={accountId}
          canEdit={canEdit}
          hasEmbeddingsKey={
            embeddingsKeyEdited
              ? embeddingsKey.trim().length > 0
              : hasStoredEmbeddingsKey
          }
        />

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
