import { type ChildProcess, spawn } from "node:child_process";
import { type AddressInfo, type Server, connect, createServer } from "node:net";
import { join } from "node:path";

/** The native device's binary, which `npm run test:e2e` builds first. */
const DEVICE = join(__dirname, "device", "target", "debug", "e2e-device");

/**
 * `count` distinct loopback ports free now: each is held until all are
 * chosen, so none is chosen twice.
 */
async function freePorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    }
    return servers.map((server) => (server.address() as AddressInfo).port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

/** Whether something accepts connections on `port` now. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Wait until `port` accepts connections, or `device` exits, or a minute passes. */
async function served(port: number, device: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!(await accepts(port))) {
    if (device.exitCode !== null) throw new Error(`the device exited (${device.exitCode})`);
    if (Date.now() > deadline) throw new Error(`the device did not serve port ${port} within a minute`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Start the native device on two free ports: the editor's bridge, whose URL
 * goes to `E2E_DEVICE_URL`, and the test client's, to `E2E_TEST_URL`. The
 * device stops with the suite.
 */
export default async function globalSetup() {
  const [editor, test] = (await freePorts(2)) as [number, number];
  const device = spawn(DEVICE, [String(editor), String(test)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "warn" },
  });
  const failed = new Promise<never>((_, reject) =>
    device.once("error", (e) => reject(new Error(`the device did not start: ${e.message}`))),
  );
  try {
    await Promise.race([Promise.all([served(editor, device), served(test, device)]), failed]);
  } catch (error) {
    // A device that did not come up is not left running.
    device.kill();
    throw error;
  }
  process.env.E2E_DEVICE_URL = `ws://127.0.0.1:${editor}`;
  process.env.E2E_TEST_URL = `ws://127.0.0.1:${test}`;
  return () => {
    device.kill();
  };
}
