// Windows 主窗口：验证评论等级颜色、明暗主题对比度和昵称行几何。
// playwright-cli -s=rwin run-code --filename=tests/comment-level-colors.browser.js
async (page) => {
  const origin = await page.evaluate(() => location.origin);
  await page.goto(`${origin}/settings`);
  return await page.evaluate(async () => {
    const { setupHarness, assert, frames } = await import('/tests/browser/harness.js');
    const { CommentLevelBadge } = await import('/src/features/video/CommentLevelBadge.tsx');
    const harness = await setupHarness();
    const previousClass = document.documentElement.className;
    const { h } = harness;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].map(value => value / 255);
    };
    const luminance = rgb => rgb.slice(0, 3).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const results = [];
    try {
      for (const dark of [false, true]) {
        document.documentElement.classList.toggle('dark', dark);
        harness.render(h('section', { className: 'bg-sidebar', style: { width: 320, padding: 8 } },
          ...[1, 2, 3, 4, 5, 6, 9].map(level => h('div', {
            key: level, 'data-level-row': level,
            className: 'flex min-w-0 items-center gap-1.5',
          }, h('span', { className: 'truncate text-[13px] font-medium', 'data-nickname': true }, '评论发布者'), h(CommentLevelBadge, { level }))),
          h('div', { 'data-invalid-levels': true }, ...[0, -1, 1.5, NaN, Infinity].map((level, index) => h(CommentLevelBadge, { key: index, level }))),
        ));
        await frames();
        for (const animation of harness.host.getAnimations({ subtree: true })) animation.finish();
        const surface = rgba(getComputedStyle(harness.host.firstElementChild).backgroundColor);
        const colors = [];
        const contrast = [];
        for (const row of harness.host.querySelectorAll('[data-level-row]')) {
          const level = Number(row.dataset.levelRow);
          const badge = row.querySelector('[data-comment-level]');
          const style = getComputedStyle(badge);
          assert(badge.textContent === `Lv${level}`, '等级文本丢失');
          assert(badge.getAttribute('aria-label').includes(`Lv${level}`), '等级缺少无障碍名称');
          assert(row.getBoundingClientRect().height <= 20, '等级徽章撑高昵称行');
          assert(row.querySelector('[data-nickname]').getBoundingClientRect().width >= 65, '昵称被等级标识挤压');
          const foreground = rgba(style.color);
          const fill = rgba(style.backgroundColor);
          const background = surface.slice(0, 3).map((value, index) => fill[index] * fill[3] + value * (1 - fill[3]));
          const a = luminance(foreground), b = luminance(background);
          const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          assert(ratio >= 4.5, `${dark ? '暗' : '亮'}色 Lv${level} 对比度仅 ${ratio.toFixed(2)}`);
          colors.push(style.color);
          contrast.push(Number(ratio.toFixed(2)));
        }
        assert(new Set(colors.slice(0, 6)).size === 6, 'Lv1–Lv6 没有各自的颜色');
        assert(colors[6] === colors[0], '未知等级不应冒充最高等级');
        assert(!harness.host.querySelector('[data-invalid-levels]').children.length, '无效等级不应显示');
        results.push({ theme: dark ? 'dark' : 'light', contrast });
      }
      return { passed: true, themes: results };
    } finally {
      harness.dispose();
      document.documentElement.className = previousClass;
    }
  });
}
