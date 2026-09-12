const STORAGE_KEY = 'vless-panel:credentials';
export function loadSavedForm() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw)
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
export function saveForm(form) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
}
export function clearSavedForm() {
    localStorage.removeItem(STORAGE_KEY);
}
export function setStatus(el, message, kind) {
    el.textContent = message;
    el.dataset.kind = kind;
}
export function showResult(el, vlessLink, workersDevUrl) {
    el.hidden = false;
    el.innerHTML = '';
    const urlLine = document.createElement('p');
    urlLine.textContent = `Worker: ${workersDevUrl}`;
    el.appendChild(urlLine);
    const linkLabel = document.createElement('p');
    linkLabel.textContent = 'VLESS link:';
    el.appendChild(linkLabel);
    const linkBox = document.createElement('code');
    linkBox.textContent = vlessLink;
    el.appendChild(linkBox);
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.textContent = 'Copy link';
    copyButton.addEventListener('click', async () => {
        await navigator.clipboard.writeText(vlessLink);
        const originalText = copyButton.textContent;
        copyButton.textContent = 'Copied!';
        copyButton.disabled = true;
        setTimeout(() => {
            copyButton.textContent = originalText;
            copyButton.disabled = false;
        }, 1500);
    });
    el.appendChild(copyButton);
}
export function showQuota(el, used, limit) {
    el.hidden = false;
    el.textContent = `${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} requests used today`;
}
