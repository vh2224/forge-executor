import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Skill } from "@gsd/pi-coding-agent/core/skills.js";
import { isShadowedSkill, makeSkillsShadowOverride } from "./skills-shadow.js";

function skill(name: string, filePath: string): Skill {
	return {
		name,
		description: name,
		filePath,
		baseDir: join(filePath, ".."),
		sourceInfo: {
			path: filePath,
			source: filePath,
			scope: "user",
			origin: "top-level",
		},
		source: filePath,
		disableModelInvocation: false,
	};
}

function resource(skills: Skill[]) {
	return { skills, diagnostics: [] };
}

test("drops forge skills from a project Claude directory", () => {
	const cwd = mkdtempSync(join(tmpdir(), "skills-shadow-project-"));
	const claudeSkills = join(cwd, ".claude", "skills");
	mkdirSync(claudeSkills, { recursive: true });
	const leaked = skill("forge-legacy", join(claudeSkills, "forge-legacy", "SKILL.md"));
	const kept = skill("custom-helper", join(claudeSkills, "custom-helper", "SKILL.md"));

	const result = makeSkillsShadowOverride({ cwd, gsdHome: join(cwd, ".gsd") })(resource([leaked, kept]));

	deepStrictEqual(result.skills, [kept]);
	strictEqual(result.diagnostics.length, 1);
	strictEqual(result.diagnostics[0]?.message, "Shadowed 1 forge/gsd skill from Claude directories.");
});

test("drops gsd skills from a project Claude directory", () => {
	const cwd = mkdtempSync(join(tmpdir(), "skills-shadow-gsd-"));
	const filePath = join(cwd, ".claude", "skills", "gsd-legacy", "SKILL.md");
	const result = makeSkillsShadowOverride({ cwd, gsdHome: join(cwd, ".gsd") })(resource([skill("gsd-legacy", filePath)]));

	strictEqual(result.skills.length, 0);
	strictEqual(result.diagnostics[0]?.message.includes("1 forge/gsd skill"), true);
});

test("keeps bundled forge and gsd skills", () => {
	const cwd = mkdtempSync(join(tmpdir(), "skills-shadow-bundled-"));
	const bundled = skill("forge-bundled", join(cwd, ".gsd", "agent", "skills", "forge-bundled", "SKILL.md"));
	const result = makeSkillsShadowOverride({ cwd, gsdHome: join(cwd, ".gsd") })(resource([bundled]));

	strictEqual(result.skills[0], bundled);
	strictEqual(result.diagnostics.length, 0);
});

test("requires both a legacy prefix and a Claude origin", () => {
	const claudeDir = "/tmp/project/.claude/skills";
	const forgeOutside = skill("forge-valid", "/tmp/project/.gsd/skills/forge-valid/SKILL.md");
	const regularClaude = skill("team-helper", join(claudeDir, "team-helper", "SKILL.md"));
	const similarlyNamed = skill("forge-valid", "/tmp/project-not-claude/skills/forge-valid/SKILL.md");

	strictEqual(isShadowedSkill(forgeOutside, [claudeDir]), false);
	strictEqual(isShadowedSkill(regularClaude, [claudeDir]), false);
	strictEqual(isShadowedSkill(similarlyNamed, [claudeDir]), false);
});

test("returns the original resource when there is no match", () => {
	const cwd = mkdtempSync(join(tmpdir(), "skills-shadow-empty-"));
	const base = resource([skill("custom", join(cwd, ".claude", "skills", "custom", "SKILL.md"))]);
	const result = makeSkillsShadowOverride({ cwd, gsdHome: join(cwd, ".gsd") })(base);

	strictEqual(result, base);
	strictEqual(result.skills, base.skills);
	strictEqual(result.diagnostics, base.diagnostics);
});

test("path boundary does not treat a sibling directory as Claude", () => {
	const claudeDir = "/tmp/repo/.claude/skills";
	const sibling = skill("gsd-sibling", "/tmp/repo/.claude/skills-copy/gsd-sibling/SKILL.md");

	strictEqual(isShadowedSkill(sibling, [claudeDir]), false);
});
