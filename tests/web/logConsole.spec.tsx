import { fireEvent, render, screen } from "@testing-library/react";
import { SettingsRpcClient as ZMKCustomSubsystem } from "../../web/src/settingsRpc";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import {
  ActivitySettings,
  SUBSYSTEM_IDENTIFIER,
} from "../../web/src/ActivitySettings";

afterEach(() => jest.restoreAllMocks());

it("keeps settings failure details in the UI and excludes them from the console", async () => {
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  jest
    .spyOn(ZMKCustomSubsystem.prototype, "callRPC")
    .mockRejectedValue(new TypeError("private-setting-name"));
  const app = createConnectedMockZMKApp({ subsystems: [SUBSYSTEM_IDENTIFIER] });
  render(
    <ZMKAppProvider value={app}>
      <ActivitySettings autoFetch={false} />
    </ZMKAppProvider>,
  );
  fireEvent.click(screen.getByText(/Save Settings/));
  await screen.findByText(/private-setting-name/);
  expect(errors).toHaveBeenCalledWith(
    "Failed to set activity settings:",
    "TypeError",
  );
  expect(JSON.stringify(errors.mock.calls)).not.toContain(
    "private-setting-name",
  );
});
