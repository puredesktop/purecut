import { files, join, projectPath } from '../lib/platform-files'
import { validateTranscript, type Transcript } from './model'
import type { SpeechScene } from './editor'
export const transcriptName = (assetId: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(assetId))
    throw Error('Invalid media identity.')
  return `speech-${assetId}.json`
}
export async function loadTranscript(
  snapshot: SpeechScene,
): Promise<Transcript | null> {
  const dir = snapshot.session.project.dir(),
    name = transcriptName(snapshot.asset.id)
  if (!(await files.list(dir)).some(entry => entry.name === name)) return null
  return validateTranscript(
    JSON.parse(await files.read(join(dir, name))),
    snapshot.asset.id,
  )
}
export async function saveTranscript(
  snapshot: SpeechScene,
  transcript: Transcript,
) {
  await files.write(
    join(snapshot.session.project.dir(), transcriptName(snapshot.asset.id)),
    JSON.stringify(validateTranscript(transcript, snapshot.asset.id)),
  )
}
export function speechSourcePath(snapshot: SpeechScene) {
  if (/^https?:/i.test(snapshot.asset.source))
    throw Error('Import the recording into this project before transcribing.')
  const source = snapshot.asset.source
  return /^\//.test(source) || /^[a-z]:/i.test(source)
    ? source
    : projectPath(snapshot.session.project.dir(), source)
}
