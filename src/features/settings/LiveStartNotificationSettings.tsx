import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/ui/toast";
import { errorText } from "@/shared/components/errorPresentation";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import {
  getLiveStartNotificationPermission,
  requestLiveStartNotificationPermission,
  type LiveStartNotificationPermission,
} from "@/features/follow/liveStartNotifications";
import { SettingsSection as Section, useSettingsFieldOrientation } from "./SettingsSection";
import { SwitchField } from "./SwitchField";

type PermissionView = LiveStartNotificationPermission | "checking";
type LocalError = {
  kind: "permission" | "save";
  message: string;
};

const PERMISSION_PRESENTATION: Record<
  PermissionView,
  {
    label: string;
    description: string;
    variant: "secondary" | "outline" | "destructive";
  }
> = {
  checking: {
    label: "读取中",
    description: "正在读取当前设备的系统通知权限。",
    variant: "outline",
  },
  granted: {
    label: "已授权",
    description: "系统通知权限已授权，开播时可同时显示系统与应用内提醒。",
    variant: "secondary",
  },
  default: {
    label: "未授权",
    description: "系统通知权限尚未授权，当前只能收到应用内提醒。",
    variant: "outline",
  },
  denied: {
    label: "已拒绝",
    description: "系统已拒绝 rLive 的通知权限，请在当前设备的系统设置中重新允许。",
    variant: "destructive",
  },
  unavailable: {
    label: "不可用",
    description: "开播通知需要在 rLive 客户端中使用。",
    variant: "outline",
  },
  error: {
    label: "读取失败",
    description: "暂时无法读取系统通知权限，请稍后重新进入设置。",
    variant: "destructive",
  },
};

const PERMISSION_ERROR: Partial<Record<LiveStartNotificationPermission, string>> = {
  denied: "系统通知权限已被拒绝，开播通知未开启。请先在当前设备的系统设置中允许 rLive 发送通知。",
  default: "尚未授予系统通知权限，开播通知未开启。请再次尝试并允许系统通知。",
  unavailable: "开播通知仅支持 rLive 客户端。",
  error: "无法请求系统通知权限，开播通知未开启。请检查系统设置后重试。",
};

export function LiveStartNotificationSettings() {
  const orientation = useSettingsFieldOrientation();
  const enabled = useSettingsStore((state) => state.liveStartNotificationsEnabled);
  const pending = useSettingsStore((state) => state.liveStartNotificationsPending);
  const setEnabled = useSettingsStore((state) => state.setLiveStartNotificationsEnabled);
  const available = isTauri();
  const [permission, setPermission] = useState<PermissionView>(() =>
    available ? "checking" : "unavailable",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LocalError | null>(null);
  const mountedRef = useRef(true);
  const operationRef = useRef(0);
  const permissionReadRef = useRef(0);
  const operationInFlightRef = useRef(false);
  const disabled = !available || busy || pending;
  const permissionView = PERMISSION_PRESENTATION[permission];

  useEffect(() => {
    mountedRef.current = true;
    if (!available) return;

    const refreshPermission = () => {
      if (operationInFlightRef.current) return;
      const read = ++permissionReadRef.current;
      void getLiveStartNotificationPermission().then((next) => {
        if (
          !mountedRef.current ||
          read !== permissionReadRef.current ||
          operationInFlightRef.current
        ) {
          return;
        }
        setPermission(next);
        if (next === "granted") {
          setError((current) => (current?.kind === "permission" ? null : current));
        }
      });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshPermission();
    };

    refreshPermission();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshPermission);
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      permissionReadRef.current += 1;
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshPermission);
    };
  }, [available]);

  async function applySetting(value: boolean) {
    setError(null);
    setBusy(true);
    operationInFlightRef.current = true;
    const operation = ++operationRef.current;
    permissionReadRef.current += 1;
    try {
      if (value) {
        // 页面缓存只用于展示；开启前重新读取系统权限，
        // 以覆盖用户离开本页期间在系统设置中撤销授权的情况。
        const nextPermission = await requestLiveStartNotificationPermission();
        if (!mountedRef.current || operation !== operationRef.current) return;
        setPermission(nextPermission);
        if (nextPermission !== "granted") {
          setError({
            kind: "permission",
            message: PERMISSION_ERROR[nextPermission] ?? "系统通知权限不可用。",
          });
          return;
        }
      }

      await setEnabled(value);
      if (!mountedRef.current || operation !== operationRef.current) return;
      notify.success(
        value ? "开播通知已开启" : "开播通知已关闭",
        value ? "应用运行期间每分钟检查全体已关注主播。" : "之后不会再发送直播开播提醒。",
      );
    } catch (cause) {
      if (!mountedRef.current || operation !== operationRef.current) return;
      setError({ kind: "save", message: `开播通知保存失败：${errorText(cause)}` });
    } finally {
      if (mountedRef.current && operation === operationRef.current) {
        operationInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

  async function requestPermissionForEnabledSetting() {
    if (busy || pending) return;
    setError(null);
    setBusy(true);
    operationInFlightRef.current = true;
    const operation = ++operationRef.current;
    permissionReadRef.current += 1;
    try {
      const next = await requestLiveStartNotificationPermission();
      if (!mountedRef.current || operation !== operationRef.current) return;
      setPermission(next);
      if (next === "granted") {
        notify.success("系统通知权限已授权");
      } else {
        setError({
          kind: "permission",
          message: PERMISSION_ERROR[next] ?? "系统通知权限不可用。",
        });
      }
    } finally {
      if (mountedRef.current && operation === operationRef.current) {
        operationInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <Section title="开播通知">
      <SwitchField
        title="关注主播开播提醒"
        description="应用运行期间每分钟检查已关注主播。关闭应用后停止提醒。"
        checked={enabled}
        disabled={disabled}
        error={error?.message ?? null}
        orientation={orientation}
        onCheckedChange={(checked) => void applySetting(checked)}
      />
      <Field orientation={orientation}>
        <FieldContent>
          <FieldTitle>
            系统通知权限
            <Badge variant={permissionView.variant}>
              {(busy || pending) && <Spinner className="size-3" aria-label="处理中" />}
              {busy || pending ? "处理中" : permissionView.label}
            </Badge>
          </FieldTitle>
          <FieldDescription>{permissionView.description}</FieldDescription>
        </FieldContent>
        {enabled && permission === "default" && (
          <Button
            variant="outline"
            disabled={busy || pending}
            onClick={() => void requestPermissionForEnabledSetting()}
          >
            请求通知权限
          </Button>
        )}
      </Field>
    </Section>
  );
}
