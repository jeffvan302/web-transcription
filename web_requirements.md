# yt-asr Web App Requirements

This document defines the requirements for rewriting the current `yt-asr` desktop application as a browser-based web application.

The goal is to preserve the current editing workflow, subtitle review workflow, `.asr` packaging, and cloud collaboration model, while moving the product to a hosted multi-user system with login, a user database, and server-managed object storage.

The required target hosting platform for the server-side web application is **AWS App Runner**.

This document is written so a team can design and build the web product without needing to read the current Tkinter code first.

---

## 1. Product Goal

Build a hosted web version of `yt-asr` that allows multiple authenticated users to:

- import titles from YouTube URLs
- import local media and subtitle files
- review and edit phrase timing and text in a waveform-based editor
- export training data
- package and import `.asr` archives
- collaborate through a check-out / check-in workflow
- store title packages in Backblaze B2 or another S3-compatible object store

The web version must preserve the current desktop workflow closely enough that an existing `yt-asr` user can move to the browser version with minimal retraining.

The primary deployment target for the web application's server-side components is **AWS App Runner**.

---

## 2. Core Web Product Principles

- The web app is the primary UI. Users must not need local Python, local S3 keys, or a desktop runtime.
- Authentication, authorization, and checkout rules must be enforced on the server.
- S3 credentials must never be exposed to the browser.
- The app must support Backblaze B2 and other S3-compatible providers through one storage abstraction.
- The editor must preserve the current phrase-based workflow: select a title, select a phrase, edit text, drag timing markers, review playback, save, sync, check in.
- Users may have at most **one active checked-out title at a time**.

---

## 3. Scope

### 3.1 In Scope

- hosted web UI
- deployment of server-side application components to AWS App Runner
- login and session management
- user database
- roles: `user` and `admin`
- title library
- waveform subtitle editor
- YouTube import
- local media import
- `.asr` pack and import
- server-managed check-out / check-in / sync
- audit trail
- S3-compatible object storage support
- Backblaze B2 preset

### 3.2 Out of Scope for Initial Web Release

- offline browser editing
- peer-to-peer sync
- client-side direct S3 credentials
- mobile-native app
- multi-title checkout per user
- real-time collaborative editing on the same title by multiple users

---

## 4. Roles

### 4.1 User

- can sign in
- can see available titles
- can check out at most one title
- can edit only titles checked out by that user
- can sync changes while keeping a title checked out
- can check in the currently checked-out title
- can upload new local/imported titles
- cannot override another user's checkout
- cannot see raw storage credentials

### 4.2 Admin

All user permissions, plus:

- configure storage provider connection
- manage shared cloud settings
- import/export managed config if still needed for hybrid workflows
- force check in abandoned titles
- take over a checked-out title
- delete cloud titles
- view audit history

---

## 5. Target Architecture

The web version should be split into these logical parts:

- **Frontend**
  - browser UI
  - waveform editor
  - title library
  - auth screens
  - cloud/admin screens

- **Backend API**
  - authentication/session validation
  - title CRUD and metadata
  - checkout/check-in/sync enforcement
  - import/export orchestration
  - S3/B2 access
  - audit recording
  - packaged for deployment on AWS App Runner

- **Background Jobs**
  - YouTube metadata retrieval
  - subtitle download
  - ffmpeg audio conversion
  - `.asr` packing/unpacking
  - export packaging
  - designed so they can run from App Runner-hosted services or from supporting AWS services if split later

- **Database**
  - users
  - sessions or auth integration
  - titles
  - title state
  - checkout history
  - audit records

- **Object Storage**
  - title packages
  - derived media assets
  - optional exports
  - audit attachments if needed

### 5.1 Hosting Target

The required hosting target is **AWS App Runner**.

This means the design must assume:

- server-side application components are containerized and deployable to App Runner
- application containers are treated as stateless
- no required persistent data may live only on the local container filesystem
- all required persistent state must live in the database and/or object storage
- configuration and secrets are managed through server-side deployment configuration, not client-side files
- the system should remain operable for low-usage patterns where the service may be paused or only lightly used

The requirements may still allow supporting AWS services where needed, but App Runner is the primary application hosting target.

---

## 6. Hosting and Storage Requirements

### 6.1 Hosting Platform Requirements

The implementation must be suitable for deployment on AWS App Runner.

Required implications:

- backend services must run as web-accessible container services
- the service must start cleanly in an App Runner container environment
- local container disk may be used only for temporary processing
- any temporary processing output that must survive request completion or container replacement must be written to durable storage
- long-running imports, packing, export generation, and media processing must not depend on a single container's local disk as the only durable copy
- if background processing is split out, the split must still be compatible with an App Runner-centered AWS architecture

### 6.2 Supported Storage Providers

The system must support:

- Backblaze B2 via S3-compatible API
- generic S3-compatible storage
- optional presets for:
  - Amazon S3
  - Cloudflare R2
  - MinIO

### 6.3 Storage Configuration Rules

- storage connection settings are configured server-side only
- end users must not see access key ID or secret access key
- the browser must only interact with the application API
- the application server may use SDK-based access or short-lived signed URLs where appropriate

### 6.4 Required Object Layout

The storage layout must support at least:

```text
{prefix}titles/{title_id or video_id}.asr
{prefix}audit/{timestamp}_{title_id}_{event}.json
{prefix}exports/{title_id}/...
{prefix}artifacts/{title_id}/...
```

The web application may keep lock state in the database instead of object-store `.lock` files.  
However, it must still support import/export compatibility with the current `.asr` package format.

### 6.5 `.asr` Compatibility

The web app must remain compatible with the current `.asr` archive structure:

- `manifest.json`
- `{video_id}/project.json`
- `{video_id}/caption.json3` or equivalent subtitle payload
- `{video_id}/working_audio.wav`

The web system may add version metadata, but it must still be able to import existing desktop-produced `.asr` files and export archives that the desktop app can understand if backward compatibility is required.

---

## 7. User Database Requirements

The web app must include a persistent user database.

### 7.1 Required User Fields

- internal user primary key
- stable `user_id`
- display name
- login identity
  - email and password, or external auth provider subject ID
- role: `user` or `admin`
- account status: active / disabled
- created timestamp
- updated timestamp
- last login timestamp

### 7.2 Account Rules

- every user must have a stable `user_id`
- every user must have a human-readable display name
- roles are managed server-side only
- normal users must not be able to promote themselves to admin

### 7.3 Authentication

The system must support:

- login
- logout
- session persistence
- password reset or admin reset flow
- optional MFA in later phases

---

## 8. Checkout / Check-In System Requirements

The web app must replace the current client-managed lock model with a server-enforced checkout system.

### 8.1 Core Rules

- one title can be checked out by only one user at a time
- one user can have only one active checked-out title at a time
- a checked-in title is visible to all users but read-only
- a title checked out by another user is visible but read-only
- a title checked out by the current user is editable

### 8.2 Required User Actions

- `Check Out`
- `Sync Checked Out`
- `Check In`
- `Upload New Title`
- `Admin Force Check In`
- `Admin Take Over`

### 8.3 Checkout Behavior

When a user checks out a title:

- the server validates that the title is not checked out by another user
- the server validates that the user does not already hold another checked-out title
- the title state becomes `checked_out_self` for that user
- the title becomes editable in the browser
- an audit record is written

### 8.4 Sync Behavior

When a user syncs a checked-out title:

- the title remains checked out
- only changed data is persisted
- last synced timestamp/version is updated
- an audit record is written

### 8.5 Check-In Behavior

When a user checks in a title:

- the latest edited state is persisted
- the title becomes available to other users
- the title state becomes `checked_in`
- the title becomes read-only unless re-checked-out
- an audit record is written

### 8.6 Working Draft Lifecycle

To avoid data loss, a checked-out title must create or use a **server-side working draft**.  
The browser must never be the only location where checked-out edits exist.

Required rules:

- checking out a title creates or resumes a server-side working draft for that user and title
- the working draft remains available after browser refresh, tab close, browser crash, session expiry, or logout
- logging out must **not** destroy the working draft
- checking in must finalize the latest working draft state into the checked-in shared version
- checking in must not blindly delete the last editable draft until the finalized version is safely persisted
- a title that is still checked out by the same user must reopen to the latest saved draft state on next login

Recommended implementation behavior:

- use the database as the source of truth for draft metadata and revision tracking
- store large binary artifacts in object storage and reference them from the draft record
- support draft resume after interrupted editing sessions
- support a retention/cleanup policy for abandoned drafts, but never immediate deletion on logout

### 8.7 Session and Logout Behavior

Required behavior:

- logout ends the authenticated browser session only
- logout does not release the checkout automatically
- logout does not delete the working draft
- if the user logs back in, the system should return them to their active checked-out title if one exists

Optional later enhancement:

- admin-configurable checkout expiration with warning and grace period
- heartbeat or presence tracking for active editing sessions

### 8.8 Admin Recovery

Admin actions must support:

- **Force Check In**
  - release another user's active checkout
  - keep the latest server-persisted copy as the available copy
  - clearly warn that edits still only present in a disconnected browser session may be lost

- **Take Over**
  - replace the active checkout with the admin user
  - preserve the current stored version
  - record previous owner in audit history

---

## 9. Required Database Entities

The implementation may vary, but the data model must support the following concepts.

### 9.1 Users

- identity, role, profile

### 9.2 Titles

- internal title ID
- source type: youtube / local media / imported package
- external video ID if present
- title
- channel / source
- language
- duration
- created by
- created at
- updated at
- current state
- current checked-out user
- phrase count

### 9.3 Title Content

- editable project JSON equivalent
- phrase list
- paths or references to subtitle payload and working audio
- latest packed `.asr` object key

### 9.4 Checkout Records

- title ID
- user ID
- checkout timestamp
- check-in timestamp
- active flag
- takeover flag if applicable

### 9.5 Working Drafts

- title ID
- user ID
- active checkout reference
- current draft version number
- last autosave timestamp
- last explicit save timestamp
- last synced timestamp
- draft state payload or reference
- object keys for large artifacts if stored outside the database
- status: active / finalized / abandoned / archived

### 9.6 Audit Records

- event type
- title ID
- actor user ID
- actor display name
- timestamp
- detail payload

### 9.7 Optional Version History

Recommended, but not mandatory for MVP:

- saved title revisions
- prior check-in snapshots
- restore capability

---

## 10. Import Requirements

### 10.1 YouTube Import

The web app must support entering one or more YouTube URLs.

For each URL, the system must:

- fetch metadata
- determine available subtitle languages
- use the selected language
- download subtitle data if available
- download/convert working audio
- create the phrase list
- create a new title in the library

If no subtitles are available:

- the title must still be created
- the editor must open with zero phrases
- the user must be able to click `Add Sentence` and transcribe manually

### 10.2 Local Media Import

The web app must support importing:

- a media file with embedded subtitle tracks
- a media file plus a separate subtitle file

The import UI must allow:

- media file selection/upload
- title field
- channel/source field
- caption language field
- choosing one embedded subtitle track when multiple tracks exist
- or selecting an external subtitle file

Supported subtitle inputs should match the desktop workflow as closely as possible, including:

- `.vtt`
- `.srt`
- `.json3`
- `.srv3`
- `.json`

---

## 11. Export Requirements

The web app must support:

- export current title
- export all eligible titles
- pack selected titles into `.asr`
- import `.asr`

Exported dataset content must preserve current behavior:

- phrase-level enable/disable state
- reviewed state
- timing
- text

---

## 12. Required Web UI

The web UI must replicate the current desktop GUI closely. The current desktop app is a three-pane editor with a top toolbar and a cloud window. The web app may reorganize some controls for responsive layout, but it must preserve the same mental model and editing flow.

### 12.1 Main Application Layout

Desktop equivalent:

- top toolbar
- left pane: title library
- center pane: editor
- right pane: phrase list
- status bar

Web requirement:

- use a responsive three-column desktop layout where space allows
- preserve the left-center-right workflow on desktop
- allow a stacked or tabbed layout on narrow screens
- keep the title list and phrase list visible during editing on normal desktop widths

---

## 13. Screen and Control Requirements

### 13.1 Top Toolbar / Header Actions

The current desktop app exposes these actions at the top:

- workspace selector
- reload
- save progress
- export current
- export all
- pack `.asr`
- import `.asr`
- cloud
- language selector
- probe languages
- YouTube URL input
- download
- import media

Web equivalent requirements:

- a visible title/library selector or workspace/project selector
- `Save`
- `Export Current`
- `Export All`
- `Pack .asr`
- `Import .asr`
- `Cloud/Library` or `Storage/Admin` entry point
- language selector for YouTube import
- available-language probe
- YouTube URL input
- `Download`
- `Import Media`

### 13.2 Left Pane: Title Library

The title library must display:

- title
- channel/source
- state
- phrase count

Current state labels to preserve:

- `Checked Out`
- `Checked In`
- `Locked: {user}`
- `Reviewed`
- `Downloaded`

Current ordering to preserve:

- titles checked out by the current user sort to the top
- all other titles follow alphabetically by title

Current color/state meaning to preserve:

- checked out by you: highlighted as your active editable item
- checked in: muted/read-only
- checked out by another user: locked/read-only

Selecting a title must:

- save pending changes if appropriate
- open the title
- load the phrase list
- load waveform/audio state
- update editor read-only status

### 13.3 Center Pane: Title Header

The center pane must show the current title summary at the top:

- title
- channel/source
- state suffix

Current state suffixes to preserve:

- `Checked in (read-only)`
- `Checked out`
- `Locked by {user} (read-only)`

### 13.4 Center Pane: Caption Text Editor

The current app shows a multiline text box for the selected phrase.

Requirements:

- editable when the title is checked out by the current user or not yet on cloud
- read-only when checked in or locked by another user
- label must change between:
  - `Caption Text (editable)`
  - `Caption Text (read-only)`

Text edit behavior to preserve:

- editing a phrase changes only the selected phrase
- committing a text change marks the phrase as reviewed
- text normalization should remain consistent with the desktop app

### 13.5 Center Pane: Waveform Editor

The waveform editor is a critical feature and must be preserved.

Required behavior:

- display the working audio waveform for the current title
- show current phrase start and end markers
- allow dragging the start marker
- allow dragging the end marker
- dragging markers updates the phrase timing
- marker changes mark the phrase reviewed

Required navigation behavior:

- mouse wheel panning
- drag-based panning
- zoom in
- zoom out
- selection remains tied to the current phrase

### 13.6 Playback Controls

The current editor has:

- Play
- Pause
- Stop
- Loop
- playback speed slider
- playback status text

The web app must include:

- phrase playback
- pause/resume
- stop
- loop playback
- playback speed control from `0.50x` to `1.50x`
- visible playback status text

Changing playback speed must affect review playback only and must not alter saved phrase timing.

### 13.7 Timing Controls

The current app allows manual timing entry for the selected phrase:

- start time field
- end time field
- apply
- reset segment

The web app must preserve these controls and their behavior.

### 13.8 Phrase Flags

For the selected phrase, the web app must support:

- `Include in export`
- `Reviewed`

These flags must persist with the title data.

### 13.9 Edit Tools

The current app provides:

- `Add Sentence`
- `Split at Cursor`
- `Combine Selected`

These must be preserved.

#### Add Sentence

- creates a new phrase
- default text must be `<Sentence>`
- new phrase is editable immediately

#### Split at Cursor

- user places text cursor within the selected phrase text
- the phrase splits into two phrases at that cursor position
- timing is split proportionally or by the current desktop behavior

#### Combine Selected

- user selects adjacent phrases
- the phrases merge into one
- merged phrase inherits combined time span and merged text
- only adjacent phrases may be combined

### 13.10 Right Pane: Phrase List

The phrase list must display one row per phrase with these columns:

- Sentence
- Start
- End
- Use
- Reviewed

Required row appearance rules:

- normal: enabled + not reviewed
- reviewed: enabled + reviewed
- disabled: disabled + not reviewed
- disabled reviewed: disabled + reviewed

Required interactions:

- selecting a phrase loads it into the center editor
- clicking the reviewed cell toggles reviewed without changing the main editing flow
- multiple selection is supported for combine

### 13.11 Status Bar / Toast Feedback

The current app uses a status line for operational feedback.

The web app must provide equivalent user feedback for:

- title loaded
- save complete
- sync complete
- check-out / check-in complete
- import/export progress
- lock lost / title became read-only
- errors

This may be implemented as a persistent status bar, toasts, or both.

### 13.12 Cloud / Shared Library Screen

The desktop app currently exposes a dedicated cloud window with:

- account/settings section
- cloud titles list
- refresh
- check out
- check in
- sync checked out
- upload from workspace
- delete from cloud
- admin force check in
- admin take over

Web requirement:

- the web app must include a dedicated shared-library screen or side panel for collaborative title actions
- the title list must auto-refresh on screen open
- the list must show, at minimum:
  - Title / Video ID
  - Size
  - Uploaded
  - Status

Current cloud statuses to preserve:

- available / checked in
- checked out by you
- checked out by another user

Current display behavior to preserve:

- prefer human title over raw video ID
- include channel/source where available
- if no title exists, fall back to the video ID

Current user actions to preserve:

- `Refresh`
- `Check Out`
- `Check In`
- `Sync Checked Out`
- `Upload New Title`
- `Delete from Cloud` or equivalent admin/library delete action
- `Admin Force Check In`
- `Admin Take Over`

---

## 14. Read-Only and Lock-State Requirements

When a title is:

- **checked in**
  - visible in the library
  - may be opened
  - editor is read-only
  - must clearly indicate checked-in status

- **checked out by current user**
  - visible at top of the library
  - editor is fully editable

- **checked out by another user**
  - visible in the library
  - editor is read-only
  - UI must show the other user's identity

If a title becomes checked in or taken over while open, the current user's editor must switch to read-only and show a clear message.

---

## 15. Auto-Save and Sync Requirements

Current desktop behavior includes saving local progress and auto-syncing checked-out cloud titles on save.

Web requirements:

- save must persist project changes server-side
- if the title is checked out by the current user, save must update the current server copy without checking it in
- the system may autosave in addition to explicit save
- autosave/sync must never silently remove the current checkout
- autosave must persist to the server-side working draft, not only browser memory
- the browser may keep a local recovery cache, but that cache is a secondary safety layer only
- explicit save must confirm that the latest phrase edits, timing edits, and edit-tool actions have been committed to the working draft

### 15.1 Required Anti-Data-Loss Behavior

To reduce data loss, the web app must implement all of the following:

- server-side autosave on a short interval while editing
- server-side autosave on important edit commits, including:
  - text commit
  - marker drag release
  - add sentence
  - split
  - combine
  - manual save
- unsaved-changes warning before closing or navigating away when local browser edits have not yet been acknowledged by the server
- draft resume after refresh, logout, or browser restart
- final server save before check-in completes
- clear user feedback when a save or autosave fails

Recommended later enhancement:

- browser `IndexedDB` recovery cache for temporary offline/interruption resilience
- background retry of failed save requests when connectivity returns
- human-visible revision history for restore of prior draft/check-in versions

If the server detects the checkout was lost:

- editing must stop
- the title becomes read-only
- the user must be informed why

---

## 16. Admin / Storage Settings UI

The desktop app has a separate cloud settings window.  
In the web app, this should become an admin-only settings area.

Requirements:

- admin-only storage settings page
- provider preset selection
- bucket/prefix configuration
- endpoint URL
- region
- addressing mode if needed
- connection test
- audit visibility

Normal users must not see or edit raw storage credentials.

---

## 17. Audit Requirements

The system must record audit events for:

- login if desired
- title upload
- title import
- check out
- sync
- check in
- admin force check in
- admin take over
- title delete

Each audit record must include:

- timestamp
- event type
- title
- actor
- relevant before/after details where applicable

---

## 18. Non-Functional Requirements

### 18.1 Security

- auth required for all non-public screens
- role checks enforced on the server
- checkout checks enforced on the server
- S3 credentials never sent to browser clients
- signed URLs short-lived if used

### 18.2 Performance

- editor screen should feel responsive for normal subtitle editing
- waveform and phrase selection should update without full page reloads
- long-running imports must use background jobs and visible progress states

### 18.3 Browser Support

- current desktop-class browsers on Windows and macOS must be supported
- keyboard and mouse editing flows must remain efficient

### 18.4 Reliability

- title edits must survive page refresh after save/autosave
- title edits must not be lost solely because the browser closed or the user logged out
- checked-out titles must resume from the latest server-persisted working draft
- background jobs must be recoverable after process restart
- audit and title state must remain consistent even if object storage operations fail mid-flow
- check-in must be atomic enough that the working draft is not discarded before the finalized checked-in version is safely stored

---

## 19. Suggested Migration Rules from Desktop

To reduce risk, the web rewrite should preserve:

- current project JSON semantics
- current segment fields:
  - `start`
  - `end`
  - `text`
  - `enabled`
  - `reviewed`
- current `.asr` structure
- current title state labels
- current check-out / check-in concepts

The following desktop concepts should be reinterpreted for the web:

- local workspace path
- local cloud config file
- delete-local-copy behavior

These become:

- server-side workspace or project scope
- admin-managed storage settings
- title/library management actions

---

## 20. Minimum Acceptance Criteria

The web MVP is acceptable when:

- a user can log in
- an admin can configure Backblaze B2 or another S3-compatible storage target
- a user can import a YouTube title
- a user can import a local media title
- a user can open a title in a waveform editor
- a user can edit text and timings
- a user can add, split, and combine phrases
- a user can play phrase audio and change playback speed
- a user can save and sync a checked-out title
- a user can check in a title
- a user cannot check out more than one title at a time
- a second user cannot edit a title checked out by someone else
- an admin can force check in or take over a title
- `.asr` import and export work
- the library clearly distinguishes checked-out, checked-in, and locked titles
- a checked-out title survives logout and can be resumed on next login
- browser refresh or crash does not lose the latest server-saved draft

---

## 21. Recommended Implementation Notes

These are recommendations, not hard requirements:

- frontend: React or Next.js
- waveform library: browser waveform/regions component
- backend: Python API service deployed on AWS App Runner
- background jobs: queue-based worker
- DB: Postgres
- object storage SDK: S3-compatible abstraction with Backblaze preset

The most important requirement is not the exact stack.  
The most important requirement is that the server owns:

- auth
- roles
- checkout rules
- audit trail
- storage access

The deployment target for those server-side responsibilities is AWS App Runner.
