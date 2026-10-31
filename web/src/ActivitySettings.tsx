import { errorKind } from "./logPrivacy";
/**
 * Activity Settings Component
 * Allows getting and setting sleep/idle timeout settings
 */

import { useContext, useState, useEffect, useMemo, useRef } from "react";
import { ZMKAppContext } from "@cormoran/zmk-studio-react-hook";
import { SettingsRpcClient } from "./settingsRpc";
import { Request, Response, Notification } from "./proto/zmk/settings/core";

// Custom subsystem identifier - must match firmware registration
export const SUBSYSTEM_IDENTIFIER = "zmk__settings";

const MAX_TIMEOUT_MS = 0xffffffff;
const TIMEOUT_ERROR = "Timeouts must be whole numbers from 0 to 4294967295 ms.";

function parseTimeout(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_TIMEOUT_MS
    ? parsed
    : null;
}

interface DeviceSettings {
  source: number;
  idleMs: number;
  sleepMs: number;
}

export interface ActivitySettingsProps {
  /**
   * Whether to automatically fetch settings on mount.
   * Defaults to true. Set to false in tests to avoid automatic RPC calls.
   */
  autoFetch?: boolean;
}

const connectionIds = new WeakMap<object, number>();
let nextConnectionId = 1;
export function ActivitySettings(props: ActivitySettingsProps) {
  const app = useContext(ZMKAppContext);
  const connection = app?.state.connection;
  let identity = 0;
  if (connection) {
    identity = connectionIds.get(connection) ?? nextConnectionId++;
    connectionIds.set(connection, identity);
  }
  const index = app?.findSubsystem(SUBSYSTEM_IDENTIFIER)?.index;
  const catalog = JSON.stringify(app?.state.customSubsystems?.subsystems ?? []);
  const key = `${identity}:${index ?? "missing"}:${catalog}`;
  return <ActivitySettingsSession key={key} {...props} />;
}

function ActivitySettingsSession({ autoFetch = true }: ActivitySettingsProps) {
  const zmkApp = useContext(ZMKAppContext);
  const [idleMs, setIdleMs] = useState("0");
  const [sleepMs, setSleepMs] = useState("0");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allDeviceSettings, setAllDeviceSettings] = useState<DeviceSettings[]>(
    []
  );
  const draftDirty = useRef(false);
  const draftRevision = useRef(0);
  const showSyncWarning =
    allDeviceSettings.length > 1 &&
    allDeviceSettings.some(
      (setting) =>
        setting.idleMs !== allDeviceSettings[0].idleMs ||
        setting.sleepMs !== allDeviceSettings[0].sleepMs
    );

  // Memoize subsystem to prevent re-rendering on every render
  const subsystem = useMemo(
    () => zmkApp?.findSubsystem(SUBSYSTEM_IDENTIFIER),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zmkApp?.state.customSubsystems]
  );

  // Responses and delayed refreshes belong to this connection/subsystem.
  // A new context can be rendered before the previous effect is cleaned up.
  const connection = zmkApp?.state.connection;
  const subsystemIndex = subsystem?.index;
  const session = useMemo(
    () => ({
      connection,
      subsystemIndex,
      active: true,
      client: new SettingsRpcClient(connection, subsystemIndex),
      requestId: 0,
      refreshTimer: null as ReturnType<typeof setTimeout> | null,
    }),
    [connection, subsystemIndex]
  );
  const currentSession = useRef(session);
  currentSession.current = session;
  const isCurrentSession = () =>
    session.active && currentSession.current === session;
  const beginRequest = () => {
    if (session.refreshTimer !== null) {
      clearTimeout(session.refreshTimer);
      session.refreshTimer = null;
    }
    const requestId = ++session.requestId;
    return () => isCurrentSession() && session.requestId === requestId;
  };
  useEffect(() => {
    session.active = true;
    session.client.activate();
    draftDirty.current = false;
    setIdleMs("0");
    setSleepMs("0");
    setAllDeviceSettings([]);
    setIsLoading(false);
    setMessage(null);
    setError(null);
    return () => {
      session.active = false;
      session.client.dispose();
      session.requestId++;
      if (session.refreshTimer !== null) clearTimeout(session.refreshTimer);
      session.refreshTimer = null;
    };
  }, [session]);

  // Subscribe to notifications
  useEffect(() => {
    if (!zmkApp?.state.connection || !subsystem) return;
    let subscribed = true;
    // Register notification handler
    const unsubscribe = zmkApp.onNotification({
      type: "custom",
      subsystemIndex: subsystem.index,
      callback: (notification) => {
        if (
          !subscribed ||
          !session.active ||
          currentSession.current !== session ||
          !notification.payload
        )
          return;
        try {
          const decoded = Notification.decode(notification.payload);
          if (decoded.activitySettings?.settings) {
            const settings = decoded.activitySettings.settings;
            const deviceSetting: DeviceSettings = {
              source: settings.source,
              idleMs: settings.idleMs,
              sleepMs: settings.sleepMs,
            };

            setAllDeviceSettings((prev) => {
              if (
                !subscribed ||
                !session.active ||
                currentSession.current !== session
              )
                return prev;
              // Check if we already have settings from this source
              const filtered = prev.filter((s) => s.source !== settings.source);
              const updated = [...filtered, deviceSetting];

              return updated;
            });
            // Reports stay live while an unsaved draft keeps its input values.
            if (settings.source === 0 && !draftDirty.current) {
              setIdleMs(String(settings.idleMs));
              setSleepMs(String(settings.sleepMs));
            }
          }
        } catch (err) {
          console.error("Failed to decode notification:", errorKind(err));
        }
      },
    });
    return () => {
      subscribed = false;
      unsubscribe?.();
    };
  }, [zmkApp, zmkApp?.state.connection, subsystem, session]);

  // Get current settings when component mounts or subsystem becomes available
  useEffect(() => {
    if (subsystem && zmkApp?.state.connection && autoFetch) {
      const timer = window.setTimeout(() => void getCurrentSettings(), 0);
      return () => window.clearTimeout(timer);
    }
    // The keyed parent owns session identity; replay cancels the first timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsystemIndex, connection, autoFetch]);

  if (!zmkApp) return null;

  const getCurrentSettings = async (replaceDraft = false) => {
    if (!zmkApp.state.connection || !subsystem || !isCurrentSession()) return;
    if (replaceDraft) {
      draftDirty.current = false;
      draftRevision.current++;
    }
    const isCurrentRequest = beginRequest();

    setIsLoading(true);
    setError(null);
    setMessage(null);
    // Keep the last reported values while collecting replacements. A refresh
    // acknowledgement does not establish that every peripheral is in sync.

    try {
      const service = session.client;

      // Request settings from all devices (central + peripherals)
      // This triggers notifications from each device
      const request = Request.create({
        getAllActivitySettings: {},
      });

      const payload = Request.encode(request).finish();
      const responsePayload = await service.callRPC(payload);
      if (!isCurrentRequest()) return;

      if (responsePayload) {
        const resp = Response.decode(responsePayload);

        if (resp.getAllActivitySettings) {
          if (resp.getAllActivitySettings.requestSent) {
            setMessage("Collecting settings from all devices...");
            // Actual settings will arrive via notifications
          }
        } else if (resp.error) {
          setError(`Error: ${resp.error.message}`);
        }
      }
    } catch (err) {
      if (!isCurrentRequest()) return;
      console.error("Failed to get activity settings:", errorKind(err));
      setError(
        `Failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      if (isCurrentRequest()) setIsLoading(false);
    }
  };

  const syncAllDevices = async () => {
    if (!zmkApp.state.connection || !subsystem || !isCurrentSession()) return;

    const idle = parseTimeout(idleMs);
    const sleep = parseTimeout(sleepMs);
    if (idle === null || sleep === null) {
      setMessage(null);
      setError(TIMEOUT_ERROR);
      return;
    }

    const revision = draftRevision.current;
    draftDirty.current = true;
    const isCurrentRequest = beginRequest();

    setIsLoading(true);
    setError(null);
    setMessage(null);

    try {
      const service = session.client;

      // Apply central's current settings to all devices
      const request = Request.create({
        setActivitySettings: {
          settings: {
            idleMs: idle,
            sleepMs: sleep,
          },
        },
      });

      const payload = Request.encode(request).finish();
      const responsePayload = await service.callRPC(payload);
      if (!isCurrentRequest()) return;

      if (responsePayload) {
        const resp = Response.decode(responsePayload);

        if (resp.setActivitySettings) {
          if (resp.setActivitySettings.success) {
            if (draftRevision.current === revision) draftDirty.current = false;
            setMessage("Settings applied; refreshing device reports...");
            // The central's acknowledgement does not confirm peripheral
            // delivery. Keep the reported mismatch until fresh reports arrive.
            session.refreshTimer = setTimeout(() => {
              session.refreshTimer = null;
              if (isCurrentRequest()) void getCurrentSettings();
            }, 500);
          } else {
            setError("Failed to sync settings");
          }
        } else if (resp.error) {
          setError(`Error: ${resp.error.message}`);
        }
      }
    } catch (err) {
      if (!isCurrentRequest()) return;
      console.error("Failed to sync settings:", errorKind(err));
      setError(
        `Failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      if (isCurrentRequest()) setIsLoading(false);
    }
  };

  const updateSettings = async () => {
    if (!zmkApp.state.connection || !subsystem || !isCurrentSession()) return;

    const idle = parseTimeout(idleMs);
    const sleep = parseTimeout(sleepMs);
    if (idle === null || sleep === null) {
      setMessage(null);
      setError(TIMEOUT_ERROR);
      return;
    }

    const revision = draftRevision.current;
    draftDirty.current = true;
    const isCurrentRequest = beginRequest();

    setIsLoading(true);
    setError(null);
    setMessage(null);

    try {
      const service = session.client;

      const request = Request.create({
        setActivitySettings: {
          settings: {
            idleMs: idle,
            sleepMs: sleep,
          },
        },
      });

      const payload = Request.encode(request).finish();
      const responsePayload = await service.callRPC(payload);
      if (!isCurrentRequest()) return;

      if (responsePayload) {
        const resp = Response.decode(responsePayload);

        if (resp.setActivitySettings) {
          if (resp.setActivitySettings.success) {
            if (draftRevision.current === revision) draftDirty.current = false;
            setMessage("Settings updated successfully!");
          } else {
            setError("Failed to update settings");
          }
        } else if (resp.error) {
          setError(`Error: ${resp.error.message}`);
        }
      }
    } catch (err) {
      if (!isCurrentRequest()) return;
      console.error("Failed to set activity settings:", errorKind(err));
      setError(
        `Failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      if (isCurrentRequest()) setIsLoading(false);
    }
  };

  if (!subsystem) {
    return (
      <section className="card">
        <div className="warning-message">
          <p>
            ⚠️ Subsystem "{SUBSYSTEM_IDENTIFIER}" not found. Make sure your
            firmware includes the settings module.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>⏱️ Activity Settings (Sleep/Idle Timeout)</h2>
      <p>
        Configure how long the keyboard waits before going idle or to sleep.
      </p>

      {showSyncWarning && (
        <div className="warning-message">
          <p>
            ⚠️ <strong>Settings mismatch detected!</strong> Not all devices have
            the same settings.
          </p>
          <button
            className="btn btn-primary"
            onClick={syncAllDevices}
            disabled={isLoading}
          >
            🔄 Sync All Devices
          </button>
        </div>
      )}

      {allDeviceSettings.length > 1 && (
        <div className="device-settings-list">
          <h3>Device Settings:</h3>
          <ul>
            {allDeviceSettings.map((device) => (
              <li key={device.source}>
                <strong>
                  {device.source === 0
                    ? "Central"
                    : `Peripheral ${device.source}`}
                </strong>
                : Idle {device.idleMs}ms, Sleep {device.sleepMs}ms
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="settings-grid">
        <div className="input-group">
          <label htmlFor="idle-timeout">Idle Timeout (ms):</label>
          <input
            id="idle-timeout"
            type="number"
            value={idleMs}
            onChange={(e) => {
              draftDirty.current = true;
              draftRevision.current++;
              setIdleMs(e.target.value);
            }}
            disabled={isLoading}
            min="0"
            max={MAX_TIMEOUT_MS}
            step="1"
          />
          <small>
            {parseTimeout(idleMs) === null
              ? "Enter a whole number of milliseconds"
              : Number(idleMs) === 0
                ? "Disabled"
                : `${(Number(idleMs) / 1000).toFixed(0)} seconds`}
          </small>
        </div>

        <div className="input-group">
          <label htmlFor="sleep-timeout">Sleep Timeout (ms):</label>
          <input
            id="sleep-timeout"
            type="number"
            value={sleepMs}
            onChange={(e) => {
              draftDirty.current = true;
              draftRevision.current++;
              setSleepMs(e.target.value);
            }}
            disabled={isLoading}
            min="0"
            max={MAX_TIMEOUT_MS}
            step="1"
          />
          <small>
            {parseTimeout(sleepMs) === null
              ? "Enter a whole number of milliseconds"
              : Number(sleepMs) === 0
                ? "Disabled"
                : `${(Number(sleepMs) / 60000).toFixed(1)} minutes`}
          </small>
        </div>
      </div>

      <div className="button-group">
        <button
          className="btn btn-secondary"
          disabled={isLoading}
          onClick={() => void getCurrentSettings(true)}
        >
          {isLoading ? "⏳ Loading..." : "🔄 Refresh"}
        </button>
        <button
          className="btn btn-primary"
          disabled={isLoading}
          onClick={updateSettings}
        >
          {isLoading ? "⏳ Updating..." : "💾 Save Settings"}
        </button>
      </div>

      {message && (
        <div className="success-message">
          <p>✅ {message}</p>
        </div>
      )}

      {error && (
        <div className="error-message">
          <p>🚨 {error}</p>
        </div>
      )}
    </section>
  );
}
