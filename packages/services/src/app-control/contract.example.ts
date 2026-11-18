import {
  APP_CONTROL_METHODS,
  type AppControlHostReply,
  type AppControlRequestEnvelope,
} from "./contract.js";

/** Host 侧最小的 ListProjects 反向请求与成功回执。 */
export const exampleListProjectsRequest: AppControlRequestEnvelope = {
  callerSessionId: "session_demo",
  callId: "call_demo",
  workspacePath: "/workspace/demo",
  input: {},
};

export const exampleListProjectsReply: AppControlHostReply = {
  ok: true,
  result: {
    projects: [{ project: { kind: "app", projectId: "project_demo" }, title: "Demo" }],
    searchScope: {
      scopes: [{ kind: "app", scope: "host" }],
      unavailableSources: [],
    },
  },
};

export const exampleOpenSessionMethod = APP_CONTROL_METHODS.openSession;