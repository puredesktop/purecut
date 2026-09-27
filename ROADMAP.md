# purecut contribution roadmap

Build something you can see and try in the app. The first five items are **good first contributions**: bounded changes with a concrete demonstration. Choose a feature below, fix a bug, or propose your own improvement.

## Scope

Keep local timeline editing, JSX as project source, and the existing optional transcript, caption and export workflows.

Size describes scope, not a promised completion time: **Small** = one focused interface change; **Medium** = coordinated interface/state work; **Large** = a feature across several flows, storage or export paths. All items are proposals, not claims that existing features are absent. Check the current code and extend what is there. Maintainers review code and tests before merging. Attribution is your choice.

## Good first contributions

1. **Read full clip names on the timeline.** Show the full source name and scene context when a timeline clip label is truncated, including for keyboard focus where available.
   <!-- contribution: {"id": "clip-name-tooltips", "size": "small", "goodFirstIssue": true, "guide": "docs/contributions/clip-name-tooltips.md"} -->
   [Small · Good first contribution · Implementation brief](docs/contributions/clip-name-tooltips.md)

2. **See the duration of a selected clip.** Display the current selected clip or passage duration beside its start and end positions for more precise trimming.
   <!-- contribution: {"id": "selection-duration-readout", "size": "small", "goodFirstIssue": true, "guide": "docs/contributions/selection-duration-readout.md"} -->
   [Small · Good first contribution · Implementation brief](docs/contributions/selection-duration-readout.md)

3. **Spot muted tracks immediately.** Make muted audio state visible on the track header and its accessible label without relying solely on colour.
   <!-- contribution: {"id": "muted-track-visibility", "size": "small", "goodFirstIssue": true, "guide": "docs/contributions/muted-track-visibility.md"} -->
   [Small · Good first contribution · Implementation brief](docs/contributions/muted-track-visibility.md)

4. **See where you are in transcript search.** Show the active match number and total matches beside transcript search, updating after an edit changes the transcript.
   <!-- contribution: {"id": "transcript-search-counts", "size": "small", "goodFirstIssue": true, "guide": "docs/contributions/transcript-search-counts.md"} -->
   [Small · Good first contribution · Implementation brief](docs/contributions/transcript-search-counts.md)

5. **Review video settings before export.** Summarize output dimensions, frame rate and selected scope immediately before export using the current settings.
   <!-- contribution: {"id": "export-settings-recap", "size": "small", "goodFirstIssue": true, "guide": "docs/contributions/export-settings-recap.md"} -->
   [Small · Good first contribution · Implementation brief](docs/contributions/export-settings-recap.md)

## More improvements

6. **Locate the media a scene is missing.** Show the missing source filename and affected scene in the existing media error state so users can identify the file that needs attention.
   <!-- contribution: {"id": "missing-media-row-details", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/missing-media-row-details.md"} -->
   [Medium · Implementation brief](docs/contributions/missing-media-row-details.md)

7. **See which files imported successfully.** Report which selected files imported successfully and which failed, retaining successful imports and giving a useful reason per failure.
   <!-- contribution: {"id": "media-import-outcome-summary", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/media-import-outcome-summary.md"} -->
   [Medium · Implementation brief](docs/contributions/media-import-outcome-summary.md)

8. **Read consistent timecodes throughout the editor.** Use the project's frame rate consistently in timeline, selection and export time labels so the same position is not shown differently across panels.
   <!-- contribution: {"id": "consistent-timecode-display", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/consistent-timecode-display.md"} -->
   [Medium · Implementation brief](docs/contributions/consistent-timecode-display.md)

9. **Understand why a trim stops.** Make minimum clip length and source-media boundary constraints visible when a trim reaches them instead of appearing to stop without explanation.
   <!-- contribution: {"id": "trim-boundary-feedback", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/trim-boundary-feedback.md"} -->
   [Medium · Implementation brief](docs/contributions/trim-boundary-feedback.md)

10. **Return to a useful timeline zoom.** Expose a clear description of the existing fit or reset action and its shortcut so users can recover after zooming deeply into a clip.
   <!-- contribution: {"id": "timeline-zoom-reset-hint", "size": "small", "goodFirstIssue": false, "guide": "docs/contributions/timeline-zoom-reset-hint.md"} -->
   [Small · Implementation brief](docs/contributions/timeline-zoom-reset-hint.md)

11. **Check the passage before cutting.** Show the start, end and duration of a selected passage before a transcript cut, using current edited timeline times.
   <!-- contribution: {"id": "transcript-selection-summary", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/transcript-selection-summary.md"} -->
   [Medium · Implementation brief](docs/contributions/transcript-selection-summary.md)

12. **See what is needed to start transcription.** Distinguish no recording, unsupported scene structure and unavailable speech service in the transcript setup panel with an appropriate next step for each.
   <!-- contribution: {"id": "speech-setup-diagnosis", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/speech-setup-diagnosis.md"} -->
   [Medium · Implementation brief](docs/contributions/speech-setup-diagnosis.md)

13. **Follow transcription progress.** Separate waiting, uploading and processing states when the provider exposes them, while retaining the existing cloud-upload consent flow.
   <!-- contribution: {"id": "transcription-progress-wording", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/transcription-progress-wording.md"} -->
   [Medium · Implementation brief](docs/contributions/transcription-progress-wording.md)

14. **Keep editing a saved transcript offline.** Explain that an existing transcript can still be edited when the speech service is unavailable, so users do not assume they must retranscribe.
   <!-- contribution: {"id": "saved-transcript-availability", "size": "small", "goodFirstIssue": false, "guide": "docs/contributions/saved-transcript-availability.md"} -->
   [Small · Implementation brief](docs/contributions/saved-transcript-availability.md)

15. **Review filler words in context.** Include a few surrounding words and the current timestamp in each cleanup suggestion so users can judge it before removing speech.
   <!-- contribution: {"id": "filler-suggestion-context", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/filler-suggestion-context.md"} -->
   [Medium · Implementation brief](docs/contributions/filler-suggestion-context.md)

16. **Preview which pauses cleanup will shorten.** Describe the existing silence threshold in plain language beside its control and preview the number of affected gaps before applying cleanup.
   <!-- contribution: {"id": "silence-threshold-explanation", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/silence-threshold-explanation.md"} -->
   [Medium · Implementation brief](docs/contributions/silence-threshold-explanation.md)

17. **Find captions that are too long.** Flag unusually long caption text in the existing caption editor and point to the caption that needs shortening or splitting.
   <!-- contribution: {"id": "caption-length-feedback", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/caption-length-feedback.md"} -->
   [Medium · Implementation brief](docs/contributions/caption-length-feedback.md)

18. **Compare caption contrast on bright and dark frames.** Improve the caption settings preview so text, background and outline remain distinguishable on both bright and dark sample frames.
   <!-- contribution: {"id": "caption-preview-contrast", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/caption-preview-contrast.md"} -->
   [Medium · Implementation brief](docs/contributions/caption-preview-contrast.md)

19. **Name a highlight before creating it.** Pre-fill a short editable name from the chosen passage and distinguish newly created highlight scenes from their source scene.
   <!-- contribution: {"id": "highlight-naming-feedback", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/highlight-naming-feedback.md"} -->
   [Medium · Implementation brief](docs/contributions/highlight-naming-feedback.md)

20. **Retry export with your settings intact.** Retain the last export settings after failure and identify whether media decoding, rendering or output writing failed when that information is available.
   <!-- contribution: {"id": "export-failure-recovery-text", "size": "medium", "goodFirstIssue": false, "guide": "docs/contributions/export-failure-recovery-text.md"} -->
   [Medium · Implementation brief](docs/contributions/export-failure-recovery-text.md)

21. **Compare caption styles before applying.** Add a side-by-side caption style preview on the current frame, with a choice to apply a style to one caption or all captions in the scene. Preserve transcript words and timing.
   <!-- contribution: {"id": "compare-caption-styles-before-applying", "size": "large", "goodFirstIssue": false, "guide": "docs/contributions/compare-caption-styles-before-applying.md"} -->
   [Large · Implementation brief](docs/contributions/compare-caption-styles-before-applying.md)

## References

- [Contribution brief index](docs/contributions/README.md)
- [App guide](docs/app-guide.md)
- [Development guide](docs/development.md)
- [Contributing](CONTRIBUTING.md)
