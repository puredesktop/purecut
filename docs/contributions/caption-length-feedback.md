# Find captions that are too long

**Medium · Open contribution** · `caption-length-feedback`

## What the user gets

Flag unusually long caption text in the existing caption editor and point to the caption that needs shortening or splitting.

## Where to start

- [purecut/speech/panel.tsx](../../purecut/speech/panel.tsx) — start with the app-owned UI/state at this path. At source revision `c7231e4cd692`, inspect line 59: `const engine = useEngineContext()`.
- [App guide](../app-guide.md) — open the view in which this change belongs.
- [Development guide](../development.md) — prepare the shared dependencies and run this app inside PureDesktop.

The source location is a navigation hint, not a patch prescription. Read the enclosing component and its existing handlers, then follow their state/command calls. If the behavior is already partly implemented, improve the missing visible part rather than adding a duplicate control. Do not edit generated output or move app behavior into the desktop shell.

## Implementation outline

1. Reproduce the current behavior in the surface above using the fixture below. Identify the existing state and the handler that owns the action.
2. Flag unusually long caption text in the existing caption editor and point to the caption that needs shortening or splitting.
3. Keep existing document identities, formats, persistence and undo behavior. Derive displayed counts, labels and previews from the same data used by the action; do not keep a second editable copy of that data.
4. Keep controls labelled and keyboard reachable. Handle empty, long-text and unavailable-data states inline. For asynchronous work, show success only after completion and retain the input on failure.

## Demonstrate it

**Setup:** Use a disposable short clip with audio and a saved fixture transcript containing repeated words and pauses. Provider-dependent tests must use mocks; do not upload recordings.

**Primary check:** Add an unusually long caption; the feedback identifies the exact caption and offers the existing edit/split route.

**Expected visible result:** Flag unusually long caption text in the existing caption editor and point to the caption that needs shortening or splitting.

**Regression check:** Repeat with an empty value or selection and in a narrow window. The previous document stays intact, existing controls remain reachable, and the user can undo/cancel where the existing workflow supports it. Verify in light and dark themes. For a display-only change, confirm that opening the view does not write to the document.

## Verification and submission

Follow [development setup](../development.md) first. Run `npm run typecheck`; run a focused existing test or add one for changed state/validation logic. Run `npm run build` for a production compilation check. For UI-only work, include before/after screenshots and the exact manual steps above; do not claim tests you did not run.

Build and test locally before deciding whether to submit through Factory’s existing website review process. Nothing in this brief authorizes automatic publication, sending messages, issuing invoices, uploading files, or merging. All contributed code follows this repository’s license. Choose a public name, nickname or anonymous credit at submission.
