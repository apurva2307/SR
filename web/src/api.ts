export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)sr_csrf=([^;]+)/);
  return m?.[1] ?? '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.method && init.method !== 'GET' ? { 'x-csrf-token': csrfToken() } : {}),
      ...init.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const e = isJson ? body : { error: 'HTTP_' + res.status, message: String(body).slice(0, 200) };
    throw new ApiError(e.error ?? 'ERROR', e.message ?? 'Something went wrong.', res.status);
  }
  return body as T;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  put: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PUT', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
export interface Principal {
  id: string; staffCode: string; fullName: string;
  email: string | null; designation: string | null;
  departmentId: string; departmentKind: 'ACCOUNTS' | 'USER_DEPT'; departmentName: string;
  roles: string[]; mustChangePassword: boolean; totpEnabled: boolean; totpRequired: boolean;
  mustEnrolTotp: boolean;
}

export type AccessState = 'CUSTODIAL' | 'GRANTED' | 'PENDING' | 'EXPIRED' | 'NO_ACCESS';

export interface SearchHit {
  id: string; ppoNumber: string; employeeName: string;
  pageCount: number | null; indexedAt: string; status: string;
  accessState: AccessState; grantValidUntil: string | null; score: number;
}

export interface RequestItem {
  id: string; recordId: string; ppoNumber: string; employeeName: string;
  pageCount: number | null; status: 'PENDING' | 'APPROVED' | 'REJECTED';
  remarks: string | null; decidedAt: string | null;
}

export interface AccessRequest {
  id: string; request_no: string; status: string; purpose: string | null;
  file_reference: string | null; requested_from: string | null; requested_to: string | null;
  submitted_at: string | null; created_at: string;
  requester_name: string; requester_code: string; requester_dept: string;
  items: RequestItem[];
}

export interface LiveAuthority {
  id: string; orderReference: string; scopeDeptIds: string[] | null; effectiveTo: string;
}
