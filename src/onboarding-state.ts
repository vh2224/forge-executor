// Onboarding completion record (~/.gsd/agent/onboarding.json)
//
// Minimal harness-core persistence shim for the first-run onboarding wizard.
// Fresh implementation (not copied from the condemned gsd extension) — records
// which onboarding steps were completed/skipped and whether the wizard finished,
// so shouldRunOnboarding() and re-entry all read one source of truth.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { agentDir } from './app-paths.js'

/**
 * Bump `FLOW_VERSION` whenever a new required onboarding step is added.
 * A record written under an older flowVersion is treated as incomplete by
 * isOnboardingComplete(), triggering a fresh run.
 */
export const FLOW_VERSION = 1
const RECORD_VERSION = 1

const FILE = join(agentDir, 'onboarding.json')

export interface OnboardingRecord {
  version: number
  flowVersion: number
  completedAt: string | null
  completedSteps: string[]
  skippedSteps: string[]
}

const DEFAULT: OnboardingRecord = {
  version: RECORD_VERSION,
  flowVersion: FLOW_VERSION,
  completedAt: null,
  completedSteps: [],
  skippedSteps: [],
}

function readRecord(): OnboardingRecord {
  if (!existsSync(FILE)) return { ...DEFAULT }
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf-8')) as Partial<OnboardingRecord>
    return {
      version: typeof raw.version === 'number' ? raw.version : RECORD_VERSION,
      flowVersion: typeof raw.flowVersion === 'number' ? raw.flowVersion : 0,
      completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
      completedSteps: Array.isArray(raw.completedSteps) ? raw.completedSteps.filter((s): s is string => typeof s === 'string') : [],
      skippedSteps: Array.isArray(raw.skippedSteps) ? raw.skippedSteps.filter((s): s is string => typeof s === 'string') : [],
    }
  } catch {
    // Corrupt file — treat as no record so onboarding can run cleanly.
    return { ...DEFAULT }
  }
}

function writeRecord(record: OnboardingRecord): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify(record, null, 2), 'utf-8')
  } catch {
    // Non-fatal: persistence is best-effort; boot never crashes on this.
  }
}

/** True once the wizard has finished under the current FLOW_VERSION. */
export function isOnboardingComplete(): boolean {
  const record = readRecord()
  return record.completedAt !== null && record.flowVersion === FLOW_VERSION
}

/** Record a step as completed (idempotent; also clears it from skipped). */
export function markStepCompleted(stepId: string): void {
  const record = readRecord()
  if (!record.completedSteps.includes(stepId)) record.completedSteps.push(stepId)
  record.skippedSteps = record.skippedSteps.filter((s) => s !== stepId)
  writeRecord(record)
}

/** Record a step as skipped (idempotent; ignored if already completed). */
export function markStepSkipped(stepId: string): void {
  const record = readRecord()
  if (record.completedSteps.includes(stepId)) return
  if (!record.skippedSteps.includes(stepId)) record.skippedSteps.push(stepId)
  writeRecord(record)
}

/** Mark the whole wizard as finished, stamping the current FLOW_VERSION. */
export function markOnboardingComplete(completedSteps: string[]): void {
  const record = readRecord()
  for (const step of completedSteps) {
    if (!record.completedSteps.includes(step)) record.completedSteps.push(step)
  }
  record.completedAt = new Date().toISOString()
  record.flowVersion = FLOW_VERSION
  record.version = RECORD_VERSION
  writeRecord(record)
}
