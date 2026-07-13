import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const forgeHomeDir = join(homedir(), '.forge')
const gsdHomeDir = join(homedir(), '.gsd')

export const appRoot =
  process.env.FORGE_HOME ||
  process.env.GSD_HOME ||
  (existsSync(forgeHomeDir) ? forgeHomeDir : existsSync(gsdHomeDir) ? gsdHomeDir : forgeHomeDir)
export const agentDir = join(appRoot, 'agent')

// Unify the pi-side agent dir with the fork's (fix batch pos-M6, 3rd dual-dir
// incident): pi's `getAgentDir()` honors GSD_CODING_AGENT_DIR and otherwise
// defaults to ~/.gsd/agent — while the fork lives here. Without this, pi-path
// consumers (getAuthPath → /forge accounts writes, getModelsPath → models.json)
// silently target the WRONG directory. Set at module init so every later
// `getAgentDir()` call agrees; an explicit operator env still wins.
if (!process.env.GSD_CODING_AGENT_DIR) process.env.GSD_CODING_AGENT_DIR = agentDir
export const sessionsDir = join(appRoot, 'sessions')
export const authFilePath = join(agentDir, 'auth.json')
export const webPidFilePath = join(appRoot, 'web-server.pid')
export const webPreferencesPath = join(appRoot, 'web-preferences.json')
