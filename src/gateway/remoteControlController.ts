import type { RemoteControlStatusChangedNotification } from "../codex/generated/v2/RemoteControlStatusChangedNotification.js";
import type { Logger } from "../observability/logger.js";
import { saveDaemonSettings } from "../daemon/settings.js";
import { RemoteControlHub } from "./remoteControlHub.js";
import { startRemoteRelay, type RemoteRelay } from "./remoteRelay.js";

type Sink = (method: string, params: unknown) => void;
type StartRelay = (socketPath: string, hub: RemoteControlHub, logger: Logger) => Promise<RemoteRelay>;

export class RemoteControlController {
  private readonly hub = new RemoteControlHub();
  private relay: RemoteRelay | undefined;
  private operations = Promise.resolve();

  public constructor(
    private readonly socketPath: string,
    private readonly logger: Logger,
    private readonly initiallyEnabled: boolean,
    private readonly startRelay: StartRelay = startRemoteRelay,
    private readonly persist = (enabled: boolean) => saveDaemonSettings({ remoteControlEnabled: enabled }),
  ) {}

  public start(): Promise<void> {
    return this.initiallyEnabled ? this.serial(async () => { await this.startIfNeeded(); }) : Promise.resolve();
  }

  public enable(ephemeral: boolean): Promise<RemoteControlStatusChangedNotification> {
    return this.serial(async () => {
      await this.startIfNeeded();
      if (!ephemeral) this.persist(true);
      return this.requiredStatus();
    });
  }

  public disable(ephemeral: boolean): Promise<RemoteControlStatusChangedNotification> {
    return this.serial(async () => {
      await this.stopIfNeeded();
      if (!ephemeral) this.persist(false);
      const current = this.requiredStatus();
      const disabled = { ...current, status: "disabled" as const, environmentId: null };
      this.hub.update(disabled);
      return disabled;
    });
  }

  public current(): RemoteControlStatusChangedNotification | undefined {
    return this.hub.current();
  }

  public intercept(connectionId: string, sink: Sink, fallback: unknown): void {
    this.hub.intercept(connectionId, sink, fallback);
  }

  public detach(connectionId: string): void {
    this.hub.detach(connectionId);
  }

  public stop(): Promise<void> {
    return this.serial(async () => { await this.stopIfNeeded(); });
  }

  private requiredStatus(): RemoteControlStatusChangedNotification {
    const status = this.hub.current();
    if (!status) throw new Error("Remote-control identity is not available yet.");
    return status;
  }

  private async startIfNeeded(): Promise<void> {
    if (this.relay) return;
    this.relay = await this.startRelay(this.socketPath, this.hub, this.logger);
  }

  private async stopIfNeeded(): Promise<void> {
    const relay = this.relay;
    if (!relay) return;
    this.relay = undefined;
    await relay.stop();
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
}
