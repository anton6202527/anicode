export { DaemonServer, type DaemonServerOptions } from "./server.js";
export { DaemonClient, type DaemonClientOptions } from "./client.js";
export {
  defaultDaemonSocketPath,
  isWindowsNamedPipePath,
  type DaemonSocketPathOptions,
} from "./socket-path.js";
export { encodeFrame, decodeLines, type ClientRequest, type ServerFrame } from "./protocol.js";
export { HttpDaemonServer, type HttpDaemonOptions } from "./http-server.js";
export { HttpSessionHost, parseSseChunk, type HttpSessionHostOptions } from "./http-client.js";
export {
  ROUTES,
  EVENTS,
  PROTOCOL_VERSION,
  generateOpenApi,
  type RouteDef,
  type EventEnvelope,
} from "./api.js";
