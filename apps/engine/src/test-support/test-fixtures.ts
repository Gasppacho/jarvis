import type { ModuleHandler } from "../../../../packages/module-sdk/src/index.js";
export {
  SAMPLE_PROBE_MODULE_ID,
  SAMPLE_PROBE_PINGED,
  createSampleProbeHandler,
  createSampleProbeSchema,
} from "../executions/sample-probe-module.js";

export const REQUEST_WORKER_MODULE_ID = "jarvis.module.test-request-worker";
export const REQUEST_WORKER_CONTRACT = {
  type: "development.implementation.requested",
  version: 1,
  kind: "request" as const,
};
export const requestWorkerHandler: ModuleHandler = () => ({ handled: true });
