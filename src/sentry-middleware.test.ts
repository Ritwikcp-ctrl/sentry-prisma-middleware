import { sentryMiddleware } from "./sentry-middleware.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlMiddleware } from "@prisma/orm-postgres/family-runtime";

const sentryMocks = vi.hoisted(() => ({
  startInactiveSpan: vi.fn(),
  getActiveSpan: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  startInactiveSpan: sentryMocks.startInactiveSpan,
  getActiveSpan: sentryMocks.getActiveSpan,
  captureException: sentryMocks.captureException,
}));


type StartedArgs = Parameters<
  NonNullable<SqlMiddleware["activityStarted"]>
>;

type EndedArgs = Parameters<
  NonNullable<SqlMiddleware["activityEnded"]>
>;

type FinalizedArgs = Parameters<
  NonNullable<SqlMiddleware["activityFinalized"]>
>;

type StateRecord = Record<string | symbol, unknown>;

type TestContext = StartedArgs[1] & {
  state: (key: string | symbol) => StateRecord;
};

function createSpanMock() {
  return {
    end: vi.fn(),
    setStatus: vi.fn(),
    setAttribute: vi.fn(),
  };
}

function createContext(): TestContext {
  const records = new Map<string | symbol, StateRecord>();

  return {
    state(key: string | symbol): StateRecord {
      let record = records.get(key);

      if (!record) {
        record = {};
        records.set(key, record);
      }

      return record;
    },
  } as unknown as TestContext;
}

function createActivity(
  kind: "query" | "transaction" = "query",
): StartedArgs[0] {
  return {
    id: "activity-12345678",
    kind,
  } as unknown as StartedArgs[0];
}

function createEndedResult(
  outcome: "succeeded" | "failed" | "stopped",
  extra: Record<string, unknown> = {},
): EndedArgs[1] {
  return {
    outcome,
    ...extra,
  } as unknown as EndedArgs[1];
}

function createFinalizedResult(
  outcome: string,
  extra: Record<string, unknown> = {},
): FinalizedArgs[1] {
  return {
    outcome,
    ...extra,
  } as unknown as FinalizedArgs[1];
}

describe("sentryMiddleware", () => {
  let span: ReturnType<typeof createSpanMock>;

  beforeEach(() => {
    vi.clearAllMocks();

    span = createSpanMock();

    sentryMocks.startInactiveSpan.mockReturnValue(span);
    sentryMocks.getActiveSpan.mockReturnValue(undefined);
  });

  it("creates a span when an activity starts", async () => {
    const middleware = sentryMiddleware();
    const activity = createActivity();
    const ctx = createContext();

    await middleware.activityStarted!(activity, ctx);

    expect(sentryMocks.startInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "db.prisma.query.activity",
        op: "db.prisma.query",
        attributes: expect.objectContaining({
          "prisma.activity.kind": "query",
          "prisma.activity.id": activity.id,
        }),
      }),
    );
  });

  it("sets success status and ends a successful query", async () => {
    const middleware = sentryMiddleware();
    const activity = createActivity();
    const ctx = createContext();

    await middleware.activityStarted!(activity, ctx);
    await middleware.activityEnded!(
      activity,
      createEndedResult("succeeded"),
      ctx,
    );

    expect(span.setStatus).toHaveBeenCalledWith({ code: 1 });
    expect(span.end).toHaveBeenCalledOnce();
  });

  it("marks a failed query as an error", async () => {
    const middleware = sentryMiddleware();
    const activity = createActivity();
    const ctx = createContext();

    await middleware.activityStarted!(activity, ctx);
    await middleware.activityEnded!(
      activity,
      createEndedResult("failed"),
      ctx,
    );

    expect(span.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "Database activity failed",
    });
    expect(span.end).toHaveBeenCalledOnce();
  });

  it("marks a stopped query as an error", async () => {
    const middleware = sentryMiddleware();
    const activity = createActivity();
    const ctx = createContext();

    await middleware.activityStarted!(activity, ctx);
    await middleware.activityEnded!(
      activity,
      createEndedResult("stopped"),
      ctx,
    );

    expect(span.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "Database activity stopped",
    });
    expect(span.end).toHaveBeenCalledOnce();
  });

  it("records query latency", async () => {
    const middleware = sentryMiddleware();
    const activity = createActivity();
    const ctx = createContext();

    await middleware.activityStarted!(activity, ctx);
    await middleware.activityEnded!(
      activity,
      createEndedResult("succeeded", { latencyMs: 42 }),
      ctx,
    );

    expect(span.setAttribute).toHaveBeenCalledWith(
      "prisma.latency_ms",
      42,
    );
  });

  it("captures an error from the query result", async () => {
    const middleware = sentryMiddleware();
    const activity = createActivity();
    const ctx = createContext();
    const error = new Error("Database query failed");

    await middleware.activityStarted!(activity, ctx);
    await middleware.activityEnded!(
      activity,
      createEndedResult("failed", { error }),
      ctx,
    );

    expect(sentryMocks.captureException).toHaveBeenCalledWith(error);
  });

  it("does not create a span when tracing is disabled", async () => {
    const middleware = sentryMiddleware({
      shouldTrace: () => false,
    });

    await middleware.activityStarted!(
      createActivity(),
      createContext(),
    );

    expect(sentryMocks.startInactiveSpan).not.toHaveBeenCalled();
  });

  it("keeps a transaction span open until finalization", async () => {
    const middleware = sentryMiddleware();
    const activity = createActivity("transaction");
    const ctx = createContext();

    await middleware.activityStarted!(activity, ctx);
    await middleware.activityEnded!(
      activity,
      createEndedResult("succeeded"),
      ctx,
    );

    expect(span.end).not.toHaveBeenCalled();

    await middleware.activityFinalized!(
      activity,
      createFinalizedResult("committed"),
      ctx,
    );

    expect(span.setStatus).toHaveBeenCalledWith({ code: 1 });
    expect(span.end).toHaveBeenCalledOnce();
  });

  it("marks a rolled-back transaction as an error", async () => {
    const middleware = sentryMiddleware();
    const activity = createActivity("transaction");
    const ctx = createContext();

    await middleware.activityStarted!(activity, ctx);
    await middleware.activityFinalized!(
      activity,
      createFinalizedResult("rolled-back"),
      ctx,
    );

    expect(span.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "Transaction rolled back",
    });
    expect(span.end).toHaveBeenCalledOnce();
  });

  it("does not end a span when no matching span exists", async () => {
    const middleware = sentryMiddleware();

    await middleware.activityEnded!(
      createActivity(),
      createEndedResult("succeeded"),
      createContext(),
    );

    expect(span.end).not.toHaveBeenCalled();
  });

  it("uses custom span prefixes and attributes", async () => {
    const middleware = sentryMiddleware({
      opPrefix: "app.database",
      customAttributes: () => ({
        environment: "test",
        version: 1,
      }),
    });

    await middleware.activityStarted!(
      createActivity(),
      createContext(),
    );

    expect(sentryMocks.startInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "app.database.query.activity",
        op: "app.database.query",
        attributes: expect.objectContaining({
          environment: "test",
          version: 1,
        }),
      }),
    );
  });
});
