import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HybridConfig } from "../config/config.js";

const execute = promisify(execFile);

export type ProviderId = "claude" | "codex";
export type ProviderAvailabilityState = "ready" | "notAuthenticated" | "notInstalled";

export interface ProviderAvailability {
  readonly provider: ProviderId;
  readonly state: ProviderAvailabilityState;
  readonly detail?: string;
  readonly action?: string;
}

export type ProviderAvailabilityProbe = () => Promise<ProviderAvailability>;

const actions: Record<ProviderId, { readonly auth: string; readonly install: string }> = {
  claude: {
    auth: "claude auth login",
    install: "npm i -g @anthropic-ai/claude-code",
  },
  codex: {
    auth: "codex login",
    install: "npm i -g @openai/codex",
  },
};

function outputOf(value: unknown): string {
  const error = value as { stdout?: unknown; stderr?: unknown };
  return `${typeof error.stdout === "string" ? error.stdout : ""}${typeof error.stderr === "string" ? error.stderr : ""}`.trim();
}

function missingExecutable(value: unknown): boolean {
  return (value as NodeJS.ErrnoException).code === "ENOENT";
}

async function probe(
  provider: ProviderId,
  command: string,
  args: readonly string[],
  authenticated: (output: string) => boolean,
): Promise<ProviderAvailability> {
  try {
    const { stdout, stderr } = await execute(command, [...args], { timeout: 10_000, maxBuffer: 128 * 1024 });
    const detail = `${stdout}${stderr}`.trim();
    return authenticated(detail)
      ? { provider, state: "ready", ...(detail ? { detail } : {}) }
      : { provider, state: "notAuthenticated", ...(detail ? { detail } : {}), action: actions[provider].auth };
  } catch (error) {
    if (missingExecutable(error)) {
      return { provider, state: "notInstalled", detail: `Executable '${command}' was not found.`, action: actions[provider].install };
    }
    const detail = outputOf(error) || (error instanceof Error ? error.message : String(error));
    return { provider, state: "notAuthenticated", detail, action: actions[provider].auth };
  }
}

export function probeClaudeAvailability(command: string): Promise<ProviderAvailability> {
  return probe("claude", command, ["auth", "status"], (value) => {
    try {
      return (JSON.parse(value) as { loggedIn?: unknown }).loggedIn === true;
    } catch {
      return false;
    }
  });
}

export function probeCodexAvailability(command: string): Promise<ProviderAvailability> {
  return probe("codex", command, ["login", "status"], (value) =>
    /logged in/i.test(value) && !/not logged in/i.test(value));
}

export async function probeProviderAvailability(
  config: Pick<HybridConfig, "claudeBinary" | "realCodex">,
): Promise<Readonly<Record<ProviderId, ProviderAvailability>>> {
  const [claude, codex] = await Promise.all([
    probeClaudeAvailability(config.claudeBinary),
    probeCodexAvailability(config.realCodex),
  ]);
  return { claude, codex };
}

export function providerUnavailableMessage(availability: ProviderAvailability): string {
  if (availability.state === "ready") return "";
  const label = availability.provider === "claude" ? "Claude" : "Codex";
  const reason = availability.state === "notInstalled"
    ? `${label} CLI is not installed`
    : `${label} is not authenticated`;
  return `${reason}${availability.action ? `\n  ↳ \`${availability.action}\`` : ""}`;
}

export function cachedProviderAvailability(
  probeAvailability: ProviderAvailabilityProbe,
  ttlMs = 5_000,
): ProviderAvailabilityProbe {
  let cached: { readonly expiresAt: number; readonly value: ProviderAvailability } | undefined;
  let loading: Promise<ProviderAvailability> | undefined;
  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    loading ??= probeAvailability().then((value) => {
      cached = { value, expiresAt: Date.now() + ttlMs };
      return value;
    }).finally(() => {
      loading = undefined;
    });
    return loading;
  };
}

export class ProviderAvailabilityService {
  private readonly probes: Readonly<Record<ProviderId, ProviderAvailabilityProbe>>;

  public constructor(
    private readonly config: Pick<HybridConfig, "claudeBinary" | "realCodex">,
    ttlMs = 30_000,
  ) {
    this.probes = {
      claude: cachedProviderAvailability(() => probeClaudeAvailability(config.claudeBinary), ttlMs),
      codex: cachedProviderAvailability(() => probeCodexAvailability(config.realCodex), ttlMs),
    };
  }

  public read(provider: ProviderId): Promise<ProviderAvailability> {
    return this.probes[provider]();
  }

  public async all(): Promise<Readonly<Record<ProviderId, ProviderAvailability>>> {
    const [claude, codex] = await Promise.all([this.read("claude"), this.read("codex")]);
    return { claude, codex };
  }

  public refresh(provider: ProviderId): Promise<ProviderAvailability> {
    return provider === "claude"
      ? probeClaudeAvailability(this.config.claudeBinary)
      : probeCodexAvailability(this.config.realCodex);
  }

  public refreshAll(): Promise<Readonly<Record<ProviderId, ProviderAvailability>>> {
    return probeProviderAvailability(this.config);
  }
}
