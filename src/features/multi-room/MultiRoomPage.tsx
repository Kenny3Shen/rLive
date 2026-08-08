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
import { ChevronLeft, Grip, Monitor, Plus, RadioTower, Trash2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { isMobileClient } from "@/shared/clientPlatform";
import { MultiRoomPickerDialog } from "./MultiRoomPickerDialog";
import { MultiRoomPlayer } from "./MultiRoomPlayer";
import { isMultiRoomMainSlot, multiRoomSlotClassName, multiRoomSlotLabel } from "./multiRoomLayout";
import { MULTI_ROOM_MAX_SLOTS, useMultiRoomStore, type MultiRoomEntry } from "./multiRoomStore";

const MULTI_ROOM_DND_INSTRUCTIONS = {
  draggable: "按空格键选中画面，使用方向键移动，按空格键放置，按 Escape 取消。",
};

function EmptySlot({ index, onAdd }: { index: number; onAdd: () => void }) {
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
        multiRoomSlotClassName(index),
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
              aria-label={`添加到${multiRoomSlotLabel(index)}`}
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

function OccupiedSlot({ index, room }: { index: number; room: MultiRoomEntry }) {
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
        multiRoomSlotClassName(index),
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
  const moveRoom = useMultiRoomStore((state) => state.moveRoom);
  const clear = useMultiRoomStore((state) => state.clear);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 160, tolerance: 5 } }),
    useSensor(KeyboardSensor),
  );
  const roomCount = useMemo(() => slots.filter(Boolean).length, [slots]);

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
          {roomCount}/{MULTI_ROOM_MAX_SLOTS}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="添加直播间"
                  disabled={roomCount >= MULTI_ROOM_MAX_SLOTS}
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
          className="grid min-h-0 flex-1 grid-cols-3 grid-rows-3 gap-px overflow-hidden bg-border/60"
        >
          {slots.map((room, index) =>
            room ? (
              <OccupiedSlot key={room.key} index={index} room={room} />
            ) : (
              <EmptySlot key={`empty:${index}`} index={index} onAdd={() => setPickerOpen(true)} />
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
