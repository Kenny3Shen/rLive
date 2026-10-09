// 抖音官网登录窗口的「仅显示登录界面」脚本。
//
// 只在顶层 douyin.com 页面运行，不接触 Cookie、不与应用通信：
// - 页面加载期间用不透明底色盖住首页，自动点击页头「登录」弹出官方登录面板；
// - 面板出现后把官方遮罩改为不透明，只露出登录面板（扫码、验证码等仍由官网处理）；
// - 用户关闭面板时重新打开；连续多次打不开就撤掉遮挡，让用户自行操作，不把窗口卡成空白。
(() => {
  if (window.top !== window) return;
  if (!/(^|\.)douyin\.com$/i.test(location.hostname)) return;

  const PENDING = "rlive-login-pending";
  const READY = "rlive-login-only";
  const BACKDROP = "rgb(22, 24, 35)";
  const style = document.createElement("style");
  style.textContent = `
    html.${PENDING}::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: 10000;
      background: ${BACKDROP};
    }
    html.${PENDING} body, html.${READY} body { overflow: hidden !important; }
    html.${READY} :has(> #login-panel-new) {
      background: ${BACKDROP} !important;
      backdrop-filter: none !important;
    }
  `;
  const root = document.documentElement;
  root.classList.add(PENDING);
  (document.head ?? root).appendChild(style);

  // 页头「登录」入口：宽屏是带头像图标的按钮，窄屏只是一段文字，
  // 因此按「文本恰为登录的叶子节点、位于页头」查找，不依赖会随构建变化的类名；
  // 点击事件挂在最内层节点或外层按钮上，外层包装 div 不响应点击。
  const findLoginEntry = () => {
    for (const element of document.body?.querySelectorAll("div, span, p") ?? []) {
      if (element.childElementCount > 0 || element.textContent?.trim() !== "登录") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.top < 120) {
        return element.closest("button") ?? element;
      }
    }
    return null;
  };

  // 每秒检查一次：没有面板就点「登录」；连续失败上限后放弃遮挡。
  const MAX_MISSES = 12;
  let misses = 0;
  const tick = () => {
    if (!style.isConnected) (document.head ?? root).appendChild(style);
    if (document.getElementById("login-panel-new")) {
      misses = 0;
      root.classList.add(READY);
      root.classList.remove(PENDING);
      return;
    }
    root.classList.remove(READY);
    findLoginEntry()?.click();
    misses += 1;
    if (misses >= MAX_MISSES) {
      root.classList.remove(PENDING);
      window.clearInterval(timer);
    }
  };
  const timer = window.setInterval(tick, 1000);
  document.addEventListener("DOMContentLoaded", tick, { once: true });
})();
