/** Errors the API layer maps directly onto status codes and audit outcomes. */
export class AuthzError extends Error {
  // Plain fields, not constructor parameter properties: those emit code, and
  // Node's type stripping refuses anything that is not erasable.
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'AuthzError';
    this.code = code;
    this.status = status;
  }
}

export const noApprovalAuthority = (): AuthzError =>
  new AuthzError(
    'You do not currently hold an approval authority, so you cannot release records to other departments. Ask a controlling officer to issue one.',
    'NO_APPROVAL_AUTHORITY',
    403,
  );

export const outOfAuthorityScope = (): AuthzError =>
  new AuthzError(
    'Your approval authority does not cover the requesting department.',
    'OUT_OF_AUTHORITY_SCOPE',
    403,
  );

export const selfApproval = (): AuthzError =>
  new AuthzError(
    'You raised this request, so you cannot decide it. It needs a second approver.',
    'SELF_APPROVAL',
    403,
  );

export const noGrant = (): AuthzError =>
  new AuthzError('You do not have access to this service record.', 'NO_GRANT', 403);

export const requestNotFound = (): AuthzError =>
  new AuthzError('That request no longer exists.', 'REQUEST_NOT_FOUND', 404);

export const requestNotOpen = (): AuthzError =>
  new AuthzError('This request has already been decided or withdrawn.', 'REQUEST_NOT_OPEN', 409);
