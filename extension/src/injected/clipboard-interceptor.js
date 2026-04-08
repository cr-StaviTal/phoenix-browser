(function() {
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;
  var _orig = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = function(text) {
    console.log('[ClipboardBridge] writeText intercepted (page):', text.substring(0, 120));
    var evt = new CustomEvent('__phoenix_clipboard_write', { detail: text });
    document.dispatchEvent(evt);
    return _orig(text);
  };
  console.log('[ClipboardBridge] Page-level writeText interceptor installed');
})();