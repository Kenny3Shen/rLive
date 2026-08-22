//! Shared reconnect policy for the site danmaku loops.
//!
//! The site loops used to retry unconditionally: every disconnect scheduled
//! another dial, forever. Worse, a socket that connected and then died at once
//! counted as a healthy session and reset the backoff, so a permanently broken
//! room — revoked Cookie, closed channel, stale signature — became a hot retry
//! loop that never surfaced a verdict to the user.
//!
//! This module makes each disconnect deterministic. A loop classifies why its
//! attempt ended, the policy decides whether another dial can plausibly help,
//! and it stops with a user-visible reason once it cannot: a refusal the remote
//! will repeat, too many consecutive failures, or an exhausted per-session
//! attempt budget. Only sessions that were actually productive reset the
//! failure streak, so a flapping endpoint still terminates.

use std::time::Duration;

/// A session shorter than this that delivered nothing is treated as a failed
/// attempt rather than ordinary churn. Without this floor, a gateway that
/// accepts a socket and closes it immediately would reset the backoff on every
/// pass and be dialed continuously.
pub const DEFAULT_HEALTHY_AFTER: Duration = Duration::from_secs(60);
pub const DEFAULT_INITIAL_DELAY: Duration = Duration::from_secs(1);
pub const DEFAULT_MAX_DELAY: Duration = Duration::from_secs(30);
/// Roughly two minutes of escalating retries (1+2+4+8+16+30+30+30s) before the
/// loop concludes the endpoint is not coming back.
pub const DEFAULT_MAX_CONSECUTIVE_FAILURES: u32 = 8;
/// Upper bound on dials for one room session, so an all-day viewer on a flaky
/// link still cannot generate unbounded connection attempts.
pub const DEFAULT_MAX_TOTAL_ATTEMPTS: u32 = 100;
/// Random 0..=800ms added to every delay so concurrent clients do not
/// reconnect in lockstep.
const JITTER_MAX_MS: u64 = 800;

/// Why one connection attempt ended.
#[derive(Debug)]
pub enum DisconnectReason {
    /// The socket was established and later closed. `messages` and
    /// `connected_for` decide whether it counted as a productive session.
    ///
    /// `detail` carries the transport-level cause (a read error, an explicit
    /// server close, an idle timeout). It is logged but deliberately kept out
    /// of the user-facing notice: strings like
    /// `读取失败: … (os error 10054)` diagnose a middlebox resetting the
    /// socket and mean nothing to a viewer waiting for chat to resume.
    Dropped {
        messages: u64,
        connected_for: Duration,
        detail: Option<String>,
    },
    /// Dial, handshake, or transport failure that a later attempt may survive.
    Transient { message: String },
    /// The remote is deliberately slowing this client down (429/403 handshake,
    /// gateway errors). Retrying is allowed but must be much less frequent, so
    /// the caller supplies the clamp for this class.
    Throttled {
        message: String,
        floor: Duration,
        max: Duration,
    },
    /// The remote refused in a way that retrying cannot change: unknown room,
    /// rejected credential, unusable local arguments.
    Fatal { message: String },
}

impl DisconnectReason {
    /// A session that connected and later ended, tagged with its transport
    /// cause for the log.
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

    /// The cause to record in the log. A `Dropped` session reports its
    /// transport detail here so a reconnect can be diagnosed after the fact;
    /// `message()` stays the stable, user-facing summary.
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

/// Tunables for one site's reconnect behaviour.
#[derive(Debug, Clone)]
pub struct Limits {
    pub max_consecutive_failures: u32,
    pub max_total_attempts: u32,
    pub initial_delay: Duration,
    pub max_delay: Duration,
    /// How long a session must stay connected to clear the failure streak when
    /// it delivered no messages.
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

/// What the loop should do after a disconnect.
#[derive(Debug)]
pub enum Decision {
    /// Sleep `delay`, then dial again.
    Retry {
        delay: Duration,
        /// User-facing notice for this wait.
        notice: String,
    },
    /// Give up. The loop must emit `notice` and return.
    Stop {
        /// User-facing terminal notice.
        notice: String,
        /// Stable reason, asserted by tests instead of the localized notice.
        /// The policy already logs it, so site loops match on `..`.
        #[cfg_attr(not(test), allow(dead_code))]
        cause: StopCause,
    },
}

/// Why automatic reconnection ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopCause {
    /// The remote refused in a way retrying cannot fix.
    Refused,
    /// Too many consecutive attempts failed to produce a healthy session.
    FailureStreak,
    /// This room session used up its total attempt budget.
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

/// Per-connection reconnect bookkeeping for one room session.
#[derive(Debug)]
pub struct ReconnectPolicy {
    site: &'static str,
    limits: Limits,
    /// Consecutive attempts that did not yield a productive session.
    failures: u32,
    /// Total dials in this room session, healthy ones included.
    attempts: u32,
    /// Messages delivered across every attempt, for the user-facing notices.
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

    /// Number of dials already made, including the one being reported.
    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    /// Record how an attempt ended and decide what happens next.
    pub fn on_disconnect(&mut self, reason: DisconnectReason) -> Decision {
        self.attempts = self.attempts.saturating_add(1);
        if let DisconnectReason::Dropped { messages, .. } = &reason {
            self.total_messages = self.total_messages.saturating_add(*messages);
        }

        // A refusal is the whole point of this policy: stop before spending a
        // backoff schedule on an answer the remote has already given.
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

    /// A session clears the failure streak only when it actually worked:
    /// it delivered chat, or it stayed up long enough to look stable.
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
        // `failures` is already incremented, so a first failure yields the
        // initial delay rather than doubling it.
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

/// Uses `uuid`'s CSPRNG rather than adding a `rand` dependency; the value only
/// needs to be spread out, not unpredictable.
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

    /// Strip jitter so the schedule itself can be asserted.
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

    /// A dropped session records its transport cause for the log while the
    /// notice the viewer reads stays free of socket vocabulary.
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

    /// A loop that breaks without keeping a cause still logs a usable reason.
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
        // The eighth consecutive failure reaches DEFAULT_MAX_CONSECUTIVE_FAILURES.
        let decision = policy.on_disconnect(DisconnectReason::transient("网络错误"));
        assert_eq!(stop_cause(&decision), StopCause::FailureStreak);
    }

    #[test]
    fn a_productive_session_clears_the_streak() {
        let mut policy = ReconnectPolicy::with_defaults("test");
        for _ in 0..5 {
            policy.on_disconnect(DisconnectReason::transient("网络错误"));
        }
        // Chat actually arrived, so the next wait restarts at the floor.
        assert_eq!(retry_secs(&policy.on_disconnect(dropped(12, 3))), 1);
        assert_eq!(retry_secs(&policy.on_disconnect(dropped(4, 1))), 1);
    }

    /// The regression this policy exists for: a gateway that accepts the socket
    /// and closes it immediately must not reset the backoff.
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
        // No chat, but the socket held for the healthy window: a quiet room is
        // not a broken one.
        assert_eq!(retry_secs(&policy.on_disconnect(dropped(0, 120))), 1);
    }

    #[test]
    fn throttling_uses_its_own_floor_and_ceiling() {
        // A wide streak limit keeps this focused on the delay schedule; the
        // streak itself is covered above.
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
        // The floor dominates while exponential growth is still below it.
        for _ in 0..6 {
            assert_eq!(retry_secs(&policy.on_disconnect(throttled())), 60);
        }
        // Then growth resumes from the schedule and rises toward the ceiling.
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
