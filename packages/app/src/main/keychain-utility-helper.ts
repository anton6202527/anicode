import {
  ELECTRON_KEYCHAIN_MAX_MESSAGE_BYTES,
  executeElectronKeychainRequest,
  type ElectronKeychainResponse,
} from "./keychain-utility-protocol.js";

interface ParentPort {
  once(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: ElectronKeychainResponse): void;
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort | null }).parentPort;
if (!parentPort) throw new Error("OS Keychain helper requires an Electron utility parent port");

parentPort.once("message", (event) => {
  let response: ElectronKeychainResponse;
  try {
    const encoded = Buffer.from(JSON.stringify(event.data), "utf8");
    const validSize = encoded.byteLength <= ELECTRON_KEYCHAIN_MAX_MESSAGE_BYTES;
    encoded.fill(0);
    response = validSize
      ? executeElectronKeychainRequest(event.data)
      : { version: 1, ok: false, code: "invalid_request" };
  } catch {
    response = { version: 1, ok: false, code: "invalid_request" };
  }
  try {
    parentPort.postMessage(response);
  } finally {
    if ("value" in response && typeof response.value === "string") response.value = "";
    setImmediate(() => process.exit(0));
  }
});
