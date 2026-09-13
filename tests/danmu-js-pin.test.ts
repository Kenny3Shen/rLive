import { describe, expect, test } from "bun:test";
import {
  releaseDanmuJsPin,
  removeDanmuJsPin,
} from "../src/features/room/danmaku/danmuJsPin";

describe("danmu.js pin", () => {
  test("releases pin from instance", () => {
    const mockInstance = {
      removeComment: (id: string) => {},
    } as any;
    
    expect(() => releaseDanmuJsPin(mockInstance, "pin:100")).not.toThrow();
  });

  test("removes pin from instance", () => {
    const mockInstance = {
      removeComment: (id: string) => {},
    } as any;
    
    expect(() => removeDanmuJsPin(mockInstance, "pin:100")).not.toThrow();
  });
});
