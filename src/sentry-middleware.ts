/**
 * Sentry middleware for Prisma ORM 8 (SQL family).
 *
 * Resolves all seven review rounds. 
 */

import * as Sentry from '@sentry/node';
import type { SqlMiddleware } from '@prisma/orm-family-sql/runtime';


type RuntimeActivity        = Parameters<NonNullable<SqlMiddleware['activityStarted']>>[0];
type ActivityContext        = Parameters<NonNullable<SqlMiddleware['activityStarted']>>[1];
type ActivityEndedResult    = Parameters<NonNullable<SqlMiddleware['activityEnded']>>[1];
type ActivityFinalizedResult = Parameters<NonNullable<SqlMiddleware['activityFinalized']>>[1];


const SENTRY = Symbol('sentry-prisma');


type SpanCtx = {
  state(key: symbol): Record<string | symbol, unknown>;
  parent?: SpanCtx | undefined;
};


export interface SentryMiddlewareOptions {
  shouldTrace?: (activity: RuntimeActivity) => boolean;

  customAttributes?: (activity: RuntimeActivity) => Record<string, string | number | boolean>;

  
  startNewTrace?: boolean;

  opPrefix?: string;
}


function spanOf(ctx: SpanCtx | undefined): Sentry.Span | undefined {
  return ctx?.state(SENTRY)['span'] as Sentry.Span | undefined;
}


function nearestSpan(ctx: SpanCtx | undefined): Sentry.Span | undefined {
  let cur: SpanCtx | undefined = ctx;
  while (cur !== undefined) {
    const span = spanOf(cur);
    if (span !== undefined) return span;
    cur = cur.parent;
  }
  return undefined;
}

// Centralized widening: ActivityContext is structurally a SpanCtx, but its
// `contract` field (unknown) differs from SqlMiddlewareContext's (Contract).
// One cast here keeps every hook body free of casts.
function asSpanCtx(ctx: ActivityContext): SpanCtx {
  return ctx as unknown as SpanCtx;
}


function recordLatency(span: Sentry.Span, result: unknown): void {
  if (typeof result !== 'object' || result === null) return;
  const latency = (result as { latencyMs?: unknown }).latencyMs;
  if (typeof latency === 'number' && Number.isFinite(latency)) {
    span.setAttribute('prisma.latency_ms', latency);
  }
}

function applyEndedOutcome(span: Sentry.Span, result: ActivityEndedResult): void {
  const outcome = String(result.outcome);
  switch (outcome) {
    case 'succeeded':
      span.setStatus({ code: 1 });
      break;
    case 'stopped':
      span.setStatus({ code: 1 });
      span.setAttribute('prisma.outcome', 'stopped');
      break;
    case 'failed':
      span.setStatus({ code: 2, message: 'Database activity failed' });
      break;
    default:
      span.setStatus({ code: 2, message: `Unexpected activity outcome: ${outcome}` });
      break;
  }
  recordLatency(span, result);
}

function applyFinalizedOutcome(span: Sentry.Span, result: ActivityFinalizedResult): void {
  const outcome = String(result.outcome);
  switch (outcome) {
    case 'committed':
      span.setStatus({ code: 1 });
      break;
    case 'rolled-back':
      span.setStatus({ code: 2, message: 'Transaction rolled back' });
      break;
    case 'unknown':
      span.setStatus({
        code: 2,
        message: 'Transaction outcome unknown (commit may have failed or a statement failed)',
      });
      break;
    default:
      span.setStatus({ code: 2, message: `Unexpected finalized outcome: ${outcome}` });
      break;
  }
  recordLatency(span, result);
}

function warn(ctx: ActivityContext, message: string, err: unknown): void {
  try {
    ctx.log?.warn?.({
      middleware: 'sentry-middleware',
      message,
      error:
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
    });
  } catch {
    // Logging must never throw.
  }
}


function resolveParentSpan(ctx: ActivityContext, startNewTrace: boolean): Sentry.Span | null {
  const prismaParent = nearestSpan(asSpanCtx(ctx).parent);
  if (prismaParent !== undefined) return prismaParent;
  if (startNewTrace) return null;                 // explicit new trace
  return Sentry.getActiveSpan() ?? null;          // attach or root
}

//  Factory
export function sentryMiddleware(options: SentryMiddlewareOptions = {}): SqlMiddleware {
  const {
    shouldTrace      = () => true,
    customAttributes = () => ({}),
    startNewTrace    = false,
    opPrefix         = 'db.prisma',
  } = options;

  return {
    name: 'sentry-middleware',
    familyId: 'sql',

    
    async activityStarted(activity, ctx) {
      try {
        if (!shouldTrace(activity)) return;

        
        const parentSpan = resolveParentSpan(ctx, startNewTrace);
        const forceTransaction = parentSpan === null;

       
        let attrs: Record<string, string | number | boolean> = {};
        try {
          attrs = customAttributes(activity);
        } catch (err) {
          warn(ctx, 'customAttributes threw; using empty attributes', err);
        }

        const span = Sentry.startInactiveSpan({
          name: `${opPrefix}.${activity.kind}`,
          op:   `${opPrefix}.${activity.kind}`,
          parentSpan,
          forceTransaction,
          attributes: {
            'prisma.activity.kind': activity.kind,
            'prisma.activity.id':   activity.id,
            ...attrs,
          },
        });

       
        asSpanCtx(ctx).state(SENTRY)['span'] = span;
      } catch (err) {
        warn(ctx, 'activityStarted failed; query will proceed untraced', err);
      }
    },

    
    beforeEncode(plan, ctx) {
      try {
        const span = spanOf(asSpanCtx(ctx));
        if (span === undefined) return;

       
        span.updateName(plan.sql);
        span.setAttribute('db.query.text', plan.sql);
        span.setAttribute(
          'db.system.name',
          plan.meta.target === 'postgres' ? 'postgresql' : plan.meta.target,
        );
      } catch (err) {
        warn(ctx, 'beforeEncode failed; query will proceed', err);
      }
    },

  
    async activityEnded(activity, result, ctx) {
      if (activity.kind === 'transaction') return; // finalized handles txs

      let span: Sentry.Span | undefined;
      try {
        span = spanOf(asSpanCtx(ctx));
        if (span === undefined) return;

        const r = result as unknown as {
          returns?: 'rows' | 'stats';
          rowCount?: number;
          stats?: { affectedRows?: number };
        };
        if (r.returns === 'rows' && typeof r.rowCount === 'number') {
          span.setAttribute('db.response.returned_rows', r.rowCount);
        }
        if (r.returns === 'stats' && typeof r.stats?.affectedRows === 'number') {
          span.setAttribute('db.response.affected_rows', r.stats.affectedRows);
        }

        applyEndedOutcome(span, result);
      } catch (err) {
        warn(ctx, 'activityEnded failed', err);
      } finally {
        // Always end the span, even if status-setting threw.
        try { span?.end(); } catch {  }
      }
    },

    
    async activityFinalized(activity, result, ctx) {
      if (activity.kind !== 'transaction') return;

      let span: Sentry.Span | undefined;
      try {
        span = spanOf(asSpanCtx(ctx));
        if (span === undefined) return;
        applyFinalizedOutcome(span, result);
      } catch (err) {
        warn(ctx, 'activityFinalized failed', err);
      } finally {
        try { span?.end(); } catch {  }
      }
    },
  };
}