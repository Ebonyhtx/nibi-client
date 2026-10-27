import type { RequestVerificationReason } from "@nibi/shared";
import type { Logger } from "@nibi/contracts";
import { RequestVerificationRetry } from "./request-security-edition/recovery.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";

export class AccountRequestRetry {
  readonly #verification: RequestVerificationRetry;

  constructor(
    private readonly request: AiSdkModelTextRequest,
    private readonly model: ResolvedAiSdkModel,
    private readonly logger?: Logger,
  ) {
    this.#verification = new RequestVerificationRetry(request, model);
  }

  get extraAttempts(): number {
    return this.#verification.extraAttempts;
  }

  takeReason(): RequestVerificationReason {
    return this.#verification.takeReason();
  }

  prepareRequest(request: AiSdkModelTextRequest): AiSdkModelTextRequest {
    const refresh = request.refreshRuntimeHeadersBeforeAttempt;
    if (!refresh) return request;
    return {
      ...request,
      refreshRuntimeHeadersBeforeAttempt: async (input) => refresh(input),
    };
  }

  claim(error: unknown, blocked = false): boolean {
    return this.#verification.claim(error, blocked);
  }
}
