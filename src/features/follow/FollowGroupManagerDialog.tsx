import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Folder, FolderPlus, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/ui/toast";
import { invokeCmd } from "@/shared/api/tauri";
import { FOLLOW_LIST_QUERY_KEY } from "./followRefresh";
import { FOLLOW_GROUPS_QUERY_KEY, sortFollowGroups, type FollowGroup } from "./followGroups";

type FollowGroupManagerDialogProps = {
  open: boolean;
  groups: readonly FollowGroup[];
  counts: ReadonlyMap<string, number>;
  onOpenChange: (open: boolean) => void;
};

export function FollowGroupManagerDialog({
  open,
  groups,
  counts,
  onOpenChange,
}: FollowGroupManagerDialogProps) {
  const queryClient = useQueryClient();
  const [newGroupName, setNewGroupName] = useState("");
  const [editing, setEditing] = useState<FollowGroup | null>(null);
  const [editingName, setEditingName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<FollowGroup | null>(null);
  const [error, setError] = useState<string | null>(null);

  function updateGroupCache(group: FollowGroup) {
    queryClient.setQueryData<FollowGroup[]>(FOLLOW_GROUPS_QUERY_KEY, (current = []) =>
      sortFollowGroups([...current.filter((item) => item.id !== group.id), group]),
    );
  }

  const saveMutation = useMutation({
    mutationFn: ({ name, id }: { name: string; id?: string }) =>
      invokeCmd<FollowGroup>("tag_upsert", { name, id }),
    onSuccess: (group, variables) => {
      updateGroupCache(group);
      setError(null);
      if (variables.id) {
        setEditing(null);
        setEditingName("");
        notify.success("分组已重命名");
      } else {
        setNewGroupName("");
        notify.success("分组已创建");
      }
    },
    onError: () => setError("保存失败，请检查名称是否重复。"),
  });

  const removeMutation = useMutation({
    mutationFn: (group: FollowGroup) => invokeCmd("tag_remove", { id: group.id }),
    onSuccess: async (_, group) => {
      queryClient.setQueryData<FollowGroup[]>(FOLLOW_GROUPS_QUERY_KEY, (current = []) =>
        current.filter((item) => item.id !== group.id),
      );
      await queryClient.invalidateQueries({ queryKey: FOLLOW_LIST_QUERY_KEY });
      setPendingDelete(null);
      notify.success("分组已删除", "其中的主播已移至未分组。");
    },
    onError: () => notify.error("删除分组失败", "请稍后重试。"),
  });

  function createGroup() {
    const name = newGroupName.trim();
    if (!name) {
      setError("请输入分组名称。");
      return;
    }
    saveMutation.mutate({ name });
  }

  function renameGroup() {
    const name = editingName.trim();
    if (!editing || !name) {
      setError("请输入分组名称。");
      return;
    }
    saveMutation.mutate({ id: editing.id, name });
  }

  const busy = saveMutation.isPending || removeMutation.isPending;

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>管理关注分组</DialogTitle>
            <DialogDescription>分组保存在当前设备，并包含在配置导入导出中。</DialogDescription>
          </DialogHeader>

          <Field data-invalid={error ? true : undefined} data-disabled={busy || undefined}>
            <FieldLabel htmlFor="follow-group-manager-new">新建分组</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <FolderPlus aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                id="follow-group-manager-new"
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
                  {saveMutation.isPending && !saveMutation.variables?.id ? (
                    <Spinner aria-hidden />
                  ) : (
                    <FolderPlus aria-hidden />
                  )}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {error && (
              <p role="status" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </Field>

          <Separator />

          <div className="flex max-h-72 flex-col overflow-y-auto">
            {groups.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">还没有分组</p>
            ) : (
              groups.map((group, index) => (
                <div key={group.id}>
                  <div className="flex min-h-12 items-center gap-2 py-2">
                    <Folder className="shrink-0 text-muted-foreground" aria-hidden />
                    {editing?.id === group.id ? (
                      <InputGroup className="min-w-0 flex-1">
                        <InputGroupInput
                          value={editingName}
                          maxLength={32}
                          autoFocus
                          aria-label="分组名称"
                          disabled={busy}
                          onChange={(event) => {
                            setEditingName(event.target.value);
                            setError(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              renameGroup();
                            }
                            if (event.key === "Escape") setEditing(null);
                          }}
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupButton
                            size="icon-xs"
                            aria-label="保存分组名称"
                            disabled={busy || !editingName.trim()}
                            onClick={renameGroup}
                          >
                            {saveMutation.isPending && saveMutation.variables?.id === group.id ? (
                              <Spinner aria-hidden />
                            ) : (
                              <Check aria-hidden />
                            )}
                          </InputGroupButton>
                          <InputGroupButton
                            size="icon-xs"
                            aria-label="取消重命名"
                            disabled={busy}
                            onClick={() => setEditing(null)}
                          >
                            <X aria-hidden />
                          </InputGroupButton>
                        </InputGroupAddon>
                      </InputGroup>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {group.name}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {counts.get(group.id) ?? 0}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`重命名${group.name}`}
                          disabled={busy}
                          onClick={() => {
                            setEditing(group);
                            setEditingName(group.name);
                            setError(null);
                          }}
                        >
                          <Pencil aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="hover:text-destructive"
                          aria-label={`删除${group.name}`}
                          disabled={busy}
                          onClick={() => setPendingDelete(group)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </>
                    )}
                  </div>
                  {index < groups.length - 1 && <Separator />}
                </div>
              ))
            )}
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>完成</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete != null}
        onOpenChange={(nextOpen) =>
          !removeMutation.isPending && !nextOpen && setPendingDelete(null)
        }
        icon={<Trash2 aria-hidden />}
        title="删除分组"
        description={<>删除“{pendingDelete?.name}”后，其中的主播会移至未分组。</>}
        busy={removeMutation.isPending}
        actionIcon={<Trash2 data-icon="inline-start" aria-hidden />}
        confirmText="删除分组"
        onConfirm={() => pendingDelete && removeMutation.mutate(pendingDelete)}
      />
    </>
  );
}
