/** Anything that can run a parameterised query: a pg Pool, Client, or a fake. */
export interface Queryable {
  // `object`, not `Record<string, unknown>`: interfaces have no implicit index
  // signature, so the tighter constraint rejects every row type declared as one.
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export type Uuid = string;

/** Roles that may read any record without a grant (§6.1). */
export const CUSTODIAL_ROLES = ['APPROVER', 'CUSTODIAN', 'CONTROLLING_OFFICER'] as const;
