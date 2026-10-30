import 'dotenv/config';
import * as Sentry from '@sentry/node';
import postgres from '@prisma/orm-postgres/runtime';
import { contractFromJson } from '@prisma/orm-postgres/static';
import { sentryMiddleware } from 'sentry-prisma-middleware';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

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
      
      startNewTrace: true,
      shouldTrace: () => true,  
    }),
  ],
});