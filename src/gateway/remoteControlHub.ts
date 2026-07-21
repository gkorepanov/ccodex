import type { RemoteControlStatusChangedNotification } from "../codex/generated/v2/RemoteControlStatusChangedNotification.js";

type Sink = (method: string, params: unknown) => void;

export class RemoteControlHub {
  private readonly sinks = new Map<string, Sink>();
  private status?: RemoteControlStatusChangedNotification;

  public update(status: RemoteControlStatusChangedNotification): void {
    this.status = status;
    for (const sink of this.sinks.values()) sink("remoteControl/status/changed", status);
  }

  public intercept(connectionId: string, sink: Sink, fallback: unknown): void {
    this.sinks.set(connectionId, sink);
    sink("remoteControl/status/changed", this.status ?? fallback);
  }

  public current(): RemoteControlStatusChangedNotification | undefined {
    return this.status;
  }

  public detach(connectionId: string): void {
    this.sinks.delete(connectionId);
  }
}
