/**
 * 文档选区的清理。
 *
 * 播放表面（点播播放页、B 站短视频、抖音短视频）在按压画面时都要做同一件事：
 * 把上一处界面留下的选区收掉。评论区抽屉卸载不会清选区 —— 选区仍留在
 * `document.getSelection()` 里、指向已经脱离文档的节点，此后系统长按会把它读成
 * 「拖拽已有选区」而不是我们自己的长按手势，长按倍速因此永远不触发，弹出的
 * 是复制/全选菜单。
 */

/** 选区所属节点是否落在可编辑元素内（输入框、文本域、可编辑区域）。 */
function isSelectionInEditable(selection: Selection): boolean {
  const anchor = selection.anchorNode;
  const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  return Boolean(element?.closest('input, textarea, [contenteditable="true"]'));
}

/**
 * 清掉当前文档里非折叠、且不属于可编辑元素的选区。
 *
 * 两条边界都是刻意的：
 *
 * - **折叠光标不清**。它表达的是输入框里的插入点，抹掉会让正在打字的输入框失焦。
 * - **可编辑元素内的选区不清**。弹幕输入框、评论输入框里的选区归用户自己，
 *   按下画面不该顺手丢掉他们刚选中准备替换的那段文字。
 *
 * 返回是否真的清掉了内容，供调用方判断本次按压是否接管了「一次拖拽选区」
 * 手势 —— 那种情况下系统菜单的归属不在我们手里。
 */
export function clearStaleSelection(): boolean {
  if (typeof document === "undefined") return false;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) return false;
  if (isSelectionInEditable(selection)) return false;
  selection.removeAllRanges();
  return true;
}
