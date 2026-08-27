import { Check, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type FollowCardDrawerAction = {
  id: string;
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  /** 开关型动作的当前态，行尾显示对勾。 */
  selected?: boolean;
  destructive?: boolean;
  onSelect: () => void;
};

export type FollowCardDrawerGroup = {
  id: string;
  name: string;
  icon: LucideIcon;
  current: boolean;
};

/** 抽屉里的整宽操作行，画法对齐播放页清晰度抽屉的选项行。 */
function FollowDrawerRow({
  action,
  onRun,
}: {
  action: FollowCardDrawerAction;
  /** 统一入口：先收起抽屉再执行动作。 */
  onRun: (action: FollowCardDrawerAction) => void;
}) {
  const Icon = action.icon;
  return (
    <Button
      type="button"
      variant={action.selected && !action.destructive ? "secondary" : "ghost"}
      size="sm"
      disabled={action.disabled}
      aria-pressed={action.selected || undefined}
      className={cn(
        "w-full justify-between max-md:h-10",
        action.destructive && "text-destructive hover:bg-destructive/10 hover:text-destructive",
      )}
      onClick={() => onRun(action)}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {action.busy ? <Spinner aria-hidden /> : <Icon aria-hidden />}
        <span className="min-w-0 truncate">{action.label}</span>
      </span>
      {action.selected && <Check aria-hidden />}
    </Button>
  );
}

/**
 * 关注卡片（直播主播与 IPTV 频道）移动端长按弹出的底部操作抽屉：
 * 顶部动作行、分组迁移列表与底部破坏性操作。任意选择都会先收起抽屉
 * 再执行回调；点按卡片本身即可进入房间/播放，因此直播卡片不设「打开直播间」项。
 */
export function FollowCardActionDrawer({
  open,
  onOpenChange,
  title,
  actions = [],
  groups,
  moving = false,
  onMoveGroup,
  destructive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  actions?: readonly FollowCardDrawerAction[];
  groups: readonly FollowCardDrawerGroup[];
  /** 分组迁移进行中时禁用所有分组行。 */
  moving?: boolean;
  onMoveGroup: (groupId: string) => void;
  destructive: FollowCardDrawerAction;
}) {
  function run(action: FollowCardDrawerAction) {
    onOpenChange(false);
    action.onSelect();
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerTitle className="truncate">{title}</DrawerTitle>

        {actions.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5">
            {actions.map((action) => (
              <FollowDrawerRow key={action.id} action={action} onRun={run} />
            ))}
          </div>
        )}

        <div className="mt-2 flex flex-col gap-0.5">
          <span className="px-2 pt-1 text-xs text-muted-foreground max-md:pt-0.5">移至分组</span>
          {groups.map((group) => (
            <FollowDrawerRow
              key={group.id}
              action={{
                id: group.id,
                icon: group.icon,
                label: group.name,
                disabled: moving || group.current,
                selected: group.current,
                onSelect: () => onMoveGroup(group.id),
              }}
              onRun={run}
            />
          ))}
        </div>

        <Separator className="my-1 max-md:my-0.5" />
        <FollowDrawerRow action={destructive} onRun={run} />
      </DrawerContent>
    </Drawer>
  );
}
