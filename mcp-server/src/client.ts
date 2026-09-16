// ============================================================
// wacrm public API client.
//
// A thin wrapper over the `/api/v1` REST surface. It attaches the
// bearer key, unwraps the `{ data }` / `{ error }` envelope, and
// turns API failures into a typed WacrmApiError the tools can render
// cleanly. Nothing here knows about MCP — it's just the CRM API.
// ============================================================

import type { Config } from './config.js';

/** A structured error from the wacrm API envelope (`{ error: { code, message } }`). */
export class WacrmApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'WacrmApiError';
    this.status = status;
    this.code = code;
  }
}

export interface Paginated<T> {
  data: T[];
  next_cursor: string | null;
}

export class WacrmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: Pick<Config, 'baseUrl' | 'apiKey'>) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    } = {}
  ): Promise<{ data: T; meta?: { next_cursor: string | null } }> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      throw new WacrmApiError(
        0,
        'network_error',
        `Could not reach wacrm at ${this.baseUrl}: ${(err as Error).message}`
      );
    }

    // 429s carry a Retry-After we surface to the model.
    let payload: unknown = undefined;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // Non-JSON body (e.g. an upstream proxy error page).
        if (!res.ok) {
          throw new WacrmApiError(res.status, 'internal', text.slice(0, 500));
        }
      }
    }

    if (!res.ok) {
      const envelope = payload as
        { error?: { code?: string; message?: string } } | undefined;
      const code = envelope?.error?.code ?? 'internal';
      let message =
        envelope?.error?.message ?? `Request failed with status ${res.status}`;
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        if (retryAfter) message += ` (retry after ${retryAfter}s)`;
      }
      throw new WacrmApiError(res.status, code, message);
    }

    const envelope = payload as {
      data: T;
      meta?: { next_cursor: string | null };
    };
    return { data: envelope.data, meta: envelope.meta };
  }

  private async list<T>(
    path: string,
    query: Record<string, string | number | undefined>
  ): Promise<Paginated<T>> {
    const res = await this.request<T[]>('GET', path, { query });
    return { data: res.data, next_cursor: res.meta?.next_cursor ?? null };
  }

  // --- Identity -----------------------------------------------------

  me(): Promise<{ data: unknown }> {
    return this.request('GET', '/me');
  }

  // --- Messages -----------------------------------------------------

  sendMessage(body: unknown): Promise<{ data: unknown }> {
    return this.request('POST', '/messages', { body });
  }

  // --- Contacts -----------------------------------------------------

  listContacts(query: {
    limit?: number;
    cursor?: string;
    search?: string;
    tag?: string;
  }): Promise<Paginated<unknown>> {
    return this.list('/contacts', query);
  }

  getContact(id: string): Promise<{ data: unknown }> {
    return this.request('GET', `/contacts/${encodeURIComponent(id)}`);
  }

  createContact(body: unknown): Promise<{ data: unknown }> {
    return this.request('POST', '/contacts', { body });
  }

  updateContact(id: string, body: unknown): Promise<{ data: unknown }> {
    return this.request('PATCH', `/contacts/${encodeURIComponent(id)}`, {
      body,
    });
  }

  // --- Conversations ------------------------------------------------

  listConversations(query: {
    limit?: number;
    cursor?: string;
    status?: string;
    contact_id?: string;
  }): Promise<Paginated<unknown>> {
    return this.list('/conversations', query);
  }

  getConversation(id: string): Promise<{ data: unknown }> {
    return this.request('GET', `/conversations/${encodeURIComponent(id)}`);
  }

  listConversationMessages(
    id: string,
    query: { limit?: number; cursor?: string }
  ): Promise<Paginated<unknown>> {
    return this.list(
      `/conversations/${encodeURIComponent(id)}/messages`,
      query
    );
  }

  // --- Broadcasts ---------------------------------------------------

  sendBroadcast(body: unknown): Promise<{ data: unknown }> {
    return this.request('POST', '/broadcasts', { body });
  }

  getBroadcast(id: string): Promise<{ data: unknown }> {
    return this.request('GET', `/broadcasts/${encodeURIComponent(id)}`);
  }

  // --- Tags ---------------------------------------------------------

  listTags(query: {
    limit?: number;
    cursor?: string;
    search?: string;
  }): Promise<Paginated<unknown>> {
    return this.list('/tags', query);
  }

  getTag(id: string): Promise<{ data: unknown }> {
    return this.request('GET', `/tags/${encodeURIComponent(id)}`);
  }

  createTag(body: unknown): Promise<{ data: unknown }> {
    return this.request('POST', '/tags', { body });
  }

  updateTag(id: string, body: unknown): Promise<{ data: unknown }> {
    return this.request('PATCH', `/tags/${encodeURIComponent(id)}`, { body });
  }

  deleteTag(id: string): Promise<{ data: unknown }> {
    return this.request('DELETE', `/tags/${encodeURIComponent(id)}`);
  }

  /** Additive: adds tags by id without touching the ones already on the contact. */
  addContactTags(id: string, tagIds: string[]): Promise<{ data: unknown }> {
    return this.request('POST', `/contacts/${encodeURIComponent(id)}/tags`, {
      body: { tag_ids: tagIds },
    });
  }

  removeContactTag(id: string, tagId: string): Promise<{ data: unknown }> {
    return this.request(
      'DELETE',
      `/contacts/${encodeURIComponent(id)}/tags/${encodeURIComponent(tagId)}`
    );
  }

  // --- Templates ----------------------------------------------------

  listTemplates(query: {
    limit?: number;
    cursor?: string;
    status?: string;
    language?: string;
    category?: string;
    search?: string;
  }): Promise<Paginated<unknown>> {
    return this.list('/templates', query);
  }

  getTemplate(id: string): Promise<{ data: unknown }> {
    return this.request('GET', `/templates/${encodeURIComponent(id)}`);
  }

  createTemplate(body: unknown): Promise<{ data: unknown }> {
    return this.request('POST', '/templates', { body });
  }

  updateTemplate(id: string, body: unknown): Promise<{ data: unknown }> {
    return this.request('PATCH', `/templates/${encodeURIComponent(id)}`, {
      body,
    });
  }

  deleteTemplate(
    id: string,
    query: { from?: string }
  ): Promise<{ data: unknown }> {
    return this.request('DELETE', `/templates/${encodeURIComponent(id)}`, {
      query,
    });
  }

  syncTemplates(body: unknown): Promise<{ data: unknown }> {
    return this.request('POST', '/templates/sync', { body });
  }

  // --- Exports ------------------------------------------------------

  listExports(query: {
    limit?: number;
    cursor?: string;
  }): Promise<Paginated<unknown>> {
    return this.list('/exports', query);
  }

  getExport(id: string): Promise<{ data: unknown }> {
    return this.request('GET', `/exports/${encodeURIComponent(id)}`);
  }

  createExport(body: unknown): Promise<{ data: unknown }> {
    return this.request('POST', '/exports', { body });
  }

  /**
   * `GET /conversations/{id}/export` is the one endpoint whose success
   * body is the FILE, not the `{ data }` envelope — so it can't go
   * through request(). Errors still come back in the envelope, so we
   * decode those the same way everything else does.
   */
  async exportConversation(
    id: string,
    format: 'json' | 'csv'
  ): Promise<{ contentType: string; filename: string | null; body: string }> {
    const url = new URL(
      `${this.baseUrl}/api/v1/conversations/${encodeURIComponent(id)}/export`
    );
    url.searchParams.set('format', format);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: '*/*' },
      });
    } catch (err) {
      throw new WacrmApiError(
        0,
        'network_error',
        `Could not reach wacrm at ${this.baseUrl}: ${(err as Error).message}`
      );
    }

    const text = await res.text();

    if (!res.ok) {
      let code = 'internal';
      let message = `Request failed with status ${res.status}`;
      try {
        const envelope = JSON.parse(text) as {
          error?: { code?: string; message?: string };
        };
        code = envelope.error?.code ?? code;
        message = envelope.error?.message ?? message;
      } catch {
        if (text) message = text.slice(0, 500);
      }
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        if (retryAfter) message += ` (retry after ${retryAfter}s)`;
      }
      throw new WacrmApiError(res.status, code, message);
    }

    const disposition = res.headers.get('Content-Disposition');
    const match = disposition?.match(/filename="([^"]*)"/);

    return {
      contentType:
        res.headers.get('Content-Type') ?? 'application/octet-stream',
      filename: match ? match[1] : null,
      body: text,
    };
  }
}
