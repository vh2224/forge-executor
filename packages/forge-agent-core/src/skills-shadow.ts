import path from "node:path";
import type { ResourceDiagnostic } from "@gsd/pi-coding-agent/core/resource-loader.js";
import type { Skill } from "@gsd/pi-coding-agent/core/skills.js";
import { getSkillDirectories } from "@gsd/pi-coding-agent/core/skill-directories.js";

const SHADOWED_SKILL_NAME = /^(forge|gsd)-/;

type SkillsResource = {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
};

export interface SkillsShadowOptions {
	cwd: string;
	gsdHome: string;
}

function isWithinDirectory(filePath: string, directory: string): boolean {
	const resolvedFile = path.resolve(filePath);
	const resolvedDirectory = path.resolve(directory);
	return resolvedFile.startsWith(`${resolvedDirectory}${path.sep}`);
}

/** Return whether a skill is a leaked 1.0 skill from a Claude directory. */
export function isShadowedSkill(skill: Skill, claudeDirs: string[]): boolean {
	return (
		SHADOWED_SKILL_NAME.test(skill.name) &&
		claudeDirs.some((directory) => isWithinDirectory(skill.filePath, directory))
	);
}

/**
 * Build the ResourceLoader transform that hides only legacy Forge/GSD skills
 * loaded from Claude directories. Bundled Forge skills remain available.
 */
export function makeSkillsShadowOverride({ cwd, gsdHome }: SkillsShadowOptions) {
	const claudeDirs = getSkillDirectories({ cwd, gsdHome })
		.filter((entry) => entry.kind === "claude-project" || entry.kind === "claude-user")
		.map((entry) => entry.path);

	return (base: SkillsResource): SkillsResource => {
		const shadowed = base.skills.filter((skill) => isShadowedSkill(skill, claudeDirs));
		if (shadowed.length === 0) return base;

		const shadowedCount = shadowed.length;
		const diagnostics: ResourceDiagnostic = {
			type: "warning",
			message: `Shadowed ${shadowedCount} forge/gsd skill${shadowedCount === 1 ? "" : "s"} from Claude directories.`,
		};
		return {
			skills: base.skills.filter((skill) => !isShadowedSkill(skill, claudeDirs)),
			diagnostics: [...base.diagnostics, diagnostics],
		};
	};
}
