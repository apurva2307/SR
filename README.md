# SevaLekh

<img src="brand/sevalekh-mark.svg" alt="SevaLekh mark" width="72" align="right">

SevaLekh (सेवालेख, "service record") is a digital reading room for pension service records. The Accounts Department keeps
custody of the PDFs; user departments search a catalogue, request a record for a
stated period, and read it **on screen only** while that grant is live.

Full design: **[SevaLekh design document](https://claude.ai/code/artifact/3e6ec42c-7e20-4127-9326-1ac6a2f1321f)**.
Section markers in the code (§6.1, §8.1, …) point into that document.

## The two ideas the whole system rests on

**Reading is a role; releasing is an authorisation.** Accounts staff read any
record, because that is the job. Releasing one to another department requires a
live row in `approval_authorities` — issued by a controlling officer, bounded by
dates. The `APPROVER` role on its own releases
nothing. Every grant carries `granted_under_authority_id NOT NULL`, so each open
door traces to a named officer and a dated authority, permanently, even after that
authority is withdrawn.

**Screen-only is structural, not a setting.** No endpoint returns a PDF. The
server renders one page at a time to a raster, burns the watermark into the
pixels, and sends that. A hidden download button would not be screen-only; it
would be a hidden button. There is a test that walks the surface looking for a
route that hands back a file, and fails if it finds one.

## Roles

Six roles, defined as much by what they cannot do as by what they can. Roles are
additive and attach to a person, not a department — one Accounts officer commonly
holds several.

| Role                    | Usually held by       | Can                                                                                                                                                                                    | Cannot                                                                                               |
| ----------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Requester**           | User department staff | Search the catalogue, raise and withdraw requests, read records covered by a live grant                                                                                                | Open anything without a grant; see who else requested a record                                       |
| **Approver**            | Accounts              | Read any record, and revoke a grant. Decide requests item by item, shorten a requested period, issue an emergency grant — those three **only while holding a live approval authority** | Release anything once that authority lapses or is withdrawn; decide a request they raised themselves |
| **Controlling officer** | Senior Accounts       | Everything an approver can, plus issue, suspend, resume and withdraw approval authorities, and approve or reject PPO corrections                                                                                              | Issue an authority to themselves, or decide a PPO correction they proposed — both need a second controlling officer                           |
| **Custodian**           | Accounts              | Read any record. Run ingestion, resolve quarantine, correct an employee name, propose a PPO correction, verify integrity, issue an emergency grant (with a live authority)                                               | Edit or delete an audit event; write to the source folder                                            |
| **Auditor**             | Anywhere              | Read the full audit log, every denial, every reading session; export CSV; view the live access register and the authority register                                                     | **Open any record** — an auditor sees who looked, never what they looked at                          |
| **Administrator**       | IT                    | Create, rename, deactivate and delete departments; create users, assign roles, issue password-reset codes, enable 2FA, suspend accounts, change policy settings                        | **Open any record** by virtue of being an administrator                                              |

### Reading is a role. Releasing is an authorisation.

This is the structural point, and it comes straight from how the department
already works. An Accounts officer consults a service record because that is the
job. Releasing one to another department is done by a named officer under a
specific authorisation.

So **the approver role by itself does nothing**. It marks a person as eligible.
What actually lets them release a record is a live row in `approval_authorities`
— issued by a controlling officer, bounded by dates, revocable in one click, and optionally scoped to particular departments.

| Situation                                          | Can read records | Can release records |
| -------------------------------------------------- | ---------------- | ------------------- |
| Approver with a live authority                     | Yes              | Yes                 |
| Approver whose authority is suspended (on leave)   | Yes              | No                  |
| Approver whose authority expired (transferred out) | Yes              | No                  |
| Approver who never held one                        | Yes              | No                  |

An officer on leave has their authority suspended and keeps reading normally. An
officer who transfers out loses the power to release on the date the authority
ends, without anyone having to remember to strip a role. Every grant records
`granted_under_authority_id`, so each open door traces to a named officer and a
written order — permanently, even after that authority is withdrawn.

### Approver or controlling officer?

These two are the ones people mix up, because in a real office the same person
often holds both. They sit at different levels of the same chain.

```
  Controlling officer          Approver              Requester
  (decides WHO may release)    (releases records)    (reads them)
          │                          │                    │
          │  issues an               │  issues a          │
          │  approval authority      │  grant             │
          └─────────────────────────▶└───────────────────▶│
             "Vikram may release        "Arun may read
              records until Dec"         PPO 4102… for 15 days"
```

An **approver** works the request queue. They see what user departments have
asked for, decide it record by record, set the period, and can revoke. This is
the daily job.

A **controlling officer** never touches the request queue. They decide _who is
allowed to work it_ — issuing an approval authority against a written office
order, suspending it when someone goes on leave, withdrawing it on transfer.
This is an occasional, deliberate act.

The two are genuinely independent, and the demo data proves it:

|                             | `AC004` Ravi Menon<br>controlling officer only | `AC002` Nalini Iyer<br>approver, no authority | `AC001` Vikram Bose<br>approver with authority |
| --------------------------- | ---------------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| Read any record             | Yes                                            | Yes                                           | Yes                                            |
| Decide a request            | **No** — `403, needs APPROVER`                 | **No** — `403 NO_APPROVAL_AUTHORITY`          | Yes                                            |
| Issue an approval authority | **Yes**                                        | No                                            | No                                             |

So a controlling officer with no approver role cannot release a single record,
and an approver cannot appoint themselves. Neither can do the other's job, and
that is the point: the person who decides _who may release records_ is not the
person releasing them.

Sign in as `AC004`, issue an authority to `AC002`, then sign in as `AC002` —
they go from refusing every decision to approving them, without any role
changing. That is the whole idea in two minutes.

`AC000` Padma Ramanathan holds **both** roles, which is the common real-world
arrangement: a senior officer who both appoints and works the queue. Note that
even she needed a _second_ controlling officer to issue her own authority — the
database refuses a self-issued one outright.

### Who can do what, endpoint by endpoint

| Action                                              | Requirement                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Search the catalogue, view record metadata          | Any signed-in account                                                                              |
| Raise, submit or withdraw a request                 | Any signed-in account (the requester role is the default marker, not a gate)                       |
| Read a page of a record                             | A live grant, **or** the approver / custodian / controlling-officer role                           |
| Decide a request                                    | Approver role **and** a live authority **and** not the requester                                   |
| Issue an emergency grant                            | Approver or custodian role **and** a live authority                                                |
| Revoke a grant                                      | Approver or custodian role. _No authority required_ — see the note below                           |
| Issue or withdraw an approval authority             | Controlling officer                                                                                |
| View the live access register                       | Approver, custodian, controlling officer, or auditor                                               |
| View the authority register                         | Approver, controlling officer, or auditor — _not_ custodian                                        |
| Run ingestion, resolve quarantine, verify integrity | Custodian                                                                                          |
| Read the audit log                                  | Auditor or administrator                                                                           |
| View the staff list                                 | Administrator or controlling officer — the latter needs it to issue an authority to a named person |
| Edit your own name, email and designation           | Any signed-in account, on their own profile only                                                   |
| Manage users, roles and settings                    | Administrator                                                                                      |
| Create, rename, deactivate or delete a department   | Administrator                                                                                      |

Revoking a grant needs the role but not a live authority, deliberately —
see §6.2.1 of the design. Authorisation gates _additions_ of privilege, never
removals. An authority is a bounded, expiring thing, and the moment it lapses is
exactly when its holder is most likely to want to pull back something they
released. Gating revocation behind it would mean the safety action expires along
with the power that created the risk, leaving "ask a controlling officer for a
fresh authority so that access can be reduced" as the only route. Revocation is
still recorded in full — actor, grant, reason, timestamp.

### Two roles that deliberately cannot read records

Neither the administrator nor the auditor can open a service record. The
administrator is IT rather than Accounts — if the person who runs the server
could read every pension record without anyone releasing it, the custody model
would be decorative. The auditor is meant to see who looked, never what they
looked at.

An administrator who genuinely needs to read one raises a request like any user
department, or assigns themselves the approver role. That second route works,
and writes a `ROLE_GRANTED` event with `selfGranted: true`. No permission model
can stop whoever controls the users table; the design makes the move loud
instead of pretending otherwise. It still does not let them release records to
anyone else — that needs an authority from a controlling officer, which is a
second person leaving a second audit event.

## Running it

### First run on a new machine

Docker is the only thing that needs installing. Five steps, in order.

**1. Set the database password.** Create a `.env` file next to
`docker-compose.yml`:

```sh
echo "PG_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')" > .env
```

Compose reads `.env` automatically. There is no default — the stack will not
start without it, which is deliberate.

**2. Put the records where the app can see them.** PDFs go in
`./service-records`, named `<PPO number> <employee name>.pdf`. The parser also
accepts the PPO in brackets or at the end; anything it cannot place confidently
is quarantined rather than guessed at.

```sh
mkdir -p service-records
cp /wherever/they/live/*.pdf service-records/
```

**3. Bring the stack up.**

```sh
docker compose up --build -d
```

Migrations run as their own service and the app waits for them, so `up` never
leaves you with a server against an empty schema. First boot takes a couple of
minutes to build the image; after that it is seconds.

Check it came up before moving on — `migrate` should read `Exited (0)`:

```sh
docker compose ps -a
docker compose logs migrate
```

**4. Create the first administrator.** There is no default account, and the
demo seed is the wrong tool here — see the warning below.

```sh
docker compose run --rm \
  -e BOOTSTRAP_STAFF_CODE=IT001 \
  -e BOOTSTRAP_NAME='Your Name' \
  -e BOOTSTRAP_EMAIL='you@example.gov' \
  -e BOOTSTRAP_DEPT_CODE=IT \
  -e BOOTSTRAP_DEPT_NAME='IT Department' \
  bootstrap
```

It prints a generated password **once**. You are made to change it at first
sign-in. Nothing is truncated and an existing staff code is refused rather than
overwritten, so it is safe to run again for a second account.

**5. Index the records.**

```sh
docker compose run --rm ingest
```

It prints how many were added and how many went to quarantine. Quarantine is a
working state, not a failure: a PPO already on file under a different name, an
unreadable scan, a filename with no PPO in it. A custodian resolves each one by
hand.

Open <http://localhost:3002>.

#### Creating further accounts

Two routes, and the first is normally the right one:

- **Administration → Add user.** Pick the department and the staff code fills
  itself in as the department's next free number. It shows a one-time password
  once — hand it over in person.
- **The `bootstrap` service above**, with different `BOOTSTRAP_*` values. Useful
  for the accounts you need before anyone can sign in. `BOOTSTRAP_ROLES` takes a
  comma-separated list; a custodian is the one to create next, since ingestion
  and quarantine are theirs:

  ```sh
  docker compose run --rm \
    -e BOOTSTRAP_STAFF_CODE=AC001 -e BOOTSTRAP_NAME='...' \
    -e BOOTSTRAP_DEPT_CODE=AC -e BOOTSTRAP_DEPT_NAME='Accounts Department' \
    -e BOOTSTRAP_DEPT_KIND=ACCOUNTS -e BOOTSTRAP_ROLES=CUSTODIAN,APPROVER \
    bootstrap
  ```

  `BOOTSTRAP_DEPT_KIND` defaults to `USER_DEPT`. Use `ACCOUNTS` for the
  department that holds approvers — it decides whether one can be posted there
  at all, and it is locked once staff exist.

An administrator **cannot open a service record**, by design. If you need to
read one, raise a request like any user department, or give yourself the
approver role — which works, and writes a `ROLE_GRANTED` event marked
`selfGranted`.

> **Do not run `docker compose run --rm seed` on a real deployment.** It is demo
> data, and it begins by truncating every table — including the account you just
> created. Its volume points at `./service-records`; your PDFs are safe because
> the mount is read-only, but the database is not.

### Day-to-day

```sh
docker compose run --rm ingest          # after adding PDFs to ./service-records
docker compose run --rm reparse-names   # dry run, after a parser change
docker compose run --rm reparse-names --apply
docker compose logs -f app
docker compose down                     # keeps ./pgdata18; `down -v` does not
```

Rebuild after changing code — `up -d` alone reuses the existing images:

```sh
docker compose build app migrate && docker compose up -d
```

### The demo stack

For a tour of the system rather than a deployment. Separate database, sample
PDFs, nine fictional users:

```sh
scripts/dev-db.sh up            # Postgres on localhost:55433
scripts/node.sh npm install
scripts/node.sh npm run migrate
scripts/node.sh npm run seed    # demo users + deliberately messy sample PDFs
scripts/node.sh npm run ingest  # 8 indexed, 3 quarantined — by design
scripts/node.sh npm run web:build
```

Then start the server (`PORT` is free to change; 3000 may be taken):

```sh
docker run --rm --network host -v "$PWD":/app -w /app \
  -e DATABASE_URL='postgres://sr:sr@127.0.0.1:55433/service_records' \
  -e SR_SOURCE_ROOTS=/app/sample-records \
  -e COOKIE_SECURE=false -e PORT=3100 \
  node:22-alpine sh -c 'apk add --no-cache font-dejavu && node --experimental-strip-types src/server.ts'
```

Open <http://localhost:3100>. With Node installed locally, drop the
`scripts/node.sh` prefix and use `npm run dev` / `npm run web:dev`.

#### Demo accounts

Created by `npm run seed`, and only there. All share the password
`ChangeMeToday!2026`.

| Staff code | Who                          | Shows off                                                              |
| ---------- | ---------------------------- | ---------------------------------------------------------------------- |
| `PW001`    | Arun Deshpande, Public Works | Search, request, read                                                  |
| `ED001`    | Thomas Varkey, Education     | A second requesting department                                         |
| `AC001`    | Vikram Bose, Accounts        | Approver **with** a live authority                                     |
| `AC002`    | Nalini Iyer, Accounts        | Approver with **no** authority — reads everything, releases nothing    |
| `AC000`    | Padma Ramanathan, Accounts   | Controlling officer **and** approver — the common real-world pairing   |
| `AC003`    | Joseph Mathai, Accounts      | Custodian: ingestion and quarantine                                    |
| `AC004`    | Ravi Menon, Accounts         | Controlling officer **only** — issues authorities, decides no requests |
| `AU001`    | Grace Fernandes              | Auditor: the log, denials, reading sessions                            |
| `IT001`    | Sandeep Nair                 | Administrator: users, roles, policy — **cannot open records**          |

Sign in as `AC002` and then `AC001` to see the difference an authority makes, and
as `AC004` to see the difference between an approver and a controlling officer.

What each role can and cannot do is set out under [Roles](#roles) above.

## Departments

Administration manages departments in full: create, rename, deactivate,
reactivate, delete. Two rules are enforced server-side rather than by hiding a
button.

**Deleting only works while a department is empty.** A department that has never
held staff, a request, or a scoped approval authority is just a typo, and
refusing to remove typos is its own kind of mess — so it deletes outright. Once
it has history, the delete is refused with a message naming exactly what it
holds, and deactivation is the honest answer: audit rows and old requests still
point at it, and removing it would orphan them. This is the opposite call from
users, who are only ever suspended, because a user is named in audit rows from
the day they are created.

**`kind` is locked while staff are posted there.** It decides whether a
department can hold approvers at all, so flipping Accounts to a user department
under people's feet would silently change who can release records. Move the
staff out first.

Deactivated departments stay in the list and keep their history, but stop being
offered when creating a user or scoping an authority. Every operation writes an
audit event (`DEPARTMENT_CREATED`, `_UPDATED`, `_DEACTIVATED`, `_ACTIVATED`,
`_DELETED`).

## Adding pages to a service record

New papers for an employee — an increment order, a transfer order — are added
by a **custodian** from the record's page, under **Add pages**. PDF, JPG or PNG,
up to 25 MB (`SR_ADDITION_MAX_MB`); an image becomes a one-page PDF.

1. **Upload.** The file is checked (type judged from its bytes, not its name;
   encrypted, empty or duplicate files refused) and held as a staged upload.
2. **Check.** The custodian pages through it, watermarked, next to the
   employee's name and PPO number. Attaching papers to the wrong employee is
   the mistake this step exists to catch.
3. **Describe and add.** A description is required; the date on the document
   is optional. The pages go after the last page of the record.

The original PDF is never changed. Each addition is its own file in
`SR_ADDITIONS_ROOT` (`./sr-additions` in compose), and the viewer shows the
record as one run of pages, labelling which ones were added, when, and as what.
Anyone with access to the record sees added pages, including grants issued
before the pages were added. A mistaken addition is **withdrawn** with a
reason, never deleted; later pages move up. When a new scan supersedes the
record, the custodian chooses whether the additions carry over.

## Accounts, two-factor and password resets

### Two-factor authentication

An administrator **requires** 2FA; the user **enrols**. Those are separate
facts, held in separate columns, because enrolment belongs to the person
holding the phone.

1. Administration → **Require 2FA** on a user. Nothing is generated and nothing
   is handed over.
2. That user is asked to set it up at their next sign-in and cannot use the
   system until they have — enforced by the API, not only by the client router.
3. They scan a QR on their own screen (rendered server-side, so the browser
   needs no QR library), or type the secret in by hand, then prove one code.
4. Only when a code verifies does the secret become live. An abandoned setup
   leaves nothing behind.

**Clear 2FA** is the lost-phone path: it wipes the enrolment _and_ the
requirement, so the user can sign in with their password and start again.
Leaving the requirement in place would lock them out of their own recovery.
**Make 2FA optional** lifts the requirement but keeps an existing enrolment.

A user can turn off their own 2FA from **Password** — needing both their
password and a current code, since knowing only one of them is the situation
2FA exists for. If an administrator required it, they cannot.

### Password resets

Deliberately offline. There is no emailed reset link, because the email account
is not a stronger factor than the password it protects.

1. The user asks in person. A custodian verifies who they are.
2. An administrator clicks **Reset code** and reads out the code. It lasts 24
   hours, works once, and issuing a new one retires any previous one — whoever
   holds an unused code can take over the account.
3. The user redeems it from **Forgotten your password?** on the sign-in screen.
4. Redeeming ends every other session on that account.

### Suspending and restoring

**Suspend** ends the account's sessions immediately and blocks the grant check
even where a live grant exists. It is reversible: **Reactivate** lets them sign
in again, leaving old sessions ended and the password untouched. If the
suspension was because the credential was suspect, issue a reset code as well.

Accounts are never deleted — audit rows name them from the day they are created.

### Policy

Administration lists every tunable value with what it affects, editable in
place. Values are validated server-side against a catalogue, so a setting
cannot be given a number that would be ignored later.

The clearest example is **Maximum grant period**. The real 180-day ceiling is a
`CHECK` constraint on `access_grants`, not a setting, so setting this to 365
would be silently overruled at the point it mattered. The API refuses it and
says why. Raising the actual cap is a migration.

## Appearance

The interface follows the operating system's light or dark setting by default,
and the **Auto / Light / Dark** switch in the sidebar — and on the sign-in
screen — overrides it. The choice is stored per browser in `localStorage`;
it never leaves the machine and is not part of the user account.

There are three states, not two, which is worth knowing if you touch the CSS.
An explicit choice stamps `data-theme` on `<html>`; the default "Auto" stamps
nothing and leaves `prefers-color-scheme` to decide. So every colour token is
defined on bare `:root` first and only _redefined_ under the media query and the
`[data-theme="dark"]` selector. A token that exists only inside a media query
is the classic bug that renders one theme's text on the other theme's
background.

## Layout

```
db/migrations/    12 numbered .sql files, applied by db/migrate.ts
src/authz/        §6.1 grantCheck — may this person READ this record?
                  §6.2 authorityCheck — may they RELEASE one to someone else?
src/ingest/       §7 normalisation, §8 filename parser (pure, no I/O)
src/services/     search, requests, grants, authorities, auth, audit,
                  ingest/ (scan, quarantine, integrity), render/ (page + watermark)
src/http/         express app, middleware, routes
src/audit/        §12 append-only event log with a hash chain
web/              React 19 + Vite client
test/             89 tests
```

## Testing

```sh
scripts/node.sh npm run test:unit   # parser + normaliser, no database
scripts/node.sh npm test            # all 89, needs DATABASE_URL
```

The dev database (`scripts/dev-db.sh`, port 55433) is deliberately separate from
the compose one (55432): the suite truncates tables, and you do not want that
pointed at a stack you are using. `scripts/node.sh` defaults `DATABASE_URL` to
the dev database.

Integration tests run with `--test-concurrency=1`: two files truncate the same
database, and in parallel they deadlock on the `TRUNCATE` lock rather than
failing usefully. `test/authz.test.ts` and `test/http.test.ts` skip themselves
when `DATABASE_URL` is unset, so a contributor without Docker still gets a green
parser suite.

## Conventions

- **Raw SQL, no ORM.** A government deployment gets audited; an ORM's migration
  format does not help that conversation. Migrations are numbered `.sql` files,
  each applied in a transaction.
- **The checks are exported as SQL constants** (`GRANT_CHECK_SQL`,
  `AUTHORITY_CHECK_SQL`) so they are greppable and identical everywhere.
- **Policy lives in the database too.** The 180-day grant cap, the self-issue
  ban, `granted_under_authority_id NOT NULL`, and the append-only audit log are
  constraints and triggers, not application rules — the layer still enforcing
  policy after the third UI rewrite.
- **Ingestion never invents metadata.** Anything the parser cannot place goes to
  quarantine and stays invisible to search until a custodian resolves it.
- **The renderer refuses to start without a watermark font.** A missing font
  fails silently — `fillText` draws nothing and pages ship unwatermarked — so
  it is checked at boot instead.

## Deployment notes

- **Mount the source folder read-only** (`:ro` in compose). The application reads
  records and never writes, renames, or deletes them. A writable mount turns an
  ingestion bug into a records-destruction incident.
- **Set `COOKIE_SECURE=true`** and terminate TLS in front. HSTS is sent only when
  it is set.
- **Rate limits are in-process.** With one process they are exact; behind four
  they are four times looser. A multi-process deployment needs a shared store.
- **Back up the PDF folder yourself.** The app verifies a rotating slice by
  checksum nightly and alerts on drift or disappearance (§8.2); it does not
  replace a backup regime.
- **Back up `./sr-additions` with the database.** It is the only writable
  folder and holds the only copy of every page added after indexing. The two
  must be restored together: a row without its file, or a file without its
  row, is an integrity alert. The `backup` service does both in one file; see
  [Backups](#backups).

## Backups

The `backup` service starts with `docker compose up`. Once a day at 02:00 IST it
writes one encrypted file that contains the database and `./sr-additions`
together. If the machine was off at 02:00, the backup runs as soon as it is back
on. Files go to `./backups`:

```
backups/daily/sr-2026-10-23.tar.age     newest 14 days
backups/weekly/sr-2026-W43.tar.age      one per week, newest 8
backups/monthly/sr-2026-10.tar.age      one per month, newest 12
backups/last-success                    when and what, after each good run
backups/last-failure                    present only while backups are failing
```

Each file is a pg_dump plus a tar of `sr-additions`, with checksums. It is
encrypted with [age](https://age-encryption.org) to the public key in
`BACKUP_AGE_RECIPIENT` (`.env`). **The server holds only the public key, so it
cannot read its own backups.** The private key is kept offline: a password
manager, plus a printed copy in the department safe. **If that key is lost, every
backup is unreadable.**

**`./backups` on the same disk as `./pgdata18` is not yet a backup.** Point the
mount at another drive in `docker-compose.yml`, for example
`- E:/sevalekh-backups:/backups` on the `backup` and `restore` services.

Every command below is run from the project folder (the one holding
`docker-compose.yml`). They work unchanged in PowerShell on Windows and in a
Linux shell.

### Setting up backups on a server

Do this once per server. Every server gets its own key pair.

**1. Make the key pair.**

```bash
docker compose run --rm keygen
```

This prints a line like the following. The `age1…` part is the **public key**:

```
Public key: age1ehryetjwnzke4drqldvz7ze3fqftdzd93hffu0hdzq4lfhvhfp4qya972w
```

It also writes the **private key** to `./restore/age-key.txt`. That file has
three lines, and the last one starts with `AGE-SECRET-KEY-1…`. If the file
already exists, the command refuses to run rather than overwrite a key that may
be the only way into existing backups.

**2. Put the public key in `.env`.**

```
BACKUP_AGE_RECIPIENT=age1ehryetjwnzke4drqldvz7ze3fqftdzd93hffu0hdzq4lfhvhfp4qya972w
```

**3. Move the private key off the server.** Copy all three lines of
`./restore/age-key.txt` into a password manager, and keep a printed copy in the
department safe. Label it with the server name and the date, then delete the
file from the server:

```bash
# Linux
rm restore/age-key.txt
# Windows PowerShell
Remove-Item restore\age-key.txt
```

**4. Start the backup service**, then take a first backup and check that it
worked:

```bash
docker compose up -d --build backup
docker compose exec backup backup.sh now
docker compose logs backup
cat backups/last-success
```

**5. Prove you can restore it.** Follow the test restore below, using the key from
the password manager. Until you have done this, you do not know that you hold
the right key.

On Windows, also turn on *Start Docker Desktop when you sign in* in Docker
Desktop settings. Backups run only while Docker is running.

### Checking on backups

```bash
docker compose logs backup                     # what it did, and when
cat backups/last-success                       # time and file of the last good backup
ls backups/daily                               # Windows: dir backups\daily
docker compose exec backup backup.sh now       # one backup, right now
```

If `backups/last-failure` exists, the last attempt failed. The service retries
every hour, and `docker compose logs backup` shows why it failed.

### Restoring

Every restore needs the private key. Save the three lines from the password
manager as `./restore/age-key.txt`. Create the `restore` folder if it does not
exist. Notepad is fine for this. **Delete the file once the restore is done.**

The backup file is named by its path under `./backups`, for example
`daily/sr-2026-10-23.tar.age`. Run `ls backups/daily` to see the dates you have.

**Test restore.** This touches nothing live. It restores into a separate
database, `service_records_restore`, unpacks the pages to
`./restore/sr-2026-10-23/sr-additions`, checks the checksums and prints row
counts to compare with the live system. Do this every month or so: a backup that
has never been restored is unproven.

```bash
docker compose run --rm restore daily/sr-2026-10-23.tar.age
```

Clean up afterwards:

```bash
docker compose exec db psql -U srdfm -d postgres -c "drop database service_records_restore"
```

**Real restore.** This replaces the live database **and** `./sr-additions` with
the backup's contents. Everything recorded after that backup was taken is lost.

```bash
docker compose stop app
docker compose run --rm restore daily/sr-2026-10-23.tar.age --live
docker compose start app
```

**Restoring onto a new server** (the old one is gone):

1. Set up the app on the new server as in [Running it](#running-it), up to and
   including `docker compose up --build -d`. Do not run `bootstrap`, because the
   restore brings the users back.
2. Copy the backup file into the new server's `./backups/daily/`.
3. Put the old server's private key at `./restore/age-key.txt`.
4. Run the real restore above, then delete the key file.
5. Set up backups on the new server with its own key pair, as described above.

### Replacing the key

To change the key, for example because the private key may have been exposed:
remove or rename the old `./restore/age-key.txt` if it is present, then repeat
steps 1–4 of setting up. New backups use the new key. **Keep the old private key
until the last backup made with it has been pruned (12 months),** because those
backups can only be opened with it.

## Not built

Email delivery for notifications (they are written to the `notifications` table
and surfaced in-app; a sender is the missing piece), SSO/LDAP, and OCR. §14 of
the design covers the suggested order.
yes

## New Admin creation:

docker compose run --rm -e BOOTSTRAP_STAFF_CODE=EDP001 -e "BOOTSTRAP_NAME=Utkarsh Tripathi" -e BOOTSTRAP_DEPT_CODE=EDP -e "BOOTSTRAP_DEPT_NAME=EDP Department" -e BOOTSTRAP_ROLES=ADMIN bootstrap
