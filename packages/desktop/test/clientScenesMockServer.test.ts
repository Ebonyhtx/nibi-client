import { describe, expect, it } from "vitest";
import {
  AUTOMATIONS_HOME_CLIENT_SCENES_FIXTURE,
  startClientScenesMockServer,
} from "./e2e/helpers/client-scenes-mock-server.js";

describe("automations Client Scenes E2E fixture", () => {
  it("通过 client scenes API 返回与 service 契约一致的 envelope", async () => {
    const server = await startClientScenesMockServer();
    try {
      const response = await fetch(`${server.baseUrl}/api/v1/client/scenes`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(AUTOMATIONS_HOME_CLIENT_SCENES_FIXTURE);
    } finally {
      await server.stop();
    }
  });
});
