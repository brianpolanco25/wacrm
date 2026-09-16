import { useTranslations } from 'next-intl';

import { CodeBlock } from '../code-block';
import type { TocEntry } from '../docs-shell';
import type {
  FieldRow,
  ReferenceModel,
  ReferenceOperation,
  ResponseRow,
} from './model';
import type { ParameterLocation } from './types';

// ============================================================
// Pintado de la referencia. Aquí no se decide nada: el modelo ya viene
// resuelto de `model.ts` y esto solo elige etiquetas y clases.
// ============================================================

const METHOD_STYLES: Record<string, string> = {
  get: 'bg-primary-soft-2 text-foreground',
  post: 'bg-positive/15 text-positive',
  patch: 'bg-brand/20 text-brand-ink',
  put: 'bg-brand/20 text-brand-ink',
  delete: 'bg-destructive/15 text-destructive',
};

const ANCHOR_WEBHOOKS = 'webhook-events';

export function referenceToc(
  model: ReferenceModel,
  webhooksLabel: string
): TocEntry[] {
  const entries = model.sections.map((section) => ({
    id: section.id,
    text: section.name,
  }));
  return model.webhooks.length > 0
    ? [...entries, { id: ANCHOR_WEBHOOKS, text: webhooksLabel }]
    : entries;
}

function MethodBadge({ method }: { method: string }) {
  return (
    <span
      className={`rounded-md px-2 py-0.5 font-mono text-xs font-semibold uppercase ${METHOD_STYLES[method] ?? 'bg-muted text-muted-foreground'}`}
    >
      {method}
    </span>
  );
}

function Chip({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'brand' | 'warn';
}) {
  const styles = {
    neutral: 'bg-card-2 text-muted-foreground',
    brand: 'bg-primary-soft text-foreground',
    warn: 'bg-destructive/15 text-destructive',
  } as const;
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-mono text-[0.7rem] ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

/** Una fila de tabla; `where` solo lo traen los parámetros. */
type TableRow = FieldRow & { where?: string };

function FieldTable({
  rows,
  columns,
}: {
  rows: TableRow[];
  columns: { field: string; type: string; description: string; where?: string };
}) {
  const showWhere = columns.where !== undefined;
  return (
    <div className="border-border mt-3 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-card-2">
          <tr>
            <th scope="col" className="text-foreground px-3 py-2 font-semibold">
              {columns.field}
            </th>
            {showWhere && (
              <th
                scope="col"
                className="text-foreground px-3 py-2 font-semibold"
              >
                {columns.where}
              </th>
            )}
            <th scope="col" className="text-foreground px-3 py-2 font-semibold">
              {columns.type}
            </th>
            <th scope="col" className="text-foreground px-3 py-2 font-semibold">
              {columns.description}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.name}-${row.where ?? ''}`}
              className="border-border/70 border-t align-top"
            >
              <td className="text-foreground px-3 py-2 font-mono text-[0.8rem]">
                {row.name}
                {row.required && <span className="text-brand-ink ml-1">*</span>}
              </td>
              {showWhere && (
                <td className="text-muted-foreground px-3 py-2 font-mono text-[0.75rem]">
                  {row.where ?? ''}
                </td>
              )}
              <td className="text-muted-foreground px-3 py-2 font-mono text-[0.75rem]">
                {row.type}
              </td>
              <td className="text-muted-foreground px-3 py-2">
                {row.description ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResponseList({ responses }: { responses: ResponseRow[] }) {
  return (
    <ul className="mt-3 space-y-2">
      {responses.map((response) => (
        <li
          key={response.status}
          className="flex flex-wrap items-baseline gap-2"
        >
          <Chip tone={response.status.startsWith('2') ? 'brand' : 'warn'}>
            {response.status}
          </Chip>
          <span className="text-muted-foreground text-sm">
            {response.description}
          </span>
          {response.contentType && (
            <span className="text-muted-foreground font-mono text-[0.7rem]">
              {response.contentType}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Operation({ operation }: { operation: ReferenceOperation }) {
  const t = useTranslations('Developers.reference');
  const localised: Record<ParameterLocation, string> = {
    path: t('inPath'),
    query: t('inQuery'),
    header: t('inHeader'),
    cookie: 'cookie',
  };
  const parameters: TableRow[] = operation.parameters.map((row) => ({
    ...row,
    where: localised[row.in],
  }));
  const success = operation.responses.filter((r) => r.status.startsWith('2'));

  return (
    <article
      id={operation.id}
      className="border-border bg-card mt-6 scroll-mt-24 rounded-xl border p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <MethodBadge method={operation.method} />
        <code className="text-foreground font-mono text-sm break-all">
          {operation.path}
        </code>
        {operation.deprecated && <Chip tone="warn">{t('deprecated')}</Chip>}
      </div>

      <h3 className="text-foreground mt-3 font-semibold">
        {operation.summary}
      </h3>
      {operation.description && (
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
          {operation.description}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs font-semibold">
          {t('scopes')}:
        </span>
        {operation.scopes.length === 0 ? (
          <Chip>{t('noScope')}</Chip>
        ) : (
          operation.scopes.map((scope) => (
            <Chip key={scope} tone="brand">
              {scope}
            </Chip>
          ))
        )}
        {operation.idempotent && <Chip>{t('idempotent')}</Chip>}
      </div>

      <h4 className="text-foreground mt-5 text-sm font-semibold">
        {t('parameters')}
      </h4>
      {parameters.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-sm">
          {t('noParameters')}
        </p>
      ) : (
        <FieldTable
          rows={parameters}
          columns={{
            field: t('colField'),
            where: t('colIn'),
            type: t('colType'),
            description: t('colDescription'),
          }}
        />
      )}

      {operation.requestBody && (
        <>
          <h4 className="text-foreground mt-5 text-sm font-semibold">
            {t('requestBody')}
          </h4>
          {operation.requestBody.description && (
            <p className="text-muted-foreground mt-1 text-sm">
              {operation.requestBody.description}
            </p>
          )}
          {operation.requestBody.fields.length > 0 && (
            <FieldTable
              rows={operation.requestBody.fields}
              columns={{
                field: t('colField'),
                type: t('colType'),
                description: t('colDescription'),
              }}
            />
          )}
        </>
      )}

      <h4 className="text-foreground mt-5 text-sm font-semibold">
        {t('responses')}
      </h4>
      <ResponseList responses={operation.responses} />

      <CodeBlock code={operation.curl} lang="bash" label={t('example')} />

      {success.map(
        (response) =>
          response.example && (
            <CodeBlock
              key={response.status}
              code={response.example}
              lang="json"
              label={`${t('colStatus')} ${response.status}`}
            />
          )
      )}
    </article>
  );
}

export function ReferenceView({ model }: { model: ReferenceModel }) {
  const t = useTranslations('Developers.reference');
  return (
    <div className="mt-10">
      <dl className="border-border bg-card-2 grid gap-3 rounded-xl border p-4 text-sm sm:grid-cols-2">
        {model.server && (
          <div>
            <dt className="text-muted-foreground text-xs font-semibold uppercase">
              {t('servers')}
            </dt>
            <dd className="text-foreground mt-0.5 font-mono break-all">
              {model.server}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground text-xs font-semibold uppercase">
            {t('version')}
          </dt>
          <dd className="text-foreground mt-0.5 font-mono">{model.version}</dd>
        </div>
      </dl>

      {model.sections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          className="mt-12 scroll-mt-24"
        >
          <h2 className="text-foreground text-xl font-semibold tracking-tight">
            {section.name}
          </h2>
          {section.description && (
            <p className="text-muted-foreground mt-1 leading-relaxed">
              {section.description}
            </p>
          )}
          {section.operations.map((operation) => (
            <Operation key={operation.id} operation={operation} />
          ))}
        </section>
      ))}

      {model.webhooks.length > 0 && (
        <section id={ANCHOR_WEBHOOKS} className="mt-12 scroll-mt-24">
          <h2 className="text-foreground text-xl font-semibold tracking-tight">
            {t('webhookEvents')}
          </h2>
          {model.webhooks.map((webhook) => (
            <article
              key={webhook.id}
              id={webhook.id}
              className="border-border bg-card mt-6 scroll-mt-24 rounded-xl border p-5"
            >
              <code className="text-foreground font-mono text-sm">
                {webhook.event}
              </code>
              {webhook.summary && (
                <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
                  {webhook.summary}
                </p>
              )}
              {webhook.fields.length > 0 && (
                <FieldTable
                  rows={webhook.fields}
                  columns={{
                    field: t('colField'),
                    type: t('colType'),
                    description: t('colDescription'),
                  }}
                />
              )}
              {webhook.example && (
                <CodeBlock
                  code={webhook.example}
                  lang="json"
                  label={t('example')}
                />
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
