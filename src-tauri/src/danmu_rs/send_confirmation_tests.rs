//! 抖音 HTTP 写入确认与 WSS 回显共用的去重、身份和房间围栏边界。

use super::*;
use crate::danmu_rs::douyin_send::ConfirmedChat;

use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

const SOURCE: &str = "live:douyin:67876457927";

fn chat(id: &str, content: &str) -> DanmakuEvent {
    ConfirmedChat {
        message_id: id.to_owned(),
        user: "Kenny3S".to_owned(),
        content: content.to_owned(),
    }
    .into_parts()
    .1
}

fn sender() -> (
    DanmakuEventSender,
    mpsc::Receiver<DanmakuEvent>,
    Arc<Mutex<MessageIdCache>>,
) {
    let (event_tx, event_rx) = mpsc::channel(DANMAKU_MESSAGE_ID_CACHE_LIMIT + 16);
    let cache = Arc::new(Mutex::new(MessageIdCache::default()));
    let event_sender = DanmakuEventSender::new(event_tx, SelfDanmakuIdentity::default())
        .with_message_ids(cache.clone());
    (event_sender, event_rx, cache)
}

fn manager_with_sender(
    generation: u64,
    source: &str,
) -> (DanmakuManager, mpsc::Receiver<DanmakuEvent>) {
    let manager = DanmakuManager::new();
    assert!(manager.begin_connect(generation, source.to_owned(), false));
    let (event_sender, receiver, _) = sender();
    let (connection, batch, control) = (
        tauri::async_runtime::spawn(std::future::pending::<()>()),
        tauri::async_runtime::spawn(std::future::pending::<()>()),
        mpsc::unbounded_channel().0,
    );
    assert!(manager.set_tasks_if_current(generation, connection, batch, control, event_sender,));
    (manager, receiver)
}

fn install_sender(manager: &DanmakuManager, generation: u64) -> mpsc::Receiver<DanmakuEvent> {
    let (event_sender, receiver, _) = sender();
    let (connection, batch, control) = (
        tauri::async_runtime::spawn(std::future::pending::<()>()),
        tauri::async_runtime::spawn(std::future::pending::<()>()),
        mpsc::unbounded_channel().0,
    );
    assert!(manager.set_tasks_if_current(generation, connection, batch, control, event_sender));
    receiver
}

fn server_chat() -> ConfirmedChat {
    ConfirmedChat {
        message_id: "7706880368884470826".into(),
        user: "Kenny3S".into(),
        content: "弹幕氛围好差，玩乐器的大姐姐在癞痢？".into(),
    }
}

#[tokio::test]
async fn http_confirmation_arriving_first_suppresses_the_same_wss_echo() {
    let (event_sender, mut receiver, _) = sender();
    let (message_id, event) = server_chat().into_parts();
    event_sender.send_confirmed(&message_id, event);
    event_sender.send_with_id(Some(&message_id), chat(&message_id, "WSS 重复回显"), false);

    let first = receiver.recv().await.expect("服务器确认消息");
    assert!(first.is_self);
    assert_eq!(first.content, "弹幕氛围好差，玩乐器的大姐姐在癞痢？");
    assert_eq!(first.user, "Kenny3S");
    assert!(
        receiver.try_recv().is_err(),
        "相同消息 ID 的 WSS 回显不得再产生一条"
    );

    // 相同正文、不同 ID 是另一条消息，不能按内容去重。
    event_sender.send_with_id(
        Some("7706880368884470827"),
        chat(
            "7706880368884470827",
            "弹幕氛围好差，玩乐器的大姐姐在癞痢？",
        ),
        false,
    );
    assert_eq!(
        receiver
            .recv()
            .await
            .expect("不同消息 ID 的内容仍应显示")
            .content,
        "弹幕氛围好差，玩乐器的大姐姐在癞痢？"
    );
}

#[tokio::test]
async fn a_full_channel_does_not_remember_an_unqueued_message_id() {
    let (event_tx, mut receiver) = mpsc::channel(1);
    let event_sender = DanmakuEventSender::new(event_tx, SelfDanmakuIdentity::default())
        .with_message_ids(Arc::new(Mutex::new(MessageIdCache::default())));
    event_sender.send_with_id(Some("1"), chat("1", "第一条"), false);
    let (message_id, event) = server_chat().into_parts();
    event_sender.send_confirmed(&message_id, event);

    assert!(receiver.recv().await.is_some());
    assert!(receiver.try_recv().is_err(), "有界队列已满时第二条不入队");
    // 消费掉第一条后，第二条的 WSS 回显仍可显示：队列满时没有记入缓存。
    event_sender.send_with_id(
        Some(&message_id),
        chat(&message_id, "消费后重新到达的 WSS 回显"),
        false,
    );
    assert!(receiver.recv().await.is_some());
}

#[tokio::test]
async fn confirmation_waits_for_the_same_generation_sender_install() {
    let manager = Arc::new(DanmakuManager::new());
    assert!(manager.begin_connect(100, SOURCE.to_owned(), false));
    let guard = manager.send_guard_for_source(SOURCE).expect("活动房间围栏");
    let waiting = {
        let manager = manager.clone();
        tauri::async_runtime::spawn(async move {
            manager
                .emit_douyin_send_confirmation(guard, server_chat())
                .await
        })
    };
    // 先让等待任务订阅 watch 并进入等待，再安装当前 generation 的批次。
    tokio::task::yield_now().await;
    let mut receiver = install_sender(&manager, 100);
    let event = receiver.recv().await.expect("连接安装后收到服务器确认");
    assert!(event.is_self);
    assert_eq!(event.content, "弹幕氛围好差，玩乐器的大姐姐在癞痢？");
    waiting.await.unwrap();
}

#[tokio::test]
async fn confirmation_is_dropped_when_the_room_changes_while_waiting() {
    let manager = Arc::new(DanmakuManager::new());
    assert!(manager.begin_connect(100, SOURCE.to_owned(), false));
    let guard = manager.send_guard_for_source(SOURCE).expect("活动房间围栏");
    let waiting = {
        let manager = manager.clone();
        tauri::async_runtime::spawn(async move {
            manager
                .emit_douyin_send_confirmation(guard, server_chat())
                .await
        })
    };
    tokio::task::yield_now().await;
    assert!(manager.begin_connect(101, "live:douyin:other".into(), false));
    let mut other_receiver = install_sender(&manager, 101);
    assert!(
        other_receiver.try_recv().is_err(),
        "旧房间确认不能注入新房间"
    );
    waiting.await.unwrap();
}

#[tokio::test]
async fn reenter_of_the_same_room_invalidates_a_stale_confirmation() {
    let manager = DanmakuManager::new();
    assert!(manager.begin_connect(100, SOURCE.to_owned(), false));
    let guard = manager.send_guard_for_source(SOURCE).expect("活动房间围栏");
    assert!(manager.begin_connect(101, SOURCE.to_owned(), false));
    let mut receiver = install_sender(&manager, 101);
    manager
        .emit_douyin_send_confirmation(guard, server_chat())
        .await;
    assert!(
        receiver.try_recv().is_err(),
        "同房重进后不能把旧 generation 的确认注入新批次"
    );
}

#[tokio::test]
async fn wss_echo_arriving_first_suppresses_the_same_http_confirmation() {
    let (event_sender, mut receiver, _) = sender();
    event_sender.send_with_id(Some("42"), chat("42", "服务器回显先到"), false);
    event_sender.send_confirmed("42", chat("42", "服务器确认后到"));

    assert_eq!(
        receiver.recv().await.expect("WSS 回显").content,
        "服务器回显先到"
    );
    assert!(
        receiver.try_recv().is_err(),
        "相同消息 ID 的 HTTP 确认不得再产生一条"
    );
}

#[tokio::test]
async fn concurrent_confirmation_and_wss_echo_enqueue_only_once() {
    let (event_sender, mut receiver, _) = sender();
    let http_sender = event_sender.clone();
    let wss_sender = event_sender.clone();
    let http = tauri::async_runtime::spawn(async move {
        http_sender.send_confirmed("7706880368884470826", chat("7706880368884470826", "重复"));
    });
    let wss = tauri::async_runtime::spawn(async move {
        wss_sender.send_with_id(
            Some("7706880368884470826"),
            chat("7706880368884470826", "重复"),
            false,
        );
    });
    http.await.unwrap();
    wss.await.unwrap();

    assert!(receiver.recv().await.is_some());
    assert!(
        receiver.try_recv().is_err(),
        "并发到达时消息 ID 缓存也必须原子去重"
    );
}

#[tokio::test]
async fn message_id_cache_has_a_bounded_lifetime() {
    let (event_sender, mut receiver, cache) = sender();
    for id in 1..=DANMAKU_MESSAGE_ID_CACHE_LIMIT as u64 + 1 {
        event_sender.send_with_id(
            Some(&id.to_string()),
            chat(&id.to_string(), "有界缓存"),
            false,
        );
    }
    let cached = cache.lock().unwrap();
    assert_eq!(cached.seen.len(), DANMAKU_MESSAGE_ID_CACHE_LIMIT);
    assert_eq!(cached.order.len(), DANMAKU_MESSAGE_ID_CACHE_LIMIT);
    assert!(!cached.seen.contains("1"));
    drop(cached);

    // 最早一条被淘汰后，重新收到相同 ID 仍按一条新事件入队。
    event_sender.send_with_id(Some("1"), chat("1", "淘汰后仍可显示"), false);
    for _ in 0..DANMAKU_MESSAGE_ID_CACHE_LIMIT + 1 {
        assert!(receiver.recv().await.is_some());
    }
    assert_eq!(
        receiver.recv().await.expect("淘汰后的 ID").content,
        "淘汰后仍可显示"
    );
}

#[tokio::test]
async fn server_confirmation_marks_itself_even_when_cookie_identity_cannot_match() {
    let (event_tx, mut receiver) = mpsc::channel(2);
    // 抖音不会从 session token 推断身份；Cookie 中也没有昵称时 mark 会得到 false。
    let identity = SelfDanmakuIdentity::from_cookie(&SiteId::Douyin, "sessionid=opaque");
    let event_sender = DanmakuEventSender::new(event_tx, identity)
        .with_message_ids(Arc::new(Mutex::new(MessageIdCache::default())));
    let mut event = chat("42", "服务器确认");
    event.is_self = false;
    event_sender.send_confirmed("42", event);

    let event = receiver.recv().await.expect("服务器确认消息");
    assert!(event.is_self, "来自写入响应的确认必须标为自己的消息");
    assert!(matches!(event.kind, DanmakuKind::Chat));
}

#[tokio::test]
async fn guard_requires_both_the_generation_and_the_exact_source() {
    let (manager, mut original_receiver) = manager_with_sender(100, SOURCE);
    let old_guard = manager.send_guard_for_source(SOURCE).expect("原房间围栏");
    let missing_guard = manager.send_guard_for_source("live:douyin:other");
    assert!(missing_guard.is_none(), "其他房间不能取得活动连接围栏");

    // 相同 generation 下换成另一个房间，旧围栏仍不得把确认投递到新批次。
    assert!(manager.begin_connect(100, "live:douyin:other".into(), false));
    let other_receiver = {
        let (event_sender, receiver, _) = sender();
        let (connection, batch, control) = (
            tauri::async_runtime::spawn(std::future::pending::<()>()),
            tauri::async_runtime::spawn(std::future::pending::<()>()),
            mpsc::unbounded_channel().0,
        );
        assert!(manager.set_tasks_if_current(100, connection, batch, control, event_sender));
        receiver
    };
    let mut other_receiver = other_receiver;
    manager
        .emit_douyin_send_confirmation(
            old_guard,
            ConfirmedChat {
                message_id: "42".into(),
                user: "Kenny3S".into(),
                content: "旧房间消息".into(),
            },
        )
        .await;
    assert!(
        other_receiver.try_recv().is_err(),
        "source_key 不匹配时不得注入"
    );
    assert!(
        original_receiver.try_recv().is_err(),
        "旧批次也不得收到确认"
    );
    assert!(manager.send_guard_for_source(SOURCE).is_none());
}
