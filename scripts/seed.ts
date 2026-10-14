// Demo data for a runnable system: departments, people, roles, one live
// approval authority, and a folder of deliberately messy PDF filenames.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { hashPassword } from '../src/services/auth.ts';
import { config } from '../src/config.ts';
import { ensureDefaultSettings } from '../src/services/settings.ts';

const PASSWORD = 'ChangeMeToday!2026';

/** A tiny valid PDF, so the renderer has something real to open. */
function pdf(lines: string[]): Buffer {
  const objs: string[] = [];
  const kids = lines.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${lines.length} >>`);
  lines.forEach((text, i) => {
    const content = `BT /F1 20 Tf 64 740 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + lines.length * 2} 0 R >> >> >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  let buf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(buf.length); buf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = buf.length;
  buf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) buf += `${String(off).padStart(10, '0')} 00000 n \n`;
  buf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(buf, 'latin1');
}

// Deliberately messy: every one of these shapes turns up in a real folder.
const FILES: [string, string[]][] = [
  ['410221100347_SHRI RAM KUMAR SHARMA.pdf',
    ['Service Record - Ram Kumar Sharma', 'Page 2 - Appointment 1987', 'Page 3 - Promotions', 'Page 4 - Leave account']],
  ['410221100348 - Smt. Sunita Devi.pdf',
    ['Service Record - Sunita Devi', 'Page 2 - Qualifying service', 'Page 3 - Pay fixation']],
  ['4102-2110-0349_Anil Kumar Verma.pdf',
    ['Service Record - Anil Kumar Verma', 'Page 2 - Transfers']],
  ['Meena Kumari (410221100350).pdf',
    ['Service Record - Meena Kumari', 'Page 2 - Nomination']],
  ['LATE SHRI B.N. MISHRA_410221100351.pdf',
    ['Service Record - B N Mishra', 'Page 2 - Family pension']],
  ['PPO 410221100352 Rajesh Prasad Singh.pdf',
    ['Service Record - Rajesh Prasad Singh', 'Page 2 - Increments', 'Page 3 - Departmental exam']],
  ['410221100353_Kavita Sharma_SR.pdf',
    ['Service Record - Kavita Sharma']],
  ['123456_OLD FORMAT PENSIONER.pdf',
    ['Service Record - legacy six digit PPO', 'Page 2']],
  // These three exist to land in quarantine, which is the point.
  ['scan0007.pdf', ['Unlabelled scan']],
  ['Service Record.pdf', ['No PPO anywhere in the filename']],
  ['1234_X Y.pdf', ['PPO too short to be valid']],
];

async function main() {
  const db = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
  await db.connect();

  // Under docker compose the source folder is mounted read-only, which is
  // correct and is exactly how production runs. Say so and carry on rather
  // than failing: the PDFs are put there from the host side.
  const root = config.sourceRoots[0]!;
  try {
    await mkdir(root, { recursive: true });
    for (const [name, pages] of FILES) await writeFile(join(root, name), pdf(pages));
    console.log(`wrote ${FILES.length} sample PDFs to ${root}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EROFS' && code !== 'EACCES' && code !== 'EPERM') throw err;
    console.log(`${root} is read-only (as it should be) — leaving its contents alone.`);
  }

  await db.query(`TRUNCATE access_events, notifications, view_sessions, access_grants,
    access_request_items, access_requests, approval_authorities, record_aliases,
    quarantine_items, ingestion_runs, service_records, sessions, password_reset_codes,
    user_roles, users, departments RESTART IDENTITY CASCADE`);

  // The TRUNCATE above cascades into settings via settings.updated_by.
  const restored = await ensureDefaultSettings(db);
  if (restored > 0) console.log(`restored ${restored} policy setting(s)`);

  const dept = async (code: string, name: string, kind: string) =>
    (await db.query<{ id: string }>(
      'INSERT INTO departments (code,name,kind) VALUES ($1,$2,$3) RETURNING id', [code, name, kind])).rows[0]!.id;

  const accounts = await dept('AC', 'Accounts Department', 'ACCOUNTS');
  const works = await dept('PW', 'Public Works Department', 'USER_DEPT');
  const edu = await dept('ED', 'Education Department', 'USER_DEPT');

  const hash = await hashPassword(PASSWORD);
  const user = async (code: string, name: string, deptId: string, roles: string[]) => {
    const id = (await db.query<{ id: string }>(
      `INSERT INTO users (staff_code, full_name, email, department_id, password_hash, must_change_password)
       VALUES ($1,$2,$3,$4,$5,false) RETURNING id`,
      [code, name, `${code.toLowerCase()}@example.gov`, deptId, hash])).rows[0]!.id;
    for (const r of roles) {
      await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [id, r]);
    }
    return id;
  };

  const controller = await user('AC000', 'Padma Ramanathan', accounts, ['APPROVER', 'CONTROLLING_OFFICER']);
  const approver = await user('AC001', 'Vikram Bose', accounts, ['APPROVER']);
  const approver2 = await user('AC002', 'Nalini Iyer', accounts, ['APPROVER']);
  const custodian = await user('AC003', 'Joseph Mathai', accounts, ['CUSTODIAN']);
  // Controlling officer ONLY, so the difference from an approver is visible
  // without unpicking anyone's role list: he decides who may release records
  // and cannot decide a single request himself.
  await user('AC004', 'Ravi Menon', accounts, ['CONTROLLING_OFFICER']);
  const requester = await user('PW001', 'Arun Deshpande', works, ['REQUESTER']);
  await user('PW002', 'Fatima Sheikh', works, ['REQUESTER']);
  await user('ED001', 'Thomas Varkey', edu, ['REQUESTER']);
  await user('AU001', 'Grace Fernandes', works, ['AUDITOR']);
  await user('IT001', 'Sandeep Nair', accounts, ['ADMIN']);

  // One live authority, and one deliberately absent: AC002 holds the approver
  // role and can read everything, but can release nothing.
  await db.query(
    `INSERT INTO approval_authorities
       (user_id, issued_by, effective_from, effective_to, remarks)
     VALUES ($1,$2, now() - interval '30 days', now() + interval '300 days',
             'Standing authority for pension case work.')`,
    [approver, controller]);
  await db.query(
    `INSERT INTO approval_authorities
       (user_id, issued_by, effective_from, effective_to, scope_dept_ids, remarks)
     VALUES ($1,$2, now() - interval '10 days', now() + interval '9 days', $3,
             'Scoped to Public Works. Expires soon on purpose.')`,
    [controller, approver, [works]]);

  console.log('\nSeeded. Everyone signs in with the same password:');
  console.log(`  password: ${PASSWORD}\n`);
  console.table([
    { staff: 'AC000', name: 'Padma Ramanathan', role: 'Controlling officer AND approver (the common real-world case)' },
    { staff: 'AC001', name: 'Vikram Bose', role: 'Approver WITH a live authority' },
    { staff: 'AC002', name: 'Nalini Iyer', role: 'Approver with NO authority (reads all, releases none)' },
    { staff: 'AC003', name: 'Joseph Mathai', role: 'Custodian' },
    { staff: 'AC004', name: 'Ravi Menon', role: 'Controlling officer ONLY — issues authorities, decides no requests' },
    { staff: 'PW001', name: 'Arun Deshpande', role: 'Requester, Public Works' },
    { staff: 'ED001', name: 'Thomas Varkey', role: 'Requester, Education' },
    { staff: 'AU001', name: 'Grace Fernandes', role: 'Auditor' },
    { staff: 'IT001', name: 'Sandeep Nair', role: 'Administrator' },
  ]);
  console.log(`\nUsers: ${[controller, approver, approver2, custodian, requester].length} core + others.`);
  console.log('Now run:  npm run ingest');
  await db.end();
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
