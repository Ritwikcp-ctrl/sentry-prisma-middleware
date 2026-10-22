import * as Sentry from "@sentry/node";
import type { SqlMiddleware } from "@prisma/orm-postgres/family-runtime";

// Derive callback types from the public Prisma middleware contract.
type RuntimeActivity = Parameters<
  NonNullable<SqlMiddleware["activityStarted"]>
>[0];

type ActivityContext = Parameters<
  NonNullable<SqlMiddleware["activityStarted"]>
>[1];

type ActivityEndedResult = Parameters<
  NonNullable<SqlMiddleware["activityEnded"]>
>[1];

type ActivityFinalizedResult = Parameters<
  NonNullable<SqlMiddleware["activityFinalized"]>
>[1];

// Activity state interfaces.
type ActivityState = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
};

type StateFunction = (key: string, value?: unknown) => unknown;

type ContextWithState = ActivityContext & {
  parent?: ContextWithState;
  state?: ActivityState | StateFunction;
};

export interface SentryMiddlewareOptions {
  shouldTrace?: (activity: RuntimeActivity) => boolean;
  customAttributes?: () => Record<string, string | number | boolean>;
  useActiveParentForRoot?: boolean;
  opPrefix?: string;
}

const SPAN_KEY = "sentrySpan";

// Fallback storage for spans when context state is unavailable.
const spansById = new Map<string, Sentry.Span>();

// Validate a state object without relying on incorrect TypeScript narrowing.
function isActivityState(value: unknown): value is ActivityState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    get?: unknown;
    set?: unknown;
  };

  return (
    typeof candidate.get === "function" && typeof candidate.set === "function"
  );
}

// Validate span-like objects without relying on instanceof Sentry.Span.
function isSpan(value: unknown): value is Sentry.Span {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    end?: unknown;
    setStatus?: unknown;
    setAttribute?: unknown;
  };

  return (
    typeof candidate.end === "function" &&
    typeof candidate.setStatus === "function" &&
    typeof candidate.setAttribute === "function"
  );
}

// Resolve Prisma's context state store.
function stateStore(ctx: ActivityContext): ActivityState | undefined {
  const state: unknown = (ctx as ContextWithState).state;

  if (isActivityState(state)) {
    return state;
  }

  if (typeof state === "function") {
    const stateFn = state as StateFunction;

    return {
      get(key: string): unknown {
        return stateFn(key);
      },

      set(key: string, value: unknown): void {
        stateFn(key, value);
      },
    };
  }

  return undefined;
}

// Save the span in both context state and fallback storage.
function storeSpan(
  ctx: ActivityContext,
  activityId: string,
  span: Sentry.Span
): void {
  try {
    stateStore(ctx)?.set(SPAN_KEY, span);
  } catch {
    // Continue using fallback storage.
  }

  spansById.set(activityId, span);
}

// Retrieve a span from context state or fallback storage.
function retrieveSpan(
  ctx: ActivityContext,
  activityId: string
): Sentry.Span | undefined {
  try {
    const span = stateStore(ctx)?.get(SPAN_KEY);

    if (isSpan(span)) {
      return span;
    }
  } catch {}

  return spansById.get(activityId);
}

function cleanupSpan(ctx: ActivityContext, activityId: string): void {
  spansById.delete(activityId);

  try {
    stateStore(ctx)?.set(SPAN_KEY, undefined);
  } catch {}
}

function resolveParentSpan(
  ctx: ActivityContext,
  useActiveParentForRoot: boolean
): Sentry.Span | undefined {
  const parent = (ctx as ContextWithState).parent;

  if (parent) {
    try {
      const parentSpan = stateStore(parent)?.get(SPAN_KEY);

      if (isSpan(parentSpan)) {
        return parentSpan;
      }
    } catch {
      // Fall through to the optional active-parent behavior.
    }
  }

  if (useActiveParentForRoot) {
    return Sentry.getActiveSpan() ?? undefined;
  }

  return undefined;
}

// Generate span names and operation types.
function spanName(activity: RuntimeActivity, prefix: string): string {
  return `${prefix}.${activity.kind}.${activity.id.slice(0, 8)}`;
}

function operationFor(activity: RuntimeActivity, prefix: string): string {
  return activity.kind === "transaction"
    ? `${prefix}.transaction`
    : `${prefix}.query`;
}

// Extract optional result details without assuming a particular result type.
function recordResultDetails(span: Sentry.Span, result: unknown): void {
  if (typeof result !== "object" || result === null) {
    return;
  }

  const details = result as {
    latencyMs?: unknown;
    error?: unknown;
  };

  if (
    typeof details.latencyMs === "number" &&
    Number.isFinite(details.latencyMs)
  ) {
    span.setAttribute("prisma.latency_ms", details.latencyMs);
  }

  if (details.error instanceof Error) {
    Sentry.captureException(details.error);
  }
}

// Handle non-transaction activity results.
function applyEndedOutcome(
  span: Sentry.Span,
  result: ActivityEndedResult
): void {
  switch (result.outcome) {
    case "succeeded":
      span.setStatus({ code: 1 });
      break;

    case "failed":
      span.setStatus({
        code: 2,
        message: "Database activity failed",
      });
      break;

    case "stopped":
      span.setStatus({
        code: 2,
        message: "Database activity stopped",
      });
      break;
  }

  recordResultDetails(span, result);
}

// Handle transaction results independently of the ended-result union.
function applyFinalizedOutcome(
  span: Sentry.Span,
  result: ActivityFinalizedResult
): void {
  const outcome = String(result.outcome);

  switch (outcome) {
    case "committed":
    case "succeeded":
      span.setStatus({ code: 1 });
      break;

    case "rolled-back":
      span.setStatus({
        code: 2,
        message: "Transaction rolled back",
      });
      break;

    case "failed":
      span.setStatus({
        code: 2,
        message: "Transaction failed",
      });
      break;

    case "stopped":
      span.setStatus({
        code: 2,
        message: "Transaction stopped",
      });
      break;

    default:
      span.setStatus({
        code: 2,
        message: `Transaction outcome: ${outcome}`,
      });
      break;
  }

  recordResultDetails(span, result);
}

// Main Prisma SQL middleware.
export function sentryMiddleware(
  options: SentryMiddlewareOptions = {}
): SqlMiddleware {
  const {
    shouldTrace = () => true,
    customAttributes = () => ({}),
    useActiveParentForRoot = false,
    opPrefix = "db.prisma",
  } = options;

  return {
    name: "sentry-middleware",
    familyId: "sql",

    async activityStarted(activity, ctx) {
      if (!shouldTrace(activity)) {
        return;
      }

      const parentSpan = resolveParentSpan(ctx, useActiveParentForRoot);

      const span = Sentry.startInactiveSpan({
        name: spanName(activity, opPrefix),
        op: operationFor(activity, opPrefix),
        parentSpan: parentSpan ?? undefined,
        forceTransaction: !parentSpan,
        attributes: {
          "prisma.activity.kind": activity.kind,
          "prisma.activity.id": activity.id,
          ...customAttributes(),
        },
      });

      storeSpan(ctx, activity.id, span);
    },

    async activityEnded(activity, result, ctx) {
      if (activity.kind === "transaction") {
        return;
      }

      const span = retrieveSpan(ctx, activity.id);

      if (!span) {
        return;
      }

      try {
        applyEndedOutcome(span, result);
      } finally {
        span.end();
        cleanupSpan(ctx, activity.id);
      }
    },

    async activityFinalized(activity, result, ctx) {
      if (activity.kind !== "transaction") {
        return;
      }

      const span = retrieveSpan(ctx, activity.id);

      if (!span) {
        return;
      }

      try {
        applyFinalizedOutcome(span, result);
      } finally {
        span.end();
        cleanupSpan(ctx, activity.id);
      }
    },
  };
}
