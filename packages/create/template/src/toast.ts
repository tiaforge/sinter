// A temper toast: appended to the page's [data-toasts] region, faded out after a few seconds.
export function toast(text: string, tone?: 'danger' | 'success') {
  const region = document.querySelector('[data-toasts]');
  if (!region) return;
  const t = document.createElement('div');
  t.dataset.toast = '';
  if (tone) t.dataset.tone = tone;
  if (tone === 'danger') t.role = 'alert';
  t.textContent = text;
  region.append(t);
  setTimeout(() => {
    t.hidden = true;
    setTimeout(() => t.remove(), 300);
  }, 5000);
}
