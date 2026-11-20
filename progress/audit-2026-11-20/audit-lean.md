# wacrm audit — leanness, client side, MCP server, build/CI config

Read-only. Nothing in the repo was changed, no test suite / build / tsc / eslint was run.
Paths are relative to `/mnt/nvme-big/Dev/apps/cabbity/wacrm`. Line numbers are from `main` at `663af39`.

Row-cap premise used in findings 1 and 4: the repo itself states that PostgREST returns at most
`db-max-rows` rows (1000 on Supabase by default) when a query has no `.limit()`/`.range()` —
`docs/security.md:108`, `src/lib/api/v1/tags.ts:105`, `src/lib/whatsapp/reencrypt.ts:17`.
I did not check the value configured on the production project.

---

## 1. Broadcasts sent from the panel silently stop at 1000 recipients, and the exclusion list fails open
- **Severity:** must · **Confidence:** high (medium on the exact cap in production)
- **Where:** `src/hooks/use-broadcast-sending.ts:183-186, 194-196, 206-208, 226-230, 346-348, 478-480`
- **What:** the whole audience is resolved in the browser with unpaginated queries.
- **Concrete cases:**
  - Audience "all", account with 2,500 contacts: `.from('contacts').select('*').eq('account_id', …)` (183) returns 1000 rows in no defined order. 1,500 contacts never get the campaign and nothing says so.
  - Even when more than 1000 recipient rows are inserted (CSV audience), the re-read at 478 (`.from('broadcast_recipients').select('*, contact:contacts(*)').eq('broadcast_id', …)`) returns 1000; the rest stay `pending` while line 623 marks the broadcast `sent`.
  - Exclude tags (226-230): the query's `error` is not read and its rows are capped. On an error, or when the excluded tag has more than 1000 members, `excludedIds` is incomplete and contacts the user explicitly excluded receive the template.
  - `.in('id', uniqueContactIds)` at 206-208 and 346-348 puts every id in the URL (37 bytes each). The same file pages this exact pattern by 500 at 144-152 "to stay safe"; these two sites do not.
- **Smallest fix:** one local `fetchAll(queryFactory)` helper that loops `.range()` in pages of 1000 (about 12 lines), used at the five read sites; chunk the two `.in()` calls like line 147 already does; throw when the exclude query errors.
- **Lines saved:** 0 (adds about 20).

## 2. A draft typed for one conversation is sent to the next one
- **Severity:** must · **Confidence:** high
- **Where:** `src/components/inbox/message-thread.tsx:1254` (`<MessageComposer conversationId=… />` with no `key`); state lives in `src/components/inbox/message-composer.tsx:148-186`.
- **Evidence:** `grep -n "key=" message-thread.tsx inbox/page.tsx` shows no key on `MessageComposer` or `MessageThread`; `grep -n conversationId message-composer.tsx` shows the prop is only used for the AI-draft request (268) — nothing resets `text`, the staged media `draft`, or an in-progress recording. `replyTo` *is* reset on conversation change (`message-thread.tsx:475-477`), so the reset was intended.
- **Concrete case:** type "Su resultado salió positivo" in patient A's chat, click patient B in the list, press Enter → `handleSend` posts it with `conversation_id` = B. Same for a staged image or voice note.
- **Smallest fix:** `key={conversation.id}` on `<MessageComposer>`. Its unmount cleanup (206-214) already stops the recorder and deletes the staged upload.
- **Lines saved:** 0 (1 line added).

## 3. Authenticated HTML and cookie-refresh responses go out as `Cache-Control: public, s-maxage=300, stale-while-revalidate=86400`
- **Severity:** should (must the day a CDN or caching proxy is put in front) · **Confidence:** high
- **Where:** `next.config.ts` headers rule `'/:path((?!_next/static|_next/image|api).*)'`; `src/middleware.ts:118-128`.
- **Evidence:**
  - The comment in `next.config.ts` says Next "still set[s] private / no-store for per-user responses". It does not: `node_modules/next/dist/build/templates/app-page.js:990` only applies its default `if (!res.getHeader('Cache-Control'))`. `src/middleware.ts:118-121` already records this ("checked against a production build: a ƒ route still comes back `public, s-maxage=300`").
  - The middleware override is applied only `if (supportToken !== null)` (126). Every other response keeps the public header, including: all `(dashboard)` pages (dynamic — `src/app/(dashboard)/layout.tsx` awaits cookies and redirects per account), the unauthenticated `/inbox → /login` redirect, and responses on which `getUser()` rotated the session and wrote `Set-Cookie`.
  - `@supabase/ssr` 0.12 warns about exactly this (`node_modules/@supabase/ssr/dist/main/types.d.ts:22-28`: "Responses that set auth cookies must not be cached by CDNs or reverse proxies, otherwise one user's session token can be served to a different user") and passes the headers as the second argument of `setAll`. `src/middleware.ts` `setAll(cookiesToSet)` ignores that argument.
- **Impact today:** none visible without a shared cache; the rule was written for one (the comment names Hostinger's CDN).
- **Smallest fix:** in `withRefreshedCookies`, set `private, no-store` when `user` is present or any cookie was written, instead of only when a support cookie exists (change one condition). Then correct the comment in `next.config.ts`.
- **Lines saved:** 0.

## 4. Inbox loads whole tables into the browser; long threads lose their newest messages
- **Severity:** should · **Confidence:** high (medium on the production cap)
- **Where / cases:**
  - `src/components/inbox/message-thread.tsx:344-348`: `messages … .order('created_at', { ascending: true })`, no limit. A conversation with more than 1000 messages returns the *oldest* 1000, so the thread opens without its most recent messages. Below the cap, the entire history is still refetched on every resync.
  - `src/components/inbox/conversation-list.tsx:183-186`: every conversation of the account with its joins, refetched each time `resyncToken` changes — which `src/app/(dashboard)/inbox/page.tsx:393-398` does on every `visibilitychange` (each time the tab regains focus). Past 1000 conversations the older ones cannot be found by the list's client-side search.
  - `src/hooks/use-total-unread.ts:62-65`: selects `id, unread_count` for every conversation to count the unread ones; no `order`, so past the cap the sidebar badge undercounts arbitrarily.
- **Smallest fix:** thread: `.order('created_at', { ascending: false }).limit(200)` and reverse (a "load older" control can come later); unread hook: add `.gt('unread_count', 0)` — the realtime handler already adds rows as they change; list: `.limit()` plus a server-side search, or at least skip the refetch when the tab was hidden for a few seconds.
- **Lines saved:** 0.

## 5. `shadcn` (a CLI) is a runtime dependency for one CSS file, and it is what makes the MCP server typecheck in CI
- **Severity:** should · **Confidence:** high
- **Where:** `package.json` dependencies (`"shadcn": "^4.16.2"`), `src/app/globals.css:3`, `tsconfig.json`, `.github/workflows/ci.yml`.
- **Evidence:**
  - `git grep` for `shadcn` imports across `src`, `mcp-server`, config and CSS finds one use: `@import 'shadcn/tailwind.css'` (a 568-line, 16 KB file of keyframes/utilities).
  - Reachability over `package-lock.json`: 803 packages in total, 609 without `shadcn` — 194 packages (24%) are installed only for it, including `express`, `hono`, `@modelcontextprotocol/sdk`, `ts-morph`, `@babel/preset-typescript`, `execa`, `@dotenvx/dotenvx`. Three of the `overrides` in `package.json` (`hono`, `fast-uri`, `ip-address`) patch packages that exist only in that subtree.
  - `tsconfig.json` includes `**/*.ts` and excludes only `node_modules`, so root `tsc --noEmit` also compiles `mcp-server/src`. CI runs a single root `npm ci`; `mcp-server/node_modules` does not exist; `mcp-server/src/index.ts` imports `@modelcontextprotocol/sdk`, which in the root tree is reachable only through `shadcn` (lock: `^1.26.0`, while `mcp-server/package.json` declares `^1.18.0` with TypeScript `^5.7` and its own lockfile). So the published `wacrm-mcp` package is never built with its own config or dependency versions in CI, and it typechecks by accident.
- **Smallest fix:** copy `node_modules/shadcn/dist/tailwind.css` to `src/app/shadcn.css`, import that, remove `shadcn` and the three overrides; add `"mcp-server"` to `tsconfig.json` `exclude`; add one CI step `npm ci && npm run build` with `working-directory: mcp-server`. (Zero-code alternative for the first part: move `shadcn` to `devDependencies` — keeps the 194 packages.)
- **Removable:** 1 dependency, 194 transitive packages, 3 overrides. Lines: +568 vendored CSS, about -15 in manifests.

## 6. Panel routes and `/api/v1` routes implement the same template and webhook operations twice
- **Severity:** should · **Confidence:** high that it is duplicated, medium on the line estimate
- **Where:** `src/app/api/whatsapp/templates/{[id],submit,sync}/route.ts` (801 lines) vs `src/app/api/v1/templates/{route,[id]/route,sync/route}.ts` (732 lines); `src/app/api/account/webhooks/**` (5 routes, 515 lines) vs `src/app/api/v1/webhooks/**` (5 routes, 472 lines).
- **Evidence:** both template `PATCH` handlers run the same sequence inline — look up row, check `meta_template_id`, check `EDITABLE_STATUSES`, refuse Authentication, `validateTemplatePayload`, `ensureImageHeaderHandle`, `buildMetaTemplatePayload`, `editMessageTemplate`, write `submission_error` on failure, then the same 13-column update — and both `DELETE` handlers repeat the Meta-delete-then-local-delete sequence. `isDryRun()` is defined three times and `EDITABLE_STATUSES` twice. The copies have already drifted: the panel writes use `.eq('id', id)` only while v1 adds `.eq('account_id', …)`; the panel resolves the account's default number while v1 resolves the WABA through `resolveTemplateWaba`; the status codes for the same refusals differ (400 vs 409). For webhooks the primitives are shared (`@/lib/webhooks/endpoints`), but the `PATCH` validation block (url / events / is_active / failure-streak reset / "no updatable fields") is copied in both `[id]/route.ts` files.
- **Not duplicated (checked):** `src/app/(public)/developers/webhooks` and `developers/guides/webhooks` are 13- and 15-line pages that delegate to shared content.
- **Smallest fix:** move the edit / delete / submit sequences into `src/lib/whatsapp/` functions that return a result object (v1 already has `resolveTemplateWaba`, `metaErrorResponse`, `TEMPLATE_SELECT` in `src/lib/api/v1/templates.ts`); each route keeps only auth and its response envelope. Same for one `buildWebhookPatch(body)`.
- **Lines saved:** about 350 (templates) + 80 (webhooks).

## 7. The broadcast detail page has its own CSV writer without the formula-injection guard
- **Severity:** should · **Confidence:** high
- **Where:** `src/app/(dashboard)/broadcasts/[id]/page.tsx:131-134` (`toCsv`) vs `src/lib/exports/csv.ts:63-80` (`csvCell` / `csvRow`).
- **Evidence:** the page escapes with `"${v.replace(/"/g,'""')}"` only. The lib prefixes `'` to cells starting with `= + - @ \t \r` and documents why. The exported columns include `r.contact?.name` (page line 219), which comes from the customer's WhatsApp profile name.
- **Concrete case:** a contact named `=HYPERLINK("http://x.example","Ver")` → the downloaded CSV contains `"=HYPERLINK(""http://x.example"",""Ver"")"`, which Excel evaluates as a formula. The server-side export of the same data neutralises it.
- **Smallest fix:** delete the local `toCsv` and build the file with `[header, ...rows].map(csvRow).join('\r\n')` from `@/lib/exports/csv` (the module has no imports, so it is safe in a client component).
- **Lines saved:** about 5.

## 8. Contact search fails on a comma or parenthesis; the sanitiser exists four times elsewhere
- **Severity:** should · **Confidence:** high on the missing sanitiser, medium on the exact failure (not executed)
- **Where:** `src/app/(dashboard)/contacts/page.tsx:185-195`; copies of `sanitizeSearch` in `src/app/api/v1/contacts/route.ts:32`, `v1/conversations/route.ts:43`, `v1/tags/route.ts:37`, `v1/templates/route.ts:49`.
- **Evidence:** the page interpolates the raw term into `.or(\`name.ilike.%${term}%,phone.ilike.…\`)`. The v1 routes strip everything "that could break the `.or()` grammar" before doing the same. The four copies use three different character classes (tags drops `_`, templates adds `{}`).
- **Concrete case:** searching `Pérez, Juan` produces `name.ilike.%Pérez, Juan%,phone.ilike.…` — the comma splits the filter list, PostgREST rejects the expression, and the page shows `toastFailedLoad` instead of results.
- **Smallest fix:** one exported `sanitizeSearch` in `src/lib/api/v1/` (or `src/lib/utils.ts`), imported by the four routes and the contacts page.
- **Lines saved:** about 10.

## 9. Any incoming message wipes every optimistic bubble, including failed ones; four send handlers are copies
- **Severity:** should (bug) / nice (duplication) · **Confidence:** high
- **Where:** `src/app/(dashboard)/inbox/page.tsx:237-245`; `src/components/inbox/message-thread.tsx:508-785`.
- **Bug:** on a realtime INSERT for the open conversation, the handler does `prev.filter((m) => !m.id.startsWith('temp-'))` before appending the new row — it removes all temp messages, not the one the new row replaces.
- **Concrete case:** the agent sends a message, `/api/whatsapp/send` returns 4xx, the bubble is marked `failed` (`message-thread.tsx:547`). The customer then writes anything → the failed bubble disappears; the thread now reads as if nothing was attempted. Same for a second outgoing message still in flight when the first one's row arrives.
- **Smallest fix:** drop only the oldest temp message with status `sending`/`sent` when the inserted row has `sender_type === 'agent'`; leave `failed` ones.
- **Duplication:** `handleSend`, `handleSendMedia`, `handleSendInteractive` and `handleSendTemplate` (508-785, about 280 lines) are the same function — build optimistic message, POST `/api/whatsapp/send`, toast and mark `failed` or `sent` — differing only in the body and one cleanup call. One `sendOptimistic(optimistic, body, onFail?)` plus four short callers.
- **Lines saved:** about 170. Also `sending` in `message-composer.tsx:148,226-238` is set true and false in the same synchronous block (`onSend` is not awaited), so the guard and the `disabled` check on it never trigger: 6 lines.

## 10. MCP server: sends are not idempotent, requests have no timeout, and one template-breaking tool has no confirm
- **Severity:** should · **Confidence:** high
- **Where:** `mcp-server/src/client.ts:49-70, 113-115, 160-162`; `mcp-server/src/tools/write.ts:80-127, 313-330`.
- **Evidence:**
  - `grep -rn Idempotency mcp-server/src` → no matches, while `POST /api/v1/messages` and `/api/v1/broadcasts` both implement `Idempotency-Key` (`git grep -l withIdempotency src/app/api/v1`). A fetch failure is returned to the model as `network_error` (`client.ts:66-70`); a model that retries `send_message` or `send_broadcast` after a response lost in transit sends the WhatsApp message(s) twice.
  - `grep -n "AbortSignal\|timeout" mcp-server/src` → no matches: a hung instance blocks the tool call indefinitely.
  - `update_template` (`write.ts:313-330`) resubmits an APPROVED template to Meta, which returns it to PENDING — its own description says so, and Meta caps edits at 10 per 30 days. It is annotated `WRITE`, not `DESTRUCTIVE`, and has no `confirm`, unlike `delete_template`, `sync_templates`, `create_export` and `delete_tag`, which all go through `requireConfirm`.
- **Checked and fine:** the API key is read from env only, sent only as a Bearer header, never logged (the startup line prints the base URL, not the key); writes and broadcasts are behind `WACRM_ENABLE_WRITES` / `WACRM_ENABLE_BROADCASTS`; every delete has a confirm gate.
- **Smallest fix:** in `request()`, add `signal: AbortSignal.timeout(30_000)` and, for POST, `'Idempotency-Key': crypto.randomUUID()` generated once per tool call (2 lines); add `confirm` + `requireConfirm` to `update_template` (about 8 lines).
- **Lines saved:** 0.

## 11. Small helpers copied instead of imported
- **Severity:** nice · **Confidence:** high
- **Evidence (script over top-level definitions with the same name in non-test files, each confirmed by grep):**
  - `supabaseAdmin()` service-role singleton ×7, identical bodies: `src/lib/{ai,auth,automations,flows}/admin-client.ts` and inline in `src/app/api/whatsapp/{config,embedded-signup,webhook}/route.ts`. Seven separate clients per process. Keep `src/lib/auth/admin-client.ts`; delete or re-export the rest. About 75 lines.
  - `UUID_RE` ×23 with two different regexes (9 accept any hex UUID, 14 require version 1-5 and the RFC variant), so the same id can be valid on one route and "not found" on another. One `isUuid` in `src/lib/`. About 45 lines.
  - `isPlainObject` ×8 (`src/lib/ai/tools/*`, `src/lib/billing/meta-*`), `isAuthError` ×6 (`src/app/api/platform/**`), `secretMatches` ×3 (the three cron routes), `getClientIp` ×2 (`invitations/[token]/{peek,redeem}`), `rpcErrorToResponse` ×3, `isDryRun` ×3, `errorMessage` ×5. About 110 lines.
- **Smallest fix:** export each once from the module that already owns the concept and import it.
- **Lines saved:** about 230.

## 12. Dead code and stray tracked files
- **Severity:** nice · **Confidence:** high
- **Evidence (import-graph script over all tracked `.ts/.tsx/.mjs`, then grep; Next file conventions excluded):**
  - `src/components/tremor/bar-chart.tsx` lines 110-437 (Legend, ScrollButton, ChartLegend, about 330 lines) and `src/components/tremor/use-on-window-resize.ts` (17 lines, used only by `ChartLegend`): the only two callers (`src/components/agents/ai-usage.tsx:181`, `src/components/dashboard/response-time-chart.tsx:93`) both pass `showLegend={false}` and neither passes `onValueChange`, `type`, `layout` or `customTooltip`.
  - `src/components/ui/separator.tsx` (25 lines): zero importers (`git grep "ui/separator"` → none).
  - `src/components/platform/platform-placeholder.tsx` (66 lines): imported only by `platform-shell.test.tsx` (about 30 test lines).
  - Zero references anywhere, tests included: `assertNever` (`src/lib/flows/types.ts:371`), `assertMessageTemplate` (`src/lib/whatsapp/template-row-guard.ts:37`), `COEXISTENCE_FEATURE_TYPE` (`src/components/settings/embedded-signup-button.tsx:148`).
  - Unused exports in `src/components/ui`: `AvatarGroup`, `AvatarGroupCount`, `CardFooter`, `DropdownMenuSub*` / `RadioGroup` / `RadioItem` / `Shortcut` / `Portal`, `PopoverHeader` / `Title` / `Description`, `SelectGroup` / `Label` / `Separator` / `ScrollUp/DownButton`, `SheetTrigger` / `SheetClose`, `TableCaption` / `TableFooter`, `badgeVariants`, `tabsListVariants` (about 150 lines of generated primitives; low value, listed for completeness).
  - `public/file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg`: create-next-app leftovers, no reference in the tree.
- **Checked and not dead:** every dependency in both `package.json` files is imported (`@dagrejs/dagre` 1 file, `@dnd-kit/core` 2, `@dnd-kit/sortable` 1, `@dnd-kit/utilities` 1, `recharts` 1, `opus-recorder` dynamic import in the composer, `tw-animate-css` via `globals.css`). No `tsconfig.tsbuildinfo` or build output is tracked. `opencode.jsonc` and `.opencode/` (323 lines) are tracked alongside `.claude/agents`; I could not establish whether opencode is still used, so that is a question, not a finding.
- **Lines saved:** about 470 without the ui exports, about 620 with them, plus 5 files.

---

## Totals
- **Deletable lines (approximate):** 350 + 80 (finding 6) + 5 (7) + 10 (8) + 176 (9) + 230 (11) + 470 to 620 (12) ≈ **1,300 to 1,450 lines**, against about +600 added (568 of them the vendored CSS in finding 5, the rest the fixes in 1, 2, 10).
- **Removable dependencies:** 1 direct (`shadcn`), which removes 194 of 803 lockfile packages and 3 `overrides` entries. No other unused dependency found.
- **Bugs:** findings 1, 2, 4, 7, 8, 9 (client), 10 (MCP), 3 (config).

## Not read / not verified
- Nothing was executed: findings 1, 4 and 8 rest on documented PostgREST behaviour and the repo's own statements about `db-max-rows`, not on a reproduction.
- Client files only skimmed for timers/listeners, not read line by line: `src/hooks/use-auth.tsx`, `use-billing-status.ts`, `use-service-cap.ts`, `use-ai-account-status.ts`, `use-media-blob-url.ts`, `use-theme.tsx`, `src/lib/presence.ts`; `src/components/inbox/` files other than `message-thread.tsx`, `message-composer.tsx` and the queries of `conversation-list.tsx`; `contacts/page.tsx` after line 370 (render).
- `mcp-server/src/tools/read.ts` and `write.ts` were read as an outline (tool names, annotations, confirm gates, client calls), not every schema field.
- Not opened: `src/components/settings/whatsapp-config.tsx` `dangerouslySetInnerHTML` sites beyond confirming they render translation strings; the other 9 near-duplicate candidates the name scan surfaced in billing/engines (`loadSubscription`, `loadPlanName`, `findOrCreateConversation`, `engineSendText` in `automations/meta-send.ts` vs `flows/meta-send.ts`) — they belong to other auditors' areas and the two `meta-send` files differ in 385 lines, so they are not copies.
- Server security, billing, engines and AI were skipped as instructed. `docker-compose.yml`, `supabase/`, `scripts/`, `docs/` and `progress/` (243 tracked files, 45,689 lines of harness notes) were not reviewed.
- GitHub Action versions in the workflows (`actions/checkout@v7`, `setup-node@v7`) were not checked against what exists.
