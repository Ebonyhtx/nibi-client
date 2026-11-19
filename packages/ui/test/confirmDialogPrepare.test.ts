import { afterEach, describe, expect, it } from "vitest";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

afterEach(() => {
  useConfirmDialogStore.getState().settleChoice("cancel");
});

describe("confirm dialog prepare", () => {
  it("打开时先禁用确认，prepare 结果合并后再启用", async () => {
    let resolvePrepare!: (patch: { description: string; confirmDisabled: boolean }) => void;
    const prepare = () =>
      new Promise<{ description: string; confirmDisabled: boolean }>((resolve) => {
        resolvePrepare = resolve;
      });
    const pending = useConfirmDialogStore.getState().requestChoice({
      title: "Delete",
      description: "Checking…",
      prepare,
    });
    expect(useConfirmDialogStore.getState().pendingRequest).toMatchObject({
      description: "Checking…",
      preparePending: true,
    });
    resolvePrepare({ description: "Nothing deletable", confirmDisabled: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(useConfirmDialogStore.getState().pendingRequest).toMatchObject({
      description: "Nothing deletable",
      confirmDisabled: true,
      preparePending: false,
      prepare: undefined,
    });
    useConfirmDialogStore.getState().settleChoice("cancel");
    await expect(pending).resolves.toBe("cancel");
  });

  it("prepare 失败时恢复可操作状态，不阻塞取消", async () => {
    const pending = useConfirmDialogStore.getState().requestChoice({
      title: "Delete",
      prepare: async () => {
        throw new Error("preview failed");
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(useConfirmDialogStore.getState().pendingRequest).toMatchObject({
      preparePending: false,
    });
    useConfirmDialogStore.getState().settleChoice("cancel");
    await expect(pending).resolves.toBe("cancel");
  });

  it("准备期间取消后，迟到的 prepare 结果不能改写下一个弹窗", async () => {
    let resolvePrepare!: () => void;
    const prepare = () =>
      new Promise<void>((resolve) => {
        resolvePrepare = resolve;
      });
    const first = useConfirmDialogStore.getState().requestChoice({ title: "First", prepare });
    useConfirmDialogStore.getState().settleChoice("cancel");
    await expect(first).resolves.toBe("cancel");

    const second = useConfirmDialogStore.getState().requestChoice({ title: "Second" });
    resolvePrepare();
    await Promise.resolve();
    await Promise.resolve();
    expect(useConfirmDialogStore.getState().pendingRequest).toMatchObject({ title: "Second" });
    useConfirmDialogStore.getState().settleChoice("cancel");
    await expect(second).resolves.toBe("cancel");
  });
});
