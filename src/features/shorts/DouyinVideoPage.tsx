import { useState } from "react";
import { DouyinShortsFeed } from "./DouyinShortsFeed";

/** `/shorts/douyin` 只保留推荐流；作品链接输入与单作品播放已移除。 */
export function DouyinVideoPage() {
  const [revision, setRevision] = useState(0);
  return (
    <div data-slot="douyin-video-page" className="h-full min-h-0">
      <DouyinShortsFeed key={revision} onRefresh={() => setRevision((value) => value + 1)} />
    </div>
  );
}
