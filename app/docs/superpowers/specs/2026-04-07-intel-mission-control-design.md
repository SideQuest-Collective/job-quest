# Intel Mission Control - Design Spec

## Problem
The Intel page is a read-only report viewer. Users can browse roles and tips but can't take action -- no way to track application progress, prepare for specific roles, or connect tips to the roles they apply to. All triage happens in Discover, which is a separate flow with no depth.

## Solution
Transform Intel into a two-panel CRM-style mission control where each role becomes a trackable entity with its own pipeline stage, prep checklist, related tips, notes, and timeline.

## Layout

Two-panel split (full-height, like Code Lab):

- **Left panel (300px fixed)**: Filterable role list with pipeline stage indicators
- **Right panel (flex)**: Selected role's mission control dashboard

## Left Panel: Role Pipeline List

### Filter Tabs
- All | Active | Applied | Interviewing | Archived
- "Active" = Discovered + Researching (not yet applied)

### Role Cards
Each card shows:
- Company name and role title
- Level badge (L6, Staff, E6)
- Stage dot (color-coded)
- Time since last activity ("2d ago")
- "NEW" badge for untriaged intel roles

### Sorting
Default: most recent activity. Also sortable by stage, company name.

### Data Source
Aggregates roles from ALL intel reports (flattened, deduplicated by `company|role` key). Merged with role-tracker state for pipeline data.

## Right Panel: Role Mission Control

### 1. Header
- Company, role title, level, location
- Horizontal stage stepper (clickable to advance/change stage)
- Action buttons: "View Posting" (opens URL), "Apply" (opens URL + advances stage), "Archive"

### 2. Fit Analysis
- The personalized "Why this fits you" text from the intel report
- Displayed prominently -- this is the key context for why this role matters

### 3. Prep Checklist
- Editable checklist items, user can add/remove/check
- Auto-generated starter items based on stage:
  - Discovered: "Research team & recent launches", "Read job description thoroughly"
  - Applied: "Prepare 2 STAR stories relevant to this role", "Review company values"
  - Phone Screen: "Practice 60-second pitch", "Prepare questions for recruiter"
  - Onsite: "Practice system design → Code Lab", "Mock interview", "Review company's tech stack"
- Checklist items can link to Code Lab (opens Code Lab with relevant problem)

### 4. Interview Tips
- Filtered from ALL intel tips matching this company name
- Shows source attribution
- Displayed as the existing `intel-tip` styled cards

### 5. Notes
- Free-form textarea, auto-saves on blur (debounced)
- For: recruiter names, referral contacts, prep thoughts, interview dates

### 6. Timeline
- Auto-logged events: discovered, saved, applied, stage changes
- User can add manual entries (e.g., "Phone screen scheduled April 15")
- Displayed as a vertical timeline with timestamps

## Pipeline Stages

| Stage | Color Variable | Description |
|-------|---------------|-------------|
| Discovered | `--text-muted` | Found via intel, no action taken |
| Researching | `--violet` | Actively learning about company/role |
| Applied | `--amber` | Application submitted |
| Phone Screen | `--cyan` | Recruiter/phone screen phase |
| Onsite | `--blue` | Virtual/onsite interview loop |
| Offer | `--emerald` | Received offer |
| Rejected | `--rose` | Rejected at any stage |

## Data Model

### New file: `data/role-tracker.json`

```json
{
  "google|Senior Staff Software Engineer, Discover Ads Retrieval": {
    "stage": "applied",
    "notes": "Referred by Alex from ads team",
    "checklist": [
      { "text": "Research team & recent launches", "done": true },
      { "text": "Practice system design: ads at scale", "done": false }
    ],
    "timeline": [
      { "date": "2026-04-06T08:00:00Z", "event": "Discovered via intel report" },
      { "date": "2026-04-07T10:30:00Z", "event": "Applied online" }
    ]
  }
}
```

### Sync with existing `role-actions.json`
- Roles saved in Discover → auto-created in tracker as "Discovered"
- Roles applied in Discover → auto-created as "Applied"
- Roles skipped in Discover → not tracked (unless user manually adds)

### API Endpoints
- `GET /api/role-tracker` — returns full tracker state
- `POST /api/role-tracker` — saves full tracker state (same pattern as other endpoints)

## Integration Points

### Discover → Intel
- Saved/applied roles in Discover auto-appear in Intel pipeline
- "Open in Intel" link in Discover's Saved/Applied tabs navigates to Intel with that role selected

### Intel → Code Lab
- Prep checklist items can link to Code Lab problems
- "Practice for this role" button suggests relevant problems based on role type

### Activity Journal
- All stage changes, checklist completions, notes edits, and timeline additions logged to `data/activity.json`

## Nav Changes
- Rename "Intel Reports" → "Intel" in sidebar
- Keep existing nav position (between Resume and Calendar)

## CSS Approach
- Full-height layout using `main-fullheight` class (same as Code Lab)
- Left panel: scrollable role list with existing card/nav-item patterns
- Right panel: scrollable sections using existing card/section patterns
- Stage stepper: new CSS, horizontal flex with connecting lines
- Follow existing design tokens (colors, fonts, spacing, border-radius)

## Files to Modify
- `server.js` — add role-tracker endpoints, sync with role-actions
- `public/index.html` — replace Intel component, add CSS, update nav label
- `data/role-tracker.json` — new file (created on first save)

## Out of Scope
- Drag-and-drop between stages (use click-to-change)
- Email/calendar integration
- Auto-scraping job postings
- Multiple users / auth
