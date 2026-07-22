export function claudeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  delete environment.CCODEX_SHIM_ACTIVE;
  return environment;
}
