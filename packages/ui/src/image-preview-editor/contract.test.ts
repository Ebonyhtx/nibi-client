import { describe, expect, it } from "vitest";
import type { ImageEditorOutput } from "./contract.js";
import { exampleImageComposerTarget } from "./contract.example.js";
import { imagePreviewEditorModule } from "./module.js";

const OUTPUT: ImageEditorOutput = {
  bytes: new Uint8Array([1, 2, 3]),
  mediaType: "image/png",
  filename: "diagram-annotated.png",
  width: 640,
  height: 480,
  changed: true,
};

describe("image-preview-editor contract", () => {
  it("declares a managed module with public entrypoints", () => {
    expect(imagePreviewEditorModule.id).toBe("image-preview-editor");
    expect(imagePreviewEditorModule.requires).toEqual(["ui"]);
    expect(imagePreviewEditorModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("only admits non-empty annotated PNG payloads in the example target", () => {
    expect(exampleImageComposerTarget.appendImage(OUTPUT)).toBe(true);
    expect(exampleImageComposerTarget.appendImage({ ...OUTPUT, bytes: new Uint8Array() })).toBe(
      false,
    );
  });
});
