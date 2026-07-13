/**
 * Native `node:test` resolver for `@forge/agent-core`.
 *
 * Restores TS source-level module resolution for this package's test suite
 * (`pnpm --filter @forge/agent-core test`) after the removal of the legacy
 * runner `src/resources/extensions/gsd/tests/resolve-ts.mjs` in the fork-strip
 * commit b8eb5c4b. It has ZERO dependency on that condemned tree (iron rule
 * 2, see CLAUDE.md) — no import of it, no reuse of its code, just the same
 * mapping shape recovered by inspection.
 *
 * It handles three specifier forms seen in this package's tests:
 *   1. Bare `@gsd/<pkg>`            -> packages/<pkg>/src/index.ts
 *   2. Subpath `@gsd/<pkg>/a/b.js`  -> packages/<pkg>/src/a/b.ts
 *   3. Self `@forge/agent-core`     -> packages/forge-agent-core/src/index.ts
 *   4. Relative `./x.js` -> `./x.ts`, only when the `.js` file does not exist
 *      on disk but the sibling `.ts` does (same guarded form as
 *      tests/e2e/_shared/resolve-src-ts.mjs).
 *
 * It only ever RESOLVES specifiers into the vendored `pi-` packages' `src`
 * directories — it never reads, writes, or otherwise modifies any file under
 * a vendored `pi-` package tree. `verify-pi-patches.cjs` must stay green
 * with this file present.
 *
 * `repoRoot` is derived from this file's own location (not `process.cwd()`)
 * so the resolver behaves the same regardless of the invoking working dir.
 *
 * Usage (wired via package.json `test` script):
 *   node --import ./scripts/resolve-ts.mjs --experimental-strip-types \
 *        --test src/*.test.ts src/**\/*.test.ts
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// packages/forge-agent-core/scripts/resolve-ts.mjs -> repo root is three levels up.
const REPO_ROOT = new URL("../../../", import.meta.url);
const PACKAGES_ROOT = fileURLToPath(new URL("packages/", REPO_ROOT));

function resolveGsdSpecifier(specifier) {
	// Strip the `@gsd/` prefix, leaving `<pkg>` or `<pkg>/sub/path.js`.
	const rest = specifier.slice("@gsd/".length);
	const slashIndex = rest.indexOf("/");
	const pkg = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
	const subpath = slashIndex === -1 ? "" : rest.slice(slashIndex + 1);

	let target = `${PACKAGES_ROOT}${pkg}/src`;
	if (subpath === "") {
		target += "/index.ts";
	} else {
		target += `/${subpath.replace(/\.js$/, ".ts")}`;
	}
	return pathToFileURL(target).href;
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@forge/agent-core") {
			const target = `${PACKAGES_ROOT}forge-agent-core/src/index.ts`;
			return nextResolve(pathToFileURL(target).href, context);
		}

		if (specifier.startsWith("@gsd/")) {
			return nextResolve(resolveGsdSpecifier(specifier), context);
		}

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
