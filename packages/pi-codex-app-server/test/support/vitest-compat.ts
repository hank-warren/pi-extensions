// The subset of vitest's API these tests use, on top of node:test and
// node:assert, so the suite ported from upstream keeps its shape and stays
// diffable against Lqm1/pi-codex-app-server. Extend it when a test needs more;
// do not add matchers speculatively.
import assert from "node:assert/strict";
import { afterEach as nodeAfterEach, describe as nodeDescribe, it as nodeIt, mock } from "node:test";

type TestBody = () => unknown;

/** vitest accepts a class or function as a suite name; node:test needs a string. */
export const describe = (name: unknown, fn: TestBody): void => {
  const title = typeof name === "function" ? (name as { name: string }).name : String(name);
  void nodeDescribe(title, fn as () => void);
};
/** vitest's `it.each(table)(title, fn)`; `%j`/`%s` in the title get the row's value. */
const runTest = (title: string, fn: TestBody): void => {
  void nodeIt(title, fn as () => void);
};

export const it = Object.assign(runTest, {
  each:
    <T,>(rows: readonly T[]) =>
    (title: string, fn: (row: T) => unknown): void => {
      for (const row of rows) {
        const label = title.replace(/%[jsdiop]/g, () =>
          typeof row === "string" ? JSON.stringify(row) : describeValue(row)
        );
        runTest(label, () => fn(row));
      }
    },
  skip: (title: string, fn: TestBody): void => {
    void nodeIt.skip(title, fn as () => void);
  },
  todo: (title: string, fn?: TestBody): void => {
    void nodeIt.todo(title, fn as () => void);
  },
});
export const test = it;
export const afterEach = nodeAfterEach;

const ASYMMETRIC = Symbol("asymmetric-matcher");

type AsymmetricMatcher = {
  readonly [ASYMMETRIC]: true;
  readonly description: string;
  matches(actual: unknown): boolean;
};

const isAsymmetric = (value: unknown): value is AsymmetricMatcher =>
  typeof value === "object" && value !== null && ASYMMETRIC in value;

const asymmetric = (description: string, matches: (actual: unknown) => boolean): AsymmetricMatcher => ({
  [ASYMMETRIC]: true,
  description,
  matches,
});

const hasAsymmetric = (value: unknown): boolean => {
  if (isAsymmetric(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasAsymmetric);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasAsymmetric);
  }
  return false;
};

/** Structural equality that honours asymmetric matchers; plain values defer to node:assert. */
const equalsWithMatchers = (actual: unknown, expected: unknown): boolean => {
  if (isAsymmetric(expected)) {
    return expected.matches(actual);
  }
  if (!hasAsymmetric(expected)) {
    return isDeepEqual(actual, expected);
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => equalsWithMatchers(actual[index], item));
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null) {
      return false;
    }
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    return (
      expectedKeys.length === actualKeys.length &&
      expectedKeys.every((key) => key in actual && equalsWithMatchers((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]))
    );
  }
  return Object.is(actual, expected);
};

type MockFn<F extends (...args: never[]) => unknown> = ReturnType<typeof mock.fn<F>> & {
  mockResolvedValue(value: Awaited<ReturnType<F>>): MockFn<F>;
  mockImplementation(implementation: F): MockFn<F>;
};

const withVitestMethods = <F extends (...args: never[]) => unknown>(fn: ReturnType<typeof mock.fn<F>>): MockFn<F> => {
  const mocked = fn as MockFn<F>;
  mocked.mockResolvedValue = (value) => {
    mocked.mock.mockImplementation((() => Promise.resolve(value)) as unknown as F);
    return mocked;
  };
  mocked.mockImplementation = (implementation) => {
    mocked.mock.mockImplementation(implementation);
    return mocked;
  };
  return mocked;
};

export const vi = {
  fn<F extends (...args: never[]) => unknown>(implementation?: F): MockFn<F> {
    return withVitestMethods(implementation ? mock.fn<F>(implementation) : mock.fn<F>());
  },
  spyOn<T extends object, K extends keyof T>(
    target: T,
    method: T[K] extends (...args: never[]) => unknown ? K : never
  ): MockFn<T[K] extends (...args: never[]) => unknown ? T[K] : never> {
    const spy = mock.method(target, method as never);
    return withVitestMethods(spy as never) as never;
  },
  restoreAllMocks(): void {
    mock.restoreAll();
  },
};

// node:test's mock.fn() returns a Proxy whose `has` trap hides `mock`, so probe
// the property rather than using `in`.
const isMock = (value: unknown): value is { mock: { calls: { arguments: unknown[] }[] } } => {
  if (typeof value !== "function") {
    return false;
  }
  const candidate = (value as unknown as { mock?: unknown }).mock;
  return typeof candidate === "object" && candidate !== null;
};

const matchesObject = (actual: unknown, expected: unknown): boolean => {
  if (isAsymmetric(expected)) {
    return expected.matches(actual);
  }
  if (expected === null || typeof expected !== "object") {
    return Object.is(actual, expected);
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => matchesObject(actual[index], item));
  }
  if (actual === null || typeof actual !== "object") {
    return false;
  }
  return Object.entries(expected).every(([key, value]) => matchesObject((actual as Record<string, unknown>)[key], value));
};

const contains = (haystack: unknown, needle: unknown, deep: boolean): boolean => {
  if (typeof haystack === "string") {
    return typeof needle === "string" && haystack.includes(needle);
  }
  if (Array.isArray(haystack) || haystack instanceof Set) {
    return [...haystack].some((item) => (deep || isAsymmetric(needle) ? equalsWithMatchers(item, needle) : Object.is(item, needle)));
  }
  return false;
};

const isDeepEqual = (a: unknown, b: unknown): boolean => {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
};

const describeValue = (value: unknown): string => {
  if (isAsymmetric(value)) {
    return value.description;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const buildMatchers = (actual: unknown, negate: boolean) => {
  const check = (condition: boolean, message: string): void => {
    if (condition === negate) {
      assert.fail(`${negate ? "expected not: " : "expected: "}${message}`);
    }
  };
  const callArgs = (): unknown[][] => {
    if (!isMock(actual)) {
      assert.fail("expected a mock function");
    }
    return actual.mock.calls.map((call) => call.arguments);
  };
  return {
    toBe: (expected: unknown) => check(Object.is(actual, expected), `${describeValue(actual)} to be ${describeValue(expected)}`),
    toStrictEqual: (expected: unknown) => check(equalsWithMatchers(actual, expected), `${describeValue(actual)} to strictly equal ${describeValue(expected)}`),
    toEqual: (expected: unknown) => check(equalsWithMatchers(actual, expected), `${describeValue(actual)} to equal ${describeValue(expected)}`),
    toMatchObject: (expected: object) => check(matchesObject(actual, expected), `${describeValue(actual)} to match ${describeValue(expected)}`),
    toContain: (item: unknown) => check(contains(actual, item, false), `${describeValue(actual)} to contain ${describeValue(item)}`),
    toContainEqual: (item: unknown) => check(contains(actual, item, true), `${describeValue(actual)} to contain an equal ${describeValue(item)}`),
    toHaveLength: (length: number) => check((actual as { length?: number })?.length === length, `length ${describeValue((actual as { length?: number })?.length)} to be ${length}`),
    toBeTruthy: () => check(Boolean(actual), `${describeValue(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, `${describeValue(actual)} to be falsy`),
    toBeUndefined: () => check(actual === undefined, `${describeValue(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, `${describeValue(actual)} to be defined`),
    toBeGreaterThan: (expected: number) => check((actual as number) > expected, `${describeValue(actual)} > ${expected}`),
    toHaveBeenCalledWith: (...expected: unknown[]) =>
      check(callArgs().some((args) => equalsWithMatchers(args, expected)), `mock to have been called with ${describeValue(expected)}; calls: ${describeValue(callArgs())}`),
    toHaveBeenCalledOnce: () => check(callArgs().length === 1, `mock to have been called once; calls: ${callArgs().length}`),
    toHaveBeenCalledTimes: (times: number) => check(callArgs().length === times, `mock to have been called ${times} times; calls: ${callArgs().length}`),
    toHaveBeenCalled: () => check(callArgs().length > 0, "mock to have been called"),
    toThrow: (expected?: string | RegExp | (new (...args: never[]) => Error)) => {
      if (typeof actual !== "function") {
        assert.fail("expected a function for toThrow");
      }
      let thrown: unknown;
      let didThrow = false;
      try {
        (actual as () => unknown)();
      } catch (error) {
        didThrow = true;
        thrown = error;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      const matchesExpectation =
        expected === undefined ||
        (expected instanceof RegExp
          ? expected.test(message)
          : typeof expected === "function"
            ? thrown instanceof expected
            : message.includes(expected));
      const matches = didThrow && matchesExpectation;
      const expectation =
        expected === undefined ? "" : typeof expected === "function" ? expected.name : describeValue(expected);
      check(matches, `function to throw ${expectation}${didThrow ? ` (threw ${describeValue(message)})` : " (did not throw)"}`);
    },
  };
};

const expectFn = (actual: unknown) => {
  const matchers = buildMatchers(actual, false);
  const not = buildMatchers(actual, true);
  const resolved = (value: Promise<unknown>) => ({
    toContain: async (item: unknown) => buildMatchers(await value, false).toContain(item),
    toStrictEqual: async (expected: unknown) => buildMatchers(await value, false).toStrictEqual(expected),
    toBe: async (expected: unknown) => buildMatchers(await value, false).toBe(expected),
  });
  const rejected = (value: Promise<unknown>) => ({
    toMatchObject: async (expected: object) => {
      await assert.rejects(value, (error: unknown) => {
        buildMatchers(error, false).toMatchObject(expected);
        return true;
      });
    },
    toThrow: async (expected?: string | RegExp | (new (...args: never[]) => Error)) => {
      await assert.rejects(value, (error: unknown) => {
        buildMatchers(() => { throw error; }, false).toThrow(expected);
        return true;
      });
    },
  });
  return {
    ...matchers,
    not,
    resolves: resolved(Promise.resolve(actual)),
    rejects: rejected(Promise.resolve(actual)),
  };
};

export const expect = Object.assign(expectFn, {
  any: (constructor: { name: string; prototype: unknown }) =>
    asymmetric(`any(${constructor.name})`, (actual) => {
      if (constructor === String) return typeof actual === "string";
      if (constructor === Number) return typeof actual === "number";
      if (constructor === Boolean) return typeof actual === "boolean";
      if (constructor === Function) return typeof actual === "function";
      return actual instanceof (constructor as new (...args: never[]) => unknown);
    }),
  stringContaining: (expected: string) =>
    asymmetric(`stringContaining(${expected})`, (actual) => typeof actual === "string" && actual.includes(expected)),
  objectContaining: (expected: object) =>
    asymmetric(`objectContaining(${describeValue(expected)})`, (actual) => matchesObject(actual, expected)),
  arrayContaining: (expected: unknown[]) =>
    asymmetric(`arrayContaining(${describeValue(expected)})`, (actual) =>
      Array.isArray(actual) && expected.every((item) => actual.some((candidate) => equalsWithMatchers(candidate, item)))
    ),
});
