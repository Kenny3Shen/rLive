import { describe, expect, test } from "bun:test";
import {
  publishLocalPendingSubmission,
  subscribeLocalPendingSubmissions,
} from "../src/features/room/danmaku/localPendingSubmission";

describe("local pending submissions", () => {
  test("routes a submission only to its platform and normalized room", () => {
    const received: string[] = [];
    const unsubscribers = [
      subscribeLocalPendingSubmissions("bilibili", "  1001  ", (submission) => {
        received.push(`bilibili:${submission.roomId}:${submission.content}`);
      }),
      subscribeLocalPendingSubmissions("douyu", "1001", (submission) => {
        received.push(`douyu:${submission.roomId}:${submission.content}`);
      }),
      subscribeLocalPendingSubmissions("bilibili", "1002", (submission) => {
        received.push(`other-room:${submission.roomId}:${submission.content}`);
      }),
    ];

    const bilibili = publishLocalPendingSubmission({
      siteId: "bilibili",
      roomId: " 1001 ",
      content: "  B 站已发送  ",
      submittedAt: 1_000,
    });
    const douyu = publishLocalPendingSubmission({
      siteId: "douyu",
      roomId: "1001",
      content: "斗鱼已发送",
      submittedAt: 2_000,
    });

    expect(bilibili).toMatchObject({
      source: "local-pending",
      siteId: "bilibili",
      roomId: "1001",
      content: "B 站已发送",
      submittedAt: 1_000,
    });
    expect(douyu).toMatchObject({
      siteId: "douyu",
      roomId: "1001",
      content: "斗鱼已发送",
    });
    expect(received).toEqual(["bilibili:1001:B 站已发送", "douyu:1001:斗鱼已发送"]);

    for (const unsubscribe of unsubscribers) unsubscribe();
  });

  test("unsubscribing one listener leaves other listeners and routes intact", () => {
    const received: string[] = [];
    const unsubscribeFirst = subscribeLocalPendingSubmissions("huya", "2001", () => {
      received.push("first");
    });
    const unsubscribeSecond = subscribeLocalPendingSubmissions("huya", "2001", () => {
      received.push("second");
    });
    const unsubscribeOtherRoom = subscribeLocalPendingSubmissions("huya", "2002", () => {
      received.push("other-room");
    });

    unsubscribeFirst();
    publishLocalPendingSubmission({
      siteId: "huya",
      roomId: "2001",
      content: "only the remaining listener",
      submittedAt: 3_000,
    });
    unsubscribeSecond();
    publishLocalPendingSubmission({
      siteId: "huya",
      roomId: "2001",
      content: "no listeners remain",
      submittedAt: 4_000,
    });
    publishLocalPendingSubmission({
      siteId: "huya",
      roomId: "2002",
      content: "other route remains live",
      submittedAt: 5_000,
    });

    expect(received).toEqual(["second", "other-room"]);

    unsubscribeOtherRoom();
  });
});
