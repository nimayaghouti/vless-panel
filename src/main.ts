import {
  deployWorker,
  getTodayRequestCount,
  verifyToken,
} from './cloudflareApi.js';
import {
  clearSavedForm,
  loadSavedForm,
  saveForm,
  setStatus,
  showQuota,
  showResult,
  type PanelForm,
} from './ui.js';

const FREE_DAILY_LIMIT = 100000;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

const tokenInput = byId<HTMLInputElement>('token');
const toggleTokenButton = byId<HTMLButtonElement>('toggleTokenButton');
const accountIdInput = byId<HTMLInputElement>('accountId');
const scriptNameInput = byId<HTMLInputElement>('scriptName');
const verifyButton = byId<HTMLButtonElement>('verifyButton');
const deployButton = byId<HTMLButtonElement>('deployButton');
const quotaButton = byId<HTMLButtonElement>('quotaButton');
const forgetButton = byId<HTMLButtonElement>('forgetButton');
const statusEl = byId<HTMLElement>('status');
const resultEl = byId<HTMLElement>('result');
const quotaEl = byId<HTMLElement>('quota');

function readForm(): PanelForm {
  return {
    token: tokenInput.value.trim(),
    accountId: accountIdInput.value.trim(),
    scriptName: scriptNameInput.value.trim() || 'my-personal-vless',
  };
}

function applySavedForm(): void {
  const saved = loadSavedForm();
  if (saved.token) tokenInput.value = saved.token;
  if (saved.accountId) accountIdInput.value = saved.accountId;
  if (saved.scriptName) scriptNameInput.value = saved.scriptName;
}

async function fetchWorkerSource(): Promise<string> {
  const res = await fetch('/worker/worker.js');
  if (!res.ok) throw new Error('Could not load worker/worker.js');
  return res.text();
}

toggleTokenButton.addEventListener('click', () => {
  const isHidden = tokenInput.type === 'password';
  tokenInput.type = isHidden ? 'text' : 'password';
  toggleTokenButton.textContent = isHidden ? 'Hide' : 'Show';
});

verifyButton.addEventListener('click', async () => {
  const form = readForm();
  if (!form.token) {
    setStatus(statusEl, 'Enter the token first', 'error');
    return;
  }

  verifyButton.disabled = true;
  setStatus(statusEl, 'Verifying token...', 'busy');

  try {
    const result = await verifyToken(form.token);
    setStatus(
      statusEl,
      result.valid
        ? `Token is valid (${result.message})`
        : `Token problem: ${result.message}`,
      result.valid ? 'success' : 'error',
    );
  } catch (err) {
    setStatus(
      statusEl,
      err instanceof Error ? err.message : 'Unknown error',
      'error',
    );
  } finally {
    verifyButton.disabled = false;
  }
});

deployButton.addEventListener('click', async () => {
  const form = readForm();
  if (!form.token || !form.accountId) {
    setStatus(statusEl, 'Enter the token and Account ID', 'error');
    return;
  }

  deployButton.disabled = true;
  setStatus(statusEl, 'Deploying...', 'busy');

  try {
    const workerSource = await fetchWorkerSource();
    const uuid = crypto.randomUUID();
    const result = await deployWorker({
      token: form.token,
      accountId: form.accountId,
      scriptName: form.scriptName,
      workerSource,
      uuid,
    });

    saveForm(form);
    setStatus(statusEl, 'Deploy succeeded', 'success');
    showResult(resultEl, result.vlessLink, result.workersDevUrl);
  } catch (err) {
    setStatus(
      statusEl,
      err instanceof Error ? err.message : 'Unknown error',
      'error',
    );
  } finally {
    deployButton.disabled = false;
  }
});

quotaButton.addEventListener('click', async () => {
  const form = readForm();
  if (!form.token || !form.accountId) {
    setStatus(statusEl, 'Enter the token and Account ID', 'error');
    return;
  }

  quotaButton.disabled = true;
  setStatus(statusEl, 'Reading usage...', 'busy');

  try {
    const used = await getTodayRequestCount(
      form.token,
      form.accountId,
      form.scriptName,
    );
    showQuota(quotaEl, used, FREE_DAILY_LIMIT);
    setStatus(statusEl, '', 'idle');
  } catch (err) {
    setStatus(
      statusEl,
      err instanceof Error ? err.message : 'Unknown error',
      'error',
    );
  } finally {
    quotaButton.disabled = false;
  }
});

forgetButton.addEventListener('click', () => {
  clearSavedForm();
  tokenInput.value = '';
  accountIdInput.value = '';
  scriptNameInput.value = '';
  setStatus(statusEl, 'Saved info cleared', 'idle');
});

applySavedForm();
