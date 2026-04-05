// Block page script - reads URL params and wires up buttons
(function () {
  const params = new URLSearchParams(location.search);
  const url = params.get('url') || 'Unknown URL';
  const rule = params.get('rule') || 'Policy rule';

  const blockedUrlEl = document.getElementById('blocked-url');
  const matchedRuleEl = document.getElementById('matched-rule');
  if (blockedUrlEl) blockedUrlEl.textContent = url;
  if (matchedRuleEl) matchedRuleEl.textContent = rule;

  // Go Back button
  const btnBack = document.getElementById('btn-back');
  if (btnBack) {
    btnBack.addEventListener('click', function () {
      if (history.length > 2) {
        history.go(-2);
      } else if (history.length > 1) {
        history.back();
      } else {
        window.location.href = 'about:blank';
      }
    });
  }

  // Request Access button
  const btnRequest = document.getElementById('btn-request');
  if (btnRequest) {
    btnRequest.addEventListener('click', function () {
      const toast = document.getElementById('toast');
      if (toast) toast.style.display = 'block';
      btnRequest.textContent = 'Request Sent';
      (btnRequest as HTMLButtonElement).disabled = true;
      btnRequest.style.opacity = '0.6';
      setTimeout(function () {
        if (toast) toast.style.display = 'none';
      }, 4000);
    });
  }
})();
