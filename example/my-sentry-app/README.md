# Sentry Middleware Test App
This is a runnable Prisma 8 application used to test and verify the `sentry-prisma-middleware` package locally.

It demonstrates the middleware capturing the Prisma 8 activity tree and mapping it to Sentry spans (`transaction` → `orm-call` → `statement`).

## Prerequisites

- **Node.js**: `v22.18.0` or newer (required by Prisma 8)
- **Database**: A PostgreSQL database (we recommend [Prisma Postgres](https://www.prisma.io/postgres))
- **Sentry**: A free Sentry account and project DSN

## Setup

1. **Install dependencies:**
   ```bash
   npm install

# Configure environment variables:
Copy the example file and fill in your credentials.
```command
cp .env.example .env
```

# Add your database URL and Sentry DSN to .env:
```ts
DATABASE_URL="postgres://..."
SENTRY_DSN="https://...@o....ingest.sentry.io/..."
```

# Intialize the database:
```ts
npx prisma db init
```

# Run this test script:
```
npx tsx src/prisma/test-sentry.ts
```

### for sentry dsn , got sentry site do signup and get your url.