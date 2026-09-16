// ============================================================
// Construcción de una exportación de conversaciones (fase 7 §5).
//
// Un solo constructor para los dos caminos de la spec:
//
//   - **síncrono** — `GET /api/v1/conversations/{id}/export`: una
//     conversación, devuelta en la misma respuesta, con tope de
//     {@link SYNC_MESSAGE_LIMIT} mensajes.
//   - **asíncrono** — `POST /api/v1/exports`: todas las que casen los
//     filtros, escritas a un objeto del bucket privado `exports`.
//
// Los dos producen el MISMO documento (mismas columnas, mismo orden,
// mismo tratamiento de `media_url`); lo único que cambia es cuántas
// conversaciones entran y dónde acaba el resultado. Un cliente que
// empieza por el síncrono y crece hasta el job no tiene que reescribir
// su parser.
//
// ------------------------------------------------------------
// `media_url`: se exporta la REFERENCIA INTERNA, nunca una URL
// ------------------------------------------------------------
// Los adjuntos viven en buckets privados desde la migración 044. La
// spec deja elegir entre «referencia firmada de corta duración» o «ruta
// interna»; aquí se elige la ruta interna, `storage://<bucket>/<path>`,
// por tres razones:
//
//   1. Una URL firmada es una credencial al portador. Meterla dentro
//      del archivo de un job la ESCRIBE en disco, dentro de un objeto
//      que vive 7 días y que el cliente puede reenviar por correo. La
//      spec prohíbe expresamente persistir una URL firmada; un archivo
//      lleno de ellas es exactamente eso, multiplicado por cada adjunto.
//   2. Aunque se aceptara, estaría muerta. Una firma de 15 minutos
//      dentro de un export que se descarga al día siguiente es un enlace
//      roto disfrazado de dato: peor que no dar nada, porque parece que
//      funciona.
//   3. La referencia interna es estable y identifica el objeto para
//      siempre. Quien la tenga puede resolverla desde el panel, donde el
//      navegador firma con la sesión del propio usuario y la política de
//      la 044 decide — es decir, la lectura del adjunto sigue gobernada
//      por la misma regla que todo lo demás, sin inventar una vía de
//      descarga con rol de servicio que auditar.
//
// Lo que NO sea uno de nuestros buckets (un enlace externo, la URL
// efímera de la CDN de Meta) sale tal cual: no es nuestro y reescribirlo
// solo perdería información.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { serializeConversation } from '@/lib/api/v1/conversations';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import { MEDIA_BUCKETS, parseStorageObjectUrl } from '@/lib/media/storage-url';
import { toCsv } from '@/lib/exports/csv';
import type { Conversation, Message } from '@/types';

/** Formatos que acepta la API. */
export type ExportFormat = 'json' | 'csv';

/** Tope del camino síncrono. Por encima, 409 y a usar el job. */
export const SYNC_MESSAGE_LIMIT = 10_000;

/**
 * Techo del camino asíncrono. No lo pide la spec: lo pide la memoria.
 * El documento se construye entero en RAM antes de subirlo, así que sin
 * un límite una cuenta con años de historial tumbaría el proceso — y con
 * él la bandeja de todas las demás. 250 000 mensajes son ~150 MB de CSV,
 * dentro del bucket (256 MB) y del sitio donde corre. Pasado el techo el
 * job queda `failed` con un mensaje que dice cómo partirlo (filtros
 * `from`/`to`), no se corta en silencio dando un export incompleto por
 * completo.
 */
export const ASYNC_MESSAGE_LIMIT = 250_000;

/** Cuántas filas pide cada página al leer mensajes o conversaciones. */
export const PAGE_SIZE = 1000;

/**
 * Columnas del CSV, en orden. Las diez que fija la spec más
 * `conversation_id` al principio: sin ella un export de varias
 * conversaciones sería un montón de mensajes sin dueño. En el JSON, las
 * mismas claves por mensaje.
 */
export const EXPORT_MESSAGE_COLUMNS = [
  'conversation_id',
  'id',
  'direction',
  'sender_type',
  'content_type',
  'text',
  'media_url',
  'template_name',
  'status',
  'whatsapp_message_id',
  'created_at',
] as const;

export interface ExportMessageRow {
  conversation_id: string;
  id: string;
  direction: 'inbound' | 'outbound';
  sender_type: string;
  content_type: string;
  text: string | null;
  media_url: string | null;
  template_name: string | null;
  status: string;
  whatsapp_message_id: string | null;
  created_at: string;
}

/**
 * La forma en que un adjunto sale de una exportación. Ver la cabecera:
 * `storage://<bucket>/<path>` para lo nuestro, el valor original para
 * cualquier otra cosa, null cuando no hay adjunto.
 */
export function exportMediaReference(
  url: string | null | undefined
): string | null {
  if (!url) return null;
  const ref = parseStorageObjectUrl(url);
  if (!ref || !MEDIA_BUCKETS.has(ref.bucket)) return url;
  return `storage://${ref.bucket}/${ref.path}`;
}

/** Proyecta una fila de `messages` a la forma estable de exportación. */
export function serializeExportMessage(m: Message): ExportMessageRow {
  return {
    conversation_id: m.conversation_id,
    id: m.id,
    // Mismo criterio que `serializeMessage` de la API: `customer` es
    // entrante, todo lo demás sale de nosotros.
    direction: m.sender_type === 'customer' ? 'inbound' : 'outbound',
    sender_type: m.sender_type,
    content_type: m.content_type,
    text: m.content_text ?? null,
    media_url: exportMediaReference(m.media_url),
    template_name: m.template_name ?? null,
    status: m.status,
    whatsapp_message_id: m.message_id ?? null,
    created_at: m.created_at,
  };
}

/** Una conversación con sus mensajes, ya proyectados. */
export interface ExportedConversation {
  conversation: ReturnType<typeof serializeConversation>;
  messages: ExportMessageRow[];
}

export interface ExportDocument {
  generated_at: string;
  conversation_count: number;
  message_count: number;
  conversations: ExportedConversation[];
}

/**
 * Serializa el documento al formato pedido.
 *
 * - `json`: el documento entero, con las conversaciones anidando sus
 *   mensajes. Es la forma que conserva la relación.
 * - `csv`: una fila por MENSAJE, con `conversation_id` como primera
 *   columna. Una hoja de cálculo no anida; aplanar es la única lectura
 *   honesta, y el orden (conversación, luego cronológico) la mantiene
 *   legible.
 */
export function renderExport(
  doc: ExportDocument,
  format: ExportFormat
): string {
  if (format === 'json') return JSON.stringify(doc, null, 2);
  return toCsv(
    EXPORT_MESSAGE_COLUMNS,
    doc.conversations.flatMap((c) => c.messages)
  );
}

/** `Content-Type` del archivo resultante. */
export function exportContentType(format: ExportFormat): string {
  return format === 'json' ? 'application/json' : 'text/csv';
}

/** Extensión del archivo resultante. */
export function exportExtension(format: ExportFormat): string {
  return format === 'json' ? 'json' : 'csv';
}

/** Type-narrow de un valor de `?format=` o del cuerpo del job. */
export function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'json' || value === 'csv';
}

// ------------------------------------------------------------
// Lectura
// ------------------------------------------------------------

/**
 * Cuántos mensajes tiene la conversación. `head: true` para que el
 * recuento no traiga ni una fila: es lo que decide si el camino
 * síncrono responde o manda al job, y hacerlo trayendo los mensajes
 * derrotaría el propósito del tope.
 *
 * Acotado por `conversation_id`, que el llamador ya resolvió bajo su
 * `account_id` (`messages` es tabla hija, ver `service-role-audit.ts`).
 */
export async function countConversationMessages(
  db: SupabaseClient,
  conversationId: string
): Promise<number> {
  const { count, error } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId);
  if (error) throw new Error(`count failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Todos los mensajes de una conversación en orden cronológico, por
 * páginas. `(created_at, id)` ascendente: el id desempata para que dos
 * mensajes del mismo milisegundo no bailen entre páginas.
 */
export async function fetchConversationMessages(
  db: SupabaseClient,
  conversationId: string,
  opts: { max?: number; pageSize?: number } = {}
): Promise<ExportMessageRow[]> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const out: ExportMessageRow[] = [];

  for (let offset = 0; out.length < max; offset += pageSize) {
    const { data, error } = await db
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`read failed: ${error.message}`);

    const rows = (data ?? []) as unknown as Message[];
    for (const row of rows) {
      out.push(serializeExportMessage(row));
      if (out.length >= max) break;
    }
    if (rows.length < pageSize) break;
  }

  return out;
}

export interface ConversationFilters {
  status?: string;
  contactId?: string;
  /** ISO. Acota `conversations.created_at` por abajo (inclusive). */
  from?: string;
  /** ISO. Acota `conversations.created_at` por arriba (inclusive). */
  to?: string;
}

/**
 * Las conversaciones de la cuenta que casan los filtros, más antiguas
 * primero, por páginas. El `.eq('account_id', …)` va SIEMPRE y no se
 * deriva de `params`: un job guarda sus filtros, no su cuenta.
 */
export async function fetchConversations(
  db: SupabaseClient,
  accountId: string,
  filters: ConversationFilters = {},
  opts: { pageSize?: number } = {}
): Promise<Conversation[]> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const out: Conversation[] = [];

  for (let offset = 0; ; offset += pageSize) {
    let query = db
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('account_id', accountId);

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.contactId) query = query.eq('contact_id', filters.contactId);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lte('created_at', filters.to);

    const { data, error } = await query
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`read failed: ${error.message}`);

    const rows = (data ?? []) as unknown as Conversation[];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }

  return out;
}

/** El export no cabe: el mensaje es el que ve el cliente en el job. */
export class ExportTooLargeError extends Error {
  constructor(limit: number) {
    super(
      `This export exceeds ${limit.toLocaleString('en-US')} messages. ` +
        'Narrow it with the `from` / `to` filters and run it in parts.'
    );
    this.name = 'ExportTooLargeError';
  }
}

/** Documento de una sola conversación (camino síncrono). */
export function buildSingleConversationDocument(
  conversation: Conversation,
  messages: ExportMessageRow[],
  now: Date = new Date()
): ExportDocument {
  return {
    generated_at: now.toISOString(),
    conversation_count: 1,
    message_count: messages.length,
    conversations: [
      {
        conversation: serializeConversation(
          normalizeConversation(conversation)
        ),
        messages,
      },
    ],
  };
}

/**
 * Documento de todas las conversaciones que casan los filtros (camino
 * asíncrono). Lanza si el total de mensajes pasa de
 * {@link ASYNC_MESSAGE_LIMIT}: ver el porqué en esa constante.
 */
export async function buildConversationsDocument(
  db: SupabaseClient,
  accountId: string,
  filters: ConversationFilters = {},
  opts: { pageSize?: number; maxMessages?: number; now?: Date } = {}
): Promise<ExportDocument> {
  const maxMessages = opts.maxMessages ?? ASYNC_MESSAGE_LIMIT;
  const conversations = await fetchConversations(db, accountId, filters, opts);

  const out: ExportedConversation[] = [];
  let total = 0;

  for (const raw of conversations) {
    const messages = await fetchConversationMessages(db, raw.id, opts);
    total += messages.length;
    if (total > maxMessages) {
      throw new ExportTooLargeError(maxMessages);
    }
    out.push({
      conversation: serializeConversation(normalizeConversation(raw)),
      messages,
    });
  }

  return {
    generated_at: (opts.now ?? new Date()).toISOString(),
    conversation_count: out.length,
    message_count: total,
    conversations: out,
  };
}
