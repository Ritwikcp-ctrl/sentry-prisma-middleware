# prisma-orm-sentry

A community middleware for [Prisma ORM 8](https://www.prisma.io/) that maps Prisma's internal **activity tree** directly to Sentry traces and spans.

## Why this exists

Prisma ORM 8 introduced a new middleware architecture based on an activity tree (`transaction` → `orm-call` → `statement`). Sentry's built-in `prismaIntegration` is a black box — you can't filter noisy queries or inject business context into the spans.

This middleware hooks directly into Prisma's `activityStarted`, `beforeEncode`, `activityEnded`, and `activityFinalized` lifecycle events, giving you programmatic control over exactly what gets sent to Sentry.

## Key features

- **Query filtering (`shouldTrace`)** — Exclude health checks, background polling, or specific tables to save Sentry quota.
- **Business context (`customAttributes`)** — Attach custom tags (`tenant_id`, `user_id`, `env`) to every database span. The function receives the `activity`, so you can read Prisma 8 annotations.
- **Native activity mapping** — Mirrors Prisma's real activity tree, including ORM calls, single-row update transactions, and `db.transaction()` blocks.
- **SQL-aware naming** — Statement spans are renamed to the **SQL text** (with placeholders) in `beforeEncode`, so Sentry can aggregate the same query across requests. The activity id is preserved as `prisma.activity.id`; SQL text is also available as `db.query.text`.
- **Honest error status** — Failed activities are marked `ERROR` on the span. The middleware does **not** capture exceptions — the error reaches your own code, where you should capture it (see [Capturing errors](#capturing-errors)).
- **Correct `stopped` semantics** — Early cancellation (e.g. `break` inside a `for await` loop) is recorded as **OK** with a `prisma.outcome: 'stopped'` attribute, so error-rate dashboards stay clean.

## Installation

```bash
npm install prisma-orm-sentry
```

**Peer dependencies:**

- `@prisma/orm-family-sql` `^8.0.0-rc.19` — the base SQL-family package re-exported by both the Postgres and SQLite adapters. You do **not** need to install the Postgres adapter unless you use it.
- `@sentry/node` `^11.8.0`

**Node.js requirement:** `>=22.18.0` (Prisma 8 runtime requirement).

## Usage

Register the middleware when you create your Prisma client.

```typescript
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import postgres from '@prisma/orm-postgres/runtime';
import { contractFromJson } from '@prisma/orm-postgres/static';
import { sentryMiddleware } from 'prisma-orm-sentry';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

// 1. Initialize Sentry
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
});

// 2. Load your Prisma 8 contract
const contract = contractFromJson<Contract>(contractJson);

// 3. Create the client with the middleware
export const db = postgres({
  contract,
  url: process.env.DATABASE_URL!,
  middleware: [
    sentryMiddleware({
      // Optional: only trace the actual SQL statement, ignoring the orm-call wrapper
      shouldTrace: (activity) => activity.kind === 'statement',

      // Optional: attach environment context to every span.
      // The function receives the activity, so you can read annotations.
      customAttributes: (activity) => ({
        env: process.env.NODE_ENV ?? 'development',
      }),

      // Optional: start a new trace for root activities instead of
      // attaching to the currently active Sentry span.
      startNewTrace: false,
    }),
  ],
});
```

## Options
```
Option              Type                               Default               Description

shouldTrace         (activity: RuntimeActivity)       () => true           Return `false` to prevent a span from being 
                    => boolean`                                             created for a specific activity

customAttributes    (activity: RuntimeActivity)       () => ({})            Extra span attributes. Receives the 
                    => Record<string,                                       `activity` so you can read annotations
                    string \| number \| boolean>
                    
startNewTrace       boolean                            false                 When `true`, root activities force a new 
                                                                             trace (`parentSpan: null`, `forceTransaction: true`).
                                                                             When `false`, the middleware follows a single rule:
                                                                             attach to the active Sentry span if one exists, otherwise start a root transaction.

                 
opPrefix           string                            db.prisma               Prefix used for Sentry span names and 
                                                                             operations (e.g. `db.prisma.statement`)

```
<<<<<<< HEAD

=======
>>>>>>> 9be12a8 (docs: add Sentry.flush() tip and end-to-end verification notes)

## How it maps to Sentry

Prisma 8 executes queries in a tree. The shapes below have been verified against a real Sentry project and a real PostgreSQL database. The middleware mirrors whatever tree Prisma emits.

**1. `db.transaction(fn)` with two queries** — the transaction is the root *(not runner-verified — see Testing)*.

```text
db.prisma.transaction
├── db.prisma.orm-call
│   └── db.prisma.statement
└── db.prisma.orm-call
    └── db.prisma.statement


Statement naming. beforeEncode renames the statement span to plan.sql, so the final Sentry waterfall shows the actual SQL text (with placeholders). The activity id is prisma.activity.id; the SQL text is also db.query.text. (Asserted by tests.)

Row counts. When a statement result has returns: 'rows', db.response.returned_rows is set. When it has returns: 'stats', db.response.affected_rows is set.


## Capturing errors

**This middleware does not capture exceptions.** On a failed query:

1. The activity's `outcome` becomes `'failed'`.
2. The middleware marks the span with Sentry's `ERROR` status.
3. The **actual exception** is thrown to the code that made the call.

The exception is **not** present in the middleware's result object, so it cannot be captured here. Capture it where it actually arrives — your own `try/catch` or Sentry's framework integration (e.g. `Sentry.setupExpressErrorHandler`). The failed span and the captured error are linked by trace ID in Sentry.

```typescript
try {
  await db.user.findUnique({ where: { id } });
} catch (error) {
  Sentry.captureException(error); // ← capture here, not in the middleware
}
```

## `stopped` outcomes

If the caller stops reading rows early (e.g. `break` inside a `for await` loop), Prisma reports the activity outcome as `'stopped'`. This is **not a failure**. The middleware records **OK** status and sets `prisma.outcome: 'stopped'`, so:

- Error-rate dashboards do not count intentional cancellations as errors.
- You can still find and filter stopped streams using the attribute.

## Cost of `activityFinalized`

The middleware implements `activityFinalized` so it can surface transaction rollbacks in Sentry. As documented in Prisma's runtime docs, **any middleware that implements `activityFinalized` makes every transaction keep its finished child activities until the transaction ends**. This is the price of showing rollbacks — a deliberate trade-off.

## Testing

The middleware can be tested **without a database**. Prisma 8 exposes `startTransactionActivity` and `executeStatement` from `@prisma/orm-framework/components/runtime` — they run the real hook pipeline with real contexts.

```typescript
import { executeStatement, startTransactionActivity }
  from '@prisma/orm-framework/components/runtime';

const context = {
  contract: {}, mode: 'strict', now: () => Date.now(),
  log: { info() {}, warn() {}, error() {} },
  contentHash: async () => 'hash', scope: 'runtime',
} as const;
const plan = { meta: { target: 'postgres', storageHash: 'h', lane: 'raw' } };

const tx = await startTransactionActivity({
  middleware: [mw], context, parent: undefined, holdFinishedChildren: true,
});
await executeStatement(
  { middleware: [mw], plan, context, parent: tx },
  async () => ({ affectedRows: 0 }),
);
await tx.end({ by: 'commit', outcome: 'succeeded' });

// Assert the recorded span tree via a fake Sentry (see test/fake-sentry.ts).
expect(recordedSpans).toEqual([
  { name: 'db.prisma.transaction', parent: undefined },
  { name: 'db.prisma.statement',   parent: 'db.prisma.transaction' },
]);
```

The test suite (26 tests) covers:

- **Span tree** — nesting under transactions; nesting when `shouldTrace` skips an `orm-call`; 3-level parent walk
- **Span naming** — `plan.sql` as the name via `beforeEncode`; `db.query.text`; `db.system.name` `postgres` → `postgresql` mapping and passthrough (`sqlite`, `mysql`); no `plan.params` leak
- **Outcomes** — `succeeded` / `stopped` / `failed` for statements; `succeeded` / `stopped` / `failed` for `orm-call`; `committed` / `rolled-back` / `unknown` for transactions; unexpected outcome strings route to the ERROR `default` branch
- **Row counts** — `db.response.returned_rows` and `db.response.affected_rows`
- **Parent resolution** — `startNewTrace: true` (new trace) and `false` (attach to active span)
- **Hook safety** — `customAttributes(activity)` receives the activity; a throwing `customAttributes` does not fail the query and produces a structured `ctx.log.warn` event
- **Edge cases** — SDK throws during span creation (query still succeeds); `activityEnded` with no stored span; parallel transactions produce independent trees


### End-to-end testing against a real Sentry project

When running a standalone script against a real Sentry project (e.g., using `tsx` or `node`), call `await Sentry.flush(5000)` before the process exits. Sentry batches spans asynchronously; a process that exits immediately will silently drop them.

The middleware has been verified end-to-end against a real Sentry project and a real PostgreSQL database, confirming:
- Span nesting (`transaction → orm-call → statement`).
- SQL text naming (`SELECT ...`, `INSERT ...`) and `db.query.text` attributes.
- Failed queries mark the span as `ERROR` without duplicating the exception (the exception remains in the caller's `try/catch`).
- Rolled-back transactions correctly fire `activityFinalized` and mark the transaction span as `ERROR`.


## License

ISC
