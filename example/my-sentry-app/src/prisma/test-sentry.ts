import "dotenv/config";
import { db } from "./db";

async function main() {
  console.log("Running test queries...");

  const users = await db.orm.public.User.where({}).all();
  console.log("Single query result:", users);

  console.log("Running transaction...");
  await db.transaction(async (tx) => {
    await tx.orm.public.User.where({}).all();
    await tx.orm.public.User.where({}).all();
  });
  console.log("Transaction complete.");

  try {
    await db.orm.public.User.create({
      email: "alice@prisma.io",
      username: "alice_duplicate",
      name: "Duplicate Alice",
    });
  } catch (error) {
    console.log("Expected failure captured:", (error as Error).message);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.close();
  });
