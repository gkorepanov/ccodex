import { describe, expect, it, vi } from "vitest";
import { RemoteControlController } from "../../src/gateway/remoteControlController.js";

const status = {
  status: "connected" as const,
  serverName: "ccodex-lab",
  installationId: "installation",
  environmentId: "environment",
};

function harness(initiallyEnabled = false) {
  const stop = vi.fn(async () => undefined);
  const start = vi.fn(async (_socket, hub) => {
    hub.update(status);
    return { child: {} as never, stop };
  });
  const persist = vi.fn();
  const controller = new RemoteControlController(
    "/tmp/ccodex.sock",
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    initiallyEnabled,
    start,
    persist,
  );
  return { controller, start, stop, persist };
}

describe("RemoteControlController", () => {
  it("starts the gateway relay once and persists only durable App changes", async () => {
    const { controller, start, stop, persist } = harness();

    expect(await controller.enable(false)).toEqual(status);
    expect(await controller.enable(true)).toEqual(status);
    expect(start).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(true);

    expect(await controller.disable(true)).toEqual({ ...status, status: "disabled", environmentId: null });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("serializes racing enable and disable transitions", async () => {
    const { controller, start, stop, persist } = harness();
    const enabled = controller.enable(false);
    const disabled = controller.disable(false);

    await expect(enabled).resolves.toEqual(status);
    await expect(disabled).resolves.toMatchObject({ status: "disabled" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls).toEqual([[true], [false]]);
  });

  it("honors the persisted startup preference without rewriting it", async () => {
    const { controller, start, persist } = harness(true);
    await controller.start();
    await controller.start();

    expect(start).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });
});
