import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGestations } from "../state/gestation.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "forge-gestation-"));
  directories.push(directory);
  return directory;
}

function milestoneDir(cwd: string, id: string): string {
  const directory = join(cwd, ".gsd", "milestones", id);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeContext(cwd: string, id: string, content = "# Context\n"): void {
  writeFileSync(join(milestoneDir(cwd, id), `${id}-CONTEXT.md`), content);
}

describe("listGestations", () => {
  test("lists a non-empty CONTEXT without ROADMAP using absolute paths", () => {
    const cwd = fixture();
    const id = "M-20260712220520-born";
    writeContext(cwd, id);

    assert.deepEqual(listGestations(cwd), [{ milestoneId: id, contextPath: join(cwd, ".gsd", "milestones", id, `${id}-CONTEXT.md`) }]);
  });

  test("omits already planned, request-only, empty, and whitespace-only milestones", () => {
    const cwd = fixture();
    const planned = "M-20260712220520-planned";
    writeContext(cwd, planned);
    writeFileSync(join(milestoneDir(cwd, planned), `${planned}-ROADMAP.md`), "# Roadmap\n");

    const requestOnly = "M-20260712220521-request";
    writeFileSync(join(milestoneDir(cwd, requestOnly), `${requestOnly}-REQUEST.md`), "request\n");
    writeContext(cwd, "M-20260712220522-empty", "");
    writeContext(cwd, "M-20260712220523-blank", " \n\t\n");

    assert.deepEqual(listGestations(cwd), []);
  });

  test("sorts gestations by descending milestone name and ignores REQUEST alongside CONTEXT", () => {
    const cwd = fixture();
    const older = "M-20260712220520-older";
    const newer = "M-20260712220521-newer";
    writeContext(cwd, older);
    writeContext(cwd, newer);
    writeFileSync(join(milestoneDir(cwd, newer), `${newer}-REQUEST.md`), "original request\n");

    assert.deepEqual(listGestations(cwd).map((entry) => entry.milestoneId), [newer, older]);
  });

  test("returns an empty list without throwing when .gsd or milestones is absent", () => {
    const withoutGsd = fixture();
    const withoutMilestones = fixture();
    mkdirSync(join(withoutMilestones, ".gsd"));

    assert.doesNotThrow(() => listGestations(withoutGsd));
    assert.deepEqual(listGestations(withoutGsd), []);
    assert.doesNotThrow(() => listGestations(withoutMilestones));
    assert.deepEqual(listGestations(withoutMilestones), []);
  });

  test("ignores files, names outside the milestone grammar, and unreadable CONTEXT entries", () => {
    const cwd = fixture();
    const milestones = join(cwd, ".gsd", "milestones");
    mkdirSync(milestones, { recursive: true });
    writeFileSync(join(milestones, "M-20260712220520-file"), "not a directory\n");
    writeContext(cwd, "not-a-milestone");

    const unreadable = "M-20260712220520-unreadable";
    mkdirSync(join(milestoneDir(cwd, unreadable), `${unreadable}-CONTEXT.md`));

    assert.doesNotThrow(() => listGestations(cwd));
    assert.deepEqual(listGestations(cwd), []);
  });
});
