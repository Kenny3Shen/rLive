import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Clock3, Plus, RadioTower } from "lucide-react";
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/ui/toast";
import { cn, normalizeCoverUrl, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";
import { invokeCmd } from "@/shared/api/tauri";
import { CARD_SURFACE_CLASS, CARD_SURFACE_HOVER_CLASS } from "@/shared/components/cardSurface";
import { SiteLogo } from "@/shared/components/SiteLogo";
import type { FollowUser, HistoryItem, LiveRoomDetail, SiteId } from "@/shared/types/live";
import { FOLLOW_LIST_QUERY_KEY } from "@/features/follow/followRefresh";
import {
  multiRoomKey,
  useMultiRoomStore,
  type MultiRoomAddResult,
  type MultiRoomCandidate,
} from "./multiRoomStore";

const SITE_OPTIONS: readonly SiteId[] = ["bilibili", "huya", "douyu", "douyin", "twitch", "acfun"];
const SITE_ITEMS = SITE_OPTIONS.map((siteId) => ({
  value: siteId,
  label: SITE_LABELS[siteId] ?? siteId,
}));

type PickerCandidate = MultiRoomCandidate & {
  source: "follow" | "history";
};

function addResultMessage(result: MultiRoomAddResult, capacity: number): void {
  if (result === "added") notify.success("已加入多画面");
  else if (result === "exists") notify.info("该直播间已在多画面中");
  else notify.error("多画面已满", `当前布局最多同时添加 ${capacity} 个直播间。`);
}

export function MultiRoomPickerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const slots = useMultiRoomStore((state) => state.slots);
  const layout = useMultiRoomStore((state) => state.layout);
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
  const full = activeKeys.size >= layout;

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
    addResultMessage(addRoom(candidate), layout);
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
      addResultMessage(result, layout);
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
        </DialogHeader>

        <form onSubmit={(event) => void addManualRoom(event)}>
          <FieldGroup className="gap-4">
            <FieldGroup className="grid grid-cols-[minmax(8rem,10rem)_minmax(0,1fr)] items-start gap-3">
              <Field data-disabled={manualPending || full ? true : undefined}>
                <FieldLabel htmlFor="multi-room-site">平台</FieldLabel>
                <Select
                  items={SITE_ITEMS}
                  value={siteId}
                  disabled={manualPending || full}
                  onValueChange={(next) => {
                    const nextSite = next as SiteId | null;
                    if (!nextSite || !SITE_OPTIONS.includes(nextSite)) return;
                    setSiteId(nextSite);
                    if (manualError) setManualError(null);
                  }}
                >
                  <SelectTrigger
                    id="multi-room-site"
                    className="w-full border border-input bg-background"
                  >
                    <SiteLogo siteId={siteId} className="size-4" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectGroup>
                      {SITE_ITEMS.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          aria-label={option.label}
                        >
                          <span
                            className="flex size-4 shrink-0 items-center justify-center"
                            aria-hidden
                          >
                            {siteId === option.value && <Check aria-hidden />}
                          </span>
                          <SiteLogo siteId={option.value} />
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field
                data-invalid={manualError ? true : undefined}
                data-disabled={manualPending || full ? true : undefined}
              >
                <FieldLabel htmlFor="multi-room-id">房间号</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="multi-room-id"
                    value={roomId}
                    placeholder="输入房间号"
                    autoComplete="off"
                    aria-invalid={manualError ? true : undefined}
                    disabled={manualPending || full}
                    onChange={(event) => {
                      setRoomId(event.target.value);
                      if (manualError) setManualError(null);
                    }}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      type="submit"
                      variant="secondary"
                      disabled={manualPending || full}
                    >
                      {/* xs 按钮内图标与 Button 基础规则同权重，显式定尺寸避免加载态跳动。 */}
                      {manualPending ? (
                        <Spinner className="size-3.5" data-icon="inline-start" aria-hidden />
                      ) : (
                        <Plus className="size-3.5" data-icon="inline-start" aria-hidden />
                      )}
                      添加
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {manualError && <FieldError>{manualError}</FieldError>}
              </Field>
            </FieldGroup>
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
                const roomTitle = candidate.title?.trim() || "";
                const displayName = candidate.user_name || roomTitle || "直播间";
                const historyTitle =
                  candidate.source === "history" && roomTitle && roomTitle !== displayName
                    ? roomTitle
                    : null;
                const imageSrc =
                  candidate.source === "follow"
                    ? normalizeImageUrl(candidate.cover)
                    : normalizeCoverUrl(candidate.cover);
                return (
                  <Card
                    key={key}
                    size="sm"
                    data-multi-room-candidate={key}
                    className={cn(
                      "min-w-0 gap-2 py-3 transition-[background-color,box-shadow]",
                      CARD_SURFACE_CLASS,
                      CARD_SURFACE_HOVER_CLASS,
                    )}
                  >
                    <CardHeader className="min-w-0 items-center gap-x-2.5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar size="lg">
                          <AvatarImage src={imageSrc} alt="" referrerPolicy="no-referrer" />
                          <AvatarFallback>{displayName.slice(0, 1)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <CardTitle className="truncate" title={displayName}>
                            {displayName}
                          </CardTitle>
                          <CardDescription className="truncate">
                            {SITE_LABELS[candidate.site_id] ?? candidate.site_id}，房间{" "}
                            {candidate.room_id}
                          </CardDescription>
                        </div>
                      </div>
                      <CardAction className="self-center">
                        <Button
                          type="button"
                          variant={added ? "secondary" : "outline"}
                          size="sm"
                          disabled={added || full}
                          aria-label={
                            added
                              ? `${displayName}已添加`
                              : full
                                ? "多画面已满"
                                : `将${displayName}加入多画面`
                          }
                          onClick={() => addCandidate(candidate)}
                        >
                          {added ? (
                            <Check data-icon="inline-start" aria-hidden />
                          ) : (
                            <Plus data-icon="inline-start" aria-hidden />
                          )}
                          {added ? "已添加" : full ? "已满" : "加入"}
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="flex min-h-5 min-w-0 items-center gap-1.5 overflow-hidden">
                      <Badge variant="outline" className="shrink-0">
                        {candidate.source === "follow" ? (
                          <RadioTower aria-hidden />
                        ) : (
                          <Clock3 aria-hidden />
                        )}
                        {candidate.source === "follow" ? "关注" : "最近观看"}
                      </Badge>
                      {historyTitle && (
                        <span className="truncate text-muted-foreground">{historyTitle}</span>
                      )}
                    </CardContent>
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
