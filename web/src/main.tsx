import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { ThemeProvider } from './theme';
import { Shell } from './components/Shell';
import { LoginPage } from './pages/Login';
import { SearchPage } from './pages/Search';
import { RecordPage } from './pages/Record';
import { ViewerPage } from './pages/Viewer';
import { MyRequestsPage } from './pages/MyRequests';
import { InboxPage } from './pages/Inbox';
import { RegisterPage } from './pages/Register';
import { AuthoritiesPage } from './pages/Authorities';
import { QuarantinePage } from './pages/Quarantine';
import { CorrectionsPage } from './pages/Corrections';
import { AuditPage } from './pages/Audit';
import { AdminPage } from './pages/Admin';
import { PasswordPage } from './pages/Password';
import { ProfilePage } from './pages/Profile';
import { TotpPage } from './pages/Totp';
import { Spinner } from './components/bits';
import '@fontsource/hind/500.css';
import '@fontsource/hind/600.css';
import './styles.css';

/**
 * Keeps a page off the screen unless the account holds one of these roles.
 *
 * The sidebar already hides links nobody can use, but a link is not a control:
 * typing /admin got you Administration whatever your roles were. The API
 * refuses the actions underneath either way, so this was never a route to
 * privilege — but a custodian could read the staff list through it, and a page
 * that renders for someone who cannot use it teaches them the wrong thing
 * about what they hold.
 *
 * Said plainly rather than redirected: bouncing to Search makes a mistyped URL
 * look like a broken application.
 */
const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'administrators',
  AUDITOR: 'auditors',
  CUSTODIAN: 'custodians',
  APPROVER: 'approvers',
  CONTROLLING_OFFICER: 'controlling officers',
  REQUESTER: 'requesters',
};

const roleNames = (roles: string[]): string => {
  const names = roles.map((r) => ROLE_LABEL[r] ?? r.toLowerCase());
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

function RequireRole({ roles, children }: { roles: string[]; children: ReactNode }) {
  const { can } = useAuth();
  if (can(...roles)) return <>{children}</>;
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <h2 style={{ marginBottom: 8 }}>Not your page</h2>
      <p className="hint" style={{ marginBottom: 14 }}>
        This page is for {roleNames(roles)}. Your account does not hold that role, and
        the server would refuse the same request directly.
      </p>
      <Link className="btn" to="/search">Back to search</Link>
    </div>
  );
}

function Gate() {
  const { principal, loading } = useAuth();
  if (loading) return <Spinner label="Checking your session…" />;
  if (!principal) return <LoginPage />;
  if (principal.mustChangePassword) return <PasswordPage />;
  // Required by an administrator but not yet enrolled: nothing else until done.
  if (principal.mustEnrolTotp) return <TotpPage forced />;

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/search" replace />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/records/:id" element={<RecordPage />} />
        <Route path="/records/:id/view" element={<ViewerPage />} />
        <Route path="/requests" element={<MyRequestsPage />} />
        <Route path="/inbox"
          element={<RequireRole roles={['APPROVER']}><InboxPage /></RequireRole>} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/authorities"
          element={<RequireRole roles={['APPROVER', 'CONTROLLING_OFFICER', 'AUDITOR']}><AuthoritiesPage /></RequireRole>} />
        <Route path="/corrections"
          element={<RequireRole roles={['CONTROLLING_OFFICER', 'CUSTODIAN', 'AUDITOR']}><CorrectionsPage /></RequireRole>} />
        <Route path="/quarantine"
          element={<RequireRole roles={['CUSTODIAN']}><QuarantinePage /></RequireRole>} />
        <Route path="/audit"
          element={<RequireRole roles={['AUDITOR', 'ADMIN']}><AuditPage /></RequireRole>} />
        <Route path="/admin"
          element={<RequireRole roles={['ADMIN']}><AdminPage /></RequireRole>} />
        <Route path="/profile" element={<ProfilePage />} />
        {/* Password and 2FA now live on the profile page. Kept so an open tab
            or a bookmark lands somewhere useful rather than on Search. */}
        <Route path="/password" element={<Navigate to="/profile" replace />} />
        <Route path="/two-factor" element={<TotpPage />} />
        <Route path="*" element={<Navigate to="/search" replace />} />
      </Routes>
    </Shell>
  );
}

// Before the first paint, so a dark-theme user never sees a white flash.
try {
  // Carry the choice over from the key used before the rename to SevaLekh.
  const legacy = localStorage.getItem('sr.theme');
  if (legacy !== null) {
    if (localStorage.getItem('sevalekh.theme') === null) localStorage.setItem('sevalekh.theme', legacy);
    localStorage.removeItem('sr.theme');
  }
  const stored = localStorage.getItem('sevalekh.theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }
} catch { /* no stored preference is a perfectly good state */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider><Gate /></AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
