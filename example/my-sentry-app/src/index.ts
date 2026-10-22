import 'dotenv/config';
import { db } from './prisma/db';

async function main() {
  console.log('Running test queries...');

  // Scenario 1: single query
  const users = await db.orm.public.User.where({}).all();
  console.log('Single query result:', users);

  // Scenario 2: transaction — Prisma 8 uses db.transaction, not $transaction
  console.log('Running transaction...');
  await db.transaction(async (tx) => {
    await tx.orm.public.User.where({}).all();
    await tx.orm.public.User.where({}).all();
  });
  console.log('Transaction complete.');

  // Scenario 3: a query that actually throws
  try {
    await db.orm.public.User.where({ id: -1 }).first();
  } catch (error) {
    console.log('Expected failure captured:', (error as Error).message);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.close(); // Prisma 8 uses close(), not $disconnect()
  });