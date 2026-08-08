import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock3, Plus, RadioTower } from "lucide-react";
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { notify } from "@/components/ui/toast";
import { SITE_LABELS } from "@/lib/utils";
import { invokeCmd } from "@/shared/api/tauri";
import type { FollowUser, HistoryItem, LiveRoomDetail, SiteId } from "@/shared/types/live";
import { FOLLOW_LIST_QUERY_KEY } from "@/features/follow/followRefresh";
import {
  MULTI_ROOM_MAX_SLOTS,
  multiRoomKey,
  useMultiRoomStore,
  type MultiRoomAddResult,
  type MultiRoomCandidate,
} from "./multiRoomStore";

const SITE_OPTIONS: readonly SiteId[] = ["bilibili", "huya", "douyu", "douyin", "twitch"];

type PickerCandidate = MultiRoomCandidate & {
  source: "follow" | "history";
};

function addResultMessage(result: MultiRoomAddResult): void {
  if (result === "added") notify.success("已加入多画面");
  else if (result === "exists") notify.info("该直播间已在多画面中");
  else notify.error("多画面已满", `最多同时添加 ${MULTI_ROOM_MAX_SLOTS} 个直播间。`);
}

export function MultiRoomPickerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const slots = useMultiRoomStore((state) => state.slots);
  const addRoom = useMultiRoomStore((state) => state.addRoom);
  const [siteId, setSiteId] = useState<SiteId>("bilibili");
  const [roomId, setRoomId] = useState("");
  const [manualPending, setManualPending] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const followsQuery = useQuery({
    queryKey: FOLLOW_LIST_QUERY_KEY,
    queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
    enabled: open,
    staleTime: 15_000,
  });
  const historyQuery = useQuery({
    queryKey: ["history", "multi-room-picker"],
    queryFn: () => invokeCmd<HistoryItem[]>("history_list", { siteId: null }),
    enabled: open,
    staleTime: 15_000,
  });
  const activeKeys = useMemo(
    () => new Set(slots.flatMap((room) => (room ? [room.key] : []))),
    [slots],
  );
  const full = activeKeys.size >= MULTI_ROOM_MAX_SLOTS;

  const candidates = useMemo(() => {
    const result: PickerCandidate[] = [];
    const seen = new Set<string>();
    const append = (candidate: PickerCandidate) => {
      const key = multiRoomKey(candidate.site_id, candidate.room_id);
      if (seen.has(key)) return;
      seen.add(key);
      result.push(candidate);
    };
    for (const follow of followsQuery.data ?? []) {
      append({
        site_id: follow.site_id,
        room_id: follow.room_id,
        title: follow.user_name,
        user_name: follow.user_name,
        cover: follow.face,
        source: "follow",
      });
    }
    for (const item of historyQuery.data ?? []) {
      append({
        site_id: item.site_id,
        room_id: item.room_id,
        title: item.title,
        user_name: item.user_name,
        cover: item.cover,
        source: "history",
      });
    }
    return result.slice(0, 80);
  }, [followsQuery.data, historyQuery.data]);

  function addCandidate(candidate: MultiRoomCandidate) {
    addResultMessage(addRoom(candidate));
  }

  async function addManualRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedRoomId = roomId.trim();
    if (!normalizedRoomId) {
      setManualError("请输入房间号");
      return;
    }
    setManualPending(true);
    setManualError(null);
    try {
      const detail = await invokeCmd<LiveRoomDetail>("site_get_room_detail", {
        siteId,
        roomId: normalizedRoomId,
      });
      const result = addRoom({
        site_id: detail.site_id,
        room_id: detail.room_id,
        title: detail.title,
        user_name: detail.user_name,
        cover: detail.cover,
      });
      addResultMessage(result);
      if (result === "added") setRoomId("");
    } catch (error) {
      const message =
        typeof error === "object" && error && "message" in error
          ? String(error.message)
          : "无法获取该直播间";
      setManualError(message || "无法获取该直播间");
    } finally {
      setManualPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl overflow-x-hidden overscroll-y-contain touch-pan-y">
        <DialogHeader>
          <DialogTitle>添加直播间</DialogTitle>
          <DialogDescription>
            可输入平台房间号，或从关注与观看历史中选择。当前 {activeKeys.size}/
            {MULTI_ROOM_MAX_SLOTS} 路。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void addManualRoom(event)}>
          <FieldGroup>
            <FieldSet>
              <FieldLegend variant="label">平台</FieldLegend>
              <ToggleGroup
                value={[siteId]}
                spacing={0}
                variant="outline"
                size="sm"
                className="max-w-full flex-wrap"
                aria-label="选择直播平台"
                onValueChange={(value) => {
                  const next = value[0];
                  if (SITE_OPTIONS.includes(next as SiteId)) setSiteId(next as SiteId);
                }}
              >
                {SITE_OPTIONS.map((option) => (
                  <ToggleGroupItem key={option} value={option}>
                    {SITE_LABELS[option] ?? option}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>

            <Field data-invalid={manualError ? true : undefined}>
              <FieldLabel htmlFor="multi-room-id">房间号</FieldLabel>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  id="multi-room-id"
                  className="min-w-0 flex-1"
                  value={roomId}
                  placeholder="输入平台房间号"
                  autoComplete="off"
                  aria-invalid={manualError ? true : undefined}
                  disabled={manualPending || full}
                  onChange={(event) => {
                    setRoomId(event.target.value);
                    if (manualError) setManualError(null);
                  }}
                />
                <Button
                  type="submit"
                  className="w-full shrink-0 sm:w-auto"
                  disabled={manualPending || full}
                >
                  {manualPending ? (
                    <Spinner data-icon="inline-start" aria-hidden />
                  ) : (
                    <Plus data-icon="inline-start" aria-hidden />
                  )}
                  添加
                </Button>
              </div>
              <FieldDescription>房间号会先由平台解析，成功后立即开始播放。</FieldDescription>
              {manualError && <FieldError>{manualError}</FieldError>}
            </Field>

            <FieldSeparator>关注与最近观看</FieldSeparator>
          </FieldGroup>
        </form>

        <ScrollArea className="h-72 min-w-0 overflow-x-hidden rounded-lg bg-muted/25">
          <div className="grid min-w-0 grid-cols-1 gap-2 p-2 sm:grid-cols-2">
            {followsQuery.isLoading || historyQuery.isLoading ? (
              <div className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner aria-hidden />
                正在加载…
              </div>
            ) : candidates.length === 0 ? (
              <div className="flex h-24 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
                <RadioTower aria-hidden />
                暂无可选直播间
              </div>
            ) : (
              candidates.map((candidate) => {
                const key = multiRoomKey(candidate.site_id, candidate.room_id);
                const added = activeKeys.has(key);
                return (
                  <Card
                    key={key}
                    size="sm"
                    data-multi-room-candidate={key}
                    className="min-w-0 gap-2"
                  >
                    <CardHeader className="min-w-0 gap-1.5">
                      <div className="flex min-w-0 items-start gap-2">
                        {candidate.source === "follow" ? (
                          <RadioTower className="mt-0.5 shrink-0" aria-hidden />
                        ) : (
                          <Clock3 className="mt-0.5 shrink-0" aria-hidden />
                        )}
                        <div className="min-w-0 flex-1">
                          <CardTitle
                            className="truncate"
                            title={candidate.title || candidate.user_name}
                          >
                            {candidate.title || candidate.user_name || "直播间"}
                          </CardTitle>
                          <CardDescription className="truncate">
                            {SITE_LABELS[candidate.site_id] ?? candidate.site_id} · 房间{" "}
                            {candidate.room_id}
                          </CardDescription>
                        </div>
                        <Badge variant={added ? "secondary" : "outline"} className="shrink-0">
                          {added ? "已添加" : candidate.source === "follow" ? "关注" : "历史"}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardFooter className="border-0 bg-transparent pt-0">
                      <Button
                        type="button"
                        variant={added ? "secondary" : "outline"}
                        className="w-full"
                        disabled={added || full}
                        onClick={() => addCandidate(candidate)}
                      >
                        <Plus data-icon="inline-start" aria-hidden />
                        {added ? "已添加" : "加入多画面"}
                      </Button>
                    </CardFooter>
                  </Card>
                );
              })
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <DialogCloseButton>完成</DialogCloseButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
