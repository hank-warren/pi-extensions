// Module customization hooks (node:module `register`) for the standalone daemon.
//
// Inside pi, extensions get `@earendil-works/*` through pi's own loader aliases,
// so this package lists them as peer dependencies and never installs a copy.
// The daemon is a separate node process with no such loader, so bare imports of
// those packages are re-resolved as if they came from inside pi's install: the
// same versions the host pi runs, and the sessions the daemon writes stay
// readable by the host TUI.
import { pathToFileURL } from "node:url";
import type { InitializeHook, ResolveHook } from "node:module";

const PI_SCOPE = "@earendil-works/";

let piParentUrl: string | undefined;

export const initialize: InitializeHook = (data: { piRoot: string }) => {
  piParentUrl = pathToFileURL(`${data.piRoot}/package.json`).href;
};

export const resolve: ResolveHook = (specifier, context, nextResolve) => {
  if (piParentUrl && specifier.startsWith(PI_SCOPE)) {
    return nextResolve(specifier, { ...context, parentURL: piParentUrl });
  }
  return nextResolve(specifier, context);
};
