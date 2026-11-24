use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;

use crate::error::{AppError, AppResult};

pub const FOLLOW_LIVE_STARTED_EVENT: &str = "follow-live-started";

/// 前端收到后同时发送系统通知与应用内提示。
///
/// 事件刻意只带稳定的关注标识和展示名，不携带地址、Cookie 或平台响应内容。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FollowLiveStartedPayload {
    pub site_id: String,
    pub room_id: String,
    pub user_name: String,
}

/// 一轮刷新中单个房间已经由平台确认的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveStatusObservationState {
    Offline,
    Live { live_started_at: Option<i64> },
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveStatusObservation {
    pub site_id: String,
    pub room_id: String,
    pub user_name: String,
    pub state: LiveStatusObservationState,
}

#[derive(Debug, Clone, Copy)]
pub struct RefreshToken {
    round_id: u64,
    follow_generation: u64,
    settings_generation: u64,
}

pub struct RoundPlan {
    follow_generation_matches: bool,
    fresh_keys: HashSet<(String, String)>,
}

impl RoundPlan {
    pub fn allows(&self, site_id: &str, room_id: &str) -> bool {
        self.follow_generation_matches
            && self
                .fresh_keys
                .contains(&(site_id.to_owned(), room_id.to_owned()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfirmedLive {
    Offline,
    Live { live_started_at: Option<i64> },
}

#[derive(Debug, Clone, Copy)]
struct TrackedFollow {
    confirmed: Option<ConfirmedLive>,
    latest_round: u64,
}

struct TrackerState {
    enabled: Option<bool>,
    next_round: u64,
    follow_generation: u64,
    settings_generation: u64,
    follows: HashMap<(String, String), TrackedFollow>,
}

impl Default for TrackerState {
    fn default() -> Self {
        Self {
            enabled: None,
            next_round: 1,
            follow_generation: 0,
            settings_generation: 0,
            follows: HashMap::new(),
        }
    }
}

impl TrackerState {
    fn sync_enabled(&mut self, enabled: bool) {
        if self.enabled != Some(enabled) {
            self.enabled = Some(enabled);
            self.settings_generation = self.settings_generation.wrapping_add(1);
            // 重新启用后的第一条成功结果只能建立基线；网络期间改变开关时，
            // 旧轮次也必须失效。
            self.follows.clear();
        }
    }
}

/// 应用生命周期内的直播开播追踪器。
///
/// 每次刷新开始时取一个轮次号。较新的轮次先落库后，较旧轮次即使随后完成，
/// 也不能覆盖已验证状态或再次发出通知。失败结果会占用该轮次但不改变最后
/// 确认状态，因此一次失败不会忘记已确认的未开播事实。
pub struct FollowNotificationTracker {
    state: Mutex<TrackerState>,
}

impl Default for FollowNotificationTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl FollowNotificationTracker {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(TrackerState::default()),
        }
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, TrackerState>> {
        self.state
            .lock()
            .map_err(|_| AppError::new("follow_notification_lock", "开播通知状态暂不可用"))
    }

    /// 在网络请求之前读取开关并固定本轮代次。
    pub fn begin_refresh(&self, enabled_at_start: bool) -> AppResult<RefreshToken> {
        let mut state = self.lock()?;
        state.sync_enabled(enabled_at_start);
        let token = RefreshToken {
            round_id: state.next_round,
            follow_generation: state.follow_generation,
            settings_generation: state.settings_generation,
        };
        state.next_round = state.next_round.wrapping_add(1);
        Ok(token)
    }

    /// 在数据库锁内规划本轮可写入的键。
    ///
    /// `current_enabled` 必须来自网络请求结束后的设置重读，不能复用刷新开始时
    /// 的值。若网络期间开关发生变化，这里会清空旧基线；本轮仍可更新关注状态
    /// 数据库，但不会据此生成通知。
    pub fn plan_round(
        &self,
        token: &RefreshToken,
        current_enabled: bool,
        observations: &[LiveStatusObservation],
    ) -> AppResult<RoundPlan> {
        let mut state = self.lock()?;
        state.sync_enabled(current_enabled);
        let follow_generation_matches = token.follow_generation == state.follow_generation;
        let mut fresh_keys = HashSet::new();
        if follow_generation_matches {
            for observation in observations {
                let key = (observation.site_id.clone(), observation.room_id.clone());
                if state
                    .follows
                    .get(&key)
                    .is_none_or(|tracked| tracked.latest_round < token.round_id)
                {
                    fresh_keys.insert(key);
                }
            }
        }
        Ok(RoundPlan {
            follow_generation_matches,
            fresh_keys,
        })
    }

    /// 只在同一批关注状态已经成功落库后调用。
    pub fn record_round(
        &self,
        token: &RefreshToken,
        current_enabled: bool,
        observations: &[LiveStatusObservation],
    ) -> AppResult<Vec<FollowLiveStartedPayload>> {
        let mut state = self.lock()?;
        state.sync_enabled(current_enabled);
        if token.follow_generation != state.follow_generation
            || token.settings_generation != state.settings_generation
        {
            return Ok(Vec::new());
        }

        let mut notifications = Vec::new();
        for observation in observations {
            let key = (observation.site_id.clone(), observation.room_id.clone());
            let tracked = state.follows.entry(key).or_insert(TrackedFollow {
                confirmed: None,
                latest_round: 0,
            });
            if tracked.latest_round >= token.round_id {
                continue;
            }
            tracked.latest_round = token.round_id;

            let previous = tracked.confirmed;
            match observation.state {
                LiveStatusObservationState::Unknown => {
                    // 未知只占用轮次，保留下方最后确认状态。
                }
                LiveStatusObservationState::Offline => {
                    tracked.confirmed = Some(ConfirmedLive::Offline);
                }
                LiveStatusObservationState::Live { live_started_at } => {
                    let (live_started_at, session_changed) = match (previous, live_started_at) {
                        (
                            Some(ConfirmedLive::Live {
                                live_started_at: Some(previous_start),
                            }),
                            Some(current_start),
                        ) if current_start > previous_start => (Some(current_start), true),
                        (
                            Some(ConfirmedLive::Live {
                                live_started_at: Some(previous_start),
                            }),
                            _,
                        ) => (Some(previous_start), false),
                        (
                            Some(ConfirmedLive::Live {
                                live_started_at: previous_start,
                            }),
                            current_start,
                        ) => (current_start.or(previous_start), false),
                        (_, current_start) => (current_start, false),
                    };
                    let newly_live = matches!(previous, Some(ConfirmedLive::Offline));
                    tracked.confirmed = Some(ConfirmedLive::Live { live_started_at });
                    if state.enabled == Some(true) && (newly_live || session_changed) {
                        notifications.push(FollowLiveStartedPayload {
                            site_id: observation.site_id.clone(),
                            room_id: observation.room_id.clone(),
                            user_name: observation.user_name.clone(),
                        });
                    }
                }
            }
        }
        Ok(notifications)
    }

    /// 单个关注增删或重新添加时，只让该键的旧轮次失效。
    ///
    /// barrier 使用最后一个已经分配的轮次号，因此所有旧刷新都会失效，
    /// 下一个尚未分配的轮次则可以建立该关注的静默基线。其他主播的确认状态
    /// 不受影响。
    pub fn reset_follow(&self, site_id: &str, room_id: &str) -> AppResult<()> {
        let mut state = self.lock()?;
        let barrier = state.next_round.saturating_sub(1);
        state.follows.insert(
            (site_id.to_owned(), room_id.to_owned()),
            TrackedFollow {
                confirmed: None,
                latest_round: barrier,
            },
        );
        Ok(())
    }

    /// 通知开关变化或配置导入后切换代次，使所有网络中的旧轮次失效。
    pub fn reset_notifications_setting(&self, enabled: bool) -> AppResult<()> {
        let mut state = self.lock()?;
        state.enabled = Some(enabled);
        state.settings_generation = state.settings_generation.wrapping_add(1);
        state.follows.clear();
        Ok(())
    }

    /// 配置导入可能同时替换关注与设置，因此两类代次都要推进。
    pub fn reset_all(&self) -> AppResult<()> {
        let mut state = self.lock()?;
        state.enabled = None;
        state.follow_generation = state.follow_generation.wrapping_add(1);
        state.settings_generation = state.settings_generation.wrapping_add(1);
        state.follows.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(state: LiveStatusObservationState) -> LiveStatusObservation {
        LiveStatusObservation {
            site_id: "bilibili".into(),
            room_id: "1".into(),
            user_name: "主播".into(),
            state,
        }
    }

    fn refresh(
        tracker: &FollowNotificationTracker,
        enabled: bool,
        observation: LiveStatusObservation,
    ) -> Vec<FollowLiveStartedPayload> {
        let token = tracker.begin_refresh(enabled).unwrap();
        let plan = tracker
            .plan_round(&token, enabled, std::slice::from_ref(&observation))
            .unwrap();
        assert!(plan.allows(&observation.site_id, &observation.room_id));
        tracker
            .record_round(&token, enabled, &[observation])
            .unwrap()
    }

    #[test]
    fn first_success_is_silent_and_repeated_live_refreshes_do_not_repeat() {
        let tracker = FollowNotificationTracker::new();
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(100)
                })
            )
            .is_empty()
        );
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(100)
                })
            )
            .is_empty()
        );
    }

    #[test]
    fn confirmed_offline_to_live_notifies_once() {
        let tracker = FollowNotificationTracker::new();
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Offline)
            )
            .is_empty()
        );
        let notifications = refresh(
            &tracker,
            true,
            observation(LiveStatusObservationState::Live {
                live_started_at: Some(100),
            }),
        );
        assert_eq!(notifications[0].user_name, "主播");
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(100)
                })
            )
            .is_empty()
        );
    }

    #[test]
    fn unknown_keeps_confirmed_offline_and_does_not_swallow_next_start() {
        let tracker = FollowNotificationTracker::new();
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Offline)
            )
            .is_empty()
        );
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Unknown)
            )
            .is_empty()
        );
        assert_eq!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(100)
                })
            )
            .len(),
            1
        );
    }

    #[test]
    fn unknown_after_a_confirmed_live_does_not_duplicate_the_same_session() {
        let tracker = FollowNotificationTracker::new();
        refresh(
            &tracker,
            true,
            observation(LiveStatusObservationState::Live {
                live_started_at: Some(100),
            }),
        );
        refresh(
            &tracker,
            true,
            observation(LiveStatusObservationState::Unknown),
        );
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(100)
                })
            )
            .is_empty()
        );
    }

    #[test]
    fn a_reliable_new_start_timestamp_identifies_a_new_live_session() {
        let tracker = FollowNotificationTracker::new();
        refresh(
            &tracker,
            true,
            observation(LiveStatusObservationState::Live {
                live_started_at: Some(100),
            }),
        );
        let notifications = refresh(
            &tracker,
            true,
            observation(LiveStatusObservationState::Live {
                live_started_at: Some(200),
            }),
        );
        assert_eq!(notifications.len(), 1);
    }

    #[test]
    fn first_live_after_reset_or_new_follow_only_establishes_a_baseline() {
        let tracker = FollowNotificationTracker::new();
        refresh(
            &tracker,
            true,
            observation(LiveStatusObservationState::Live {
                live_started_at: Some(100),
            }),
        );
        tracker.reset_follow("bilibili", "1").unwrap();
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(100)
                })
            )
            .is_empty()
        );
    }

    #[test]
    fn resetting_one_follow_keeps_other_confirmed_offline_baselines() {
        let tracker = FollowNotificationTracker::new();
        refresh(
            &tracker,
            true,
            observation(LiveStatusObservationState::Offline),
        );
        tracker.reset_follow("bilibili", "2").unwrap();
        assert_eq!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(100),
                }),
            )
            .len(),
            1
        );
    }

    #[test]
    fn a_single_follow_reset_blocks_only_its_in_flight_round() {
        let tracker = FollowNotificationTracker::new();
        let stale = tracker.begin_refresh(true).unwrap();
        tracker.reset_follow("bilibili", "1").unwrap();
        let plan = tracker
            .plan_round(
                &stale,
                true,
                &[observation(LiveStatusObservationState::Offline)],
            )
            .unwrap();
        assert!(!plan.allows("bilibili", "1"));
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(100)
                })
            )
            .is_empty()
        );
    }

    #[test]
    fn reset_follow_establishes_offline_before_the_next_live_notifies() {
        let tracker = FollowNotificationTracker::new();
        tracker.reset_follow("bilibili", "1").unwrap();
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Offline)
            )
            .is_empty()
        );
        assert_eq!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(100)
                })
            )
            .len(),
            1
        );
    }

    #[test]
    fn a_backward_start_timestamp_is_not_treated_as_a_new_session() {
        let tracker = FollowNotificationTracker::new();
        refresh(
            &tracker,
            true,
            observation(LiveStatusObservationState::Live {
                live_started_at: Some(200),
            }),
        );
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(100)
                })
            )
            .is_empty()
        );
        // 倒退值不得覆盖已确认的较大时间戳，否则下一次恢复为 200 会误报。
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(200)
                })
            )
            .is_empty()
        );
    }

    #[test]
    fn setting_change_during_network_wait_invalidates_the_round_baseline() {
        let tracker = FollowNotificationTracker::new();
        let token = tracker.begin_refresh(false).unwrap();
        let live = observation(LiveStatusObservationState::Live {
            live_started_at: Some(100),
        });
        let plan = tracker
            .plan_round(&token, true, std::slice::from_ref(&live))
            .unwrap();
        assert!(plan.allows("bilibili", "1"));
        assert!(
            tracker
                .record_round(&token, true, &[live])
                .unwrap()
                .is_empty()
        );
        // 新开关代次的第一条成功结果仍是静默基线。
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(100)
                })
            )
            .is_empty()
        );
    }

    #[test]
    fn a_newer_unknown_round_blocks_a_stale_success_from_notifying() {
        let tracker = FollowNotificationTracker::new();
        refresh(
            &tracker,
            true,
            observation(LiveStatusObservationState::Offline),
        );
        let stale = tracker.begin_refresh(true).unwrap();
        let newer = tracker.begin_refresh(true).unwrap();
        tracker
            .record_round(
                &newer,
                true,
                &[observation(LiveStatusObservationState::Unknown)],
            )
            .unwrap();
        assert!(
            tracker
                .record_round(
                    &stale,
                    true,
                    &[observation(LiveStatusObservationState::Live {
                        live_started_at: Some(200),
                    })],
                )
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(200)
                })
            )
            .len(),
            1
        );
    }

    #[test]
    fn an_older_round_cannot_regress_a_newer_confirmed_live_state() {
        let tracker = FollowNotificationTracker::new();
        refresh(
            &tracker,
            true,
            observation(LiveStatusObservationState::Offline),
        );
        let stale = tracker.begin_refresh(true).unwrap();
        let newer = tracker.begin_refresh(true).unwrap();
        assert_eq!(
            tracker
                .record_round(
                    &newer,
                    true,
                    &[observation(LiveStatusObservationState::Live {
                        live_started_at: Some(200),
                    })],
                )
                .unwrap()
                .len(),
            1
        );
        assert!(
            tracker
                .record_round(
                    &stale,
                    true,
                    &[observation(LiveStatusObservationState::Offline)],
                )
                .unwrap()
                .is_empty()
        );
        assert!(
            refresh(
                &tracker,
                true,
                observation(LiveStatusObservationState::Live {
                    live_started_at: Some(200)
                })
            )
            .is_empty()
        );
    }
}
