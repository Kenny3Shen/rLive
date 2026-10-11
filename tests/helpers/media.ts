/** 只提供共享媒体状态；缓冲计数、播放和 seek 事件由各测试按需补充。 */
export class MediaStub extends EventTarget {
  currentTime = 0;
  paused = true;
  src = "";
  load() {}
  pause() {
    this.paused = true;
  }
  removeAttribute() {
    this.src = "";
  }
}
