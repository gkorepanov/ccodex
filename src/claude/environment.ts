/**
 * Environment for every Claude runtime CCodex starts. Operator overrides from
 * `[claude_env]` in config.toml win over the gateway's own environment, so a
 * setting like CLAUDE_AUTOCOMPACT_PCT_OVERRIDE holds even when Claude Code's
 * user settings are not the source of it.
 */
export function claudeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment = { ...source, ...overrides };
  delete environment.CCODEX_SHIM_ACTIVE;
  return environment;
}
