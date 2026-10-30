import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startTransactionActivity,
  executeStatement,
} from '@prisma/orm-framework/components/runtime';
import type { SqlMiddlewareContext } from '@prisma/orm-family-sql/runtime';
import { sentryMiddleware } from '../sentry-middleware';
import { createFakeSentry, type FakeSentry } from './fake-sentry';

// Fake Sentry wire-up 
const holder = vi.hoisted(() => ({ fake: undefined as FakeSentry | undefined }));

vi.mock('@sentry/node', () => ({
  startInactiveSpan: (opts: any) => holder.fake!.startInactiveSpan(opts),
  getActiveSpan: () => holder.fake!.getActiveSpan(),
  captureException: (e: unknown) => holder.fake!.captureExceptionCalls.push(e),
}));

beforeEach(() => {
  holder.fake = createFakeSentry();
});

function fake(): FakeSentry {
  return holder.fake!;
}

// Context helpers 
function makeRunnerContext() {
  const warnings: unknown[] = [];
  return {
    warnings,
    context: {
      contract: {},
      mode: 'strict' as const,
      now: () => Date.now(),
      log: {
        info:  (_event: unknown) => {},
        warn:  (event: unknown) => { warnings.push(event); },
        error: (_event: unknown) => {},
      },
      contentHash: async () => 'hash',
      scope: 'runtime' as const,
    },
  };
}

function makeHookContext(): { context: SqlMiddlewareContext; warnings: unknown[] } {
  const base = makeRunnerContext();
  const stateStore = new Map<symbol, Record<string | symbol, unknown>>();

  const context = {
    ...base.context,
    parent: undefined,
    inTransaction: () => false,
    state(key: symbol) {
      let bucket = stateStore.get(key);
      if (!bucket) { bucket = {}; stateStore.set(key, bucket); }
      return bucket;
    },
  };

  return {
    context: context as unknown as SqlMiddlewareContext,
    warnings: base.warnings,
  };
}

const plan = { meta: { target: 'postgres', storageHash: 'h', lane: 'raw' } };

//  nesting
describe('span tree', () => {
  it('nests a statement under its transaction', async () => {
    const { context } = makeRunnerContext();
    const mw = sentryMiddleware();

    const tx = await startTransactionActivity({
      middleware: [mw], context, parent: undefined, holdFinishedChildren: true,
    });
    await executeStatement(
      { middleware: [mw], plan, context, parent: tx },
      async () => ({ affectedRows: 0 }),
    );
    await tx.end({ by: 'commit', outcome: 'succeeded' });

    expect(fake().spans.map(s => ({ name: s.name, parent: s.parent }))).toEqual([
      { name: 'db.prisma.transaction', parent: undefined },
      { name: 'db.prisma.statement',   parent: 'db.prisma.transaction' },
    ]);
    expect(fake().spans.every(s => s.ended)).toBe(true);
  });

  it('still nests when shouldTrace skips an orm-call ancestor', async () => {
    const { context } = makeRunnerContext();
    const mw = sentryMiddleware({ shouldTrace: (a) => a.kind !== 'orm-call' });

    const tx = await startTransactionActivity({
      middleware: [mw], context, parent: undefined, holdFinishedChildren: true,
    });
    const orm = await startTransactionActivity({
      middleware: [mw], context, parent: tx, holdFinishedChildren: false,
    });
    await executeStatement(
      { middleware: [mw], plan, context, parent: orm },
      async () => ({ affectedRows: 0 }),
    );
    await orm.end({ by: 'commit', outcome: 'succeeded' });
    await tx.end({ by: 'commit', outcome: 'succeeded' });

    const statement = fake().spans.find(s => s.parent === 'db.prisma.transaction');
    expect(statement).toBeDefined();
    expect(fake().spans.some(s => s.name === 'db.prisma.orm-call')).toBe(false);
  });
});

// SQL naming + no params leak 
describe('span naming', () => {
  it('renames the statement span to plan.sql and records db.query.text', async () => {
    const { context } = makeHookContext();
    const mw = sentryMiddleware();
    const activity = { kind: 'statement', id: 'stmt-sql' } as any;

    await mw.activityStarted!(activity, context);

    mw.beforeEncode!(
      {
        sql: 'SELECT * FROM "user" WHERE id = $1',
        params: ['secret-value'],
        meta: plan.meta,
      } as any,
      context,
    );

    await mw.activityEnded!(activity, { outcome: 'succeeded' } as any, context);

    const span = fake().spans[0];
    expect(span.name).toBe('SELECT * FROM "user" WHERE id = $1');
    expect(span.attributes['db.query.text']).toBe('SELECT * FROM "user" WHERE id = $1');
    expect(span.attributes['db.system.name']).toBe('postgresql');
    expect(JSON.stringify(span.attributes)).not.toContain('secret-value');
    expect(span.attributes['prisma.activity.id']).toBe('stmt-sql');
  });

  // NEW — closes the untested branch of the db.system.name mapping.
  // The middleware only rewrites `postgres` → `postgresql`; every other
  // target must pass through unchanged, or non-postgres users see a
  // mangled attribute.
  it('passes non-postgres targets through db.system.name unchanged', async () => {
    const { context } = makeHookContext();
    const mw = sentryMiddleware();
    const activity = { kind: 'statement', id: 'stmt-sqlite' } as any;

    await mw.activityStarted!(activity, context);

    mw.beforeEncode!(
      { sql: 'SELECT 1', params: [], meta: { target: 'sqlite' } } as any,
      context,
    );

    await mw.activityEnded!(activity, { outcome: 'succeeded' } as any, context);

    expect(fake().spans[0].attributes['db.system.name']).toBe('sqlite');
  });
});

// stopped = OK, failed = ERROR, no captureException 
describe('outcome mapping', () => {
  // NEW — closes the untested `succeeded` branch. Every runner-driven test
  // produces succeeded outcomes, but none of them assert status.code === 1,
  // so a regression from code 1 → code 2 would go unnoticed.
  it('marks succeeded statements OK', async () => {
    const { context } = makeHookContext();
    const mw = sentryMiddleware();
    const activity = { kind: 'statement', id: 'stmt-ok' } as any;

    await mw.activityStarted!(activity, context);
    await mw.activityEnded!(activity, { outcome: 'succeeded' } as any, context);

    const span = fake().spans[0];
    expect(span.status?.code).toBe(1);
    expect(span.ended).toBe(true);
  });

  it('marks stopped as OK and sets prisma.outcome = "stopped"', async () => {
    const { context } = makeHookContext();
    const mw = sentryMiddleware();
    const activity = { kind: 'statement', id: 'stmt-stopped' } as any;

    await mw.activityStarted!(activity, context);
    await mw.activityEnded!(activity, { outcome: 'stopped' } as any, context);

    const span = fake().spans[0];
    expect(span.status?.code).toBe(1);
    expect(span.attributes['prisma.outcome']).toBe('stopped');
    expect(span.ended).toBe(true);
  });

  it('marks failed as ERROR and never calls captureException', async () => {
    const { context } = makeHookContext();
    const mw = sentryMiddleware();
    const activity = { kind: 'statement', id: 'stmt-failed' } as any;

    await mw.activityStarted!(activity, context);
    await mw.activityEnded!(activity, { outcome: 'failed' } as any, context);

    const span = fake().spans[0];
    expect(span.status?.code).toBe(2);
    expect(span.ended).toBe(true);
    expect(fake().captureExceptionCalls).toHaveLength(0);
  });
});

// startNewTrace semantics 
describe('parent resolution', () => {
  it('startNewTrace=true → no parent, forceTransaction=true', async () => {
    const { context } = makeRunnerContext();
    const mw = sentryMiddleware({ startNewTrace: true });

    await executeStatement(
      { middleware: [mw], plan, context, parent: undefined },
      async () => ({ affectedRows: 0 }),
    );

    const span = fake().spans[0];
    expect(span.parent).toBeUndefined();
    expect(span.forceTransaction).toBe(true);
  });

  it('startNewTrace=false → attaches to active Sentry span if present', async () => {
    fake().activeSpan = fake().startInactiveSpan({
      name: 'http.request', op: 'http', parentSpan: null, forceTransaction: true,
    });

    const { context } = makeRunnerContext();
    const mw = sentryMiddleware();

    await executeStatement(
      { middleware: [mw], plan, context, parent: undefined },
      async () => ({ affectedRows: 0 }),
    );

    expect(fake().spans[1].parent).toBe('http.request');
  });
});

// customAttributes receives activity, never breaks query
describe('hook safety', () => {
  it('passes the activity to customAttributes', async () => {
    const { context } = makeRunnerContext();
    const receivedKinds: string[] = [];
    const mw = sentryMiddleware({
      customAttributes: (activity) => {
        receivedKinds.push(activity.kind);
        return { env: 'test' };
      },
    });

    await executeStatement(
      { middleware: [mw], plan, context, parent: undefined },
      async () => ({ affectedRows: 0 }),
    );

    expect(receivedKinds).toContain('statement');
    expect(fake().spans[0].attributes.env).toBe('test');
  });

  it('does not fail the query when customAttributes throws, and logs via ctx.log.warn', async () => {
    const throwingFactory = {
      customAttributes: () => { throw new Error('user bug'); },
    };

    //  runner-based: proves the query still completes.
    const { context: runCtx } = makeRunnerContext();
    await expect(executeStatement(
      { middleware: [sentryMiddleware(throwingFactory)], plan, context: runCtx, parent: undefined },
      async () => ({ affectedRows: 0 }),
    )).resolves.toBeDefined();

    //  direct hook: proves warn() received the structured event.
    const { context: hookCtx, warnings } = makeHookContext();
    await sentryMiddleware(throwingFactory).activityStarted!(
      { kind: 'statement', id: 'stmt-throw' } as any,
      hookCtx,
    );

    const logged = warnings.find((e): e is {
      middleware: string; message: string; error: { message?: string };
    } =>
      typeof e === 'object' && e !== null &&
      (e as { middleware?: unknown }).middleware === 'sentry-middleware'
    );

    expect(logged).toBeDefined();
    expect(logged!.message).toContain('customAttributes');
    expect(logged!.error?.message).toBe('user bug');
  });
});

// finalized outcomes 
describe('finalized outcomes', () => {
  it('marks committed transactions OK', async () => {
    const { context } = makeRunnerContext();
    const mw = sentryMiddleware();

    const tx = await startTransactionActivity({
      middleware: [mw], context, parent: undefined, holdFinishedChildren: true,
    });
    await tx.end({ by: 'commit', outcome: 'succeeded' });

    expect(fake().spans[0].status?.code).toBe(1);
  });

  it('marks rolled-back transactions ERROR', async () => {
    const { context } = makeRunnerContext();
    const mw = sentryMiddleware();

    const tx = await startTransactionActivity({
      middleware: [mw], context, parent: undefined, holdFinishedChildren: true,
    });
    await tx.end({ by: 'rollback', outcome: 'succeeded', commitAttempted: false });

    expect(fake().spans[0].status?.code).toBe(2);
    expect(fake().spans[0].status?.message).toMatch(/rolled back/i);
  });

  it('marks unknown finalized outcome ERROR with a clear message', async () => {
    const { context } = makeHookContext();
    const mw = sentryMiddleware();
    const activity = { kind: 'transaction', id: 'tx-unknown' } as any;

    await mw.activityStarted!(activity, context);
    await mw.activityFinalized!(activity, { outcome: 'unknown' } as any, context);

    expect(fake().spans[0].status?.code).toBe(2);
    expect(fake().spans[0].status?.message).toMatch(/unknown/i);
  });
});

// Edge cases (closes the "not tested" gaps) 
describe('edge cases', () => {
  it('does not fail the query if startInactiveSpan throws', async () => {
    const throwingFake = createFakeSentry();
    throwingFake.startInactiveSpan = () => {
      throw new Error('SDK boom');
    };
    holder.fake = throwingFake;

    const { context, warnings } = makeRunnerContext();
    const mw = sentryMiddleware();

    await expect(executeStatement(
      { middleware: [mw], plan, context, parent: undefined },
      async () => ({ affectedRows: 0 }),
    )).resolves.toBeDefined();

    expect(fake().spans).toHaveLength(0);
    const logged = warnings.find((e): e is { middleware: string; message: string } =>
      typeof e === 'object' && e !== null &&
      (e as { middleware?: unknown }).middleware === 'sentry-middleware'
    );
    expect(logged).toBeDefined();
    expect(logged!.message).toContain('activityStarted');
  });

  it('does not error when activityEnded fires without a stored span', async () => {
    const { context } = makeRunnerContext();
    const mw = sentryMiddleware({ shouldTrace: () => false });

    await expect(executeStatement(
      { middleware: [mw], plan, context, parent: undefined },
      async () => ({ affectedRows: 0 }),
    )).resolves.toBeDefined();

    expect(fake().spans).toHaveLength(0);
  });

  it('produces independent span trees for concurrent transactions', async () => {
    const { context } = makeRunnerContext();
    const mw = sentryMiddleware();

    const txA = await startTransactionActivity({
      middleware: [mw], context, parent: undefined, holdFinishedChildren: true,
    });
    const txB = await startTransactionActivity({
      middleware: [mw], context, parent: undefined, holdFinishedChildren: true,
    });

    await executeStatement(
      { middleware: [mw], plan, context, parent: txA },
      async () => ({ affectedRows: 0 }),
    );
    await executeStatement(
      { middleware: [mw], plan, context, parent: txB },
      async () => ({ affectedRows: 0 }),
    );

    await txA.end({ by: 'commit', outcome: 'succeeded' });
    await txB.end({ by: 'commit', outcome: 'succeeded' });

    const transactions = fake().spans.filter(s => s.op === 'db.prisma.transaction');
    const statements   = fake().spans.filter(s => s.op === 'db.prisma.statement');
    expect(transactions).toHaveLength(2);
    expect(statements).toHaveLength(2);

    for (const stmt of statements) expect(stmt.parent).toBe('db.prisma.transaction');
    for (const tx of transactions) expect(tx.parent).toBeUndefined();
    expect(fake().spans.every(s => s.ended)).toBe(true);
  });

  it('handles orm-call succeeded outcome', async () => {
    const { context } = makeHookContext();
    const mw = sentryMiddleware();
    const activity = { kind: 'orm-call', id: 'orm-1' } as any;

    await mw.activityStarted!(activity, context);
    await mw.activityEnded!(activity, { outcome: 'succeeded' } as any, context);

    const span = fake().spans[0];
    expect(span.op).toBe('db.prisma.orm-call');
    expect(span.status?.code).toBe(1);
    expect(span.ended).toBe(true);
  });

  it('handles orm-call failed outcome without capturing an exception', async () => {
    const { context } = makeHookContext();
    const mw = sentryMiddleware();
    const activity = { kind: 'orm-call', id: 'orm-2' } as any;

    await mw.activityStarted!(activity, context);
    await mw.activityEnded!(activity, { outcome: 'failed' } as any, context);

    const span = fake().spans[0];
    expect(span.op).toBe('db.prisma.orm-call');
    expect(span.status?.code).toBe(2);
    expect(fake().captureExceptionCalls).toHaveLength(0);
  });

  it('walks up 3 levels to find the nearest traced ancestor', async () => {
    const makeCtx = (parent: any): any => {
      const store = new Map<symbol, Record<string | symbol, unknown>>();
      return {
        contract: {},
        mode: 'strict',
        now: () => Date.now(),
        log: { info: () => {}, warn: () => {}, error: () => {} },
        contentHash: async () => 'hash',
        scope: 'runtime',
        parent,
        inTransaction: () => false,
        state(key: symbol) {
          let bucket = store.get(key);
          if (!bucket) { bucket = {}; store.set(key, bucket); }
          return bucket;
        },
      };
    };

    const rootCtx = makeCtx(undefined);
    const midCtx  = makeCtx(rootCtx);
    const leafCtx = makeCtx(midCtx);

    const mw = sentryMiddleware();

    await mw.activityStarted!({ kind: 'transaction', id: 'root' } as any, rootCtx);
    // Mid: orm-call skipped (no span stored).
    await mw.activityStarted!({ kind: 'statement', id: 'leaf' } as any, leafCtx);
    await mw.activityEnded!(
      { kind: 'statement', id: 'leaf' } as any,
      { outcome: 'succeeded' } as any,
      leafCtx,
    );

    const [rootSpan, leafSpan] = fake().spans;
    expect(rootSpan.name).toBe('db.prisma.transaction');
    expect(rootSpan.parent).toBeUndefined();
    expect(leafSpan.name).toBe('db.prisma.statement');
    expect(leafSpan.parent).toBe('db.prisma.transaction');
  });
});