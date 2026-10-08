# Omer license server

Deployment candidate: not yet verified against live accounts and providers.

Upload the contents of this folder to the root of a PRIVATE GitHub repository. Do not upload the ZIP itself. No desktop binaries, saved profiles, API settings, or credentials are included.

Render: Node runtime; Free instance; build command npm ci --omit=dev --ignore-scripts; start command node server.js; health path /health. Configure secrets using Render environment settings.

Supabase schema was installed in project cxontapfbojoyqfquqgz. Do not rerun schema.sql on that project.

Required configuration is listed in render.yaml. Never commit actual secrets. Only the selected transcription provider requires its API key.

Tests: npm test

Do not distribute a desktop installer until login, activation, revocation, answers, and transcription have been tested against the deployed service.
