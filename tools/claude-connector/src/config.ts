// Runtime configuration, read once from the environment. The LaunchAgent
// (launchd/install.sh) sets every value; nothing here is a secret.
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  /** Local listen address. Only Tailscale Funnel reaches it from outside. */
  host: string
  port: number
  /**
   * Public origin claude.ai talks to: Tailscale Funnel on port 443 of this
   * MacBook, where the connector paths sit beside the Multica web app.
   * claude.ai does not reach connectors on 8443 (see README "Erreichbarkeit").
   */
  publicUrl: string
  /** Multica API as seen from this machine. */
  multicaUrl: string
  workspaceId: string
  /** The only Multica account that may connect. Login codes go to this address. */
  allowedEmail: string
  allowedUserId: string
  dbPath: string
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim()
  if (!v) throw new Error(`${key} fehlt`)
  return v
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.CONNECTOR_HOST?.trim() || '127.0.0.1',
    port: Number(env.CONNECTOR_PORT ?? 8791),
    publicUrl: required(env, 'CONNECTOR_PUBLIC_URL').replace(/\/+$/, ''),
    multicaUrl: (env.MULTICA_API_URL?.trim() || 'http://localhost:8080').replace(/\/+$/, ''),
    workspaceId: required(env, 'MULTICA_WORKSPACE_ID'),
    allowedEmail: required(env, 'CONNECTOR_ALLOWED_EMAIL').toLowerCase(),
    allowedUserId: required(env, 'CONNECTOR_ALLOWED_USER_ID'),
    dbPath: env.CONNECTOR_DB?.trim() || join(homedir(), '.local/state/multica-claude-connector/connector.db'),
  }
}
