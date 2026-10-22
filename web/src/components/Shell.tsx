import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth';
import { useLoad } from '../hooks';
import { ThemeSwitch } from '../theme';
import { Brand } from './Logo';

interface Notification { id: string; kind: string; read_at: string | null }

export function Shell({ children }: { children: ReactNode }) {
  const { principal, signOut, can, isAccounts, idleWarning, stayActive } = useAuth();
  const { data } = useLoad<{ notifications: Notification[] }>('/notifications?unread=true');
  const unread = data?.notifications.length ?? 0;
  const corrections = useLoad<{ corrections: unknown[] }>(
    can('CONTROLLING_OFFICER') ? '/corrections/pending' : null);
  const waitingCorrections = corrections.data?.corrections.length ?? 0;

  const link = (to: string, label: string, badge?: number) => (
    <NavLink to={to} className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>
      <span>{label}</span>
      {badge ? <span className="pill warn">{badge}</span> : null}
    </NavLink>
  );

  return (
    <div className="shell">
      {idleWarning != null && (
        <div className="idle-warning" role="alertdialog" aria-live="assertive">
          <span>No activity — you will be signed out in <strong>{idleWarning}s</strong>.</span>
          <button className="small" onClick={stayActive}>Stay signed in</button>
        </div>
      )}
      <nav className="sidebar">
        <Brand sub="Accounts Department" />

        {link('/search', 'Search')}
        {link('/requests', 'My requests')}
        {link('/register', isAccounts ? 'Access register' : 'My access')}

        {can('APPROVER') && <>
          <div className="navgroup">Decide</div>
          {link('/inbox', 'Approver inbox', unread || undefined)}
        </>}

        {can('CONTROLLING_OFFICER', 'AUDITOR') && <>
          <div className="navgroup">Authority</div>
          {link('/authorities', 'Authority register')}
          {link('/corrections', 'PPO corrections', can('CONTROLLING_OFFICER') ? waitingCorrections || undefined : undefined)}
        </>}

        {can('CUSTODIAN') && <>
          <div className="navgroup">Custody</div>
          {link('/quarantine', 'Quarantine')}
          {!can('CONTROLLING_OFFICER', 'AUDITOR') && link('/corrections', 'PPO corrections')}
        </>}

        {can('AUDITOR', 'ADMIN') && <>
          <div className="navgroup">Oversight</div>
          {link('/audit', 'Audit log')}
        </>}

        {can('ADMIN') && link('/admin', 'Administration')}

        <div className="sidebar-foot">
          <div className="who">{principal?.fullName}</div>
          {principal?.designation && <div className="dept">{principal.designation}</div>}
          <div className="dept">{principal?.staffCode} · {principal?.departmentName}</div>
          <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
            <NavLink to="/profile" className="btn small">Profile</NavLink>
            <button className="small ghost" onClick={() => void signOut()}>Sign out</button>
          </div>
          <div style={{ marginTop: 10 }}><ThemeSwitch /></div>
        </div>
      </nav>

      <main className="main">{children}</main>
      <div className="print-notice">
        Printing is disabled. Service records are released for on-screen reading only,
        and every page you open is recorded against your name.
      </div>
    </div>
  );
}
