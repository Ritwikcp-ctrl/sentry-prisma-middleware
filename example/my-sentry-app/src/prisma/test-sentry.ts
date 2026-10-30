import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import * as Sentry from '@sentry/node';
import postgres from '@prisma/orm-postgres/runtime';
import { contractFromJson } from '@prisma/orm-postgres/static';
import { sentryMiddleware } from '../../../../dist/sentry-middleware.js';
import type { Contract } from '../prisma/contract.d';
import contractJson from '../prisma/contract.json' with { type: 'json' };

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
});

const contract = contractFromJson<Contract>(contractJson);

export const db = postgres({
  contract,
  url: process.env.DATABASE_URL!,
  middleware: [
    sentryMiddleware({
      shouldTrace: () => true,
      startNewTrace: true,
    }),
  ],
});

async function main() {
  // Pass the connection string here to resolve the binding
  console.log('DATABASE_URL is:', process.env.DATABASE_URL);
  await db.connect({ url: process.env.DATABASE_URL! });

  console.log('Test 1: successful transaction');

  await db.transaction(async (tx) => {
    await tx.orm.public.User.first();
    await tx.orm.public.User.create({
      email: `e2e-${Date.now()}@example.com`,
    });
  });

  console.log('Test 1 complete');

  console.log('Test 2: failing query');

  try {
    const dupEmail = `dup-${Date.now()}@example.com`;
    await db.orm.public.User.create({ email: dupEmail });
    await db.orm.public.User.create({ email: dupEmail });
  } catch (e) {
    console.log('Test 2 caught at caller:', (e as Error).message);
    Sentry.captureException(e);
  }

  console.log('Test 3: rolled-back transaction');

  try {
    await db.transaction(async (tx) => {
      await tx.orm.public.User.first();
      throw new Error('deliberate rollback');
    });
  } catch (e) {
    console.log('Test 3 caught at caller:', (e as Error).message);
  }

  console.log('Flushing to Sentry...');
  const flushed = await Sentry.flush(5000);
  console.log(flushed ? 'Flushed successfully' : 'Flush timed out');

  await db.close();
}

main().catch((err) => {
  console.error('E2E failed:', err);
  process.exit(1);
});