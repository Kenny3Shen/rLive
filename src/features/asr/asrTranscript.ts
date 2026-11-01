/**
 * 本次运行内全部已识别字幕的转录 store。
 *
 * 画面内叠加层只保留最近 `12 秒`的定稿行，而且随播放页卸载一起消失；独立字幕窗口
 * 需要按时间顺序保留整场对话，因此转录放在模块级单例里，跨 `PlayerPane` 卸载、
 * 换房间与换清晰度存活。只有直播间宿主会调用写入接口，其他宿主不订阅也不写入。
 */

export type AsrTranscriptLine = {
  kind: "line";
  id: string;
  /** 已带「说话人 N：」前缀的定稿文本。 */
  text: string;
  translation: string | null;
  at: number;
};

export type AsrTranscriptDivider = {
  kind: "divider";
  id: string;
  /** 该段对话所属的房间标题。 */
  title: string;
  at: number;
};

export type AsrTranscriptEntry = AsrTranscriptLine | AsrTranscriptDivider;

/** 独立窗口顶栏与底部在途文本的状态。 */
export type AsrTranscriptLive = {
  sourceTitle: string | null;
  captionsOn: boolean;
  partial: string | null;
  notice: string | null;
};

/**
 * 增量变更。桥接按条转发给字幕窗口，避免每次识别窗都重发整份转录；
 * 新窗口加载或重载时另发一次完整快照。
 */
export type AsrTranscriptChange =
  | { kind: "append"; entry: AsrTranscriptEntry }
  | { kind: "patch"; id: string; translation: string }
  | { kind: "live"; live: AsrTranscriptLive };

export type AsrTranscriptAppendInput = {
  text: string;
  /** 房间身份；同一房间换清晰度/线路必须保持不变。 */
  sourceKey: string;
  sourceTitle: string;
  at?: number;
};

export type AsrTranscriptStore = {
  /**
   * 转录的只读副本。快照是低频操作（窗口打开或重载），复制一次 O(n) 换调用方
   * 不必担心后续追加、译文回填会改到自己手里的数组。
   */
  getEntries: () => readonly AsrTranscriptEntry[];
  getLive: () => AsrTranscriptLive;
  /**
   * 追加一条定稿语句。`sourceKey` 与上一条不同时先插入房间分隔条，
   * 而不是清空已有对话。
   */
  appendLine: (input: AsrTranscriptAppendInput) => AsrTranscriptLine;
  /** 按条目 id 回填译文；迟到译文也写入，不受叠加层过期时间限制。 */
  patchTranslation: (id: string, translation: string) => void;
  updateLive: (patch: Partial<AsrTranscriptLive>) => void;
  subscribe: (listener: (change: AsrTranscriptChange) => void) => () => void;
};

const EMPTY_LIVE: AsrTranscriptLive = {
  sourceTitle: null,
  captionsOn: false,
  partial: null,
  notice: null,
};

export function createAsrTranscriptStore(): AsrTranscriptStore {
  // 内部数组可变：追加 push、回填按下标替换都是 O(1)。外部的 `getEntries()`
  // 只拿副本，所以没有人会观察到这里的原地修改。
  const entries: AsrTranscriptEntry[] = [];
  /** 条目 id 到数组下标；译文回填不再线性查找。 */
  const indexById = new Map<string, number>();
  let live = EMPTY_LIVE;
  let lastSourceKey: string | null = null;
  let sequence = 0;
  const listeners = new Set<(change: AsrTranscriptChange) => void>();

  const emit = (change: AsrTranscriptChange) => {
    for (const listener of listeners) listener(change);
  };

  return {
    getEntries: () => entries.slice(),
    getLive: () => live,

    appendLine: ({ text, sourceKey, sourceTitle, at = Date.now() }) => {
      // 首次追加与换房间都会带出分隔条，让快照里也能看出对话属于哪个直播间。
      if (lastSourceKey !== sourceKey) {
        const divider: AsrTranscriptDivider = {
          kind: "divider",
          id: `divider-${++sequence}`,
          title: sourceTitle.trim() || "直播字幕",
          at,
        };
        indexById.set(divider.id, entries.length);
        entries.push(divider);
        lastSourceKey = sourceKey;
        emit({ kind: "append", entry: divider });
      }

      const line: AsrTranscriptLine = {
        kind: "line",
        id: `line-${++sequence}`,
        text,
        translation: null,
        at,
      };
      indexById.set(line.id, entries.length);
      entries.push(line);
      emit({ kind: "append", entry: line });
      return line;
    },

    patchTranslation: (id, translation) => {
      const index = indexById.get(id);
      if (index === undefined) return;
      const entry = entries[index];
      if (entry.kind !== "line" || entry.translation === translation) return;
      entries[index] = { ...entry, translation };
      emit({ kind: "patch", id, translation });
    },

    updateLive: (patch) => {
      const next = { ...live };
      let changed = false;
      if (patch.sourceTitle !== undefined && patch.sourceTitle !== live.sourceTitle) {
        next.sourceTitle = patch.sourceTitle;
        changed = true;
      }
      if (patch.captionsOn !== undefined && patch.captionsOn !== live.captionsOn) {
        next.captionsOn = patch.captionsOn;
        changed = true;
      }
      if (patch.partial !== undefined && patch.partial !== live.partial) {
        next.partial = patch.partial;
        changed = true;
      }
      if (patch.notice !== undefined && patch.notice !== live.notice) {
        next.notice = patch.notice;
        changed = true;
      }
      // 每个识别窗都会重复写相同的在途文本与提示；内容不变时不通知桥接。
      if (!changed) return;
      live = next;
      emit({ kind: "live", live });
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 模块级单例：转录的生命周期是整个应用运行期，而不是某个播放页。 */
export const asrTranscript = createAsrTranscriptStore();
