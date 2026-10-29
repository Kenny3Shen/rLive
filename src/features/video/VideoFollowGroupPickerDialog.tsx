import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Heart, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { invokeCmd } from "@/shared/api/tauri";
import {
  upsertVideoFollowGroupInCache,
  useVideoFollowGroups,
  type VideoFollowGroup,
} from "./videoFollows";

const UNGROUPED_VALUE = "__ungrouped__";

type VideoFollowGroupPickerDialogProps = {
  open: boolean;
  uploaderName: string;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (groupId: string | null) => void | Promise<void>;
};

export function VideoFollowGroupPickerDialog({
  open,
  uploaderName,
  pending = false,
  onOpenChange,
  onConfirm,
}: VideoFollowGroupPickerDialogProps) {
  const queryClient = useQueryClient();
  const [selectedGroupId, setSelectedGroupId] = useState(UNGROUPED_VALUE);
  const [newGroupName, setNewGroupName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const groupsQuery = useVideoFollowGroups(open);

  const createGroupMutation = useMutation({
    mutationFn: (name: string) =>
      invokeCmd<VideoFollowGroup>("video_follow_group_upsert", { name }),
    onSuccess: (group) => {
      upsertVideoFollowGroupInCache(queryClient, group);
      setSelectedGroupId(group.id);
      setNewGroupName("");
      setError(null);
    },
    onError: () => setError("分组创建失败，请检查名称是否重复。"),
  });

  const [previousOpen, setPreviousOpen] = useState(open);
  if (open !== previousOpen) {
    setPreviousOpen(open);
    if (open) {
      setSelectedGroupId(UNGROUPED_VALUE);
      setNewGroupName("");
      setError(null);
    }
  }

  function createGroup() {
    const name = newGroupName.trim();
    if (!name) {
      setError("请输入分组名称。");
      return;
    }
    createGroupMutation.mutate(name);
  }

  const busy = pending || createGroupMutation.isPending;
  const groups = groupsQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>关注 {uploaderName}</DialogTitle>
          <DialogDescription>选择这位 UP 主在「视频关注」中的分组。</DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field
            data-invalid={groupsQuery.isError ? true : undefined}
            data-disabled={busy || groupsQuery.isLoading || undefined}
          >
            <FieldLabel htmlFor="video-follow-group-select">保存到</FieldLabel>
            <Select
              value={selectedGroupId}
              disabled={busy || groupsQuery.isLoading}
              onValueChange={(value) => value && setSelectedGroupId(value)}
            >
              <SelectTrigger id="video-follow-group-select" className="w-full">
                <SelectValue>
                  {selectedGroupId === UNGROUPED_VALUE
                    ? "未分组"
                    : (groups.find((group) => group.id === selectedGroupId)?.name ?? "选择分组")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  <SelectItem value={UNGROUPED_VALUE}>未分组</SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {groupsQuery.isError && (
              <FieldError className="flex items-center justify-between gap-2">
                <span>分组加载失败，请重试后再关注。</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => void groupsQuery.refetch()}
                >
                  重试
                </Button>
              </FieldError>
            )}
          </Field>

          <Field data-invalid={error ? true : undefined} data-disabled={busy || undefined}>
            <FieldLabel htmlFor="video-follow-new-group">新建分组</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <FolderPlus aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                id="video-follow-new-group"
                value={newGroupName}
                maxLength={32}
                disabled={busy}
                aria-invalid={error ? true : undefined}
                placeholder="分组名称"
                onChange={(event) => {
                  setNewGroupName(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  createGroup();
                }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  disabled={busy || !newGroupName.trim()}
                  aria-label="创建视频关注分组"
                  onClick={createGroup}
                >
                  {createGroupMutation.isPending ? <Spinner aria-hidden /> : <Plus aria-hidden />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {error && <FieldError className="text-xs">{error}</FieldError>}
          </Field>
        </FieldGroup>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>取消</DialogClose>
          <Button
            type="button"
            disabled={busy || groupsQuery.isLoading || groupsQuery.isError}
            onClick={() => {
              // 失败提示由调用方的 mutation 负责；这里接住 reject，避免未处理的 Promise。
              void Promise.resolve(
                onConfirm(selectedGroupId === UNGROUPED_VALUE ? null : selectedGroupId),
              ).catch(() => undefined);
            }}
          >
            {pending ? (
              <Spinner data-icon="inline-start" aria-hidden />
            ) : (
              <Heart data-icon="inline-start" />
            )}
            确认关注
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
