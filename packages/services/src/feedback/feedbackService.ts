import { basename, join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import type { ApiClient, FeedbackDeviceInfo } from "@nibi/shared";
import {
  buildRuntimeNibiApiUrl,
  NIBI_BUILD_TIME,
  NIBI_COMMIT,
  NIBI_VERSION,
} from "@nibi/shared";
import { Emitter } from "@nibi/rpc";
import { arch, platform, release, type as osType } from "node:os";

import type { ICredentialService } from "../credential/credential.js";
import type { IOAuthService } from "../oauth/oauth.js";
import type { FeedbackUploadProgress, IFeedbackService } from "./feedback.js";
import { FeedbackHttpClient, FeedbackUploadCanceledError } from "./feedbackHttpClient.js";
import { cleanupLogArchive, prepareCompactLogArchive } from "./compactLogArchive.js";
import { getFeedbackAttachmentDir } from "../paths.js";

/** 反馈 v2 只认 NIBI 登录令牌（服务端拒绝匿名）；不再读上游遗留 nibi-jwttoken。 */
const NIBI_ACCESS_TOKEN_KEY = "oauth:nibi:access_token";

export const FEEDBACK_LOGIN_REQUIRED_MESSAGE = "请先登录 NIBI 账号后再提交或查看反馈";

export class FeedbackLoginRequiredError extends Error {
  constructor() {
    super(FEEDBACK_LOGIN_REQUIRED_MESSAGE);
    this.name = "FeedbackLoginRequiredError";
  }
}

export interface CreateFeedbackServiceOptions {
  credentialService: ICredentialService;
  oauthService: IOAuthService;
  apiClient: ApiClient;
  getDeviceMid?: () => string | undefined;
  apiBaseUrl?: string;
  createFullLogArchive?: (
    sourceDir: string,
    options?: {
      onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
    },
  ) => Promise<{ path: string; size: number }>;
  revealPath?: (path: string) => Promise<void>;
}

function resolveApiBaseUrl(explicit?: string): string {
  return (
    explicit?.trim() ||
    process.env.NIBI_FEEDBACK_API_BASE?.trim() ||
    buildRuntimeNibiApiUrl(process.env, "/api/v1")
  );
}

function buildDeviceSnapshot(): FeedbackDeviceInfo {
  return {
    appVersion: NIBI_VERSION,
    buildCommitId: NIBI_COMMIT,
    buildTime: NIBI_BUILD_TIME,
    nodeVersion: process.version,
    osType: osType(),
    osPlatform: platform(),
    osRelease: release(),
    // node:os.version() 在 macOS 上是完整 Darwin kernel 字符串，超过后端 os_version VARCHAR(64) 会写库失败。
    osVersion: release(),
    osArch: arch(),
  };
}

export function createFeedbackService(options: CreateFeedbackServiceOptions): IFeedbackService {
  const apiBaseUrl = resolveApiBaseUrl(options.apiBaseUrl);
  function getHostDeviceMid(): string | undefined {
    return options.getDeviceMid?.()?.trim() || undefined;
  }

  async function getNibiAccessToken(): Promise<string | undefined> {
    return (await options.credentialService.load(NIBI_ACCESS_TOKEN_KEY))?.trim() || undefined;
  }

  const httpClient = new FeedbackHttpClient({
    baseUrl: apiBaseUrl,
    apiClient: options.apiClient,
    getAuthHeaders: async () => {
      const headers: Record<string, string> = {};
      const deviceMid = getHostDeviceMid();
      // feedback 的 device_mid 必须复用宿主 deviceMid（与 provider 请求头、远控同一身份）；
      // 不单独生成 fb_ 身份，否则同一台机器在不同系统里会被拆成两个设备。
      if (deviceMid) {
        headers["X-Device-Mid"] = deviceMid;
      }
      const accessToken = await getNibiAccessToken();
      if (!accessToken) throw new FeedbackLoginRequiredError();
      headers.Authorization = `Bearer ${accessToken}`;
      headers["X-Nibi-Client-Version"] = NIBI_VERSION;
      return headers;
    },
  });
  const uploadProgressEmitters = new Map<string, Emitter<FeedbackUploadProgress>>();
  const activeUploadControllers = new Map<string, AbortController>();
  const activeCreateControllers = new Map<string, AbortController>();

  function getUploadProgressEmitter(id: string): Emitter<FeedbackUploadProgress> {
    const current = uploadProgressEmitters.get(id);
    if (current) return current;
    const emitter = new Emitter<FeedbackUploadProgress>({
      onDidRemoveLastListener: () => {
        uploadProgressEmitters.delete(id);
        emitter.dispose();
      },
    });
    uploadProgressEmitters.set(id, emitter);
    return emitter;
  }

  return {
    isLoggedIn: async () => Boolean(await getNibiAccessToken()),
    create: async (input, createOptions) => {
      const device = input.device ?? buildDeviceSnapshot();
      const operationId = createOptions?.operationId?.trim();
      const controller = new AbortController();
      if (operationId) {
        // UI 取消创建工单时不能只关闭弹窗；host 需要能按 operationId
        // 找到当前 HTTP 请求并 abort，避免“正在连接反馈服务”永久悬挂。
        activeCreateControllers.get(operationId)?.abort();
        activeCreateControllers.set(operationId, controller);
      }
      try {
        const ticket = await httpClient.create(
          {
            ...input,
            device,
          },
          {
            signal: controller.signal,
            ...(operationId ? { idempotencyKey: operationId } : {}),
          },
        );
        return ticket;
      } finally {
        if (operationId && activeCreateControllers.get(operationId) === controller) {
          activeCreateControllers.delete(operationId);
        }
      }
    },
    cancelCreate: async (operationId) => {
      const key = operationId.trim();
      if (!key) return;
      activeCreateControllers.get(key)?.abort();
    },
    list: async (query) => {
      // v2：列表只看服务端（登录账号维度）；本地 tickets.json 仅保留为历史缓存，不再作为数据源。
      return httpClient.list(query);
    },
    get: (id) => httpClient.get(id),
    comment: (id, body) => httpClient.comment(id, body),
    uploadAttachment: async (id, kind, file) => {
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      return httpClient.uploadFile(id, kind, file.path, filename, contentType, {
        messageId: file.messageId,
      });
    },
    uploadAttachmentWithProgress: async (id, kind, file, progressId) => {
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      const emitter = getUploadProgressEmitter(progressId);
      emitter.fire({
        id: progressId,
        phase: "preparing",
        uploadedBytes: 0,
        totalBytes: 0,
      });
      const controller = new AbortController();
      activeUploadControllers.set(progressId, controller);
      return httpClient
        .uploadFile(id, kind, file.path, filename, contentType, {
          messageId: file.messageId,
          signal: controller.signal,
          onUploadProgress: (event) => {
            emitter.fire({
              id: progressId,
              phase: event.uploadedBytes >= event.totalBytes ? "complete" : "uploading",
              uploadedBytes: event.uploadedBytes,
              totalBytes: event.totalBytes,
            });
          },
        })
        .catch((error) => {
          if (error instanceof FeedbackUploadCanceledError) {
            emitter.fire({
              id: progressId,
              phase: "canceled",
              uploadedBytes: 0,
              totalBytes: 0,
            });
          }
          throw error;
        })
        .finally(() => {
          activeUploadControllers.delete(progressId);
        });
    },
    cancelUpload: async (progressId) => {
      activeUploadControllers.get(progressId)?.abort();
    },
    onDynamicUploadProgress: (id) => getUploadProgressEmitter(id).event,
    uploadAttachmentData: async (id, kind, file) => {
      const attachmentRootDir = getFeedbackAttachmentDir();
      await mkdir(attachmentRootDir, { recursive: true });
      const tempDir = await mkdtemp(join(attachmentRootDir, "attachment-"));
      // 附件名来自 renderer，不能作为本地相对路径使用。
      const filename = basename(file.filename.replaceAll("\\", "/")) || "attachment";
      const tempPath = join(tempDir, "content");
      try {
        await writeFile(tempPath, Buffer.from(file.dataBase64, "base64"));
        return await httpClient.uploadFile(id, kind, tempPath, filename, file.contentType, {
          messageId: file.messageId,
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    attachLogsFromExport: async (id, attachOptions) => {
      const archive = await prepareCompactLogArchive({
        full: attachOptions?.full,
        createFullArchive: options.createFullLogArchive,
      });
      try {
        return await httpClient.uploadFile(
          id,
          "log",
          archive.path,
          basename(archive.path),
          "application/zip",
        );
      } finally {
        await cleanupLogArchive(archive.path);
      }
    },
    getDeviceSnapshot: async () => buildDeviceSnapshot(),
    prepareCompactLogArchive: async (archiveOptions) => {
      const progressId = archiveOptions?.progressId;
      const progressEmitter = progressId ? getUploadProgressEmitter(progressId) : null;
      return prepareCompactLogArchive({
        full: archiveOptions?.full,
        createFullArchive: options.createFullLogArchive,
        onProgress: progressEmitter
          ? (event) => {
              progressEmitter.fire({
                id: progressId!,
                phase: "preparing",
                uploadedBytes: event.processedBytes,
                totalBytes: event.totalBytes,
              });
            }
          : undefined,
      });
    },
    cleanupPreparedLogArchive: (path) => cleanupLogArchive(path),
    revealLogArchive: async (path) => {
      if (options.revealPath) {
        await options.revealPath(path);
        return;
      }
    },
  };
}
