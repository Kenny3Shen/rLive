//! 站点弹幕循环共享的重连策略。
//!
//! 过去站点循环会无条件重试：每次断开都会安排下一次拨号，永不停歇。更糟的是，
//! 一个连上后立刻断掉的套接字会被算作健康会话并重置退避，于是永久损坏的房间
//! —— Cookie 被吊销、频道关闭、签名过期 —— 会变成疯狂重试的死循环，
//! 且从不向用户给出任何结论。
//!
//! 本模块让每次断开都变得确定。循环先归类本次尝试为何结束，策略再判断再拨号
//! 是否可能有用，一旦无望就以用户可见的原因停止：远端必然重复的拒绝、连续
//! 失败过多、或单次会话的尝试预算耗尽。只有真正有产出的会话才会重置失败
//! 计数，因此反复闪断的端点同样会终止。

use std::time::Duration;

/// 短于此时长且毫无交付的会话视为一次失败尝试，而不是普通抖动。没有这个
/// 下限，接受连接后立即关闭的网关会在每一轮都重置退避，
/// 并被持续不停地拨号。
pub const DEFAULT_HEALTHY_AFTER: Duration = Duration::from_secs(60);
pub const DEFAULT_INITIAL_DELAY: Duration = Duration::from_secs(1);
pub const DEFAULT_MAX_DELAY: Duration = Duration::from_secs(30);
/// 约两分钟的递增重试（1+2+4+8+16+30+30+30s）之后，
/// 循环即认定端点不会恢复。
pub const DEFAULT_MAX_CONSECUTIVE_FAILURES: u32 = 8;
/// 单个房间会话的拨号次数上限，
/// 使长时间观看的用户在劣质链路上也无法产生无界连接尝试。
pub const DEFAULT_MAX_TOTAL_ATTEMPTS: u32 = 100;
/// 每次延迟附加 0..=800ms 的随机量，
/// 避免并发客户端同步一致地重连。
const JITTER_MAX_MS: u64 = 800;

/// 一次连接尝试因何结束。
#[derive(Debug)]
pub enum DisconnectReason {
    /// 套接字已建立但随后被关闭。`messages` 与 `connected_for`
    /// 决定它是否算作有产出的会话。
    ///
    /// `detail` 携带传输层原因（读取错误、服务端显式关闭、空闲超时）。它会写入
    /// 日志，但刻意不进入面向用户的提示：`读取失败: … (os error 10054)`
    /// 这类字符串能诊断出中间设备重置了套接字，
    /// 对等待聊天恢复的观众却毫无意义。
    Dropped {
        messages: u64,
        connected_for: Duration,
        detail: Option<String>,
    },
    /// 后续尝试可能挺过去的拨号、握手或传输失败。
    Transient { message: String },
    /// 远端正在刻意拖慢本客户端（429/403 握手、网关错误）。允许重试但频率必须
    /// 大幅降低，因此由调用方提供该类别的上限。
    Throttled {
        message: String,
        floor: Duration,
        max: Duration,
    },
    /// 远端的拒绝无法靠重试改变：未知房间、凭据被拒、本地参数不可用。
    Fatal { message: String },
}

impl DisconnectReason {
    /// 已连接但后来结束的会话，附带其传输层原因供日志使用。
    pub fn dropped(messages: u64, connected_for: Duration, detail: impl Into<String>) -> Self {
        Self::Dropped {
            messages,
            connected_for,
            detail: Some(detail.into()),
        }
    }

    pub fn transient(message: impl Into<String>) -> Self {
        Self::Transient {
            message: message.into(),
        }
    }

    pub fn fatal(message: impl Into<String>) -> Self {
        Self::Fatal {
            message: message.into(),
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::Dropped { .. } => "连接已断开",
            Self::Transient { message }
            | Self::Throttled { message, .. }
            | Self::Fatal { message } => message,
        }
    }

    /// 要记录到日志中的原因。`Dropped` 会话在这里报告传输层细节，
    /// 便于事后诊断重连；`message()` 则保持稳定、面向用户的概要。
    fn log_reason(&self) -> &str {
        match self {
            Self::Dropped {
                detail: Some(detail),
                ..
            } => detail,
            other => other.message(),
        }
    }
}

/// 单个站点重连行为的可调参数。
#[derive(Debug, Clone)]
pub struct Limits {
    pub max_consecutive_failures: u32,
    pub max_total_attempts: u32,
    pub initial_delay: Duration,
    pub max_delay: Duration,
    /// 会话在未交付任何消息的情况下，需要保持连接多久才能清除失败计数。
    pub healthy_after: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_consecutive_failures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
            max_total_attempts: DEFAULT_MAX_TOTAL_ATTEMPTS,
            initial_delay: DEFAULT_INITIAL_DELAY,
            max_delay: DEFAULT_MAX_DELAY,
            healthy_after: DEFAULT_HEALTHY_AFTER,
        }
    }
}

/// 断开之后循环应当做什么。
#[derive(Debug)]
pub enum Decision {
    /// 睡眠 `delay` 后再次拨号。
    Retry {
        delay: Duration,
        /// 这次等待对应的用户提示。
        notice: String,
    },
    /// 放弃。循环必须发出 `notice` 并返回。
    Stop {
        /// 面向用户的终止提示。
        notice: String,
        /// 稳定的原因值，测试断言用它而不是本地化的提示文本。
        /// 策略已经把它写入日志，因此站点循环用 `..` 匹配即可。
        #[cfg_attr(not(test), allow(dead_code))]
        cause: StopCause,
    },
}

/// 自动重连因何结束。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopCause {
    /// 远端的拒绝无法靠重试解决。
    Refused,
    /// 连续尝试多次都没有产生健康的会话。
    FailureStreak,
    /// 这个房间会话耗尽了总尝试预算。
    AttemptBudget,
}

impl StopCause {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Refused => "refused",
            Self::FailureStreak => "failure_streak",
            Self::AttemptBudget => "attempt_budget",
        }
    }
}

/// 单个房间会话的按连接重连记账信息。
#[derive(Debug)]
pub struct ReconnectPolicy {
    site: &'static str,
    limits: Limits,
    /// 未能产生有效会话的连续尝试次数。
    failures: u32,
    /// 本房间会话的总拨号次数，包括健康的那些。
    attempts: u32,
    /// 所有尝试累计投递的消息数，用于面向用户的提示。
    total_messages: u64,
}

impl ReconnectPolicy {
    pub fn new(site: &'static str, limits: Limits) -> Self {
        Self {
            site,
            limits,
            failures: 0,
            attempts: 0,
            total_messages: 0,
        }
    }

    pub fn with_defaults(site: &'static str) -> Self {
        Self::new(site, Limits::default())
    }

    /// 已经完成的拨号次数，包含正在报告的这一次。
    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    /// 记录一次尝试如何结束，并决定接下来做什么。
    pub fn on_disconnect(&mut self, reason: DisconnectReason) -> Decision {
        self.attempts = self.attempts.saturating_add(1);
        if let DisconnectReason::Dropped { messages, .. } = &reason {
            self.total_messages = self.total_messages.saturating_add(*messages);
        }

        // 拒绝类结果是这套策略的核心：不要为远端已经给出的答复
        // 再消耗一整套退避排程。
        if let DisconnectReason::Fatal { message } = &reason {
            let notice = format!("弹幕连接失败：{message}；已停止自动重连");
            self.log_stop(StopCause::Refused, message);
            return Decision::Stop {
                notice,
                cause: StopCause::Refused,
            };
        }

        if self.was_productive(&reason) {
            self.failures = 0;
        } else {
            self.failures = self.failures.saturating_add(1);
        }

        if self.failures >= self.limits.max_consecutive_failures {
            let notice = format!(
                "弹幕连续 {} 次重连失败（{}）；已停止自动重连",
                self.failures,
                reason.message()
            );
            self.log_stop(StopCause::FailureStreak, reason.log_reason());
            return Decision::Stop {
                notice,
                cause: StopCause::FailureStreak,
            };
        }

        if self.attempts >= self.limits.max_total_attempts {
            let notice = format!("弹幕本次观看已重连 {} 次；已停止自动重连", self.attempts);
            self.log_stop(StopCause::AttemptBudget, reason.log_reason());
            return Decision::Stop {
                notice,
                cause: StopCause::AttemptBudget,
            };
        }

        let delay = self.delay_for(&reason);
        let notice = self.retry_notice(&reason, delay);
        tracing::warn!(
            site = self.site,
            failures = self.failures,
            attempts = self.attempts,
            delay_secs = delay.as_secs(),
            reason = reason.log_reason(),
            "danmaku disconnected, scheduling reconnect"
        );
        Decision::Retry { delay, notice }
    }

    /// 只有真正起作用的会话才能清除失败计数：
    /// 要么交付过聊天消息，
    /// 要么存续得足够久、看起来是稳定的。
    fn was_productive(&self, reason: &DisconnectReason) -> bool {
        match reason {
            DisconnectReason::Dropped {
                messages,
                connected_for,
                ..
            } => *messages > 0 || *connected_for >= self.limits.healthy_after,
            _ => false,
        }
    }

    fn delay_for(&self, reason: &DisconnectReason) -> Duration {
        let (floor, max) = match reason {
            DisconnectReason::Throttled { floor, max, .. } => (*floor, *max),
            _ => (self.limits.initial_delay, self.limits.max_delay),
        };
        // `failures` 已先行自增，因此首次失败得到的是初始延迟而不是翻倍值。
        let shift = self.failures.saturating_sub(1).min(16);
        let seconds = self
            .limits
            .initial_delay
            .as_secs()
            .max(1)
            .saturating_mul(1_u64 << shift)
            .min(max.as_secs())
            .max(floor.as_secs());
        Duration::from_secs(seconds) + jitter()
    }

    fn retry_notice(&self, reason: &DisconnectReason, delay: Duration) -> String {
        let secs = delay.as_secs();
        let remaining = self
            .limits
            .max_consecutive_failures
            .saturating_sub(self.failures);
        match reason {
            DisconnectReason::Dropped { .. } => format!(
                "弹幕连接断开（已收 {} 条），{secs} 秒后自动重连…",
                self.total_messages
            ),
            DisconnectReason::Throttled { message, .. } => {
                format!("弹幕连接被限流：{message}，{secs} 秒后重试（剩余 {remaining} 次）…")
            }
            DisconnectReason::Transient { message } => {
                format!("弹幕连接失败：{message}，{secs} 秒后重试（剩余 {remaining} 次）…")
            }
            DisconnectReason::Fatal { .. } => unreachable!("fatal returns before retry"),
        }
    }

    fn log_stop(&self, cause: StopCause, message: &str) {
        tracing::warn!(
            site = self.site,
            cause = cause.as_str(),
            failures = self.failures,
            attempts = self.attempts,
            total_messages = self.total_messages,
            reason = message,
            "danmaku reconnect stopped"
        );
    }
}

/// 使用 `uuid` 的 CSPRNG 而不引入 `rand` 依赖；
/// 该取值只需要分散开，不需要不可预测。
fn jitter() -> Duration {
    let ms = (uuid::Uuid::new_v4().as_u128() % u128::from(JITTER_MAX_MS + 1)) as u64;
    Duration::from_millis(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dropped(messages: u64, secs: u64) -> DisconnectReason {
        DisconnectReason::Dropped {
            messages,
            connected_for: Duration::from_secs(secs),
            detail: None,
        }
    }

    /// 剔除抖动，以便对排程本身做断言。
    fn retry_secs(decision: &Decision) -> u64 {
        match decision {
            Decision::Retry { delay, .. } => delay.as_secs(),
            Decision::Stop { notice, .. } => panic!("expected retry, stopped: {notice}"),
        }
    }

    fn stop_cause(decision: &Decision) -> StopCause {
        match decision {
            Decision::Stop { cause, .. } => *cause,
            Decision::Retry { notice, .. } => panic!("expected stop, retried: {notice}"),
        }
    }

    #[test]
    fn a_refusal_stops_without_spending_any_retries() {
        let mut policy = ReconnectPolicy::with_defaults("test");
        let decision = policy.on_disconnect(DisconnectReason::fatal("房间不存在"));
        assert_eq!(stop_cause(&decision), StopCause::Refused);
        assert_eq!(policy.attempts(), 1);
    }

    /// 被丢弃的会话会把传输层原因记入日志，
    /// 而观众读到的提示保持不含套接字词汇。
    #[test]
    fn a_dropped_session_logs_its_cause_but_does_not_show_it() {
        let reason = DisconnectReason::dropped(
            147,
            Duration::from_secs(70),
            "读取失败: IO error: 远程主机强迫关闭了一个现有的连接。 (os error 10054)",
        );
        assert!(reason.log_reason().contains("os error 10054"));
        assert_eq!(reason.message(), "连接已断开");

        let mut policy = ReconnectPolicy::with_defaults("test");
        let decision = policy.on_disconnect(reason);
        match decision {
            Decision::Retry { notice, .. } => {
                assert!(notice.contains("已收 147 条"), "notice was: {notice}");
                assert!(
                    !notice.contains("os error"),
                    "notice leaked detail: {notice}"
                );
            }
            Decision::Stop { notice, .. } => panic!("expected retry, stopped: {notice}"),
        }
    }

    /// 不带原因就退出的循环也要记录可用的原因。
    #[test]
    fn a_dropped_session_without_detail_falls_back_to_the_summary() {
        assert_eq!(dropped(5, 10).log_reason(), "连接已断开");
    }

    #[test]
    fn transient_failures_back_off_then_stop_at_the_streak_limit() {
        let mut policy = ReconnectPolicy::with_defaults("test");
        for expected in [1, 2, 4, 8, 16, 30, 30] {
            let decision = policy.on_disconnect(DisconnectReason::transient("网络错误"));
            assert_eq!(retry_secs(&decision), expected);
        }
        // 第八次连续失败达到 DEFAULT_MAX_CONSECUTIVE_FAILURES。
        let decision = policy.on_disconnect(DisconnectReason::transient("网络错误"));
        assert_eq!(stop_cause(&decision), StopCause::FailureStreak);
    }

    #[test]
    fn a_productive_session_clears_the_streak() {
        let mut policy = ReconnectPolicy::with_defaults("test");
        for _ in 0..5 {
            policy.on_disconnect(DisconnectReason::transient("网络错误"));
        }
        // 聊天确实到达过，因此下一次等待从下限重新开始。
        assert_eq!(retry_secs(&policy.on_disconnect(dropped(12, 3))), 1);
        assert_eq!(retry_secs(&policy.on_disconnect(dropped(4, 1))), 1);
    }

    /// 这套策略所针对的回归场景：接受连接又立即关闭的网关
    /// 绝不能重置退避。
    #[test]
    fn instant_empty_drops_escalate_and_terminate_instead_of_hot_looping() {
        let mut policy = ReconnectPolicy::with_defaults("test");
        for expected in [1, 2, 4, 8, 16, 30, 30] {
            assert_eq!(retry_secs(&policy.on_disconnect(dropped(0, 0))), expected);
        }
        assert_eq!(
            stop_cause(&policy.on_disconnect(dropped(0, 0))),
            StopCause::FailureStreak
        );
    }

    #[test]
    fn a_long_quiet_session_still_counts_as_healthy() {
        let mut policy = ReconnectPolicy::with_defaults("test");
        policy.on_disconnect(DisconnectReason::transient("网络错误"));
        policy.on_disconnect(DisconnectReason::transient("网络错误"));
        // 没有聊天，但套接字在健康窗口内存续：安静的房间不是坏掉的房间。
        assert_eq!(retry_secs(&policy.on_disconnect(dropped(0, 120))), 1);
    }

    #[test]
    fn throttling_uses_its_own_floor_and_ceiling() {
        // 把连续失败上限放宽，让这个测试专注于延迟排程；
        // 计数本身已在上面覆盖。
        let mut policy = ReconnectPolicy::new(
            "test",
            Limits {
                max_consecutive_failures: 20,
                ..Limits::default()
            },
        );
        let throttled = || DisconnectReason::Throttled {
            message: "429".into(),
            floor: Duration::from_secs(60),
            max: Duration::from_secs(300),
        };
        // 指数增长仍低于下限时，由下限主导。
        for _ in 0..6 {
            assert_eq!(retry_secs(&policy.on_disconnect(throttled())), 60);
        }
        // 随后恢复按排程增长，并向天花板靠近。
        assert_eq!(retry_secs(&policy.on_disconnect(throttled())), 64);
        assert_eq!(retry_secs(&policy.on_disconnect(throttled())), 128);
        assert_eq!(retry_secs(&policy.on_disconnect(throttled())), 256);
        assert_eq!(retry_secs(&policy.on_disconnect(throttled())), 300);
        assert_eq!(retry_secs(&policy.on_disconnect(throttled())), 300);
    }

    #[test]
    fn healthy_churn_still_exhausts_the_session_attempt_budget() {
        let mut policy = ReconnectPolicy::new(
            "test",
            Limits {
                max_total_attempts: 4,
                ..Limits::default()
            },
        );
        for _ in 0..3 {
            assert_eq!(retry_secs(&policy.on_disconnect(dropped(9, 90))), 1);
        }
        assert_eq!(
            stop_cause(&policy.on_disconnect(dropped(9, 90))),
            StopCause::AttemptBudget
        );
    }

    #[test]
    fn retry_notices_report_the_cumulative_message_count() {
        let mut policy = ReconnectPolicy::with_defaults("test");
        policy.on_disconnect(dropped(12, 3));
        let decision = policy.on_disconnect(dropped(4, 1));
        match decision {
            Decision::Retry { notice, .. } => assert!(
                notice.contains("已收 16 条"),
                "notice should total both sessions: {notice}"
            ),
            Decision::Stop { notice, .. } => panic!("expected retry, stopped: {notice}"),
        }
    }
}
