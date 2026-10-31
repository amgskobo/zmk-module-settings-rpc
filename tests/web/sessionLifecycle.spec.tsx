import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { call_rpc } from "@zmkfirmware/zmk-studio-ts-client";
import {
  ActivitySettings,
  SUBSYSTEM_IDENTIFIER,
} from "../../web/src/ActivitySettings";
import {
  Request,
  Response,
  Notification,
} from "../../web/src/proto/zmk/settings/core";

jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({ call_rpc: jest.fn() }));
function app(identifiers = [SUBSYSTEM_IDENTIFIER, "fixture"]) {
  return createConnectedMockZMKApp({
    subsystems: identifiers,
    deviceName: "Fixture Device",
  });
}
function panel(
  value: ReturnType<typeof app>,
  strict = false,
  autoFetch = false,
) {
  const node = (
    <ZMKAppProvider value={value}>
      <ActivitySettings autoFetch={autoFetch} />
    </ZMKAppProvider>
  );
  return strict ? <StrictMode>{node}</StrictMode> : node;
}
function replacement(old: ReturnType<typeof app>, change: string) {
  const next = app(
    change === "index"
      ? ["fixture", SUBSYSTEM_IDENTIFIER]
      : change === "catalog"
        ? [SUBSYSTEM_IDENTIFIER, "replacement"]
        : undefined,
  );
  if (change !== "connection") next.state.connection = old.state.connection;
  return next;
}
function wire(value: Parameters<typeof Response.create>[0]) {
  return {
    custom: {
      call: { payload: Response.encode(Response.create(value)).finish() },
    },
  };
}
const success = () => wire({ setActivitySettings: { success: true } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  await act(async () => {
    for (let n = 0; n < 32; n++) await Promise.resolve();
  });
}
function notify(
  value: ReturnType<typeof app>,
  source: number,
  idleMs: number,
  sleepMs = 60000,
) {
  const registration = (value.onNotification as jest.Mock).mock.calls.at(
    -1,
  )![0];
  registration.callback({
    payload: Notification.encode(
      Notification.create({
        activitySettings: { settings: { source, idleMs, sleepMs } },
      }),
    ).finish(),
  });
}
function draft(idle = "1234", sleep = "60000") {
  fireEvent.change(screen.getByLabelText(/Idle Timeout/), {
    target: { value: idle },
  });
  fireEvent.change(screen.getByLabelText(/Sleep Timeout/), {
    target: { value: sleep },
  });
}
function save() {
  fireEvent.click(screen.getByRole("button", { name: /Save Settings/ }));
}
function requests() {
  return (call_rpc as jest.Mock).mock.calls.map((call) =>
    Request.decode(call[1].custom.call.payload),
  );
}
function noTimers() {
  jest.runAllTicks();
  expect(jest.getTimerCount()).toBe(0);
}

describe("Activity editor session lifetime", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    (call_rpc as jest.Mock).mockImplementation((_connection, raw) => {
      const req = Request.decode(raw.custom.call.payload);
      return Promise.resolve(
        req.getAllActivitySettings
          ? wire({ getAllActivitySettings: { requestSent: true } })
          : success(),
      );
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each(["connection", "index", "catalog"])(
    "resets the form and retires a pending save on %s replacement",
    async (change) => {
      const old = app();
      const view = render(panel(old));
      const pending = deferred<ReturnType<typeof success>>();
      (call_rpc as jest.Mock).mockReturnValueOnce(pending.promise);
      draft();
      save();
      await flush();
      expect(requests().filter((r) => r.setActivitySettings)).toHaveLength(1);
      view.rerender(panel(replacement(old, change)));
      await flush();
      expect(screen.getByLabelText(/Idle Timeout/)).toHaveValue(0);
      expect(
        screen.getByRole("button", { name: /Save Settings/ }),
      ).toBeEnabled();
      await act(async () => {
        pending.resolve(success());
      });
      await flush();
      expect(
        screen.queryByText(/Settings updated successfully/),
      ).not.toBeInTheDocument();
    },
  );
  it.each(["connection", "index", "catalog"])(
    "retires a scheduled synchronization refresh on %s replacement",
    async (change) => {
      const old = app();
      const view = render(panel(old));
      act(() => {
        notify(old, 0, 10);
        notify(old, 1, 11);
      });
      fireEvent.click(screen.getByRole("button", { name: /Sync All Devices/ }));
      await flush();
      expect(requests()).toHaveLength(1);
      view.rerender(panel(replacement(old, change)));
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      await flush();
      expect(requests()).toHaveLength(1);
    },
  );
  it("clears the deadline of an unresolved request on unmount", async () => {
    (call_rpc as jest.Mock).mockReturnValue(new Promise(() => {}));
    const view = render(panel(app()));
    draft();
    save();
    await flush();
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    await flush();
    noTimers();
  });
  it("clears the deadline after a successful request", async () => {
    render(panel(app()));
    draft();
    save();
    await flush();
    expect(
      screen.getByText(/Settings updated successfully/),
    ).toBeInTheDocument();
    noTimers();
  });
  it("reports the five-second deadline and restores current controls", async () => {
    (call_rpc as jest.Mock).mockReturnValue(new Promise(() => {}));
    render(panel(app()));
    draft();
    save();
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await flush();
    expect(screen.getByText(/timed out/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Settings/ })).toBeEnabled();
    noTimers();
  });
  it("keeps unsaved edits while late reports update the reported device values", async () => {
    const current = app();
    render(panel(current));
    act(() => {
      notify(current, 0, 10);
    });
    draft();
    act(() => {
      notify(current, 0, 77, 120000);
      notify(current, 1, 78, 120000);
    });
    expect(screen.getByLabelText(/Idle Timeout/)).toHaveValue(1234);
    expect(screen.getByLabelText(/Sleep Timeout/)).toHaveValue(60000);
    expect(screen.getAllByRole("listitem").map((n) => n.textContent)).toContain(
      "Central: Idle 77ms, Sleep 120000ms",
    );
    expect(screen.getByText(/Settings mismatch detected/)).toBeInTheDocument();
  });
  it.each(["", "-1", "1.5"])(
    "does not replace invalid draft %p with a delayed report and send it",
    async (value) => {
      const current = app();
      render(panel(current));
      draft(value);
      act(() => {
        notify(current, 0, 42);
      });
      save();
      await flush();
      expect(
        screen.getByText(/whole numbers from 0 to 4294967295/),
      ).toBeInTheDocument();
      expect(requests()).toHaveLength(0);
    },
  );
  it("lets an explicit refresh replace the draft with new reports", async () => {
    const current = app();
    render(panel(current));
    draft();
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await flush();
    act(() => {
      notify(current, 0, 99, 120000);
    });
    expect(screen.getByLabelText(/Idle Timeout/)).toHaveValue(99);
    expect(screen.getByLabelText(/Sleep Timeout/)).toHaveValue(120000);
  });
  it("retains current edits across an unrelated provider update", async () => {
    const current = app();
    const view = render(panel(current));
    draft();
    view.rerender(panel({ ...current }));
    await flush();
    expect(screen.getByLabelText(/Idle Timeout/)).toHaveValue(1234);
    expect(requests()).toHaveLength(0);
  });
  it("starts one automatic refresh under StrictMode replay", async () => {
    render(panel(app(), true, true));
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    await flush();
    expect(requests().filter((r) => r.getAllActivitySettings)).toHaveLength(1);
  });
  it.each([
    "reject-error",
    "throw-error",
    "reject-undefined",
    "reject-null",
    "reject-false",
  ])(
    "clears the deadline and keeps rejection semantics for %s",
    async (failure) => {
      const named = failure.endsWith("error");
      const error = named
        ? new Error("Fixture transport failure")
        : failure.endsWith("null")
          ? null
          : failure.endsWith("false")
            ? false
            : undefined;
      (call_rpc as jest.Mock).mockImplementationOnce(() => {
        if (failure.startsWith("throw")) throw error;
        return Promise.reject(error);
      });
      render(panel(app()));
      draft();
      save();
      await flush();
      expect(
        screen.getByText(named ? /Fixture transport failure/ : /Unknown error/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Save Settings/ }),
      ).toBeEnabled();
      noTimers();
    },
  );
});
