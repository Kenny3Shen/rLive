import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { SendHorizontal } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
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
  messageComposerSendButtonClass,
} from "@/shared/components/messageComposerStyles";
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
} from "./videoCommentSubmission";

type VideoCommentComposerProps = {
  aid: string;
  className?: string;
};

/** 放在评论滚动区之外，作为 comments 面板的固定底部；只发送一级文本评论。 */
export function VideoCommentComposer({ aid, className }: VideoCommentComposerProps) {
  // 分 P 共用 aid，草稿保留；换稿件重新挂载，旧请求不得清空新稿件草稿。
  return <VideoCommentComposerForm key={aid} aid={aid} className={className} />;
}

function VideoCommentComposerForm({ aid, className }: VideoCommentComposerProps) {
  const inputId = useId();
  const [message, setMessage] = useState("");
  const submitLock = useRef(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationKey: ["video_comment_send", aid],
    mutationFn: (text: string) => videoSendComment(aid, text),
    // 写入结果未知时可能已送达，绝不继承全局重试配置。
    retry: false,
    onSuccess: () => {
      setMessage("");
      invalidateVideoComments(queryClient, aid);
      notify.success("评论已提交", "若未立即显示，请稍后刷新评论区");
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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!aid || draftError || mutation.isPending) return;
    void withVideoCommentSubmitLock(submitLock, async () => {
      try {
        await mutation.mutateAsync(message.trim());
      } catch {
        // onError 负责反馈；保留原文，由用户决定是否重试。
      }
    });
  };

  return (
    <section className={cn(MESSAGE_COMPOSER_SURFACE_CLASS, className)} aria-label="发送评论">
      <form onSubmit={handleSubmit} aria-busy={mutation.isPending}>
        <FieldGroup className="gap-2">
          <Field data-invalid={Boolean(errorMessage)} data-disabled={mutation.isPending || !aid}>
            <FieldLabel htmlFor={inputId} className="sr-only">
              评论内容
            </FieldLabel>
            <InputGroup className={MESSAGE_COMPOSER_GROUP_CLASS}>
              <InputGroupTextarea
                id={inputId}
                name="comment"
                value={message}
                rows={1}
                maxLength={VIDEO_COMMENT_MAX_LENGTH}
                placeholder={aid ? "输入评论…" : "正在获取视频信息"}
                className="min-h-8 max-h-24 py-1 text-sm leading-6 [field-sizing:content] [@media(pointer:coarse)]:min-h-11"
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
                  aria-label="发送评论"
                  title={mutation.isPending ? "发送中" : "发送评论（Enter），Shift+Enter 换行"}
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
