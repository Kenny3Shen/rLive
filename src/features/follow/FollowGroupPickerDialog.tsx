import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  FOLLOW_GROUPS_QUERY_KEY,
  sortFollowGroups,
  UNGROUPED_FOLLOW_GROUP_ID,
  type FollowGroup,
} from "./followGroups";

type FollowGroupPickerDialogProps = {
  open: boolean;
  subjectName: string;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (groupId: string) => void | Promise<void>;
};

export function FollowGroupPickerDialog({
  open,
  subjectName,
  pending = false,
  onOpenChange,
  onConfirm,
}: FollowGroupPickerDialogProps) {
  const queryClient = useQueryClient();
  const [selectedGroupId, setSelectedGroupId] = useState(UNGROUPED_FOLLOW_GROUP_ID);
  const [newGroupName, setNewGroupName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const groupsQuery = useQuery({
    queryKey: FOLLOW_GROUPS_QUERY_KEY,
    queryFn: () => invokeCmd<FollowGroup[]>("tag_list"),
    enabled: open,
    staleTime: 30_000,
    select: sortFollowGroups,
  });

  const createGroupMutation = useMutation({
    mutationFn: (name: string) => invokeCmd<FollowGroup>("tag_upsert", { name }),
    onSuccess: (group) => {
      queryClient.setQueryData<FollowGroup[]>(FOLLOW_GROUPS_QUERY_KEY, (current = []) =>
        sortFollowGroups([...current.filter((item) => item.id !== group.id), group]),
      );
      setSelectedGroupId(group.id);
      setNewGroupName("");
      setError(null);
    },
    onError: () => setError("分组创建失败，请检查名称是否重复。"),
  });

  useEffect(() => {
    if (!open) return;
    setSelectedGroupId(UNGROUPED_FOLLOW_GROUP_ID);
    setNewGroupName("");
    setError(null);
  }, [open, subjectName]);

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
          <DialogTitle>关注 {subjectName}</DialogTitle>
          <DialogDescription>选择这个主播在关注页中的分组。</DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field data-disabled={busy || groupsQuery.isLoading || undefined}>
            <FieldLabel htmlFor="follow-group-select">保存到</FieldLabel>
            <Select
              value={selectedGroupId}
              disabled={busy || groupsQuery.isLoading}
              onValueChange={(value) => value && setSelectedGroupId(value)}
            >
              <SelectTrigger id="follow-group-select" className="w-full">
                <SelectValue>
                  {selectedGroupId === UNGROUPED_FOLLOW_GROUP_ID
                    ? "未分组"
                    : (groups.find((group) => group.id === selectedGroupId)?.name ?? "选择分组")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  <SelectItem value={UNGROUPED_FOLLOW_GROUP_ID}>未分组</SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field data-invalid={error ? true : undefined} data-disabled={busy || undefined}>
            <FieldLabel htmlFor="follow-new-group">新建分组</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <FolderPlus aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                id="follow-new-group"
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
                  aria-label="创建分组"
                  onClick={createGroup}
                >
                  {createGroupMutation.isPending ? <Spinner aria-hidden /> : <Plus aria-hidden />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {error && (
              <p role="status" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </Field>
        </FieldGroup>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>取消</DialogClose>
          <Button
            type="button"
            disabled={busy || groupsQuery.isLoading}
            onClick={() => void onConfirm(selectedGroupId)}
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
