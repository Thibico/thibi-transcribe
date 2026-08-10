# thibi-transcribe
An audio transcription app that connects with Google Speech-to-Text API for languages that don't work well with other transcription services.

Self-hosted, one instance per newsroom. Multi-language, multi-provider, with diarization,
glossary-driven accuracy and an editorial LLM layer.

## Orientation

| Where | What |
|---|---|
| [AGENTS.md](./AGENTS.md) | How this project is planned, executed and recorded — read first |
| [plans/](./plans/README.md) | The design record: an overview plus one execution document per phase |
| [work-diary/](./work-diary/README.md) | One file per working day, linking each commit to its plan |
| [spikes/](./spikes/RESULTS.md) | Recorded answers to the questions that could have invalidated the design |

## Development

```bash
pnpm install
docker compose -f infra/compose.dev.yml up -d    # postgres + minio
pnpm build
pnpm thibi db migrate                            # apply migrations
pnpm typecheck && pnpm lint && pnpm test
```

```bash
pnpm thibi transcribe interview.m4a --lang my
```
