/**
 * Tests for ActivitySettings component
 *
 * This test demonstrates how to use react-zmk-studio test helpers to test
 * components that interact with ZMK devices.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SettingsRpcClient as ZMKCustomSubsystem } from "../../web/src/settingsRpc";
import {
  Request,
  Response,
  Notification,
} from "../../web/src/proto/zmk/settings/core";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import {
  ActivitySettings,
  SUBSYSTEM_IDENTIFIER,
} from "../../web/src/ActivitySettings";

describe("ActivitySettings Component", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const connectedView = () => {
    const app = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    const rpc = jest
      .spyOn(ZMKCustomSubsystem.prototype, "callRPC")
      .mockResolvedValue(
        Response.encode(
          Response.create({ setActivitySettings: { success: true } }),
        ).finish(),
      );
    render(
      <ZMKAppProvider value={app}>
        <ActivitySettings autoFetch={false} />
      </ZMKAppProvider>,
    );
    return { app, rpc };
  };

  const setterOk = () =>
    Response.encode(
      Response.create({ setActivitySettings: { success: true } }),
    ).finish();
  const report = (
    callback: (value: unknown) => void,
    source: number,
    idleMs: number,
  ) => {
    callback({
      payload: Notification.encode(
        Notification.create({
          activitySettings: { settings: { source, idleMs, sleepMs: 2000 } },
        }),
      ).finish(),
    });
  };

  it("ignores a setter response from the previous connection", async () => {
    const first = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    const next = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    let finish!: (value: Uint8Array) => void;
    jest.spyOn(ZMKCustomSubsystem.prototype, "callRPC").mockReturnValueOnce(
      new Promise<Uint8Array>((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(
      <ZMKAppProvider value={first}>
        <ActivitySettings autoFetch={false} />
      </ZMKAppProvider>,
    );
    fireEvent.change(screen.getByLabelText(/Idle Timeout/), {
      target: { value: "1234" },
    });
    fireEvent.click(screen.getByText(/Save Settings/));
    view.rerender(
      <ZMKAppProvider value={next}>
        <ActivitySettings autoFetch={false} />
      </ZMKAppProvider>,
    );
    await act(async () => {
      finish(setterOk());
    });
    expect(
      screen.queryByText(/Settings updated successfully/),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Idle Timeout/)).toHaveValue(0);
    expect(screen.getByText(/Save Settings/)).toBeEnabled();
  });

  it("ignores an already queued notification from the previous connection", () => {
    const first = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    const next = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    const view = render(
      <ZMKAppProvider value={first}>
        <ActivitySettings autoFetch={false} />
      </ZMKAppProvider>,
    );
    const oldCallback = (first.onNotification as jest.Mock).mock.calls[0][0]
      .callback;
    act(() => {
      report(oldCallback, 0, 1234);
    });
    view.rerender(
      <ZMKAppProvider value={next}>
        <ActivitySettings autoFetch={false} />
      </ZMKAppProvider>,
    );
    act(() => {
      report(oldCallback, 0, 7777);
    });
    expect(screen.getByLabelText(/Idle Timeout/)).toHaveValue(0);
  });

  it("keeps the current setter pending when an old connection rejects", async () => {
    const first = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    const next = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    let rejectOld!: (value: Error) => void;
    let finishNew!: (value: Uint8Array) => void;
    jest
      .spyOn(ZMKCustomSubsystem.prototype, "callRPC")
      .mockReturnValueOnce(
        new Promise<Uint8Array>((_, reject) => {
          rejectOld = reject;
        }),
      )
      .mockReturnValueOnce(
        new Promise<Uint8Array>((resolve) => {
          finishNew = resolve;
        }),
      );
    const view = render(
      <ZMKAppProvider value={first}>
        <ActivitySettings autoFetch={false} />
      </ZMKAppProvider>,
    );
    fireEvent.click(screen.getByText(/Save Settings/));
    view.rerender(
      <ZMKAppProvider value={next}>
        <ActivitySettings autoFetch={false} />
      </ZMKAppProvider>,
    );
    fireEvent.click(screen.getByText(/Save Settings/));
    await act(async () => {
      rejectOld(new Error("old connection closed"));
    });
    expect(screen.getByRole("button", { name: /Updating/ })).toBeDisabled();
    expect(screen.queryByText(/old connection closed/)).not.toBeInTheDocument();
    await act(async () => {
      finishNew(setterOk());
    });
    expect(screen.getByText(/Save Settings/)).toBeEnabled();
    expect(
      screen.getByText(/Settings updated successfully/),
    ).toBeInTheDocument();
  });

  it("keeps mismatched reports visible after the central accepts synchronization", async () => {
    jest.useFakeTimers();
    const { app } = connectedView();
    const callback = (app.onNotification as jest.Mock).mock.calls[0][0]
      .callback;
    act(() => {
      report(callback, 0, 1000);
      report(callback, 1, 1001);
    });
    fireEvent.click(screen.getByText(/Sync All Devices/));
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.queryByText(/synchronized across all devices/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Settings mismatch detected/)).toBeInTheDocument();
    expect(screen.getByText(/refreshing device reports/i)).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(screen.getByText(/Settings mismatch detected/)).toBeInTheDocument();
    act(() => {
      report(callback, 1, 1000);
    });
    expect(
      screen.queryByText(/Settings mismatch detected/),
    ).not.toBeInTheDocument();
  });

  it("cancels delayed synchronization refresh when the connection changes", async () => {
    jest.useFakeTimers();
    const first = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    const next = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    const rpc = jest
      .spyOn(ZMKCustomSubsystem.prototype, "callRPC")
      .mockResolvedValue(setterOk());
    const view = render(
      <ZMKAppProvider value={first}>
        <ActivitySettings autoFetch={false} />
      </ZMKAppProvider>,
    );
    const callback = (first.onNotification as jest.Mock).mock.calls[0][0]
      .callback;
    act(() => {
      report(callback, 0, 1000);
      report(callback, 1, 1001);
    });
    fireEvent.click(screen.getByText(/Sync All Devices/));
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(
      <ZMKAppProvider value={next}>
        <ActivitySettings autoFetch={false} />
      </ZMKAppProvider>,
    );
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("cancels delayed synchronization refresh on unmount", async () => {
    jest.useFakeTimers();
    const first = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    const rpc = jest
      .spyOn(ZMKCustomSubsystem.prototype, "callRPC")
      .mockResolvedValue(setterOk());
    const view = render(
      <ZMKAppProvider value={first}>
        <ActivitySettings autoFetch={false} />
      </ZMKAppProvider>,
    );
    const callback = (first.onNotification as jest.Mock).mock.calls[0][0]
      .callback;
    act(() => {
      report(callback, 0, 1000);
      report(callback, 1, 1001);
    });
    fireEvent.click(screen.getByText(/Sync All Devices/));
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount();
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each(["-1", "4294967296", "1.5", "", "1e3"])(
    "rejects invalid unsigned decimal timeout %p before any RPC",
    async (value) => {
      const { rpc } = connectedView();
      fireEvent.change(screen.getByLabelText(/Idle Timeout/), {
        target: { value },
      });
      fireEvent.click(screen.getByText(/Save Settings/));
      await waitFor(() =>
        expect(
          screen.getByText(/whole numbers from 0 to 4294967295/),
        ).toBeInTheDocument(),
      );
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("validates the sleep field independently", async () => {
    const { rpc } = connectedView();
    fireEvent.change(screen.getByLabelText(/Sleep Timeout/), {
      target: { value: "-1" },
    });
    fireEvent.click(screen.getByText(/Save Settings/));
    await waitFor(() =>
      expect(
        screen.getByText(/whole numbers from 0 to 4294967295/),
      ).toBeInTheDocument(),
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("preserves both uint32 endpoints through the actual protobuf encoder", async () => {
    const { rpc } = connectedView();
    fireEvent.change(screen.getByLabelText(/Idle Timeout/), {
      target: { value: "4294967295" },
    });
    fireEvent.change(screen.getByLabelText(/Sleep Timeout/), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByText(/Save Settings/));
    await waitFor(() =>
      expect(
        screen.getByText(/Settings updated successfully/),
      ).toBeInTheDocument(),
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(
      Request.decode(rpc.mock.calls[0][0]).setActivitySettings?.settings,
    ).toMatchObject({ idleMs: 4294967295, sleepMs: 0 });
  });

  it("validates edits before syncing settings received through notifications", async () => {
    const { app, rpc } = connectedView();
    const registration = (app.onNotification as jest.Mock).mock.calls[0][0];
    act(() => {
      for (const source of [0, 1]) {
        registration.callback({
          payload: Notification.encode(
            Notification.create({
              activitySettings: {
                settings: { source, idleMs: 1000 + source, sleepMs: 2000 },
              },
            }),
          ).finish(),
        });
      }
    });
    expect(screen.getByText(/Settings mismatch detected/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Idle Timeout/), {
      target: { value: "-1" },
    });
    fireEvent.click(screen.getByText(/Sync All Devices/));
    await waitFor(() =>
      expect(
        screen.getByText(/whole numbers from 0 to 4294967295/),
      ).toBeInTheDocument(),
    );
    expect(rpc).not.toHaveBeenCalled();
  });
  describe("With Subsystem", () => {
    it("should render activity settings controls when subsystem is found", () => {
      // Create a connected mock ZMK app with the required subsystem
      const mockZMKApp = createConnectedMockZMKApp({
        deviceName: "Test Device",
        subsystems: [SUBSYSTEM_IDENTIFIER],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <ActivitySettings autoFetch={false} />
        </ZMKAppProvider>,
      );

      // Check for activity settings UI elements
      expect(
        screen.getByText(/Activity Settings \(Sleep\/Idle Timeout\)/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /Configure how long the keyboard waits before going idle or to sleep/i,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText(/Idle Timeout \(ms\):/i),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText(/Sleep Timeout \(ms\):/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/Refresh/i)).toBeInTheDocument();
      expect(screen.getByText(/Save Settings/i)).toBeInTheDocument();
    });

    it("should show default input values", () => {
      const mockZMKApp = createConnectedMockZMKApp({
        subsystems: [SUBSYSTEM_IDENTIFIER],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <ActivitySettings autoFetch={false} />
        </ZMKAppProvider>,
      );

      // Check that the inputs have default values
      const idleInput = screen.getByLabelText(
        /Idle Timeout \(ms\):/i,
      ) as HTMLInputElement;
      expect(idleInput.value).toBe("0");

      const sleepInput = screen.getByLabelText(
        /Sleep Timeout \(ms\):/i,
      ) as HTMLInputElement;
      expect(sleepInput.value).toBe("0");
    });
  });

  describe("Without Subsystem", () => {
    it("should show warning when subsystem is not found", () => {
      // Create a connected mock ZMK app without the required subsystem
      const mockZMKApp = createConnectedMockZMKApp({
        deviceName: "Test Device",
        subsystems: [], // No subsystems
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <ActivitySettings autoFetch={false} />
        </ZMKAppProvider>,
      );

      // Check for warning message
      expect(
        screen.getByText(/Subsystem "zmk__settings" not found/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /Make sure your firmware includes the settings module/i,
        ),
      ).toBeInTheDocument();
    });
  });

  describe("Without ZMKAppContext", () => {
    it("should not render when ZMKAppContext is not provided", () => {
      const { container } = render(<ActivitySettings autoFetch={false} />);

      // Component should return null when context is not available
      expect(container.firstChild).toBeNull();
    });
  });
});
