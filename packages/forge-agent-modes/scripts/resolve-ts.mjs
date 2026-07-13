/**
 * Native `node:test` resolver for `@forge/agent-modes`.
 *
 * Restores TS source-level module resolution for this package's test suite
 * (`pnpm --filter @forge/agent-modes test`) after the removal of the legacy
 * runner `src/resources/extensions/gsd/tests/resolve-ts.mjs` in the fork-strip
 * commit b8eb5c4b. It has ZERO dependency on that condemned tree (iron rule
 * 2, see CLAUDE.md) — no import of it, no reuse of its code, just the same
 * mapping shape recovered by inspection, following the precedent set by
 * `packages/forge-agent-core/scripts/resolve-ts.mjs`.
 *
 * It handles the workspace specifiers this package's source imports:
 *   1. Bare `@gsd/<pkg>`            -> packages/<pkg>/src/index.ts
 *   2. Subpath `@gsd/<pkg>/a/b`     -> packages/<pkg>/src/a/b.ts, or
 *                                      packages/<pkg>/src/a/b/index.ts when
 *                                      the target itself is a directory
 *                                      (e.g. `@gsd/native/text`, `@gsd/pi-ai/oauth`).
 *   3. Self `@forge/agent-modes`    -> packages/forge-agent-modes/src/index.ts
 *   4. `@forge/agent-core`          -> packages/forge-agent-core/src/index.ts
 *   5. Relative `./x.js` -> `./x.ts`, only when the `.js` file does not exist
 *      on disk but the sibling `.ts` does.
 *
 * `--experimental-strip-types` cannot parse TypeScript parameter properties
 * (used throughout `pi-tui`/`pi-coding-agent` components), so workspace
 * `.ts` sources are transpiled through TypeScript's `transpileModule` in the
 * `load` hook, matching the condemned runner's original behavior.
 *
 * It only ever RESOLVES/LOADS specifiers from the vendored `pi-` packages'
 * `src` directories — it never writes to or otherwise modifies any file
 * under a vendored `pi-` package tree. `verify-pi-patches.cjs` must stay
 * green with this file present.
 *
 * `REPO_ROOT` is derived from this file's own location (not `process.cwd()`)
 * so the resolver behaves the same regardless of the invoking working dir.
 *
 * Usage (wired via package.json `test` script):
 *   node --import ./scripts/resolve-ts.mjs --experimental-strip-types \
 *        --test src/**\/*.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// packages/forge-agent-modes/scripts/resolve-ts.mjs -> repo root is three levels up.
const REPO_ROOT = new URL("../../../", import.meta.url);
const PACKAGES_ROOT = fileURLToPath(new URL("packages/", REPO_ROOT));
const require = createRequire(import.meta.url);

function resolveSubpathTarget(pkg, subpath) {
	const base = `${PACKAGES_ROOT}${pkg}/src`;
	if (subpath === "") return `${base}/index.ts`;
	const stripped = subpath.replace(/\.js$/, "");
	const direct = `${base}/${stripped}.ts`;
	if (existsSync(direct)) return direct;
	return `${base}/${stripped}/index.ts`;
}

function resolveGsdSpecifier(specifier) {
	const rest = specifier.slice("@gsd/".length);
	const slashIndex = rest.indexOf("/");
	const pkg = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
	const subpath = slashIndex === -1 ? "" : rest.slice(slashIndex + 1);
	return pathToFileURL(resolveSubpathTarget(pkg, subpath)).href;
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@forge/agent-modes") {
			return nextResolve(pathToFileURL(`${PACKAGES_ROOT}forge-agent-modes/src/index.ts`).href, context);
		}
		if (specifier.startsWith("@forge/agent-modes/")) {
			const subpath = specifier.slice("@forge/agent-modes/".length);
			return nextResolve(pathToFileURL(resolveSubpathTarget("forge-agent-modes", subpath)).href, context);
		}
		if (specifier === "@forge/agent-core") {
			return nextResolve(pathToFileURL(`${PACKAGES_ROOT}forge-agent-core/src/index.ts`).href, context);
		}
		if (specifier.startsWith("@forge/agent-core/")) {
			const subpath = specifier.slice("@forge/agent-core/".length);
			return nextResolve(pathToFileURL(resolveSubpathTarget("forge-agent-core", subpath)).href, context);
		}
		// `@gsd/agent-core` is a legacy specifier vendored `pi-coding-agent` code
		// still imports for its "extension-stable re-export" shim — the real
		// package moved to `packages/forge-agent-core` in the M0 rename.
		if (specifier === "@gsd/agent-core" || specifier.startsWith("@gsd/agent-core/")) {
			const subpath = specifier === "@gsd/agent-core" ? "" : specifier.slice("@gsd/agent-core/".length);
			return nextResolve(pathToFileURL(resolveSubpathTarget("forge-agent-core", subpath)).href, context);
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

	load(url, context, nextLoad) {
		// `--experimental-strip-types` rejects parameter properties and other
		// TS-only constructs used across the vendored pi-* packages. Transpile
		// every workspace package source file through TypeScript instead.
		const isWorkspaceSource = url.startsWith(pathToFileURL(PACKAGES_ROOT).href) && url.includes("/src/");
		if (url.endsWith(".ts") && isWorkspaceSource) {
			const ts = require("typescript");
			const source = readFileSync(fileURLToPath(url), "utf-8");
			const { outputText } = ts.transpileModule(source, {
				fileName: fileURLToPath(url),
				compilerOptions: {
					module: ts.ModuleKind.ESNext,
					target: ts.ScriptTarget.ESNext,
					esModuleInterop: true,
					experimentalDecorators: true,
					emitDecoratorMetadata: true,
				},
			});
			// Workspace sources compiled as ESM may still reference CJS-only
			// globals (__dirname, __filename, require) directly — inject them
			// from import.meta.url rather than rewriting every call site.
			const preambleLines = [
				'import { fileURLToPath as __preamble_fUTP } from "node:url";',
				'import { dirname as __preamble_dn } from "node:path";',
				'import { createRequire as __preamble_cR } from "node:module";',
			];
			if (!/\b(?:const|let|var)\s+__filename\b/.test(outputText)) {
				preambleLines.push("const __filename = __preamble_fUTP(import.meta.url);");
			}
			if (!/\b(?:const|let|var)\s+__dirname\b/.test(outputText)) {
				preambleLines.push("const __dirname = __preamble_dn(__preamble_fUTP(import.meta.url));");
			}
			if (!/\b(?:const|let|var)\s+require\b/.test(outputText)) {
				preambleLines.push("const require = __preamble_cR(import.meta.url);");
			}
			return { format: "module", source: `${preambleLines.join("\n")}\n${outputText}`, shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});
