import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getMetaAppSecret,
  getPlatformSignupConfig,
  isMissingWebhookVerifyToken,
} from './platform-mode';

// ---------------------------------------------------------------------------
// Mode detection (fase 4 §1.1). The whole "self-hosted keeps working"
// criterion rests on this returning null by default: three variables
// have to be deliberately set for the integrated signup to exist.
// ---------------------------------------------------------------------------

const KEYS = [
  'META_APP_ID',
  'META_CONFIG_ID',
  'META_APP_SECRET',
  'META_GRAPH_VERSION',
  'META_WEBHOOK_VERIFY_TOKEN',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function platform() {
  process.env.META_APP_ID = 'app-123';
  process.env.META_CONFIG_ID = 'cfgid-456';
  process.env.META_APP_SECRET = 'secret';
}

describe('getPlatformSignupConfig', () => {
  it('is null with nothing configured — self-hosted is the default', () => {
    expect(getPlatformSignupConfig()).toBeNull();
  });

  it('returns the three ids when all of them are set', () => {
    platform();
    expect(getPlatformSignupConfig()).toEqual({
      appId: 'app-123',
      configId: 'cfgid-456',
      graphVersion: 'v21.0',
    });
  });

  it('never returns the app secret', () => {
    platform();
    expect(JSON.stringify(getPlatformSignupConfig())).not.toContain('secret');
  });

  it.each(['META_APP_ID', 'META_CONFIG_ID', 'META_APP_SECRET'])(
    'is null when %s is missing',
    (missing) => {
      platform();
      delete process.env[missing];
      expect(getPlatformSignupConfig()).toBeNull();
    }
  );

  it.each(['META_APP_ID', 'META_CONFIG_ID', 'META_APP_SECRET'])(
    'treats a whitespace-only %s as unset',
    (blank) => {
      platform();
      process.env[blank] = '   \n';
      expect(getPlatformSignupConfig()).toBeNull();
    }
  );

  it('trims values that arrived with a trailing newline from a secrets file', () => {
    process.env.META_APP_ID = 'app-123\n';
    process.env.META_CONFIG_ID = ' cfgid-456 ';
    process.env.META_APP_SECRET = 'secret\n';
    const config = getPlatformSignupConfig();
    expect(config?.appId).toBe('app-123');
    expect(config?.configId).toBe('cfgid-456');
  });

  it('lets the operator move the graph version without a redeploy', () => {
    platform();
    process.env.META_GRAPH_VERSION = 'v23.0';
    expect(getPlatformSignupConfig()?.graphVersion).toBe('v23.0');
  });
});

describe('getMetaAppSecret', () => {
  it('is the only way to obtain the secret, and it trims', () => {
    process.env.META_APP_SECRET = ' shh \n';
    expect(getMetaAppSecret()).toBe('shh');
  });

  it('is null when unset', () => {
    expect(getMetaAppSecret()).toBeNull();
  });
});

describe('isMissingWebhookVerifyToken', () => {
  it('is true when the operator never set one', () => {
    expect(isMissingWebhookVerifyToken()).toBe(true);
  });

  it('is true for a whitespace-only value, same rule as f2.4', () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = '  ';
    expect(isMissingWebhookVerifyToken()).toBe(true);
  });

  it('is false once it is set', () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'a-random-string';
    expect(isMissingWebhookVerifyToken()).toBe(false);
  });
});
