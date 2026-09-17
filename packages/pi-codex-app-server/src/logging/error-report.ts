/**
 * Normalise anything thrown or handed to a callback into an `Error`.
 *
 * The logger serialises an `Error` as `{ name, message, stack }`, and a plain
 * string as a bare message with nothing else. So a call site that passes the
 * string it happens to have — the JSON-RPC library's `errorListener` does
 * exactly that, with the real failure in its second argument — produces a log
 * line that says something broke and nothing about what or where. Route error
 * logging through this, and the stack survives.
 */
const describe = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular, or a getter that throws. The fallback message still carries the
    // call site's own description.
    return String(value);
  }
};

export const asError = (value: unknown, fallbackMessage: string): Error => {
  if (value instanceof Error) {
    return value;
  }
  if (value === undefined || value === null) {
    return new Error(fallbackMessage);
  }
  const error = new Error(`${fallbackMessage}: ${describe(value)}`);
  // Keep the original around for a structured sink, without pretending it was
  // an Error to begin with.
  error.cause = value;
  return error;
};
