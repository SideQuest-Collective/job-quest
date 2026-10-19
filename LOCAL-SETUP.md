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

In **Outreach → Accounts to review**, add each Gmail account you want covered. Add **LinkedIn email notifications** separately if those messages arrive in Gmail. Link an account to a named source row only when that row actually describes its review. Source rows show checked or blocked time and coverage detail; access verification is recorded separately after a real connector or browser check. LinkedIn notifications do not establish coverage of the direct LinkedIn inbox, InMail or invitations. For direct LinkedIn review, select a direct LinkedIn account and verify its actual signed-in identity with a connector or visible browser profile/email and canonical profile URL before reading messages. A similar display name is insufficient. Missing and blocked sources remain visible.

The native runner checks only tools exposed to its own invocation. It can use an already authorized connector or fall back to an already signed-in browser exposed there; browser access in an interactive agent app does not establish automatic CLI access. The current Claude invocation permits file, web and Bash tools and excludes inbox/browser MCP tools, so selected inbox accounts remain unavailable there. A Codex runtime also needs an actual account-capable connector or browser tool in its visible inventory; selecting Codex alone does not grant access. No scraper, token store, browser-secret extraction or duplicate collector is installed. The collector records unavailable access with no reviewed time, and reports actual bounds for partial scans (14 days, up to 25 relevant conversations and 2 result/list pages). Read the saved source detail to see which Messaging, InMail, sent replies or invitations were actually inspected.

Discover uses the existing native Intel search for company/ATS listings and LinkedIn Jobs. It prefers an employer/ATS posting, but accepts a specific source-read LinkedIn job detail link when the title, employer and availability are established and no other listing is available. Independent employer verification remains explicit. Generic job/search links and unreadable snippets do not qualify. Each new Intel report records `sourceCoverage`, including bounded LinkedIn queries (up to 2 result pages and 25 detail pages), remaining results or unavailable tools. These listing checks never establish inbox access. Runs that preserve existing daily files do not refresh listing discovery.

Queue edits use record revisions and preserve unrelated fields. Opening a conversation, copying a draft or opening a calendar link does not mark a reply sent or a meeting booked. The user sends replies and chooses booking times; sent/booked reports are explicitly user reported.

The optional interview bridge uses `~/.interview` unless you choose another existing directory:

```bash
~/.job-quest/bin/configure-local.cjs --interview-home /absolute/path/to/interview-home
~/.job-quest/bin/restart.sh
```

For private phone access, first configure and verify Tailscale Serve and the exact login identity. Then use `--private-origin https://your-device.your-tailnet.ts.net --tailscale-user your-login` and restart. This command records the allowlisted origin and identity; it does not turn on Tailscale or publish Job Quest. Keep the Mac awake and online while using the phone. `--local-only` removes those two private-access settings and retains native Outreach data and optional legacy/interview paths.

Run `~/.job-quest/bin/configure-local.cjs --help` to see the options. The local status endpoint `/api/local-setup` reports native versus external Outreach storage, configured sources and private access settings without returning brief or queue content. A configured path or account is not proof that a source was checked today; verify Outreach and its source rows after each setup change.

For a source checkout, `install.sh` copies `skill/bin/configure-local.cjs` and `skill/bin/collect-outreach.cjs` to `~/.job-quest/bin` and makes them executable. When updating an existing local installation, preserve `~/.job-quest/data`, the current branch changes, and the external review schedule. Install only the reviewed source files needed for this update, then restart and check the local page before testing private phone access.

## Configure collection and practice from the dashboard

- **Setup → Configure accounts and sources** opens and focuses Outreach's actual account form. Select Gmail, LinkedIn notification email or a direct LinkedIn inbox, then add the account identity. Account selection records a preference; it does not authenticate an inbox. The same panel includes the request to verify access in the chosen agent app and links directly to Intel run settings.
- **Setup → Intel runs** shows the active AI runtime and native schedule, starts an on-demand run, and offers Daily, Weekdays or Off with a local time. These use the existing runner and native scheduler. A saved Off choice survives skill startup. Native scheduling requires the host online and awake and does not install dashboard login startup. If an external career review owns inbox collection, it continues doing so; native runs skip the duplicate inbox step.
- Runs preserve existing dated files. A completed runner may therefore have skipped an already prepared batch. Behavioral shortages on a partially prepared day need the existing prep-plan flow, rather than forcing an overwrite.
- **Setup → Content readiness** checks distinct unanswered behavioral prompts, valid recent quiz questions/topic types, and audio/video publisher and topic variety. Minimums and freshness windows are configurable in the expanded panel. The server checks nonblockingly at startup; the skill runs `check-content-readiness.cjs` even when reusing a healthy server. Gaps have a copyable request for the agent to fill them while preserving existing work. Checking does not silently generate content or claim media playback.
- **Practice → Focused / On the go** groups the former Learn page under Practice. `#learn` remains the direct link to On the go. Focused owns writing, coding and rehearsal; On the go leads with listening/watching, format filters and saved bookmarks. Written reflections are optional. Drafts retain separate mode identities and stay mounted when switching tabs.

The additional media references were checked against [MIT's BFS lecture](https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/resources/lecture-9-breadth-first-search/) and the [official AWS podcast feed](https://d3gih7jbfe3jlq.cloudfront.net/aws-podcast.rss); audio episode 704 returned audio/mpeg. Catalog check dates are not evidence of listening or comprehension.
