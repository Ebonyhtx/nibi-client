// 帧级会合控制器：转场视频开头是源循环的完整拷贝，用 RVFC 追踪源循环当前帧，
// 把转场 seek 到（源帧 + 6）%，在精确帧上换层，避免姿态跳变。
const FPS = 24;
const LOOP_FRAMES: Record<string, number> = {
  "calm-loop": 107,
  "working-loop": 124,
};
const TRANSITION_SOURCE: Record<string, string> = {
  "enter-transition": "calm-loop",
  "exit-transition": "working-loop",
};
const PREPARE_FRAMES = 6;

export type CompanionMotionKind =
  | "static"
  | "calm-loop"
  | "working-loop"
  | "enter-transition"
  | "exit-transition"
  | "paused-hold";

export interface CompanionPlayback {
  kind: CompanionMotionKind;
  key: number;
  ready?: boolean;
  retiring?: boolean;
  held?: boolean;
}

interface Player {
  playback: CompanionPlayback;
  video: HTMLVideoElement;
  serial: number;
  frame?: number;
  mediaTime?: number;
  held?: boolean;
}

interface Candidate {
  player: Player;
  source: Player | null;
  target: { serial: number; frame: number } | null;
  prepared: boolean;
  lead: number;
}

interface FrameMetadata {
  mediaTime: number;
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: FrameMetadata) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface CreateMotionPlaybackOptions {
  rates: Record<string, number>;
  onPresented: (playback: CompanionPlayback) => void;
  onEnded: (playback: CompanionPlayback) => void;
  onFailed: (playback: CompanionPlayback) => void;
  onHeld: (playback: CompanionPlayback) => void;
}

export function createMotionPlayback({
  rates,
  onPresented,
  onEnded,
  onFailed,
  onHeld,
}: CreateMotionPlaybackOptions) {
  const players = new Map<number, Player>();
  let requested: CompanionPlayback | null = null;
  let displayed: Player | null = null;
  let pending: Candidate | null = null;
  let pauseRequested = false;

  const updateRestLoop = () => {
    if (displayed?.playback.kind !== "calm-loop") return;
    // 静止请求在当前 calm 循环的闭眼尾帧收尾；正在为起飞供帧的源循环必须继续循环到换层。
    displayed.video.loop =
      !displayed.held &&
      !(pauseRequested && requested?.key === displayed.playback.key);
  };

  const fail = (player: Player) => {
    if (players.get(player.playback.key) !== player) return;
    if (requested?.key !== player.playback.key && pending?.source !== player) return;
    player.video.pause();
    pending = null;
    const failed = requested;
    if (failed) onFailed(failed);
  };

  const present = (candidate: Candidate) => {
    if (pending !== candidate || requested?.key !== candidate.player.playback.key) return;
    const player = candidate.player;
    // 替换层已经在源视频刚提交的同一帧上解码并暂停，换层时两个解码器都不倒帧。
    displayed?.video.pause();
    displayed = player;
    pending = null;
    updateRestLoop();
    onPresented(player.playback);
    player.video.play()?.catch(() => fail(player));
  };

  const prepare = (candidate: Candidate) => {
    const { player, source } = candidate;
    if (player.video.readyState < 2 || source?.frame === undefined) return;
    const frameCount = LOOP_FRAMES[source.playback.kind];
    if (!frameCount) return;
    candidate.target = {
      serial: source.serial + candidate.lead,
      frame: (source.frame + candidate.lead) % frameCount,
    };
    candidate.prepared = false;
    // WebM 时间戳按毫秒取整；seek 到帧内一点点，再按真实解码 mediaTime 验帧，不信任 seeked 事件。
    player.video.currentTime = candidate.target.frame / FPS + 0.002;
  };

  const advance = () => {
    const candidate = pending;
    if (!candidate) return;
    if (!candidate.source) {
      if (candidate.prepared) present(candidate);
      return;
    }
    const source = candidate.source;
    if (!candidate.target) {
      prepare(candidate);
    } else if (source.serial > candidate.target.serial) {
      // seek 慢或源丢帧：让旧视频继续走，准备一个更晚的会合点，绝不暴露过期帧。
      candidate.lead = Math.min(FPS, candidate.lead * 2);
      prepare(candidate);
    } else if (source.serial === candidate.target.serial && candidate.prepared) {
      present(candidate);
    }
  };

  const acceptFrame = (player: Player, mediaTime: number) => {
    if (player.video.seeking) return;
    const frame = Math.round(mediaTime * FPS);
    if (player.frame !== undefined) {
      const count = LOOP_FRAMES[player.playback.kind];
      player.serial += count
        ? (frame - player.frame + count) % count
        : Math.max(0, frame - player.frame);
    }
    player.frame = frame;
    player.mediaTime = mediaTime;
    const candidate = pending;
    if (candidate?.player === player) {
      const expected = candidate.source ? candidate.target?.frame : 0;
      candidate.prepared = frame === expected;
    }
    advance();
  };

  return {
    setPaused(paused: boolean) {
      pauseRequested = paused;
      updateRestLoop();
    },

    request(playback: CompanionPlayback) {
      requested = playback;
      if (pending) pending.player.video.pause();
      pending = null;
      if (playback.kind === "static") {
        for (const player of players.values()) player.video.pause();
        displayed = null;
      }
      updateRestLoop();
    },

    mount(playback: CompanionPlayback, video: HTMLVideoElement) {
      if (requested?.key !== playback.key) return () => video.pause();
      const player: Player = { playback, video, serial: 0, frame: undefined };
      players.set(playback.key, player);
      const source =
        displayed &&
        !displayed.held &&
        TRANSITION_SOURCE[playback.kind] === displayed.playback.kind
          ? displayed
          : null;
      pending = { player, source, target: null, prepared: false, lead: PREPARE_FRAMES };
      const playbackRate = rates[playback.kind] ?? 1;
      video.defaultPlaybackRate = playbackRate;
      video.playbackRate = playbackRate;
      video.pause();
      video.currentTime = 0;

      let active = true;
      let frameCallback: number | undefined;
      let fallbackFrame: number | undefined;
      const watchFrame = (_now: number, metadata: FrameMetadata) => {
        if (!active) return;
        acceptFrame(player, metadata.mediaTime);
        if (active) {
          frameCallback = (video as FrameVideo).requestVideoFrameCallback?.(watchFrame);
        }
      };
      // 老引擎没有解码帧回调；保留安全的层所有权，用媒体时钟尽力同步。
      const watchMediaClock = () => {
        if (!active) return;
        if (video.readyState >= 2) acceptFrame(player, video.currentTime);
        fallbackFrame = requestAnimationFrame(watchMediaClock);
      };
      if (typeof (video as FrameVideo).requestVideoFrameCallback === "function") {
        frameCallback = (video as FrameVideo).requestVideoFrameCallback?.(watchFrame);
      } else {
        fallbackFrame = requestAnimationFrame(watchMediaClock);
      }
      const ended = () => {
        if (displayed !== player || requested?.key !== playback.key || player.held) return;
        if (pauseRequested && ["calm-loop", "exit-transition"].includes(playback.kind)) {
          // 保持已解码的静止帧在原视口里；单独 PNG 的轮廓不同，会破坏自然落地。
          player.held = true;
          video.pause();
          video.loop = false;
          onHeld(playback);
        } else {
          onEnded(playback);
        }
      };
      const failed = () => fail(player);
      video.addEventListener("loadeddata", advance);
      video.addEventListener("canplay", advance);
      video.addEventListener("ended", ended);
      video.addEventListener("error", failed);
      advance();

      return () => {
        active = false;
        if (frameCallback !== undefined) {
          (video as FrameVideo).cancelVideoFrameCallback?.(frameCallback);
        }
        if (fallbackFrame !== undefined) cancelAnimationFrame(fallbackFrame);
        video.removeEventListener("loadeddata", advance);
        video.removeEventListener("canplay", advance);
        video.removeEventListener("ended", ended);
        video.removeEventListener("error", failed);
        video.pause();
        players.delete(playback.key);
        if (displayed === player) displayed = null;
        if (pending?.player === player) pending = null;
      };
    },
  };
}
