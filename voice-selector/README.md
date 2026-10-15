# Voice catalog

`voice_source.json` is a runtime asset. The voice catalog loader reads it to
support `voice.options` and voice selection. Speech synthesis also uses its
voice identifiers.

It ships from `hatch-skills/runtime-assets` with the other runtime assets and
has no workflow entry. The build installs it at `/opt/hatch/skills/voice-selector`,
where the loader reads it; the agent reads it at
`/opt/muse/assets/voice-selector`.
