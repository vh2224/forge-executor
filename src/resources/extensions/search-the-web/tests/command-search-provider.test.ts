import { test } from "node:test";
import assert from "node:assert/strict";
import type { AutocompleteItem } from "@gsd/pi-tui";
import { registerSearchProviderCommand } from "../command-search-provider.js";

type CommandOptions = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
	handler: (args: string, ctx: never) => Promise<void>;
};

function makeFakePi() {
	const commands = new Map<string, CommandOptions>();
	const pi = {
		registerCommand(name: string, options: CommandOptions) {
			commands.set(name, options);
		},
	};
	return { pi, commands };
}

test("registers canonical web search provider and deprecated alias", () => {
	const { pi, commands } = makeFakePi();

	registerSearchProviderCommand(pi as never);

	assert.deepEqual([...commands.keys()], ["web-search-provider", "search-provider"]);
	const canonical = commands.get("web-search-provider");
	const alias = commands.get("search-provider");
	assert.ok(canonical);
	assert.ok(alias);
	assert.match(canonical.description ?? "", /not the LLM provider/);
	assert.match(canonical.description ?? "", /\/model/);
	assert.match(alias.description ?? "", /deprecated alias of \/web-search-provider/);
	assert.strictEqual(alias.handler, canonical.handler);
	assert.strictEqual(alias.getArgumentCompletions, canonical.getArgumentCompletions);
});

test("both command names expose the same provider completions", () => {
	const { pi, commands } = makeFakePi();

	registerSearchProviderCommand(pi as never);

	const canonical = commands.get("web-search-provider")!;
	const alias = commands.get("search-provider")!;
	const canonicalMatches = canonical.getArgumentCompletions?.("ta") ?? [];
	const aliasMatches = alias.getArgumentCompletions?.("ta") ?? [];

	assert.deepEqual(canonicalMatches.map((item) => item.value), ["tavily"]);
	assert.deepEqual(aliasMatches.map((item) => item.value), ["tavily"]);
});

test("completion matching remains case-insensitive for the alias", () => {
	const { pi, commands } = makeFakePi();

	registerSearchProviderCommand(pi as never);

	const matches = commands.get("search-provider")!.getArgumentCompletions?.(" OLL") ?? [];
	assert.deepEqual(matches.map((item) => item.value), ["ollama"]);
});
