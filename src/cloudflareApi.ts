const PROXY_BASE = '/cf-proxy/client/v4';

interface CloudflareResponse<T> {
  success: boolean;
  result: T;
  errors: { message: string }[];
}

export interface DeployOptions {
  token: string;
  accountId: string;
  scriptName: string;
  workerSource: string;
  uuid: string;
  proxyIp?: string;
}

export interface DeployResult {
  scriptName: string;
  workersDevUrl: string;
  vlessLink: string;
}

export interface TokenVerifyResult {
  valid: boolean;
  message: string;
}

async function cfFetch<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${PROXY_BASE}${path}`, { ...init, headers });
  const data: CloudflareResponse<T> = await res.json();

  if (!data.success) {
    const message =
      data.errors?.[0]?.message ?? `Cloudflare API error (HTTP ${res.status})`;
    throw new Error(message);
  }
  return data.result;
}

async function uploadWorker(options: DeployOptions): Promise<void> {
  const bindings: Record<string, unknown>[] = [
    { type: 'secret_text', name: 'UUID', text: options.uuid },
  ];
  if (options.proxyIp) {
    bindings.push({
      type: 'plain_text',
      name: 'PROXYIP',
      text: options.proxyIp,
    });
  }

  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2026-09-01',
    bindings,
  };

  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append(
    'worker.js',
    new Blob([options.workerSource], { type: 'application/javascript+module' }),
    'worker.js',
  );

  await cfFetch(
    options.token,
    `/accounts/${options.accountId}/workers/scripts/${options.scriptName}`,
    {
      method: 'PUT',
      body: form,
    },
  );
}

async function enableWorkersDevRoute(options: DeployOptions): Promise<void> {
  await cfFetch(
    options.token,
    `/accounts/${options.accountId}/workers/scripts/${options.scriptName}/subdomain`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    },
  );
}

async function getAccountSubdomain(options: DeployOptions): Promise<string> {
  const result = await cfFetch<{ subdomain: string }>(
    options.token,
    `/accounts/${options.accountId}/workers/subdomain`,
  );
  return result.subdomain;
}

export function buildVlessLink(
  uuid: string,
  hostname: string,
  remark: string,
): string {
  const params = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni: hostname,
    fp: 'chrome',
    type: 'ws',
    host: hostname,
    path: '/?ed=2048',
  });
  return `vless://${uuid}@${hostname}:443?${params.toString()}#${encodeURIComponent(remark)}`;
}

export async function deployWorker(
  options: DeployOptions,
): Promise<DeployResult> {
  await uploadWorker(options);
  await enableWorkersDevRoute(options);
  const subdomain = await getAccountSubdomain(options);
  const workersDevUrl = `${options.scriptName}.${subdomain}.workers.dev`;

  return {
    scriptName: options.scriptName,
    workersDevUrl,
    vlessLink: buildVlessLink(options.uuid, workersDevUrl, options.scriptName),
  };
}

export async function verifyToken(token: string): Promise<TokenVerifyResult> {
  const res = await fetch(`${PROXY_BASE}/user/tokens/verify`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();

  if (!data.success) {
    return {
      valid: false,
      message: data.errors?.[0]?.message ?? `HTTP ${res.status}`,
    };
  }

  const status = data.result?.status;
  return {
    valid: status === 'active',
    message: data.messages?.[0]?.message ?? status ?? 'unknown',
  };
}

export async function getTodayRequestCount(
  token: string,
  accountId: string,
  scriptName: string,
): Promise<number> {
  const now = new Date();
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  const query = `
		query GetUsage($accountTag: string, $scriptName: string, $start: string, $end: string) {
			viewer {
				accounts(filter: { accountTag: $accountTag }) {
					workersInvocationsAdaptive(
						limit: 1000
						filter: { scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end }
					) {
						sum {
							requests
						}
					}
				}
			}
		}
	`;

  const res = await fetch(`${PROXY_BASE}/graphql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: accountId,
        scriptName,
        start: startOfDay.toISOString(),
        end: now.toISOString(),
      },
    }),
  });

  const data = await res.json();
  if (data.errors?.length) {
    throw new Error(data.errors[0].message);
  }

  const rows: { sum: { requests: number } }[] =
    data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return rows.reduce((sum, row) => sum + (row.sum?.requests ?? 0), 0);
}
