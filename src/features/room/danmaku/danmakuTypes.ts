/** 业务层共享的弹幕描述；与渲染器私有字段分离。 */
export type DanmakuComment = {
  id: string;
  text: string;
  mode: "scroll" | "top" | "bottom";
  /** 媒体时间，单位秒；直播无需提供。 */
  time?: number;
  /** 固定弹幕时长，单位毫秒；滚动弹幕由标准速度决定。 */
  duration?: number;
  style?: Record<string, string | number | undefined>;
  render?: () => HTMLElement;
};

export type DanmakuRendererOptions = {
  container: HTMLElement;
  media?: HTMLMediaElement;
  speed?: number;
  /** 只限制滚动弹幕区域，固定弹幕使用整个舞台。 */
  area?: number;
  onAttach?: (comment: DanmakuComment, element: HTMLElement) => void;
  onDetach?: (id: string) => void;
};
