import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  ChevronLeft,
  Grip,
  LayoutGrid,
  LayoutPanelLeft,
  Monitor,
  Plus,
  RadioTower,
  Trash2,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { isMobileClient } from "@/shared/clientPlatform";
import { MultiRoomPickerDialog } from "./MultiRoomPickerDialog";
import { MultiRoomPlayer } from "./MultiRoomPlayer";
import {
  isMultiRoomMainSlot,
  multiRoomGridClassName,
  multiRoomSlotClassName,
  multiRoomSlotLabel,
} from "./multiRoomLayout";
import {
  MULTI_ROOM_FOUR_LAYOUT_OPTIONS,
  MULTI_ROOM_LAYOUT_OPTIONS,
  useMultiRoomStore,
  type MultiRoomEntry,
  type MultiRoomFourLayout,
  type MultiRoomLayout,
} from "./multiRoomStore";

const MULTI_ROOM_DND_INSTRUCTIONS = {
  draggable: "按空格键选中画面，使用方向键移动，按空格键放置，按 Escape 取消。",
};

function EmptySlot({
  index,
  fourLayout,
  layout,
  onAdd,
}: {
  index: number;
  fourLayout: MultiRoomFourLayout;
  layout: MultiRoomLayout;
  onAdd: () => void;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `multi-room-slot:${index}`,
    data: { slotIndex: index },
  });

  return (
    <div
      ref={setNodeRef}
      data-multi-room-slot={index}
      data-empty="true"
      className={cn(
        "flex min-h-0 items-center justify-center overflow-hidden bg-muted/20",
        multiRoomSlotClassName(index, layout, fourLayout),
        isOver && "bg-primary/15 ring-2 ring-inset ring-primary",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label={`添加到${multiRoomSlotLabel(index, layout, fourLayout)}`}
              onClick={onAdd}
            />
          }
        >
          <Plus data-icon="inline-start" aria-hidden />
        </TooltipTrigger>
        <TooltipContent>添加直播间</TooltipContent>
      </Tooltip>
    </div>
  );
}

function OccupiedSlot({
  index,
  fourLayout,
  layout,
  room,
}: {
  index: number;
  fourLayout: MultiRoomFourLayout;
  layout: MultiRoomLayout;
  room: MultiRoomEntry;
}) {
  const { isOver, setNodeRef: setDroppableNodeRef } = useDroppable({
    id: `multi-room-slot:${index}`,
    data: { slotIndex: index },
  });
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef: setDraggableNodeRef,
    transform,
  } = useDraggable({
    id: `multi-room-player:${room.key}`,
    data: { slotIndex: index, roomKey: room.key },
  });
  const setNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      setDroppableNodeRef(node);
      setDraggableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  const dragHandle = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={setActivatorNodeRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="cursor-grab bg-black/45 text-white active:cursor-grabbing hover:bg-black/70 hover:text-white"
            aria-label={`移动${room.title}`}
            {...attributes}
            {...listeners}
          />
        }
      >
        <Grip data-icon="inline-start" aria-hidden />
      </TooltipTrigger>
      <TooltipContent>移动画面</TooltipContent>
    </Tooltip>
  );

  return (
    <div
      ref={setNodeRef}
      data-multi-room-slot={index}
      data-room-key={room.key}
      className={cn(
        "relative min-h-0 min-w-0 overflow-hidden bg-black",
        multiRoomSlotClassName(index, layout, fourLayout),
        isOver && !isDragging && "ring-2 ring-inset ring-primary",
        isDragging && "opacity-45",
      )}
      style={style}
    >
      <MultiRoomPlayer room={room} main={isMultiRoomMainSlot(index)} dragHandle={dragHandle} />
    </div>
  );
}

export function MultiRoomPage() {
  const navigate = useNavigate();
  const slots = useMultiRoomStore((state) => state.slots);
  const layout = useMultiRoomStore((state) => state.layout);
  const fourLayout = useMultiRoomStore((state) => state.fourLayout);
  const moveRoom = useMultiRoomStore((state) => state.moveRoom);
  const setLayout = useMultiRoomStore((state) => state.setLayout);
  const setFourLayout = useMultiRoomStore((state) => state.setFourLayout);
  const clear = useMultiRoomStore((state) => state.clear);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 160, tolerance: 5 } }),
    useSensor(KeyboardSensor),
  );
  const roomCount = useMemo(() => slots.filter(Boolean).length, [slots]);
  const visibleSlots = useMemo(() => slots.slice(0, layout), [layout, slots]);

  function goBack() {
    const historyState = window.history.state as { idx?: number } | null;
    if (typeof historyState?.idx === "number" && historyState.idx > 0) navigate(-1);
    else navigate("/", { replace: true });
  }

  function handleDragEnd(event: DragEndEvent) {
    const sourceIndex = Number(event.active.data.current?.slotIndex);
    const targetIndex = Number(event.over?.data.current?.slotIndex);
    if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) return;
    moveRoom(sourceIndex, targetIndex);
  }

  if (isMobileClient()) {
    return (
      <div className="flex h-full flex-col bg-background">
        <header className="flex h-11 shrink-0 items-center border-b border-border px-3">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="返回" onClick={goBack}>
            <ChevronLeft data-icon="inline-start" aria-hidden />
          </Button>
          <strong className="ml-2 text-sm font-medium">多画面</strong>
        </header>
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Monitor aria-hidden />
            </EmptyMedia>
            <EmptyTitle>多画面仅支持桌面端</EmptyTitle>
            <EmptyDescription>移动端继续使用单直播间播放。</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" variant="outline" onClick={goBack}>
              返回
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div data-multi-room-page className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/80 bg-sidebar/90 px-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="返回上一页"
                onClick={goBack}
              />
            }
          >
            <ChevronLeft data-icon="inline-start" aria-hidden />
          </TooltipTrigger>
          <TooltipContent>返回上一页</TooltipContent>
        </Tooltip>
        <RadioTower className="size-4 text-primary" aria-hidden />
        <strong className="text-sm font-medium">多画面</strong>
        <Badge variant="secondary" className="tabular-nums">
          {roomCount}/{layout}
        </Badge>
        <ToggleGroup
          value={[String(layout)]}
          spacing={0}
          variant="outline"
          size="sm"
          aria-label="多画面布局"
          onValueChange={(value) => {
            const next = Number(value[0]);
            if (MULTI_ROOM_LAYOUT_OPTIONS.includes(next as MultiRoomLayout)) {
              setLayout(next as MultiRoomLayout);
            }
          }}
        >
          {MULTI_ROOM_LAYOUT_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option}
              value={String(option)}
              aria-label={`${option} 画面布局`}
              disabled={option === 4 && roomCount > 4}
              title={option === 4 && roomCount > 4 ? "请先将直播间减少到 4 路" : undefined}
            >
              {option}画面
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {layout === 4 && (
          <ToggleGroup
            value={[fourLayout]}
            spacing={0}
            variant="outline"
            size="sm"
            aria-label="四画面排列"
            onValueChange={(value) => {
              const next = value[0];
              if (MULTI_ROOM_FOUR_LAYOUT_OPTIONS.includes(next as MultiRoomFourLayout)) {
                setFourLayout(next as MultiRoomFourLayout);
              }
            }}
          >
            <Tooltip>
              <TooltipTrigger
                render={<ToggleGroupItem value="main-left" aria-label="主画面靠左排列" />}
              >
                <LayoutPanelLeft aria-hidden />
              </TooltipTrigger>
              <TooltipContent>主画面靠左</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={<ToggleGroupItem value="equal" aria-label="四画面均分排列" />}
              >
                <LayoutGrid aria-hidden />
              </TooltipTrigger>
              <TooltipContent>四画面均分</TooltipContent>
            </Tooltip>
          </ToggleGroup>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="添加直播间"
                  disabled={roomCount >= layout}
                  onClick={() => setPickerOpen(true)}
                />
              }
            >
              <Plus data-icon="inline-start" aria-hidden />
            </TooltipTrigger>
            <TooltipContent>添加直播间</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="清空多画面"
                  disabled={roomCount === 0}
                  onClick={() => setClearOpen(true)}
                />
              }
            >
              <Trash2 data-icon="inline-start" aria-hidden />
            </TooltipTrigger>
            <TooltipContent>清空多画面</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <DndContext
        sensors={sensors}
        collisionDetection={rectIntersection}
        accessibility={{ screenReaderInstructions: MULTI_ROOM_DND_INSTRUCTIONS }}
        onDragEnd={handleDragEnd}
      >
        <div
          data-multi-room-grid
          data-multi-room-layout={layout === 4 ? fourLayout : "six"}
          className={cn(
            "grid min-h-0 flex-1 gap-px overflow-hidden bg-border/60",
            multiRoomGridClassName(layout, fourLayout),
          )}
        >
          {visibleSlots.map((room, index) =>
            room ? (
              <OccupiedSlot
                key={room.key}
                index={index}
                fourLayout={fourLayout}
                layout={layout}
                room={room}
              />
            ) : (
              <EmptySlot
                key={`empty:${index}`}
                index={index}
                fourLayout={fourLayout}
                layout={layout}
                onAdd={() => setPickerOpen(true)}
              />
            ),
          )}
        </div>
      </DndContext>

      <MultiRoomPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} />

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Trash2 aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>清空多画面</AlertDialogTitle>
            <AlertDialogDescription>将关闭全部 {roomCount} 路直播流。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                clear();
                setClearOpen(false);
              }}
            >
              清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
