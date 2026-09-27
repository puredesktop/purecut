# purecut roadmap

## Scope

Keep local timeline editing, JSX as project source, and the existing optional transcript, caption and export workflows.

These are proposed, incremental improvements, not a release schedule or a list of missing core features. Keep each change small and preserve existing file formats, user data and app workflows.

## Improvements

1. **Missing-media row details.** Show the missing source filename and affected scene in the existing media error state so users can identify the file that needs attention.

2. **Media import outcome summary.** Report which selected files imported successfully and which failed, retaining successful imports and giving a useful reason per failure.

3. **Clip name tooltips.** Show the full source name and scene context when a timeline clip label is truncated, including for keyboard focus where available.

4. **Consistent timecode display.** Use the project's frame rate consistently in timeline, selection and export time labels so the same position is not shown differently across panels.

5. **Selection duration readout.** Display the current selected clip or passage duration beside its start and end positions for more precise trimming.

6. **Trim boundary feedback.** Make minimum clip length and source-media boundary constraints visible when a trim reaches them instead of appearing to stop without explanation.

7. **Timeline zoom reset hint.** Expose a clear description of the existing fit or reset action and its shortcut so users can recover after zooming deeply into a clip.

8. **Muted-track visibility.** Make muted audio state visible on the track header and its accessible label without relying solely on colour.

9. **Transcript search counts.** Show the active match number and total matches beside transcript search, updating after an edit changes the transcript.

10. **Transcript selection summary.** Show the start, end and duration of a selected passage before a transcript cut, using current edited timeline times.

11. **Speech setup diagnosis.** Distinguish no recording, unsupported scene structure and unavailable speech service in the transcript setup panel with an appropriate next step for each.

12. **Transcription progress wording.** Separate waiting, uploading and processing states when the provider exposes them, while retaining the existing cloud-upload consent flow.

13. **Saved transcript availability.** Explain that an existing transcript can still be edited when the speech service is unavailable, so users do not assume they must retranscribe.

14. **Filler suggestion context.** Include a few surrounding words and the current timestamp in each cleanup suggestion so users can judge it before removing speech.

15. **Silence threshold explanation.** Describe the existing silence threshold in plain language beside its control and preview the number of affected gaps before applying cleanup.

16. **Caption length feedback.** Flag unusually long caption text in the existing caption editor and point to the caption that needs shortening or splitting.

17. **Caption preview contrast.** Improve the caption settings preview so text, background and outline remain distinguishable on both bright and dark sample frames.

18. **Highlight naming feedback.** Pre-fill a short editable name from the chosen passage and distinguish newly created highlight scenes from their source scene.

19. **Export settings recap.** Summarize output dimensions, frame rate and selected scope immediately before export using the current settings.

20. **Export failure recovery text.** Retain the last export settings after failure and identify whether media decoding, rendering or output writing failed when that information is available.

## References

- [App guide](docs/app-guide.md)
- [Development guide](docs/development.md)
- [Current implementation](apps/web/src/engine/timeline/timeline.ts)
