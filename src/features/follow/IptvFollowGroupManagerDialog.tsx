import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Folder, FolderPlus, Pencil, Trash2, X } from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/ui/toast";
import {
  IPTV_FAVORITES_QUERY_KEY,
  IPTV_FAVORITE_GROUPS_QUERY_KEY,
  sortIptvFavoriteGroups,
  type IptvFavorite,
  type IptvFavoriteGroup,
} from "@/features/iptv/favorites";
import { invokeCmd } from "@/shared/api/tauri";

type IptvFollowGroupManagerDialogProps = {
  open: boolean;
  groups: readonly IptvFavoriteGroup[];
  counts: ReadonlyMap<string, number>;
  onOpenChange: (open: boolean) => void;
};

export function IptvFollowGroupManagerDialog({
  open,
  groups,
  counts,
  onOpenChange,
}: IptvFollowGroupManagerDialogProps) {
  const queryClient = useQueryClient();
  const [newGroupName, setNewGroupName] = useState("");
  const [editing, setEditing] = useState<IptvFavoriteGroup | null>(null);
  const [editingName, setEditingName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<IptvFavoriteGroup | null>(null);
  const [error, setError] = useState<string | null>(null);

  function updateGroupCache(group: IptvFavoriteGroup) {
    queryClient.setQueryData<IptvFavoriteGroup[]>(IPTV_FAVORITE_GROUPS_QUERY_KEY, (current = []) =>
      sortIptvFavoriteGroups([...current.filter((item) => item.id !== group.id), group]),
    );
  }

  const saveMutation = useMutation({
    mutationFn: ({ name, id }: { name: string; id?: string }) =>
      invokeCmd<IptvFavoriteGroup>("iptv_favorite_group_upsert", { name, id }),
    onSuccess: (group, variables) => {
      updateGroupCache(group);
      setError(null);
      if (variables.id) {
        setEditing(null);
        setEditingName("");
        notify.success("IPTV 分组已重命名");
      } else {
        setNewGroupName("");
        notify.success("IPTV 分组已创建");
      }
    },
    onError: () => setError("保存失败，请检查名称是否重复。"),
  });

  const removeMutation = useMutation({
    mutationFn: (group: IptvFavoriteGroup) =>
      invokeCmd("iptv_favorite_group_remove", { id: group.id }),
    onSuccess: async (_, group) => {
      queryClient.setQueryData<IptvFavoriteGroup[]>(
        IPTV_FAVORITE_GROUPS_QUERY_KEY,
        (current = []) => current.filter((item) => item.id !== group.id),
      );
      queryClient.setQueriesData<IptvFavorite[]>(
        { queryKey: IPTV_FAVORITES_QUERY_KEY },
        (current) =>
          current?.map((favorite) =>
            favorite.favorite_group_id === group.id
              ? { ...favorite, favorite_group_id: null }
              : favorite,
          ),
      );
      await queryClient.invalidateQueries({ queryKey: IPTV_FAVORITES_QUERY_KEY });
      setPendingDelete(null);
      notify.success("IPTV 分组已删除", "其中的频道已移至未分组。");
    },
    onError: () => notify.error("删除 IPTV 分组失败", "请稍后重试。"),
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
            <DialogTitle>管理 IPTV 分组</DialogTitle>
            <DialogDescription>
              自定义频道分组保存在当前设备，并包含在配置导入导出中。
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field data-invalid={error ? true : undefined} data-disabled={busy || undefined}>
              <FieldLabel htmlFor="iptv-follow-group-manager-new">新建分组</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <FolderPlus aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  id="iptv-follow-group-manager-new"
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
                    aria-label="创建 IPTV 分组"
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
          </FieldGroup>

          <Separator />

          <div className="flex max-h-72 flex-col overflow-y-auto">
            {groups.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">还没有自定义分组</p>
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
                          aria-label="IPTV 分组名称"
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
                            aria-label="保存 IPTV 分组名称"
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

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(nextOpen) =>
          !removeMutation.isPending && !nextOpen && setPendingDelete(null)
        }
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Trash2 aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>删除 IPTV 分组</AlertDialogTitle>
            <AlertDialogDescription>
              删除“{pendingDelete?.name}”后，其中的频道会移至未分组。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMutation.isPending}>取消</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={removeMutation.isPending}
              onClick={() => pendingDelete && removeMutation.mutate(pendingDelete)}
            >
              {removeMutation.isPending ? (
                <Spinner data-icon="inline-start" aria-hidden />
              ) : (
                <Trash2 data-icon="inline-start" aria-hidden />
              )}
              删除分组
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
