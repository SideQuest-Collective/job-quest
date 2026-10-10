# Local Job Quest setup

Job Quest works on the Mac without an optional connection. The dashboard stores its state under `~/.job-quest/data` and listens on loopback by default. Outreach now owns its brief and recruiter queue in that same private data directory:

- `outreach/brief.json` — collected source coverage and opportunities.
- `outreach/queue.json` — reply drafts, holds and user-reported workflow state.
- `opportunity-accounts.json` — accounts selected for review; account selection does not establish access or a completed scan.

For a fresh setup, initialize the native files without connecting to an account or sending anything:

```bash
~/.job-quest/bin/collect-outreach.cjs --init
```

To save a completed collection, pass its JSON candidate to the shared collector:

```bash
~/.job-quest/bin/collect-outreach.cjs --input /absolute/path/to/collection.json
```

The candidate uses `schema: "job-quest-collection/1"`, optional `generatedAt` and `summary`, and `sources` and `opportunities` arrays. Each source records its actual account, review status, checked time and coverage detail. Opportunities use stable IDs and `kind: "job"` or `kind: "recruiter"`, with precise role/message links and actual check times. An optional prepared recruiter draft seeds only a new queue ID. Do not supply `queue`, `items` or `holds` in a collection: it cannot replace a reply queue. Unavailable account access must be recorded as unavailable, without claiming that messages were reviewed.

Collection merges source evidence and opportunities, retains previously collected leads, and seeds recruiter queue records only for IDs absent from both current items and holds. It preserves saved drafts, holds, snoozes, sent/booked reports and other user state for existing IDs. It also projects supported, precisely identified job listings into native Intel reports; recruiter messages and generic listing URLs stay in Outreach. This is an evidence import, not a new inbox scan. The collector does not connect accounts or send messages.

### Move an existing external review into native Outreach

Before switching an installation that already uses an external brief and recruiter queue, import them together:

```bash
~/.job-quest/bin/collect-outreach.cjs --import-legacy \
  --brief /absolute/path/to/daily-intelligence.json \
  --queue /absolute/path/to/recruiter-reply-queue.json
~/.job-quest/bin/restart.sh
```

The import validates the files, backs up their original bytes and existing `local-setup.json` under private `data/migration-backups/native-outreach-*`, and copies the brief and queue byte for byte into the native paths. It removes `careerBrief` and `replyQueue` from setup while preserving interview, private-access and schedule settings. It leaves the old source files in place. It refuses to replace different existing native Outreach files; reconcile that conflict before retrying. Confirm the printed native paths, source rows, saved drafts and holds in the dashboard after restarting. Keep an existing review schedule; update its write step to submit a collection through this command rather than replace queue files. Do not add another schedule merely to migrate the store.

For isolated data or testing, each collector mode accepts `--data-dir /absolute/path/to/data`. `configure-local.cjs --native-outreach` removes legacy path overrides, but does not import their data; use the import above before switching an existing setup. Explicit `--career-brief` and `--reply-queue` overrides remain available for compatibility and are no longer required by default.

In **Outreach → Accounts to review**, add each Gmail account you want covered. Add **LinkedIn email notifications** separately if those messages arrive in Gmail. Link an account to a named source row only when that row actually describes its review. Source rows show checked or blocked time and coverage detail; access verification is recorded separately after a real connector or browser check. LinkedIn notifications do not establish coverage of the direct LinkedIn inbox, InMail or invitations. Missing and blocked sources remain visible.

Queue edits use record revisions and preserve unrelated fields. Opening a conversation, copying a draft or opening a calendar link does not mark a reply sent or a meeting booked. The user sends replies and chooses booking times; sent/booked reports are explicitly user reported.

The optional interview bridge uses `~/.interview` unless you choose another existing directory:

```bash
~/.job-quest/bin/configure-local.cjs --interview-home /absolute/path/to/interview-home
~/.job-quest/bin/restart.sh
```

For private phone access, first configure and verify Tailscale Serve and the exact login identity. Then use `--private-origin https://your-device.your-tailnet.ts.net --tailscale-user your-login` and restart. This command records the allowlisted origin and identity; it does not turn on Tailscale or publish Job Quest. Keep the Mac awake and online while using the phone. `--local-only` removes those two private-access settings and retains native Outreach data and optional legacy/interview paths.

Run `~/.job-quest/bin/configure-local.cjs --help` to see the options. The local status endpoint `/api/local-setup` reports native versus external Outreach storage, configured sources and private access settings without returning brief or queue content. A configured path or account is not proof that a source was checked today; verify Outreach and its source rows after each setup change.

For a source checkout, `install.sh` copies `skill/bin/configure-local.cjs` and `skill/bin/collect-outreach.cjs` to `~/.job-quest/bin` and makes them executable. When updating an existing local installation, preserve `~/.job-quest/data`, the current branch changes, and the external review schedule. Install only the reviewed source files needed for this update, then restart and check the local page before testing private phone access.
