/**
 * Minimal source-level `.js` → `.ts` import hook for the forge-loop e2e.
 *
 * The forge extension source (`src/resources/extensions/forge/**`) follows the
 * ESM `.js`-specifier convention (`import ... from "./x.js"`) even though the
 * files on disk are `.ts` — at runtime the harness's own loader strips types and
 * resolves those specifiers. Node's bare `--experimental-strip-types` does NOT
 * rewrite `.js`→`.ts`, so importing that source into an e2e that runs under
 * strip-types fails with ERR_MODULE_NOT_FOUND.
 *
 * This hook redirects a relative `.js` specifier to its sibling `.ts` file when
 * (and only when) the `.js` does not exist but the `.ts` does. It touches
 * nothing else — node builtins, bare packages, and real `.js`/`.ts` files fall
 * straight through to the default resolver. It intentionally has ZERO dependency
 * on the condemned legacy extension tree (iron rule 2) — no import of it, no
 * reuse of its resolver.
 *
 * Usage:
 *   node --import ./tests/e2e/_shared/resolve-src-ts.mjs \
 *        --experimental-strip-types --test tests/e2e/forge-loop.e2e.test.ts
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			(specifier.startsWith("./") || specifier.startsWith("../")) &&
			specifier.endsWith(".js") &&
			context.parentURL?.startsWith("file:")
		) {
			try {
				const jsUrl = new URL(specifier, context.parentURL);
				if (!existsSync(fileURLToPath(jsUrl))) {
					const tsPath = fileURLToPath(jsUrl).slice(0, -3) + ".ts";
					if (existsSync(tsPath)) {
						return nextResolve(pathToFileURL(tsPath).href, context);
					}
				}
			} catch {
				// Fall through to the default resolver on any URL/FS hiccup.
			}
		}
		return nextResolve(specifier, context);
	},
});
