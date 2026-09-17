import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const PI_ROOT_ENV = "PI_CODEX_APP_SERVER_PI_ROOT";
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

const packageNameAt = (dir: string): string | undefined => {
  const manifest = path.join(dir, "package.json");
  if (!existsSync(manifest)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(manifest, "utf-8")).name;
  } catch {
    return undefined;
  }
};

/** Walk up from a file inside pi's install until its package.json is found. */
export const piRootFromPath = (start: string): string | undefined => {
  let dir = path.dirname(start);
  for (;;) {
    if (packageNameAt(dir) === PI_PACKAGE_NAME) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
};

const piRootFromPathEnv = (): string | undefined => {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) {
      continue;
    }
    const candidate = path.join(entry, "pi");
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const root = piRootFromPath(realpathSync(candidate));
      if (root) {
        return root;
      }
    } catch {
      // unreadable symlink; keep looking
    }
  }
  return undefined;
};

/**
 * Locate the host pi install. The extension passes it through the environment
 * when it spawns the daemon (it knows its own `process.argv[1]`); a manual
 * launch falls back to the `pi` binary on PATH.
 */
export const resolvePiRoot = (): string => {
  const fromEnv = process.env[PI_ROOT_ENV];
  if (fromEnv) {
    if (packageNameAt(fromEnv) !== PI_PACKAGE_NAME) {
      throw new Error(`${PI_ROOT_ENV}=${fromEnv} is not a ${PI_PACKAGE_NAME} install`);
    }
    return fromEnv;
  }
  const fromPath = piRootFromPathEnv();
  if (fromPath) {
    return fromPath;
  }
  throw new Error(
    `Cannot find the pi install: set ${PI_ROOT_ENV} to the ${PI_PACKAGE_NAME} directory or put \`pi\` on PATH`
  );
};
