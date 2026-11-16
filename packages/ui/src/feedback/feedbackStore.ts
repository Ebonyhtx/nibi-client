import { create } from "zustand";
import type {
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketType,
} from "@nibi/shared";

type FeedbackTab = "submit" | "tickets";

export interface FeedbackAttachmentDraft {
  readonly filename: string;
  readonly contentType: string;
  readonly dataBase64: string;
  readonly size: number;
}

export interface FeedbackSubmitDraft {
  readonly title?: string;
  readonly description?: string;
  readonly contact?: string;
  readonly type?: FeedbackTicketType;
  readonly module?: FeedbackTicketModule;
  readonly severity?: FeedbackTicketSeverity;
  readonly screenshots?: readonly FeedbackAttachmentDraft[];
  readonly includeLogs?: boolean;
}

interface FeedbackUiState {
  open: boolean;
  featureRequestOpen: boolean;
  tab: FeedbackTab;
  submitDraft: FeedbackSubmitDraft | null;
  /** 仅查看指定后台提交时设置；新建反馈必须保持为 null */
  submissionJobId: string | null;
  /** 打开"我的反馈"列表时，可选地高亮某条工单 */
  selectedTicketId: string | null;
  /** 打开后立刻聚焦到提交表单 */
  openSubmit: (draft?: FeedbackSubmitDraft) => void;
  /** 打开指定后台提交任务的进度弹窗 */
  openSubmissionJob: (jobId: string) => void;
  /** 打开独立产品需求反馈弹窗 */
  openFeatureRequest: () => void;
  /** 打开后立刻聚焦到工单列表，可选 highlight */
  openTickets: (ticketId?: string) => void;
  /** 切换 Tab，但不关闭 dialog */
  setTab: (tab: FeedbackTab) => void;
  setSelectedTicketId: (ticketId: string | null) => void;
  close: () => void;
}

export const useFeedbackStore = create<FeedbackUiState>((set) => ({
  open: false,
  featureRequestOpen: false,
  tab: "submit",
  submitDraft: null,
  submissionJobId: null,
  selectedTicketId: null,
  openSubmit: (draft) =>
    set({
      // “问题上报”是新建入口，不能隐式续接上一次仍在上传的 job，
      // 否则新表单会继承旧 job 的 submitting 状态并阻止用户继续提交。
      open: true,
      featureRequestOpen: false,
      tab: "submit",
      submitDraft: draft ?? null,
      submissionJobId: null,
      selectedTicketId: null,
    }),
  openSubmissionJob: (jobId) =>
    set({
      open: true,
      featureRequestOpen: false,
      tab: "submit",
      submitDraft: null,
      submissionJobId: jobId,
      selectedTicketId: null,
    }),
  openFeatureRequest: () =>
    set({
      // 需求反馈和问题上报是两个独立 Dialog，必须互斥打开，避免后台浮层或快捷入口叠出双弹窗。
      open: false,
      featureRequestOpen: true,
      submitDraft: null,
      submissionJobId: null,
      selectedTicketId: null,
    }),
  openTickets: (ticketId) =>
    set({
      open: true,
      featureRequestOpen: false,
      tab: "tickets",
      submitDraft: null,
      submissionJobId: null,
      selectedTicketId: ticketId ?? null,
    }),
  setTab: (tab) =>
    set({
      tab,
      ...(tab === "submit" ? { submissionJobId: null } : {}),
    }),
  setSelectedTicketId: (ticketId) => set({ selectedTicketId: ticketId }),
  close: () =>
    set({
      open: false,
      featureRequestOpen: false,
      submitDraft: null,
      submissionJobId: null,
      selectedTicketId: null,
    }),
}));

// ── 反馈表单草稿持久化 ────────────────────────────────────────────────
// 描述/联系方式/类型/日志开关放 localStorage，截图 Base64 放 IndexedDB
// （localStorage 只有 5–10MB，压缩后的截图很容易超）。切 Tab、关弹窗、重启后还在。
const FEEDBACK_DRAFT_TEXT_KEY = "nibi.feedback.submitDraft.v2";
const FEEDBACK_DRAFT_DB_NAME = "nibi-feedback-drafts";
const FEEDBACK_DRAFT_DB_VERSION = 1;
const FEEDBACK_DRAFT_STORE = "submit";
const FEEDBACK_DRAFT_RECORD_KEY = "current";
const FEEDBACK_DRAFT_MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

interface PersistedFeedbackTextDraft {
  title?: string;
  description?: string;
  contact?: string;
  type?: FeedbackSubmitDraft["type"];
  module?: FeedbackSubmitDraft["module"];
  severity?: FeedbackSubmitDraft["severity"];
  includeLogs?: boolean;
}

function readPersistedFeedbackTextDraft(): PersistedFeedbackTextDraft | null {
  try {
    const raw = localStorage.getItem(FEEDBACK_DRAFT_TEXT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as PersistedFeedbackTextDraft) : null;
  } catch {
    return null;
  }
}

function openFeedbackDraftDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(FEEDBACK_DRAFT_DB_NAME, FEEDBACK_DRAFT_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FEEDBACK_DRAFT_STORE)) {
        db.createObjectStore(FEEDBACK_DRAFT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function readPersistedFeedbackScreenshots(): Promise<
  FeedbackSubmitDraft["screenshots"] | undefined
> {
  const db = await openFeedbackDraftDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(FEEDBACK_DRAFT_STORE, "readonly");
      const request = tx.objectStore(FEEDBACK_DRAFT_STORE).get(FEEDBACK_DRAFT_RECORD_KEY);
      request.onsuccess = () => {
        const value = request.result as
          | { screenshots?: FeedbackSubmitDraft["screenshots"] }
          | undefined;
        db.close();
        resolve(value?.screenshots);
      };
      request.onerror = () => {
        db.close();
        resolve(undefined);
      };
    } catch {
      db.close();
      resolve(undefined);
    }
  });
}

async function writePersistedFeedbackScreenshots(
  screenshots: FeedbackSubmitDraft["screenshots"],
): Promise<void> {
  const db = await openFeedbackDraftDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(FEEDBACK_DRAFT_STORE, "readwrite");
      const store = tx.objectStore(FEEDBACK_DRAFT_STORE);
      if (!screenshots || screenshots.length === 0) {
        store.delete(FEEDBACK_DRAFT_RECORD_KEY);
      } else {
        store.put({ screenshots }, FEEDBACK_DRAFT_RECORD_KEY);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve(undefined);
    }
  });
}

export async function loadFeedbackSubmitDraft(): Promise<FeedbackSubmitDraft | null> {
  const text = readPersistedFeedbackTextDraft();
  const screenshots = await readPersistedFeedbackScreenshots();
  if (!text && !screenshots?.length) return null;
  return {
    ...(text?.title ? { title: text.title } : {}),
    ...(text?.description ? { description: text.description } : {}),
    ...(text?.contact ? { contact: text.contact } : {}),
    ...(text?.type ? { type: text.type } : {}),
    ...(text?.module ? { module: text.module } : {}),
    ...(text?.severity ? { severity: text.severity } : {}),
    ...(text?.includeLogs !== undefined ? { includeLogs: text.includeLogs } : {}),
    ...(screenshots?.length ? { screenshots } : {}),
  };
}

export function saveFeedbackSubmitDraft(input: {
  title?: string;
  description: string;
  contact: string;
  type: FeedbackSubmitDraft["type"];
  module: FeedbackSubmitDraft["module"];
  severity: FeedbackSubmitDraft["severity"];
  includeLogs: boolean;
  screenshots: NonNullable<FeedbackSubmitDraft["screenshots"]>;
}): void {
  const text: PersistedFeedbackTextDraft = {
    ...(input.title ? { title: input.title } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.contact ? { contact: input.contact } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.module ? { module: input.module } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    includeLogs: input.includeLogs,
  };
  try {
    localStorage.setItem(FEEDBACK_DRAFT_TEXT_KEY, JSON.stringify(text));
  } catch {
    // 配额满/隐私模式：草稿持久化失败不应影响提交。
  }
  const totalBytes = input.screenshots.reduce((sum, item) => sum + (item.size || 0), 0);
  if (totalBytes > FEEDBACK_DRAFT_MAX_SCREENSHOT_BYTES) return;
  void writePersistedFeedbackScreenshots(input.screenshots);
}

export function clearFeedbackSubmitDraft(): void {
  try {
    localStorage.removeItem(FEEDBACK_DRAFT_TEXT_KEY);
  } catch {
    // ignore
  }
  void writePersistedFeedbackScreenshots([]);
}
