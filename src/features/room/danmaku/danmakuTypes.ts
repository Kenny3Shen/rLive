/** 业务层共享的弹幕描述；与渲染器私有字段分离。 */
export type DanmakuComment = {
  id: string;
  text: string;
  mode: "scroll" | "top" | "bottom";
  /** 媒体时间，单位秒；直播无需提供。 */
  time?: number;
  /** 固定弹幕时长，单位毫秒；滚动弹幕由标准速度决定。 */
  duration?: number;
  /** 占用车道数：大于 1 的滚动弹幕按大表情处理，占多条车道并放大。 */
  lanes?: number;
  style?: Record<string, string | number | undefined>;
  /**
   * 构建弹幕的业务节点，由渲染器挂到库的包裹节点（`danmaku.node`）下。
   * 必填：样式作用于这个子元素，库的 `setStyle` 只写包裹节点，无法替代。
   */
  render: () => HTMLElement;
};

export type DanmakuRendererOptions = {
  container: HTMLElement;
  media?: HTMLMediaElement;
  speed?: number;
  /** 只限制滚动弹幕区域，固定弹幕使用整个舞台。 */
  area?: number;
  /** 单条车道高度（像素），同时是引擎轨道高；调用方按字号推导。 */
  laneHeight?: number;
  onAttach?: (comment: DanmakuComment, element: HTMLElement) => void;
  onDetach?: (id: string) => void;
};
