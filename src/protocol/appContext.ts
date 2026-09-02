const appContext = /<app-context>[\s\S]*?<\/app-context>/gu;

export function withoutAppContext(value: string | null | undefined): string | null {
  return value?.replace(appContext, "").trim() || null;
}
