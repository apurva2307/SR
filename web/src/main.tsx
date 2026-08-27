import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
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
import { AuditPage } from './pages/Audit';
import { AdminPage } from './pages/Admin';
import { PasswordPage } from './pages/Password';
import { TotpPage } from './pages/Totp';
import { Spinner } from './components/bits';
import './styles.css';

function Gate() {
  const { principal, loading } = useAuth();
  if (loading) return <Spinner label="Checking your session…" />;
  if (!principal) return <LoginPage />;
  if (principal.mustChangePassword) return <PasswordPage forced />;
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
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/authorities" element={<AuthoritiesPage />} />
        <Route path="/quarantine" element={<QuarantinePage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/password" element={<PasswordPage />} />
        <Route path="/two-factor" element={<TotpPage />} />
        <Route path="*" element={<Navigate to="/search" replace />} />
      </Routes>
    </Shell>
  );
}

// Before the first paint, so a dark-theme user never sees a white flash.
try {
  const stored = localStorage.getItem('sr.theme');
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
