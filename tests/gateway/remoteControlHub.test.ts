import { describe, expect, it, vi } from "vitest";
import { RemoteControlHub } from "../../src/gateway/remoteControlHub.js";

describe("RemoteControlHub", () => {
  it("replaces stock disabled status and broadcasts relay changes", () => {
    const hub = new RemoteControlHub();
    const first = vi.fn();
    const second = vi.fn();
    const connecting = {
      status: "connecting" as const,
      serverName: "test-host",
      installationId: "installation",
      environmentId: null,
    };
    const connected = { ...connecting, status: "connected" as const, environmentId: "environment" };
    hub.update(connecting);
    hub.intercept("one", first, { status: "disabled" });
    hub.intercept("two", second, { status: "disabled" });
    expect(first).toHaveBeenLastCalledWith("remoteControl/status/changed", connecting);
    expect(second).toHaveBeenLastCalledWith("remoteControl/status/changed", connecting);
    hub.update(connected);
    expect(first).toHaveBeenLastCalledWith("remoteControl/status/changed", connected);
    expect(second).toHaveBeenLastCalledWith("remoteControl/status/changed", connected);
    hub.detach("one");
    hub.update(connecting);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(3);
  });

  it("adopts the stock identity only until relay status becomes authoritative", () => {
    const hub = new RemoteControlHub();
    const sink = vi.fn();
    const disabled = {
      status: "disabled" as const,
      serverName: "test-host",
      installationId: "installation",
      environmentId: null,
    };
    hub.intercept("one", sink, disabled);
    expect(hub.current()).toEqual(disabled);

    const connected = { ...disabled, status: "connected" as const, environmentId: "environment" };
    hub.update(connected);
    hub.intercept("two", sink, { ...disabled, installationId: "stock-must-not-win" });
    expect(hub.current()).toEqual(connected);
  });
});
