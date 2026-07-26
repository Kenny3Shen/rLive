import type { SiteId } from "@/shared/types/live";
import { isDanmakuSendSite, type DanmakuSendSiteId } from "./sending";

/**
 * A successful local write request that still awaits a platform chat echo.
 * It exists only in memory and never enters the native `danmaku-batch` path.
 */
export type LocalPendingSubmission = Readonly<{
  source: "local-pending";
  siteId: DanmakuSendSiteId;
  roomId: string;
  id: string;
  content: string;
  submittedAt: number;
}>;

type LocalPendingSubmissionSubscriber = (submission: LocalPendingSubmission) => void;

const subscribersByRoom = new Map<string, Set<LocalPendingSubmissionSubscriber>>();
let sequence = 0;

function routeKey(siteId: DanmakuSendSiteId, roomId: string): string {
  return `${siteId}\u0000${roomId}`;
}

/**
 * Publish a visible local-pending marker only after the corresponding Tauri
 * send command resolved. There is intentionally no replay buffer: a room
 * that has been left must never render a stale submission from another room.
 */
export function publishLocalPendingSubmission(input: {
  siteId: DanmakuSendSiteId;
  roomId: string;
  content: string;
  submittedAt?: number;
}): LocalPendingSubmission | null {
  const roomId = input.roomId.trim();
  const content = input.content.trim();
  const submittedAt = input.submittedAt ?? Date.now();
  if (!roomId || !content || !Number.isFinite(submittedAt)) return null;

  const submission: LocalPendingSubmission = {
    source: "local-pending",
    siteId: input.siteId,
    roomId,
    id: `local-${Math.trunc(submittedAt)}-${++sequence}`,
    content,
    submittedAt: Math.trunc(submittedAt),
  };
  const subscribers = subscribersByRoom.get(routeKey(input.siteId, roomId));
  if (!subscribers) return submission;

  // A panel can unsubscribe while another surface handles this same submit.
  // Snapshot + isolation keeps the local UI marker best-effort without
  // suppressing the Canvas or chat-list subscriber.
  for (const subscriber of Array.from(subscribers)) {
    try {
      subscriber(submission);
    } catch {
      // Local display sinks must not affect the underlying send result.
    }
  }
  return submission;
}

/** Subscribe only to pending submissions for one supported platform room. */
export function subscribeLocalPendingSubmissions(
  siteId: SiteId | undefined,
  roomId: string | undefined,
  subscriber: LocalPendingSubmissionSubscriber,
): () => void {
  if (!isDanmakuSendSite(siteId)) return () => {};
  const normalizedRoomId = roomId?.trim();
  if (!normalizedRoomId) return () => {};

  const key = routeKey(siteId, normalizedRoomId);
  const subscribers = subscribersByRoom.get(key) ?? new Set<LocalPendingSubmissionSubscriber>();
  subscribers.add(subscriber);
  subscribersByRoom.set(key, subscribers);

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) subscribersByRoom.delete(key);
  };
}
