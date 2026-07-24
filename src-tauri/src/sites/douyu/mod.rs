//! Douyu live site — ported from simple_live_core `douyu_site.dart`.

mod sign;

use std::collections::HashMap;

use reqwest::Client;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::http_client;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomItem, LiveSubCategory, PlayUrl,
    RoomListPage, SiteId,
};
use crate::sites::traits::LiveSite;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.43";

pub struct DouyuSite {
    client: Client,
}

impl Default for DouyuSite {
    fn default() -> Self {
        Self {
            client: http_client::default_client(),
        }
    }
}

impl DouyuSite {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    fn err(msg: impl Into<String>) -> AppError {
        AppError::new("douyu_api_error", msg)
            .with_site("douyu")
            .retryable()
    }

    async fn get_json(&self, url: &str, referer: &str) -> AppResult<Value> {
        let text = self
            .client
            .get(url)
            .header("user-agent", UA)
            .header("referer", referer)
            .send()
            .await
            .map_err(|e| Self::err(format!("http: {e}")))?
            .text()
            .await
            .map_err(|e| Self::err(format!("body: {e}")))?;
        serde_json::from_str(&text).map_err(|e| Self::err(format!("json: {e}")))
    }

    async fn post_form(&self, url: &str, body: &str, referer: &str) -> AppResult<Value> {
        let text = self
            .client
            .post(url)
            .header("user-agent", UA)
            .header("referer", referer)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| Self::err(format!("http post: {e}")))?
            .text()
            .await
            .map_err(|e| Self::err(format!("body: {e}")))?;
        serde_json::from_str(&text).map_err(|e| Self::err(format!("json: {e}")))
    }

    async fn room_info(&self, room_id: &str) -> AppResult<Value> {
        // betard API returns room dict
        let url = format!("https://www.douyu.com/betard/{room_id}");
        let v = self
            .get_json(&url, &format!("https://www.douyu.com/{room_id}"))
            .await?;
        // Sometimes wrapped
        if v.get("room").is_some() {
            Ok(v)
        } else if v.get("data").is_some() {
            Ok(v)
        } else {
            Ok(serde_json::json!({ "room": v }))
        }
    }
}

fn json_i64(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_u64().map(|u| u as i64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

fn json_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}

fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn parse_mix_list(v: &Value) -> AppResult<RoomListPage> {
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let mut items = Vec::new();
    if let Some(arr) = data.get("rl").and_then(|x| x.as_array()) {
        for item in arr {
            if json_i64(item.get("type").unwrap_or(&Value::Null)) != 1 {
                continue;
            }
            items.push(LiveRoomItem {
                site_id: SiteId::Douyu,
                room_id: json_str(item.get("rid").unwrap_or(&Value::Null)),
                title: json_str(item.get("rn").unwrap_or(&Value::Null)),
                cover: json_str(item.get("rs16").unwrap_or(&Value::Null)),
                user_name: json_str(item.get("nn").unwrap_or(&Value::Null)),
                online: json_i64(item.get("ol").unwrap_or(&Value::Null)),
            });
        }
    }
    let page = json_i64(
        // callers pass page externally; pgcnt is total pages
        data.get("pgcnt").unwrap_or(&Value::Null),
    );
    Ok(RoomListPage {
        // has_more decided by caller when page known; use rl length heuristic
        has_more: page > 1 || items.len() >= 20,
        items,
    })
}

#[async_trait::async_trait]
impl LiveSite for DouyuSite {
    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        let v = self
            .get_json("https://m.douyu.com/api/cate/list", "https://m.douyu.com/")
            .await?;
        let data = v.get("data").cloned().unwrap_or(Value::Null);
        let cate1 = data
            .get("cate1Info")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        let cate2 = data
            .get("cate2Info")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        let mut categories = Vec::new();
        for c1 in cate1 {
            let id = json_str(c1.get("cate1Id").unwrap_or(&Value::Null));
            let name = json_str(c1.get("cate1Name").unwrap_or(&Value::Null));
            let mut children = Vec::new();
            for c2 in &cate2 {
                if json_str(c2.get("cate1Id").unwrap_or(&Value::Null)) != id {
                    continue;
                }
                children.push(LiveSubCategory {
                    id: json_str(c2.get("cate2Id").unwrap_or(&Value::Null)),
                    name: json_str(c2.get("cate2Name").unwrap_or(&Value::Null)),
                    parent_id: id.clone(),
                    pic: c2.get("icon").map(json_str).filter(|s| !s.is_empty()),
                });
            }
            categories.push(LiveCategory { id, name, children });
        }
        categories.sort_by(|a, b| {
            a.id.parse::<i64>()
                .unwrap_or(0)
                .cmp(&b.id.parse::<i64>().unwrap_or(0))
        });
        Ok(categories)
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        let page = page.max(1);
        let url = format!("https://www.douyu.com/japi/weblist/apinc/allpage/6/{page}");
        let v = self.get_json(&url, "https://www.douyu.com/").await?;
        let mut page_data = parse_mix_list(&v)?;
        let pgcnt = json_i64(v.pointer("/data/pgcnt").unwrap_or(&Value::Null));
        page_data.has_more = (page as i64) < pgcnt;
        Ok(page_data)
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        let page = page.max(1);
        let url = format!(
            "https://www.douyu.com/gapi/rkc/directory/mixList/2_{}/{page}",
            category.id
        );
        let v = self.get_json(&url, "https://www.douyu.com/").await?;
        let mut page_data = parse_mix_list(&v)?;
        let pgcnt = json_i64(v.pointer("/data/pgcnt").unwrap_or(&Value::Null));
        page_data.has_more = (page as i64) < pgcnt;
        Ok(page_data)
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let page = page.max(1);
        let did = "10000000000000000000000000001501";
        let url = format!(
            "https://www.douyu.com/japi/search/api/searchShow?kw={}&page={page}&pageSize=20",
            urlencoding_encode(keyword)
        );
        let text = self
            .client
            .get(&url)
            .header("user-agent", UA)
            .header("referer", "https://www.douyu.com/search/")
            .header("cookie", format!("dy_did={did};acf_did={did}"))
            .send()
            .await
            .map_err(|e| Self::err(format!("http: {e}")))?
            .text()
            .await
            .map_err(|e| Self::err(format!("body: {e}")))?;
        let v: Value = serde_json::from_str(&text).map_err(|e| Self::err(format!("json: {e}")))?;
        let mut items = Vec::new();
        if let Some(arr) = v
            .pointer("/data/relateShow")
            .or_else(|| v.pointer("/data/list"))
            .and_then(|x| x.as_array())
        {
            for item in arr {
                let room_id = json_str(
                    item.get("rid")
                        .or_else(|| item.get("roomId"))
                        .unwrap_or(&Value::Null),
                );
                if room_id.is_empty() {
                    continue;
                }
                items.push(LiveRoomItem {
                    site_id: SiteId::Douyu,
                    room_id,
                    title: json_str(
                        item.get("roomName")
                            .or_else(|| item.get("rn"))
                            .unwrap_or(&Value::Null),
                    ),
                    cover: json_str(
                        item.get("roomSrc")
                            .or_else(|| item.get("rs16"))
                            .unwrap_or(&Value::Null),
                    ),
                    user_name: json_str(
                        item.get("nickName")
                            .or_else(|| item.get("nn"))
                            .unwrap_or(&Value::Null),
                    ),
                    online: json_i64(
                        item.get("hot")
                            .or_else(|| item.get("ol"))
                            .unwrap_or(&Value::Null),
                    ),
                });
            }
        }
        Ok(RoomListPage {
            has_more: items.len() >= 20,
            items,
        })
    }

    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let root = self.room_info(room_id).await?;
        let room = root.get("room").cloned().unwrap_or_else(|| root.clone());

        let enc = self
            .get_json(
                &format!("https://www.douyu.com/swf_api/homeH5Enc?rids={room_id}"),
                &format!("https://www.douyu.com/{room_id}"),
            )
            .await?;
        let key = format!("room{room_id}");
        let crptext = json_str(enc.pointer(&format!("/data/{key}")).unwrap_or(&Value::Null));
        if crptext.is_empty() {
            return Err(Self::err("homeH5Enc empty"));
        }
        let sign_body = sign::get_sign(&crptext, room_id)?;

        let show_status = json_i64(room.get("show_status").unwrap_or(&Value::Null));
        let video_loop = json_i64(room.get("videoLoop").unwrap_or(&Value::Null));
        let hot = room
            .pointer("/room_biz_all/hot")
            .map(json_i64)
            .unwrap_or_else(|| json_i64(room.get("hn").unwrap_or(&Value::Null)));

        Ok(LiveRoomDetail {
            site_id: SiteId::Douyu,
            room_id: json_str(
                room.get("room_id")
                    .unwrap_or(&Value::String(room_id.into())),
            ),
            title: json_str(room.get("room_name").unwrap_or(&Value::Null)),
            cover: json_str(room.get("room_pic").unwrap_or(&Value::Null)),
            user_name: json_str(room.get("owner_name").unwrap_or(&Value::Null)),
            user_avatar: json_str(room.get("owner_avatar").unwrap_or(&Value::Null)),
            online: hot,
            status: show_status == 1 && video_loop != 1,
            notice: json_str(room.get("show_details").unwrap_or(&Value::Null)),
            url: format!("https://www.douyu.com/{room_id}"),
            raw: serde_json::json!({
                "sign": sign_body,
                "room_id": room_id,
            }),
        })
    }

    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>> {
        let mut data = json_str(detail.raw.get("sign").unwrap_or(&Value::Null));
        data.push_str("&cdn=&rate=-1&ver=Douyu_223061205&iar=1&ive=1&hevc=0&fa=0");
        let room_id = detail.room_id.clone();
        let v = self
            .post_form(
                &format!("https://www.douyu.com/lapi/live/getH5Play/{room_id}"),
                &data,
                &format!("https://www.douyu.com/{room_id}"),
            )
            .await?;
        let data_obj = v.get("data").cloned().unwrap_or(Value::Null);
        let mut cdns: Vec<String> = data_obj
            .get("cdnsWithName")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|i| json_str(i.get("cdn").unwrap_or(&Value::Null)))
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        cdns.sort_by(|a, b| {
            let as_ = a.starts_with("scdn");
            let bs = b.starts_with("scdn");
            as_.cmp(&bs)
        });

        let mut qualities = Vec::new();
        if let Some(arr) = data_obj.get("multirates").and_then(|x| x.as_array()) {
            for item in arr {
                let rate = json_i64(item.get("rate").unwrap_or(&Value::Null));
                let name = json_str(item.get("name").unwrap_or(&Value::Null));
                qualities.push(LivePlayQuality {
                    quality: if name.is_empty() {
                        format!("rate{rate}")
                    } else {
                        name
                    },
                    data: serde_json::json!({
                        "rate": rate,
                        "cdns": cdns,
                        "sign": detail.raw.get("sign").cloned().unwrap_or(Value::String(String::new())),
                    }),
                });
            }
        }
        if qualities.is_empty() {
            qualities.push(LivePlayQuality {
                quality: "原画".into(),
                data: serde_json::json!({
                    "rate": 0,
                    "cdns": cdns,
                    "sign": detail.raw.get("sign").cloned().unwrap_or(Value::String(String::new())),
                }),
            });
        }
        Ok(qualities)
    }

    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        let rate = json_i64(quality.data.get("rate").unwrap_or(&Value::Null));
        let sign = json_str(quality.data.get("sign").unwrap_or(&Value::Null));
        let cdns = quality
            .data
            .get("cdns")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        let room_id = detail.room_id.clone();
        let mut headers = HashMap::new();
        headers.insert("user-agent".into(), UA.into());
        headers.insert("referer".into(), format!("https://www.douyu.com/{room_id}"));

        let mut urls = Vec::new();
        for cdn_v in cdns {
            let cdn = json_str(&cdn_v);
            let body = format!("{sign}&cdn={cdn}&rate={rate}");
            let v = self
                .post_form(
                    &format!("https://www.douyu.com/lapi/live/getH5Play/{room_id}"),
                    &body,
                    &format!("https://www.douyu.com/{room_id}"),
                )
                .await?;
            let data = v.get("data").cloned().unwrap_or(Value::Null);
            let rtmp_url = json_str(data.get("rtmp_url").unwrap_or(&Value::Null));
            let rtmp_live = html_unescape(&json_str(data.get("rtmp_live").unwrap_or(&Value::Null)));
            if rtmp_url.is_empty() || rtmp_live.is_empty() {
                continue;
            }
            let url = format!("{rtmp_url}/{rtmp_live}");
            urls.push(PlayUrl {
                url,
                headers: headers.clone(),
            });
        }
        if urls.is_empty() {
            return Err(Self::err("no douyu play urls"));
        }
        Ok(urls)
    }

    async fn get_live_status(&self, room_id: &str) -> AppResult<bool> {
        Ok(self.get_room_detail(room_id).await?.status)
    }
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
