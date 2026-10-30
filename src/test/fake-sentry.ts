/**
 * Fake Sentry that records each span's name, parent, attributes, status
 * and end-state. Matches the SDK surface the middleware uses:
 *   startInactiveSpan({ name, op, parentSpan, forceTransaction, attributes })
 *   getActiveSpan()
 *   captureException(e)  — recorded so we can prove it's never called
 */

export interface RecordedSpan {
  name: string;
  op: string;
  parent?: string;
  forceTransaction: boolean;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  ended: boolean;
}

export interface FakeSpanApi {
  readonly name: string;
  updateName(name: string): void;
  setAttribute(key: string, value: unknown): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}

export interface FakeSentry {
  spans: RecordedSpan[];
  activeSpan: FakeSpanApi | undefined;
  captureExceptionCalls: unknown[];


  startInactiveSpan(opts: {
    name: string;
    op: string;
    parentSpan?: any;          // Sentry.Span | null at runtime; `any` sidesteps type friction
    forceTransaction?: boolean;
    attributes?: Record<string, unknown>;
  }): FakeSpanApi;

  getActiveSpan(): FakeSpanApi | undefined;
  reset(): void;
}

export function createFakeSentry(): FakeSentry {
  const spans: RecordedSpan[] = [];
  const captureExceptionCalls: unknown[] = [];
  let activeSpan: FakeSpanApi | undefined;

  const fake: FakeSentry = {
    spans,
    get activeSpan() { return activeSpan; },
    set activeSpan(v) { activeSpan = v; },
    captureExceptionCalls,

    startInactiveSpan(opts) {
      const recorded: RecordedSpan = {
        name: opts.name,
        op: opts.op,
        // null  = explicit "no parent" (new trace)
        // span  = attach to that parent
        // undef = attach to active (or root) — resolveParentSpan never emits this
        parent: opts.parentSpan ? opts.parentSpan.name : undefined,
        forceTransaction: opts.forceTransaction ?? false,
        attributes: { ...(opts.attributes ?? {}) },
        ended: false,
      };

      const span: FakeSpanApi = {
        get name() { return recorded.name; },
        updateName(n) { recorded.name = n; },
        setAttribute(k, v) { recorded.attributes[k] = v; },
        setStatus(s) { recorded.status = s; },
        end() { recorded.ended = true; },
      };

      spans.push(recorded);
      return span;
    },

    getActiveSpan() { return activeSpan; },

    reset() {
      spans.length = 0;
      captureExceptionCalls.length = 0;
      activeSpan = undefined;
    },
  };

  return fake;
}