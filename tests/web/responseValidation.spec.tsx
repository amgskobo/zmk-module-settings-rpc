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
  Notification,
  Request,
  Response,
} from "../../web/src/proto/zmk/settings/core";

jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({ call_rpc: jest.fn() }));

type Action = "refresh" | "save" | "sync";
const payload = (value: Parameters<typeof Response.create>[0]) =>
  Response.encode(Response.create(value)).finish();
const envelope = (value: Uint8Array) => ({
  custom: { call: { payload: value } },
});
const accepted = (action: Action) =>
  payload(
    action === "refresh"
      ? { getAllActivitySettings: { requestSent: true } }
      : { setActivitySettings: { success: true } },
  );
async function flush() {
  await act(async () => {
    for (let n = 0; n < 16; n++) await Promise.resolve();
  });
}
function noTimers() {
  jest.runAllTicks();
  expect(jest.getTimerCount()).toBe(0);
}
function start(action: Action) {
  const app = createConnectedMockZMKApp({
    deviceName: "Fixture Device",
    subsystems: [SUBSYSTEM_IDENTIFIER],
  });
  render(
    <ZMKAppProvider value={app}>
      <ActivitySettings autoFetch={false} />
    </ZMKAppProvider>,
  );
  const notify = (source: number, idleMs: number) => {
    const registration = (app.onNotification as jest.Mock).mock.calls.at(
      -1,
    )![0];
    registration.callback({
      payload: Notification.encode(
        Notification.create({
          activitySettings: { settings: { source, idleMs, sleepMs: 60000 } },
        }),
      ).finish(),
    });
  };
  if (action === "sync") {
    act(() => {
      notify(0, 10);
      notify(1, 11);
    });
  }
  fireEvent.change(screen.getByLabelText(/Idle Timeout/), {
    target: { value: "1234" },
  });
  fireEvent.change(screen.getByLabelText(/Sleep Timeout/), {
    target: { value: "60000" },
  });
  const button = () =>
    screen.getByRole("button", {
      name:
        action === "refresh"
          ? /Refresh/
          : action === "save"
            ? /Save Settings/
            : /Sync All Devices/,
    });
  return { notify, button, invoke: () => fireEvent.click(button()) };
}

describe.each<Action>(["refresh", "save", "sync"])(
  "Activity response admission for %s",
  (action) => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.clearAllMocks();
      jest.spyOn(console, "error").mockImplementation(() => {});
      (call_rpc as jest.Mock).mockImplementation((_connection, raw) => {
        const request = Request.decode(raw.custom.call.payload);
        return Promise.resolve(
          envelope(
            accepted(request.getAllActivitySettings ? "refresh" : "save"),
          ),
        );
      });
    });
    afterEach(() => {
      jest.restoreAllMocks();
      jest.useRealTimers();
    });

    it.each([
      ["empty payload", new Uint8Array(), /Empty RPC response/],
      [
        "unknown response variant",
        Uint8Array.of(0x2a, 0),
        /Unexpected activity settings response/,
      ],
      [
        "wrong response variant",
        payload(
          action === "refresh"
            ? { setActivitySettings: { success: true } }
            : { getAllActivitySettings: { requestSent: true } },
        ),
        /Unexpected activity settings response/,
      ],
      [
        "negative acknowledgement",
        payload(
          action === "refresh"
            ? { getAllActivitySettings: { requestSent: false } }
            : { setActivitySettings: { success: false } },
        ),
        action === "refresh"
          ? /Settings report request refused/
          : /Failed to (update|sync) settings/,
      ],
      [
        "firmware refusal",
        payload({ error: { message: "Fixture refusal" } }),
        /Error: Fixture refusal/,
      ],
      ["truncated protobuf", Uint8Array.of(0x12, 4, 0x0a), /Failed:/],
    ] as const)(
      "reports %s, releases work and accepts a later valid response",
      async (_name, response, error) => {
        const view = start(action);
        (call_rpc as jest.Mock).mockResolvedValueOnce(envelope(response));
        view.invoke();
        await flush();
        expect(screen.getByText(error)).toBeInTheDocument();
        expect(view.button()).toBeEnabled();
        noTimers();
        expect(
          screen.queryByText(
            /successfully|refreshing device reports|Collecting settings/,
          ),
        ).not.toBeInTheDocument();
        expect(screen.getByLabelText(/Idle Timeout/)).toHaveValue(1234);
        if (action !== "refresh") {
          act(() => view.notify(0, 42));
          expect(screen.getByLabelText(/Idle Timeout/)).toHaveValue(1234);
        }
        view.invoke();
        await flush();
        expect(screen.queryByText(error)).not.toBeInTheDocument();
        expect(
          screen.getByText(
            action === "refresh"
              ? /Collecting settings/
              : action === "save"
                ? /Settings updated successfully/
                : /refreshing device reports/,
          ),
        ).toBeInTheDocument();
        expect(call_rpc).toHaveBeenCalledTimes(2);
        if (action === "sync") {
          await act(async () => {
            jest.advanceTimersByTime(500);
          });
          await flush();
          expect(call_rpc).toHaveBeenCalledTimes(3);
          const [, request] = (call_rpc as jest.Mock).mock.calls[2];
          expect(
            Request.decode(request.custom.call.payload).getAllActivitySettings,
          ).toBeDefined();
        }
        noTimers();
      },
    );
  },
);
