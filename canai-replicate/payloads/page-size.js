
(() => ({
  width: document.documentElement.clientWidth,
  height: Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0
  ),
}))();
