import { memo, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { SendHorizontal, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import {
  MESSAGE_COMPOSER_GROUP_CLASS,
  MESSAGE_COMPOSER_SURFACE_CLASS,
  commentComposerToneClass,
  messageComposerSendButtonClass,
} from "@/shared/components/messageComposerStyles";
import { isMobileClient } from "@/shared/clientPlatform";
import { notify } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { videoSendComment } from "./videoApi";
import {
  VIDEO_COMMENT_MAX_LENGTH,
  invalidateVideoComments,
  isVideoCommentLoginError,
  videoCommentDraftError,
  videoCommentErrorMessage,
  withVideoCommentSubmitLock,
  type VideoCommentReplyTarget,
} from "./videoCommentSubmission";

type VideoCommentComposerProps = {
  aid: string;
  className?: string;
  /** 回复目标；缺省发一级评论。 */
  replyTarget?: VideoCommentReplyTarget | null;
  /** 回到默认目标；不提供时不显示取消按钮（如评论详情里默认回复楼主）。 */
  onCancelReply?: () => void;
};

/** 放在评论滚动区之外，作为 comments 面板的固定底部；发送一级评论或回复。 */
export const VideoCommentComposer = memo(function VideoCommentComposer({
  aid,
  ...props
}: VideoCommentComposerProps) {
  // 分 P 共用 aid，草稿保留；换稿件重新挂载，旧请求不得清空新稿件草稿。
  return <VideoCommentComposerForm key={aid} aid={aid} {...props} />;
});

function VideoCommentComposerForm({
  aid,
  className,
  replyTarget = null,
  onCancelReply,
}: VideoCommentComposerProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState("");
  const submitLock = useRef(false);
  const queryClient = useQueryClient();
  // 点「回复」后直接可输入；挂载时不抢焦点，移动端不会无端弹出软键盘。
  const focusedParent = useRef(replyTarget?.parent);
  useEffect(() => {
    if (focusedParent.current === replyTarget?.parent) return;
    focusedParent.current = replyTarget?.parent;
    if (replyTarget) inputRef.current?.focus();
  }, [replyTarget]);
  const mutation = useMutation({
    mutationKey: ["video_comment_send", aid],
    mutationFn: ({ text, reply }: { text: string; reply: VideoCommentReplyTarget | null }) =>
      videoSendComment(aid, text, reply),
    // 写入结果未知时可能已送达，绝不继承全局重试配置。
    retry: false,
    onSuccess: (_, { reply }) => {
      setMessage("");
      invalidateVideoComments(queryClient, aid);
      onCancelReply?.();
      notify.success(reply ? "回复已提交" : "评论已提交", "若未立即显示，请稍后刷新评论区");
    },
    onError: (error) => {
      // 失败和登录失效都不清空草稿，也不自动删除用户保存的 Cookie。
      notify.error("评论发送提示", videoCommentErrorMessage(error));
    },
  });
  const draftError = videoCommentDraftError(message);
  const errorMessage = mutation.error ? videoCommentErrorMessage(mutation.error) : null;
  const errorId = `${inputId}-error`;
  const canSubmit = Boolean(aid) && !draftError && !mutation.isPending;
  const actionLabel = replyTarget ? "发送回复" : "发送评论";

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!aid || draftError || mutation.isPending) return;
    void withVideoCommentSubmitLock(submitLock, async () => {
      try {
        await mutation.mutateAsync({ text: message.trim(), reply: replyTarget });
      } catch {
        // onError 负责反馈；保留原文，由用户决定是否重试。
      }
    });
  };

  return (
    <section
      className={cn(
        MESSAGE_COMPOSER_SURFACE_CLASS,
        commentComposerToneClass(isMobileClient()),
        className,
      )}
      aria-label={actionLabel}
    >
      <form onSubmit={handleSubmit} aria-busy={mutation.isPending}>
        <FieldGroup className="gap-2">
          {replyTarget && (
            <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate">
                回复 <span className="font-medium text-foreground/80">@{replyTarget.uname}</span>
              </span>
              {onCancelReply && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="取消回复"
                  title="取消回复，改为发表评论"
                  disabled={mutation.isPending}
                  onClick={onCancelReply}
                >
                  <X aria-hidden />
                </Button>
              )}
            </div>
          )}
          <Field data-invalid={Boolean(errorMessage)} data-disabled={mutation.isPending || !aid}>
            <FieldLabel htmlFor={inputId} className="sr-only">
              {replyTarget ? "回复内容" : "评论内容"}
            </FieldLabel>
            <InputGroup className={MESSAGE_COMPOSER_GROUP_CLASS}>
              <InputGroupTextarea
                ref={inputRef}
                id={inputId}
                name="comment"
                value={message}
                rows={1}
                maxLength={VIDEO_COMMENT_MAX_LENGTH}
                placeholder={
                  !aid
                    ? "正在获取视频信息"
                    : replyTarget
                      ? `回复 @${replyTarget.uname}…`
                      : "输入评论…"
                }
                // 单行时文字垂直居中：桌面 4 + 24 + 4 = 32；粗指针输入组抬到 44px 触控高度，
                // 内边距同步加到 10px（10 + 24 + 10），否则多出的 12px 全堆在文字下方。
                className="min-h-8 max-h-24 py-1 text-sm leading-6 [field-sizing:content] [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-2.5"
                disabled={mutation.isPending || !aid}
                aria-invalid={Boolean(errorMessage)}
                aria-describedby={errorMessage ? errorId : undefined}
                onChange={(event) => {
                  setMessage(event.target.value);
                  if (mutation.error) mutation.reset();
                }}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    event.shiftKey ||
                    event.nativeEvent.isComposing ||
                    event.repeat
                  )
                    return;
                  event.preventDefault();
                  if (canSubmit) event.currentTarget.form?.requestSubmit();
                }}
              />
              <InputGroupAddon align="inline-end" className="py-0">
                <InputGroupButton
                  type="submit"
                  variant="ghost"
                  size="icon-sm"
                  disabled={!canSubmit}
                  aria-label={actionLabel}
                  title={
                    mutation.isPending ? "发送中" : `${actionLabel}（Enter），Shift+Enter 换行`
                  }
                  aria-busy={mutation.isPending}
                  className={messageComposerSendButtonClass(canSubmit)}
                >
                  {mutation.isPending ? <Spinner aria-hidden /> : <SendHorizontal aria-hidden />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {errorMessage && <FieldError id={errorId}>{errorMessage}</FieldError>}
          </Field>
          {isVideoCommentLoginError(mutation.error) && (
            <Field orientation="horizontal" className="justify-end">
              <Link
                to="/settings?section=account"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                去登录
              </Link>
            </Field>
          )}
        </FieldGroup>
      </form>
    </section>
  );
}
