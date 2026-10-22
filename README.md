# Sentry Middleware for Prisma ORM 8

A community middleware for Prisma ORM 8 that maps Prisma's internal activity tree directly to Sentry traces and spans.

## Why this exists

Prisma ORM 8 introduced a completely new middleware architecture based on an activity tree (`transaction` → `orm-call` → `statement`). While Sentry provides a built-in `prismaIntegration` that handles this automatically, it acts as a "black box"—you can't filter out noisy queries or inject custom business context into the spans.

This middleware hooks directly into Prisma's `activityStarted` and `activityEnded` lifecycle events, giving you fine-grained, programmatic control over exactly what gets sent to Sentry.

### Key Features
- **Query Filtering (`shouldTrace`):** Exclude health checks, background polling, or specific tables from Sentry to save quota.
- **Business Context (`customAttributes`):** Attach custom tags (e.g., `tenant_id`, `user_id`) to every database span.
- **Native Activity Mapping:** Explicitly mirrors Prisma's 3-level tree: `transaction` → `orm-call` → `statement`.
- **Error Capture:** Automatically marks spans as failed and captures database exceptions.

## Installation

```bash
npm install sentry-prisma-middleware

Note: This package requires @prisma/orm-postgres@8.0.0-rc.19 or later and @sentry/node@11.1.0 or later.
```

## Usage
Register the middleware when you create your Prisma client.

```ts
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import postgres from '@prisma/orm-postgres/runtime';
import { contractFromJson } from '@prisma/orm-postgres/static';
import { sentryMiddleware } from 'sentry-prisma-middleware';
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
      // Optional: Only trace the actual SQL statement, ignoring the orm-call wrapper
      shouldTrace: (activity) => activity.kind === 'statement',
      
      // Optional: Attach environment context to every span
      customAttributes: () => ({ env: process.env.NODE_ENV ?? 'development' }),
      
      // Optional: If Prisma is called inside an HTTP request, nest the DB trace under it
      useActiveParentForRoot: true, 
    }),
  ],
});
```

## Options
The sentryMiddleware function accepts an options object with the following properties:

```
| Option                  Type                                                     Default            description
     
  shuldTrace             (activity) =>boolean                                     () =>true            Return false to prevent a span from being created for a specific activity.
 
  customAttributes	     () => Record<string, string | number | boolean>	        () => ({})           A function that returns key-value pairs to attach to every generated span.

  useActiveParentForRoot      boolean                                             false                If true, root activities will attach to the currently active Sentry span instead of starting a new trace.
 
  opPrefix                    string                                              "db.prisma           The prefix used for Sentry span operations (e.g., db.prisma.statement).
```

# How it maps to Sentry
## Prisma 8 executes queries in a tree. This middleware creates a matching Sentry span tree. For a db.transaction() containing two queries, the resulting Sentry waterfall looks like this:

```text
db.prisma.transaction (1.50s)
├── db.prisma.orm-call (380ms)
│   └── db.prisma.statement (377ms)
└── db.prisma.orm-call (376ms)
    └── db.prisma.statement (375ms)
```

If a query fails, the statement and orm-call spans will be marked with an error status in Sentry, and the underlying database exception will be attached.

## License
ISC