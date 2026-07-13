import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readAdvancedCommandsPref } from "./advanced-commands.ts";

function sandbox(): string {
	return mkdtempSync(path.join(os.tmpdir(), "forge-advanced-commands-"));
}

function withForgeHome<T>(callback: (cwd: string) => T): T {
	const cwd = sandbox();
	const previous = process.env.FORGE_HOME;
	process.env.FORGE_HOME = path.join(cwd, "forge-home");
	mkdirSync(process.env.FORGE_HOME, { recursive: true });
	try {
		return callback(cwd);
	} finally {
		if (previous === undefined) delete process.env.FORGE_HOME;
		else process.env.FORGE_HOME = previous;
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("absent preference defaults to false", () => {
	withForgeHome((cwd) => assert.equal(readAdvancedCommandsPref(cwd), false));
});

test("repo preference enables advanced commands", () => {
	withForgeHome((cwd) => {
		mkdirSync(path.join(cwd, ".gsd"), { recursive: true });
		writeFileSync(path.join(cwd, ".gsd", "prefs.md"), "advanced_commands: true\n");
		assert.equal(readAdvancedCommandsPref(cwd), true);
	});
});

test("local preference wins over the repo preference", () => {
	withForgeHome((cwd) => {
		mkdirSync(path.join(cwd, ".gsd"), { recursive: true });
		writeFileSync(path.join(cwd, ".gsd", "prefs.md"), "advanced_commands: true\n");
		writeFileSync(path.join(cwd, ".gsd", "prefs.local.md"), "advanced_commands: false\n");
		assert.equal(readAdvancedCommandsPref(cwd), false);
	});
});

test("unreadable preference layer degrades to false", () => {
	withForgeHome((cwd) => {
		mkdirSync(path.join(cwd, ".gsd", "prefs.md"), { recursive: true });
		assert.doesNotThrow(() => readAdvancedCommandsPref(cwd));
		assert.equal(readAdvancedCommandsPref(cwd), false);
	});
});

test("accepts true, yes, 1, and on as truthy values", () => {
	for (const value of ["true", "yes", "1", "on"]) {
		withForgeHome((cwd) => {
			mkdirSync(path.join(cwd, ".gsd"), { recursive: true });
			writeFileSync(path.join(cwd, ".gsd", "prefs.md"), `advanced_commands: ${value}\n`);
			assert.equal(readAdvancedCommandsPref(cwd), true, value);
		});
	}
});
