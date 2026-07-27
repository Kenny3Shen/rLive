import { describe, expect, test } from "bun:test";
import {
  canUsePictureInPicture,
  toggleVideoPictureInPicture,
  type PictureInPictureDocument,
} from "../src/features/room/player/useWebPlayer";

type TestVideo = Pick<HTMLVideoElement, "disablePictureInPicture" | "requestPictureInPicture">;

function createTestVideo(onRequest: () => Promise<void>): TestVideo {
  return {
    disablePictureInPicture: false,
    requestPictureInPicture: async () => {
      await onRequest();
      return {} as PictureInPictureWindow;
    },
  };
}

describe("native picture-in-picture", () => {
  test("only exposes the control when the document and video both support it", () => {
    const video = createTestVideo(async () => {});

    expect(canUsePictureInPicture({ pictureInPictureEnabled: true }, video)).toBe(true);
    expect(canUsePictureInPicture({ pictureInPictureEnabled: false }, video)).toBe(false);
    expect(canUsePictureInPicture({ pictureInPictureEnabled: true }, null)).toBe(false);
    expect(
      canUsePictureInPicture(
        { pictureInPictureEnabled: true },
        {
          ...video,
          disablePictureInPicture: true,
        },
      ),
    ).toBe(false);
  });

  test("enters and exits PiP through the native video and document APIs", async () => {
    let requests = 0;
    let exits = 0;
    const video = createTestVideo(async () => {
      requests += 1;
    });
    const documentRef: PictureInPictureDocument = {
      pictureInPictureEnabled: true,
      pictureInPictureElement: null,
      exitPictureInPicture: async () => {
        exits += 1;
        documentRef.pictureInPictureElement = null;
      },
    };

    expect(await toggleVideoPictureInPicture(documentRef, video)).toBe(true);
    expect(requests).toBe(1);
    expect(exits).toBe(0);

    documentRef.pictureInPictureElement = video as unknown as Element;
    expect(await toggleVideoPictureInPicture(documentRef, video)).toBe(true);
    expect(requests).toBe(1);
    expect(exits).toBe(1);
  });

  test("contains native PiP failures without affecting playback state", async () => {
    const video = createTestVideo(async () => {
      throw new Error("native PiP rejected");
    });

    expect(
      await toggleVideoPictureInPicture(
        { pictureInPictureEnabled: true, pictureInPictureElement: null },
        video,
      ),
    ).toBe(false);
  });
});
