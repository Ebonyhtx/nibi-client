import type { TaskNotificationPayload } from "@nibi/shared";
import taskCompleteChirpUrl from "@/assets/notification-sounds/task-complete-chirp.mp3";
import taskConfirmChimeUrl from "@/assets/notification-sounds/task-confirm-chime.mp3";
import taskErrorFeatherUrl from "@/assets/notification-sounds/task-error-feather.mp3";
import { isTaskNotificationSoundEnabled } from "@/lib/taskNotificationPreferences.js";

type TaskNotificationStatus = TaskNotificationPayload["status"];

// 三声归位（D21）：完成 = 短促鸟鸣；需要确认/授权 = 双音风铃；出错 = 轻羽落。
// feedback_update 未分配音色，保持静音，避免自造第四种音。
const SOUND_BY_STATUS: Partial<Record<TaskNotificationStatus, string>> = {
  completed: taskCompleteChirpUrl,
  permission_request: taskConfirmChimeUrl,
  elicitation_request: taskConfirmChimeUrl,
  failed: taskErrorFeatherUrl,
};

const audioByUrl = new Map<string, HTMLAudioElement>();

function getTaskNotificationAudio(url: string): HTMLAudioElement | null {
  if (typeof Audio === "undefined") {
    return null;
  }

  let audio = audioByUrl.get(url);
  if (!audio) {
    audio = new Audio(url);
    audio.preload = "auto";
    audioByUrl.set(url, audio);
  }

  return audio;
}

export async function playTaskNotificationSound(
  status?: TaskNotificationStatus | null,
): Promise<void> {
  // Desktop/Web 都会在“通知已展示”后异步触发音效播放；
  // 如果这里不再检查声音子开关，设置页里关闭提示音后运行时仍会继续响，
  // 看起来就像设置没生效。把最终判定收口到播放器入口，能保证所有调用方行为一致。
  if (!isTaskNotificationSoundEnabled()) {
    return;
  }

  if (!status) {
    return;
  }

  const url = SOUND_BY_STATUS[status];
  if (!url) {
    return;
  }

  const audio = getTaskNotificationAudio(url);
  if (!audio) {
    return;
  }

  try {
    // 同一个 Audio 实例在后台通知里反复复用时，若不先回到起点，
    // 新一轮通知经常会因为还停留在上次播放结束态而直接静默。
    // 这里显式重置播放位置，并吞掉自动播放限制异常，避免音效失败反过来影响通知主链路。
    audio.pause();
    audio.currentTime = 0;
    await audio.play();
  } catch {
    // 音效属于增强体验，播放失败时不打断通知主流程。
  }
}
