import { call_rpc } from "@zmkfirmware/zmk-studio-ts-client";

type Connection = Parameters<typeof call_rpc>[0];
const RPC_TIMEOUT_MS = 5000;

export class RetiredSettingsRequest extends Error {
  constructor() {
    super("Settings RPC request retired");
    this.name = "RetiredSettingsRequest";
  }
}

/** Owns request deadlines; disposal retires UI work, not device-side writes. */
export class SettingsRpcClient {
  private active = true;
  private readonly pending = new Set<() => void>();

  private readonly connection: Connection | null | undefined;
  private readonly index: number | undefined;

  constructor(
    connection: Connection | null | undefined,
    index: number | undefined
  ) {
    this.connection = connection;
    this.index = index;
  }

  activate() {
    this.active = true;
  }

  dispose() {
    this.active = false;
    for (const cancel of [...this.pending]) cancel();
  }

  callRPC(payload: Uint8Array): Promise<Uint8Array> {
    if (!this.active) return Promise.reject(new RetiredSettingsRequest());
    const connection = this.connection;
    const index = this.index;
    if (!connection || index === undefined)
      return Promise.reject(new Error("Settings RPC is not connected"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, result?: Uint8Array) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.pending.delete(cancel);
        if (result === undefined) reject(error);
        else resolve(result);
      };
      const cancel = () => finish(new RetiredSettingsRequest());
      this.pending.add(cancel);
      const timer = window.setTimeout(
        () => finish(new Error("Settings RPC request timed out")),
        RPC_TIMEOUT_MS
      );
      try {
        Promise.resolve(
          call_rpc(connection, {
            custom: { call: { subsystemIndex: index, payload } },
          })
        ).then(
          (response) => {
            const data = response?.custom?.call?.payload;
            if (!data) finish(new Error("Empty RPC response"));
            else finish(undefined, data);
          },
          (error: unknown) => finish(error)
        );
      } catch (error) {
        finish(error);
      }
    });
  }
}
