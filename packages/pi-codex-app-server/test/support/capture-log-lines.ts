// Run something with the daemon's real logging configuration and return the
// JSON lines it wrote. Tests that assert on log *content* have to go through the
// actual formatter and redaction stack, or they prove only that a stub was
// called.
import { configure, getConsoleSink, getJsonLinesFormatter } from "@logtape/logtape";

const LOGGER_CATEGORY = "pi-codex-app-server";

export const captureLogLines = async (
  run: () => Promise<void> | void
): Promise<readonly Record<string, unknown>[]> => {
  const written: string[] = [];
  const formatter = getJsonLinesFormatter();
  await configure({
    loggers: [
      {
        category: LOGGER_CATEGORY,
        lowestLevel: "debug",
        sinks: ["capture"],
      },
      // Without this, every capture prints logtape's "configure the meta logger"
      // advice over the test output.
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
    sinks: {
      capture: (record) => {
        written.push(formatter(record));
      },
    },
  });
  try {
    await run();
  } finally {
    await configure({ loggers: [], reset: true, sinks: { console: getConsoleSink() } });
  }
  return written.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
};
