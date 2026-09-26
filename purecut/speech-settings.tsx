/** @jsxImportSource react */
import { useEffect, useState } from 'react'
import { usePlatformAppSettings } from '@purescience/platform-ui/bridge/react/usePlatformAppSettings'
import {
  getDiarizationStatus,
  type DiarizationProviderInfo,
} from '@purescience/platform-ui/bridge/diarization.mjs'
import { SettingsFields } from '@purescience/platform-ui/components/settings/SettingsFields'

export function SpeechSettings() {
  const { settings, patchSettings, error, loading } = usePlatformAppSettings({
    appSlug: 'cut',
  })
  const [providers, setProviders] = useState<DiarizationProviderInfo[]>([])
  const [failure, setFailure] = useState('')
  useEffect(() => {
    let live = true
    void getDiarizationStatus()
      .then(s => {
        if (live) setProviders(s.providers.filter(p => p.input === 'audio'))
      })
      .catch(() => {
        if (live)
          setFailure(
            'Speech services are unavailable on this host. Normal video editing remains available.',
          )
      })
    return () => {
      live = false
    }
  }, [])
  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
      <p>
        Speech editing is optional. Without a configured service you can still
        import, edit and export videos. Saved transcripts can be edited offline.
      </p>
      <p>
        AssemblyAI credentials and local speech servers are managed in
        puredesktop Settings → Speech. Audio is uploaded only after you choose
        Transcribe and allow cloud processing.
      </p>
      <SettingsFields
        fields={[
          {
            key: 'speechEditingEnabled',
            label: 'Speech editing',
            description: 'Enable transcription when a service is configured.',
            type: 'toggle',
            value: settings.speechEditingEnabled !== false,
            disabled: loading,
            onChange: value => patchSettings({ speechEditingEnabled: value }),
          },
          {
            key: 'diarizationProvider',
            label: 'Transcription provider',
            description:
              'Use the shared Speech settings or choose a configured service for this app.',
            type: 'select',
            value:
              typeof settings.diarizationProvider === 'string'
                ? settings.diarizationProvider
                : 'default',
            options: [
              { value: 'default', label: 'Use speech settings' },
              ...providers.map(p => ({
                value: p.id,
                label: p.label + (p.available ? '' : ' (not configured)'),
              })),
            ],
            onChange: value =>
              patchSettings({
                diarizationProvider: value === 'default' ? null : value,
              }),
          },
          {
            key: 'diarizationDailyCap',
            label: 'Daily transcription limit',
            description: 'Maximum attempts per day, including failures.',
            type: 'number',
            min: 1,
            max: 200,
            value:
              typeof settings.diarizationDailyCap === 'number'
                ? settings.diarizationDailyCap
                : 20,
            onChange: value => {
              const n = Number(value)
              if (!Number.isInteger(n) || n < 1 || n > 200)
                throw Error('Choose a limit between 1 and 200.')
              return patchSettings({ diarizationDailyCap: n })
            },
          },
        ]}
      />
      <p>
        Choose a service that returns word timestamps for transcript cuts and
        captions. Speaker labels alone are not sufficient. Provider usage
        charges may apply.
      </p>
      {(error || failure) && <p role="alert">{error?.message || failure}</p>}
    </div>
  )
}
